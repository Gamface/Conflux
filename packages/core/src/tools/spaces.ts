import type { Tool, ToolContext } from "./types.ts";

function allowedSpaces(ctx: ToolContext): string[] {
  return ctx.coworker.spaces ?? ["default"];
}

function checkSpace(ctx: ToolContext, space: string): void {
  const ok = allowedSpaces(ctx);
  if (!ok.includes(space) && !ok.includes("*")) throw new Error(`${ctx.coworker.name} has no access to space "${space}" (allowed: ${ok.join(", ")})`);
}

export const pageSaveTool: Tool = {
  name: "page_save",
  toolset: "spaces",
  effect: (a) => (a?.page_id ? "write" : "write"),
  description:
    "Save durable work as a Markdown page in a Space. Without page_id it creates a page (or updates the page with the same title). With page_id and base_revision it updates that page; a stale revision is rejected so newer edits are never overwritten.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      body: { type: "string", description: "Markdown content." },
      space: { type: "string" },
      page_id: { type: "string" },
      base_revision: { type: "number" },
      parent_id: { type: "string" },
    },
    required: ["title", "body"],
  },
  resolveContext: (a, ctx) => ({ space: { name: a.space ?? allowedSpaces(ctx)[0] } }),
  async run(a, ctx) {
    const space = a.space ?? allowedSpaces(ctx)[0];
    checkSpace(ctx, space);
    const pages = ctx.rt.pages;
    const author = ctx.coworker.id;
    let page;
    if (a.page_id) page = pages.update(a.page_id, { title: a.title, body: a.body, baseRevision: a.base_revision, author });
    else {
      const existing = pages.findByTitle(space, a.title);
      page = existing ? pages.update(existing.id, { body: a.body, author }) : pages.create({ title: a.title, body: a.body, space, parentId: a.parent_id, author });
    }
    ctx.rt.bus.publish("pages", { type: "page_saved", id: page.id, title: page.title, space });
    return {
      content: `Saved page "${page.title}" (id ${page.id}, revision ${page.revision}) in space "${space}".`,
      ui: "page",
      data: { id: page.id, title: page.title, space, revision: page.revision, excerpt: String(page.body).slice(0, 500) },
    };
  },
};

export const pageSearchTool: Tool = {
  name: "page_search",
  toolset: "spaces",
  effect: "read",
  description: "Full-text search pages in the Spaces you can access.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  async run(a, ctx) {
    const sp = allowedSpaces(ctx);
    const rows = ctx.rt.pages.search(a.query, sp.includes("*") ? undefined : sp);
    return rows.length ? rows.map((r) => `- ${r.title} (id ${r.id}, space ${r.space}): ${r.snippet}`).join("\n") : "No pages matched.";
  },
};

export const pageReadTool: Tool = {
  name: "page_read",
  toolset: "spaces",
  effect: "read",
  description: "Read a page's full Markdown and current revision (needed to update it safely).",
  parameters: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] },
  async run(a, ctx) {
    const p = ctx.rt.pages.get(a.page_id);
    if (!p) throw new Error(`no page ${a.page_id}`);
    checkSpace(ctx, p.space);
    return `# ${p.title}\n(space ${p.space}, revision ${p.revision}, last edited by ${p.author})\n\n${p.body}`;
  },
};

export const spaceTools = [pageSaveTool, pageSearchTool, pageReadTool];
