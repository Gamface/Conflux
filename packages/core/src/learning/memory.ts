import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * Curated memory, after Hermes: two small markdown files the agent maintains itself.
 *   USER.md   — who the user is and how they like to work. Shared by every coworker the user permits.
 *   MEMORY.md — per-coworker notes: environment facts, lessons learned, conventions.
 *
 * Both are injected into the system prompt as a FROZEN snapshot when a conversation starts. Writes
 * mid-conversation land on disk immediately but never mutate the running prompt, so the provider's
 * prefix cache survives — the single most important cost invariant in Hermes.
 *
 * Limits are deliberately small: memory is a curated index, not a dump. Detail belongs in pages,
 * skills, or session search.
 */
export const ENTRY_DELIMITER = "\n§\n";
export type MemoryTarget = "memory" | "user";

const LIMITS: Record<MemoryTarget, number> = { memory: 4000, user: 2000 };

const INJECTION = [
  /ignore (all |any )?(previous|prior|above) (instructions|rules)/i,
  /you are now|new system prompt|disregard (your|the) (rules|instructions)/i,
  /<\/?(system|assistant)>/i,
];
const SECRET = [/sk-[A-Za-z0-9_-]{20,}/, /AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{30,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[baprs]-[A-Za-z0-9-]{10,}/];

export function scanMemoryContent(content: string): string | null {
  for (const re of INJECTION) if (re.test(content)) return "content looks like a prompt-injection attempt and was not saved";
  for (const re of SECRET) if (re.test(content)) return "content contains what looks like a credential; secrets never go in memory";
  return null;
}

export class MemoryStore {
  private root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, "memory");
    mkdirSync(this.root, { recursive: true });
  }

  private path(target: MemoryTarget, coworkerId: string): string {
    return target === "user" ? join(this.root, "USER.md") : join(this.root, "coworkers", coworkerId, "MEMORY.md");
  }

  entries(target: MemoryTarget, coworkerId: string): string[] {
    const p = this.path(target, coworkerId);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split(ENTRY_DELIMITER)
      .map((e) => e.trim())
      .filter(Boolean);
  }

  private write(target: MemoryTarget, coworkerId: string, entries: string[]): void {
    const p = this.path(target, coworkerId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, entries.join(ENTRY_DELIMITER) + (entries.length ? "\n" : ""));
  }

  usage(target: MemoryTarget, coworkerId: string): { used: number; limit: number } {
    return { used: this.entries(target, coworkerId).join(ENTRY_DELIMITER).length, limit: LIMITS[target] };
  }

  add(target: MemoryTarget, coworkerId: string, content: string): string {
    content = content.trim();
    if (!content) throw new Error("content is empty");
    const bad = scanMemoryContent(content);
    if (bad) throw new Error(bad);
    const entries = this.entries(target, coworkerId);
    if (entries.some((e) => e.toLowerCase() === content.toLowerCase())) return "Already remembered.";
    const next = [...entries, content];
    const size = next.join(ENTRY_DELIMITER).length;
    if (size > LIMITS[target]) {
      throw new Error(
        `${target} is full (${size}/${LIMITS[target]} chars). Consolidate: replace or remove older entries first, or move detail into a page or skill.`,
      );
    }
    this.write(target, coworkerId, next);
    return `Saved to ${target === "user" ? "user profile" : "memory"} (${size}/${LIMITS[target]} chars).`;
  }

  replace(target: MemoryTarget, coworkerId: string, oldText: string, content: string): string {
    const bad = scanMemoryContent(content);
    if (bad) throw new Error(bad);
    const entries = this.entries(target, coworkerId);
    const i = this.find(entries, oldText);
    entries[i] = content.trim();
    if (entries.join(ENTRY_DELIMITER).length > LIMITS[target]) throw new Error(`${target} would exceed its ${LIMITS[target]} char limit`);
    this.write(target, coworkerId, entries);
    return "Updated.";
  }

  remove(target: MemoryTarget, coworkerId: string, oldText: string): string {
    const entries = this.entries(target, coworkerId);
    entries.splice(this.find(entries, oldText), 1);
    this.write(target, coworkerId, entries);
    return "Removed.";
  }

  /** Replace the whole file (user editing in the UI). */
  setAll(target: MemoryTarget, coworkerId: string, entries: string[]): void {
    for (const e of entries) {
      const bad = scanMemoryContent(e);
      if (bad) throw new Error(bad);
    }
    this.write(target, coworkerId, entries.map((e) => e.trim()).filter(Boolean));
  }

  private find(entries: string[], oldText: string): number {
    const needle = oldText.trim().toLowerCase();
    const hits = entries.map((e, i) => [e, i] as const).filter(([e]) => e.toLowerCase().includes(needle));
    if (hits.length === 0) throw new Error(`no entry contains "${oldText}"`);
    if (hits.length > 1) throw new Error(`"${oldText}" matches ${hits.length} entries; quote more of the one you mean`);
    return hits[0][1];
  }

  /** The frozen block that goes into a new conversation's system prompt. */
  snapshot(coworkerId: string, includeUser = true): string {
    const parts: string[] = [];
    const user = includeUser ? this.entries("user", coworkerId) : [];
    const mem = this.entries("memory", coworkerId);
    if (user.length) parts.push(`<user-profile>\n${user.map((e) => `- ${e}`).join("\n")}\n</user-profile>`);
    if (mem.length) parts.push(`<memory>\n${mem.map((e) => `- ${e}`).join("\n")}\n</memory>`);
    return parts.join("\n\n");
  }
}
