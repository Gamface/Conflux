import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Db } from "../db.ts";
import { now } from "../db.ts";

/**
 * Skills: folders with a SKILL.md (YAML frontmatter `name` + `description`, then instructions),
 * plus optional references/, scripts/, templates/. The format is the open agentskills.io / Claude
 * skills standard, so skills move freely between Conflux, Hermes, Claude Code and others.
 *
 * Progressive disclosure: only `name: description` lines enter the system prompt; the body is
 * loaded with `skill_view` when the task calls for it. Learned skills (written by the agent's
 * learning loop) live in data/skills and override bundled ones of the same name.
 */
export type SkillMeta = {
  name: string;
  description: string;
  source: "bundled" | "learned";
  path: string;
  category?: string;
  createdBy?: string;
  views?: number;
};

export function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  let key = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      meta[key] = kv[2].replace(/^["']|["']$/g, "").trim();
    } else if (key && /^\s+\S/.test(line)) {
      meta[key] = (meta[key] + " " + line.trim()).replace(/^[>|]\s*/, "").trim();
    }
  }
  return { meta, body: m[2] };
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MAX_SKILL_CHARS = 30_000;

export function validateSkill(content: string): string | null {
  if (!content.startsWith("---")) return "SKILL.md must start with YAML frontmatter (---)";
  const { meta, body } = parseFrontmatter(content);
  if (!meta.name) return "frontmatter needs a `name`";
  if (!NAME_RE.test(meta.name)) return "name must be kebab-case (a-z, 0-9, -), 2-64 chars";
  if (!meta.description) return "frontmatter needs a `description` saying when to use the skill";
  if (meta.description.length > 1024) return "description must be under 1024 characters";
  if (!body.trim()) return "SKILL.md needs instructions after the frontmatter";
  if (content.length > MAX_SKILL_CHARS) return `SKILL.md is over ${MAX_SKILL_CHARS} characters; move detail into references/`;
  return null;
}

export class SkillStore {
  readonly bundledDir: string;
  readonly learnedDir: string;
  private db: Db;

  constructor(bundledDir: string, dataDir: string, db: Db) {
    this.bundledDir = bundledDir;
    this.learnedDir = join(dataDir, "skills");
    this.db = db;
    mkdirSync(this.learnedDir, { recursive: true });
  }

  private scan(root: string, source: SkillMeta["source"]): SkillMeta[] {
    if (!existsSync(root)) return [];
    const out: SkillMeta[] = [];
    const walk = (dir: string, depth: number) => {
      const skillMd = join(dir, "SKILL.md");
      if (existsSync(skillMd)) {
        const { meta } = parseFrontmatter(readFileSync(skillMd, "utf8"));
        const rel = relative(root, dir).split(/[\\/]/);
        out.push({
          name: meta.name || rel[rel.length - 1],
          description: meta.description ?? "",
          source,
          path: dir,
          category: rel.length > 1 ? rel[0] : undefined,
          createdBy: meta["created-by"],
        });
        return;
      }
      if (depth > 2) return;
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (!e.startsWith(".") && statSync(p).isDirectory()) walk(p, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }

  list(): SkillMeta[] {
    const byName = new Map<string, SkillMeta>();
    for (const s of this.scan(this.bundledDir, "bundled")) byName.set(s.name, s);
    for (const s of this.scan(this.learnedDir, "learned")) byName.set(s.name, s);
    const views = new Map(this.db.all("SELECT name, views FROM skill_usage").map((r) => [r.name, r.views]));
    return [...byName.values()].map((s) => ({ ...s, views: views.get(s.name) ?? 0 })).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SkillMeta | undefined {
    return this.list().find((s) => s.name === name);
  }

  view(name: string, file?: string): { content: string; files: string[] } {
    const s = this.get(name);
    if (!s) throw new Error(`no skill named "${name}". Available: ${this.list().map((x) => x.name).join(", ") || "none"}`);
    const files = listFiles(s.path).filter((f) => f !== "SKILL.md");
    let content: string;
    if (file) {
      const p = join(s.path, file);
      if (!p.startsWith(s.path) || !existsSync(p)) throw new Error(`no file ${file} in skill ${name}`);
      content = readFileSync(p, "utf8");
    } else {
      content = readFileSync(join(s.path, "SKILL.md"), "utf8");
      this.db.run(
        "INSERT INTO skill_usage (name, views, last_used_at) VALUES (?, 1, ?) ON CONFLICT(name) DO UPDATE SET views = views + 1, last_used_at = excluded.last_used_at",
        name, now(),
      );
    }
    return { content, files };
  }

  create(content: string, createdBy: string): SkillMeta {
    const err = validateSkill(content);
    if (err) throw new Error(err);
    const { meta } = parseFrontmatter(content);
    const dir = join(this.learnedDir, meta.name);
    if (existsSync(join(dir, "SKILL.md"))) throw new Error(`skill "${meta.name}" already exists; use action "patch" to improve it`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), withProvenance(content, createdBy));
    return this.get(meta.name)!;
  }

  /** Replace text inside a skill. Patching a bundled skill forks it into data/skills (originals stay pristine). */
  patch(name: string, oldText: string, newText: string, by: string): SkillMeta {
    const s = this.get(name);
    if (!s) throw new Error(`no skill named "${name}"`);
    const current = readFileSync(join(s.path, "SKILL.md"), "utf8");
    if (!current.includes(oldText)) throw new Error("old_text not found in SKILL.md");
    if (current.split(oldText).length > 2) throw new Error("old_text matches more than once; include more context");
    const next = current.replace(oldText, newText);
    const err = validateSkill(next);
    if (err) throw new Error(err);
    const dir = join(this.learnedDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), withProvenance(next, by));
    return this.get(name)!;
  }

  writeFile(name: string, file: string, content: string): void {
    const s = this.get(name);
    if (!s || s.source !== "learned") throw new Error("supporting files can only be added to learned skills");
    if (!/^(references|scripts|templates|assets)\/[\w.-]+$/.test(file)) throw new Error("file must be under references/, scripts/, templates/ or assets/");
    mkdirSync(join(s.path, file.split("/")[0]), { recursive: true });
    writeFileSync(join(s.path, file), content);
  }

  delete(name: string): void {
    const s = this.get(name);
    if (!s) throw new Error(`no skill named "${name}"`);
    if (s.source !== "learned") throw new Error("bundled skills cannot be deleted");
    rmSync(s.path, { recursive: true, force: true });
  }

  /** The progressive-disclosure index placed in the system prompt. */
  index(): string {
    const skills = this.list();
    if (!skills.length) return "";
    return (
      "<skills>\nBefore starting a task, check whether a skill below covers it; if so, load it with skill_view and follow it.\n" +
      skills.map((s) => `- ${s.name}: ${s.description}`).join("\n") +
      "\n</skills>"
    );
  }
}

function withProvenance(content: string, by: string): string {
  if (/^created-by:/m.test(content.split("\n---")[0])) return content;
  return content.replace(/^---\r?\n/, `---\ncreated-by: ${by}\n`);
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p));
  }
  return out;
}
