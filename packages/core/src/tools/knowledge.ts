import type { Tool } from "./types.ts";

export const knowledgeSearchTool: Tool = {
  name: "knowledge_search",
  toolset: "knowledge",
  effect: "read",
  description: "Retrieve passages from the knowledge base (company docs, handbooks, uploaded files). Cite the document title for every claim you take from it.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, dataset: { type: "string" }, top_k: { type: "number" } },
    required: ["query"],
  },
  async run(a, ctx) {
    const rows = ctx.rt.knowledge.search(a.query, { dataset: a.dataset, topK: Math.min(Number(a.top_k ?? 5), 12) });
    if (!rows.length) return "No passages matched. Say so rather than guessing.";
    return {
      content: rows.map((r, i) => `[${i + 1}] ${r.title} (${r.dataset}${r.source ? `, ${r.source}` : ""})\n${r.content}`).join("\n\n---\n\n"),
      ui: "sources",
      data: rows.map((r) => ({ title: r.title, dataset: r.dataset, source: r.source, excerpt: String(r.content).slice(0, 240) })),
    };
  },
};

export const knowledgeAddTool: Tool = {
  name: "knowledge_add",
  toolset: "knowledge",
  effect: "write",
  description: "Add or replace a document in a knowledge dataset so it can be retrieved later.",
  parameters: {
    type: "object",
    properties: { dataset: { type: "string" }, title: { type: "string" }, content: { type: "string" }, source: { type: "string" } },
    required: ["dataset", "title", "content"],
  },
  async run(a, ctx) {
    const n = ctx.rt.knowledge.add(a.dataset, a.title, a.content, a.source);
    return `Indexed "${a.title}" into ${a.dataset} (${n} chunks).`;
  },
};

export const knowledgeTools = [knowledgeSearchTool, knowledgeAddTool];
