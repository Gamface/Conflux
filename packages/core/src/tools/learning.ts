import type { Tool } from "./types.ts";
import { ftsQuery } from "../db.ts";

export const memoryTool: Tool = {
  name: "memory",
  toolset: "learning",
  effect: "learn",
  aliases: { action: { save: "add", create: "add", remember: "add", update: "replace", edit: "replace", delete: "remove", forget: "remove", show: "list", read: "list" }, target: { profile: "user", me: "user", notes: "memory", environment: "memory" } },
  description:
    "Curated long-term memory that persists across conversations. target=user for facts about the user (preferences, role, constraints, communication style); target=memory for your own notes about the environment, conventions and lessons learned. Actions: add, replace (old_text → content), remove (old_text). Keep entries short and durable; consolidate when near the limit. Never store secrets.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "replace", "remove", "list"] },
      target: { type: "string", enum: ["user", "memory"] },
      content: { type: "string", description: "The entry text (add / replace)." },
      old_text: { type: "string", description: "A unique substring of the entry to replace or remove." },
    },
    required: ["action", "target"],
  },
  async run(a, ctx) {
    const m = ctx.rt.memory;
    const id = ctx.coworker.id;
    switch (a.action) {
      case "add":
        return m.add(a.target, id, a.content ?? "");
      case "replace":
        return m.replace(a.target, id, a.old_text ?? "", a.content ?? "");
      case "remove":
        return m.remove(a.target, id, a.old_text ?? "");
      case "list": {
        const e = m.entries(a.target, id);
        return e.length ? e.map((x) => `- ${x}`).join("\n") : "(empty)";
      }
    }
    throw new Error(`unknown action ${a.action}`);
  },
};

export const skillViewTool: Tool = {
  name: "skill_view",
  toolset: "learning",
  effect: "read",
  description: "Load a skill's full instructions (SKILL.md), or one of its supporting files, before doing a task the skill covers.",
  parameters: {
    type: "object",
    properties: { name: { type: "string" }, file: { type: "string", description: "Optional supporting file, e.g. references/api.md" } },
    required: ["name"],
  },
  async run(a, ctx) {
    const { content, files } = ctx.rt.skills.view(a.name, a.file);
    return content + (files.length && !a.file ? `\n\n[supporting files: ${files.join(", ")}]` : "");
  },
};

export const skillManageTool: Tool = {
  name: "skill_manage",
  toolset: "learning",
  aliases: { action: { add: "create", new: "create", save: "create", write: "create", update: "patch", edit: "patch", modify: "patch", improve: "patch", remove: "delete", add_file: "write_file", file: "write_file" } },
  effect: (a) => (a?.action === "delete" ? "destructive" : "learn"),
  description:
    "Create or improve reusable skills (procedural memory). Skills are NOT knowledge datasets. Example create call: {\"action\": \"create\", \"content\": \"---\\nname: kdenlive-export\\ndescription: Export a Kdenlive project to MP4\\n---\\n1. ...\"}. create: full SKILL.md content with YAML frontmatter (name: kebab-case, description: when to use it) followed by numbered steps, pitfalls and how to verify. patch: replace old_text with new_text inside an existing skill (bundled skills are forked, originals untouched). write_file: add references/, scripts/ or templates/ files. delete: remove a learned skill.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "patch", "write_file", "delete"] },
      name: { type: "string" },
      content: { type: "string", description: "SKILL.md for create; file content for write_file." },
      old_text: { type: "string" },
      new_text: { type: "string" },
      file: { type: "string" },
    },
    required: ["action"],
  },
  async run(a, ctx) {
    const s = ctx.rt.skills;
    const by = `${ctx.coworker.id}${ctx.initiator === "review" ? " (learning loop)" : ""}`;
    switch (a.action) {
      case "create": {
        const meta = s.create(a.content ?? "", by);
        ctx.rt.bus.publish("learning", { type: "skill_created", name: meta.name, coworker: ctx.coworker.id });
        return `Created skill "${meta.name}". It will be listed in new conversations.`;
      }
      case "patch":
        s.patch(a.name, a.old_text ?? "", a.new_text ?? "", by);
        return `Patched skill "${a.name}".`;
      case "write_file":
        s.writeFile(a.name, a.file, a.content ?? "");
        return `Wrote ${a.file} in skill "${a.name}".`;
      case "delete":
        s.delete(a.name);
        return `Deleted skill "${a.name}".`;
    }
    throw new Error(`unknown action ${a.action}`);
  },
};

export const sessionSearchTool: Tool = {
  name: "session_search",
  toolset: "learning",
  effect: "read",
  description:
    "Full-text search across ALL past conversations (including compacted history) to recall what was said, decided or produced before. Returns matching snippets with their conversation ids.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number" } },
    required: ["query"],
  },
  async run(a, ctx) {
    const rows = ctx.rt.db.all(
      `SELECT f.thread_id, f.role, snippet(messages_fts, 0, '[', ']', '…', 32) AS snippet, t.title, t.coworker_id, t.updated_at
       FROM messages_fts f JOIN threads t ON t.id = f.thread_id
       WHERE messages_fts MATCH ? AND f.thread_id != ? ORDER BY bm25(messages_fts) LIMIT ?`,
      ftsQuery(a.query), ctx.threadId, Math.min(Number(a.limit ?? 8), 25),
    );
    if (!rows.length) return "No past conversations matched.";
    return rows
      .map((r) => `• [${r.title}] (${r.coworker_id}, ${new Date(r.updated_at).toISOString().slice(0, 10)}, thread ${r.thread_id}) ${r.role}: ${r.snippet}`)
      .join("\n");
  },
};

export const learningTools = [memoryTool, skillViewTool, skillManageTool, sessionSearchTool];
