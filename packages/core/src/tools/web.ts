import type { Tool } from "./types.ts";

export function htmlToText(html: string): { title: string; text: string; links: { text: string; href: string }[] } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const links: { text: string; href: string }[] = [];
  for (const m of html.matchAll(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (text && links.length < 60) links.push({ text: text.slice(0, 80), href: m[1] });
  }
  const text = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  return { title, text, links };
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  toolset: "web",
  effect: "read",
  description: "Fetch a public web page (or JSON/text URL) and return its readable text, title and top links.",
  parameters: { type: "object", properties: { url: { type: "string" }, max_chars: { type: "number" } }, required: ["url"] },
  resolveContext: (a) => {
    const u = new URL(String(a.url));
    return { page: { url: u.toString(), host: u.hostname } };
  },
  async run(a, ctx) {
    const res = await fetch(a.url, { headers: { "user-agent": "Conflux/1.0 (+https://github.com)" }, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) });
    const type = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const max = Math.min(Number(a.max_chars ?? 12_000), 40_000);
    if (!type.includes("html")) return `HTTP ${res.status} ${type}\n\n${raw.slice(0, max)}`;
    const { title, text, links } = htmlToText(raw);
    return {
      content: `HTTP ${res.status} — ${title}\n\n${text.slice(0, max)}\n\nLinks:\n${links.slice(0, 25).map((l) => `- ${l.text}: ${l.href}`).join("\n")}`,
      ui: "web",
      data: { url: a.url, title, excerpt: text.slice(0, 400) },
    };
  },
};

/** Service-gated web search: Tavily, Brave or a self-hosted SearXNG, whichever is configured. */
export const webSearchTool: Tool = {
  name: "web_search",
  toolset: "web",
  effect: "read",
  description: "Search the web. Returns titles, URLs and snippets; follow up with web_fetch or the browser.",
  parameters: { type: "object", properties: { query: { type: "string" }, count: { type: "number" } }, required: ["query"] },
  available: () => !!(process.env.TAVILY_API_KEY || process.env.BRAVE_API_KEY || process.env.SEARXNG_URL),
  async run(a, ctx) {
    const n = Math.min(Number(a.count ?? 6), 10);
    let results: { title: string; url: string; snippet: string }[] = [];
    if (process.env.TAVILY_API_KEY) {
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: a.query, max_results: n }),
        signal: ctx.signal,
      }).then((r) => r.json());
      results = (r.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content }));
    } else if (process.env.BRAVE_API_KEY) {
      const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(a.query)}&count=${n}`, {
        headers: { "x-subscription-token": process.env.BRAVE_API_KEY, accept: "application/json" },
        signal: ctx.signal,
      }).then((r) => r.json());
      results = (r.web?.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: x.description }));
    } else {
      const r = await fetch(`${process.env.SEARXNG_URL!.replace(/\/$/, "")}/search?format=json&q=${encodeURIComponent(a.query)}`, { signal: ctx.signal }).then((r) => r.json());
      results = (r.results ?? []).slice(0, n).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content }));
    }
    return {
      content: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet?.slice(0, 300) ?? ""}`).join("\n") || "No results.",
      ui: "search",
      data: results,
    };
  },
};

export const webTools = [webFetchTool, webSearchTool];
