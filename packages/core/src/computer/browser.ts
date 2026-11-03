import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Tool, ToolContext } from "../tools/types.ts";
import type { Runtime } from "../runtime.ts";
import { SnapshotCache } from "./snapshot.ts";

/**
 * Each coworker gets its own persistent Chromium profile (OpenBot / OpenMuse "a real browser with
 * its own logins"). Pages are driven through accessibility-style refs, not pixels.
 */
const require = createRequire(import.meta.url);
let playwrightAvailable: boolean | undefined;

export function hasPlaywright(): boolean {
  if (playwrightAvailable === undefined) {
    try {
      require.resolve("playwright");
      playwrightAvailable = true;
    } catch {
      playwrightAvailable = false;
    }
  }
  return playwrightAvailable;
}

const SNAPSHOT_JS = `(() => {
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick]';
  document.querySelectorAll('[data-cfx-ref]').forEach(e => e.removeAttribute('data-cfx-ref'));
  const lines = []; let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none') continue;
    if (n >= 250) break;
    const ref = 'e' + (++n); el.setAttribute('data-cfx-ref', ref);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (['checkbox','radio','submit','button'].includes(el.type) ? el.type : 'textbox') : tag === 'select' ? 'combobox' : tag === 'textarea' ? 'textbox' : tag);
    let name = el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
    name = name.replace(/\\s+/g, ' ').trim().slice(0, 80).replace(/"/g, '\\\\"');
    let extra = '';
    if (tag === 'input' && el.type) extra += ' type=' + el.type;
    if ((tag === 'input' || tag === 'textarea') && el.value && el.type !== 'password') extra += ' value="' + String(el.value).slice(0, 40).replace(/"/g, "'") + '"';
    if (tag === 'a') extra += ' href=' + (el.getAttribute('href') || '').slice(0, 80);
    lines.push('[@' + ref + '] ' + role + ' "' + name + '"' + extra);
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 3500);
  return { title: document.title, url: location.href, lines, text };
})()`;

export class BrowserManager {
  private rt: Runtime;
  private contexts = new Map<string, Promise<any>>();
  readonly snapshots = new SnapshotCache();

  constructor(rt: Runtime) {
    this.rt = rt;
  }

  async page(coworkerId: string): Promise<any> {
    let ctxP = this.contexts.get(coworkerId);
    if (!ctxP) {
      ctxP = (async () => {
        // Resolve the same way hasPlaywright() does (works for local, workspace and global installs).
        const mod = (await import(pathToFileURL(require.resolve("playwright")).href)) as any;
        const chromium = mod.chromium ?? mod.default?.chromium;
        const dir = join(this.rt.config.dataDir, "browser", coworkerId);
        mkdirSync(dir, { recursive: true });
        const context = await chromium.launchPersistentContext(dir, {
          headless: this.rt.config.computer.headless,
          viewport: { width: 1280, height: 800 },
          args: ["--no-sandbox"],
        });
        return context;
      })();
      this.contexts.set(coworkerId, ctxP);
    }
    const context = await ctxP;
    return context.pages()[0] ?? (await context.newPage());
  }

  async snapshot(coworkerId: string): Promise<{ title: string; url: string; text: string; snapshot: string }> {
    const page = await this.page(coworkerId);
    const s = await page.evaluate(SNAPSHOT_JS);
    const snapshot = s.lines.join("\n");
    this.snapshots.set(coworkerId, snapshot, s.url);
    return { title: s.title, url: s.url, text: s.text, snapshot };
  }

  async screenshot(coworkerId: string): Promise<string> {
    const page = await this.page(coworkerId);
    const buf: Buffer = await page.screenshot({ type: "jpeg", quality: 60 });
    return buf.toString("base64");
  }

  async currentUrl(coworkerId: string): Promise<string | undefined> {
    if (!this.contexts.has(coworkerId)) return undefined;
    return (await this.page(coworkerId)).url();
  }

  isOpen(coworkerId: string): boolean {
    return this.contexts.has(coworkerId);
  }

  async close(): Promise<void> {
    for (const p of this.contexts.values()) await (await p).close().catch(() => {});
    this.contexts.clear();
  }
}

async function observe(ctx: ToolContext, note: string) {
  const b = ctx.rt.browser;
  const s = await b.snapshot(ctx.coworker.id);
  const shot = await b.screenshot(ctx.coworker.id).catch(() => undefined);
  return {
    content: `${note}\nPage: ${s.title} — ${s.url}\n\nInteractive elements:\n${s.snapshot || "(none)"}\n\nVisible text:\n${s.text}`,
    ui: "browser",
    data: { url: s.url, title: s.title, screenshot: shot },
  };
}

/** Policy context: the page we are on and — for ref actions — the element as WE saw it. */
async function pageContext(a: any, ctx: ToolContext): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const url = a.url ?? (await ctx.rt.browser.currentUrl(ctx.coworker.id));
  if (url) {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    out.page = { url: u.toString(), host: u.hostname };
  }
  if (a.ref) {
    const el = ctx.rt.browser.snapshots.element(ctx.coworker.id, a.ref);
    if (!el) throw new Error(`unknown ref ${a.ref}; take a fresh browser_snapshot first`);
    out.element = el;
  }
  if (a.submit) out.key = "Enter";
  if (a.key) out.key = a.key;
  return out;
}

const available = (_rt: Runtime) => hasPlaywright();

export const browserTools: Tool[] = [
  {
    name: "browser_navigate",
    toolset: "computer",
    effect: "read",
    available,
    description: "Open a URL in your own persistent browser (your logins persist). Returns the page's interactive elements as [@eN] refs, visible text and a screenshot.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    resolveContext: pageContext,
    async run(a, ctx) {
      const page = await ctx.rt.browser.page(ctx.coworker.id);
      const url = String(a.url).startsWith("http") ? a.url : `https://${a.url}`;
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
      return observe(ctx, `Navigated (HTTP ${res?.status() ?? "?"}).`);
    },
  },
  {
    name: "browser_snapshot",
    toolset: "computer",
    effect: "read",
    available,
    description: "Re-read the current page: interactive elements as [@eN] refs plus visible text. Refs change after navigation — always act on the latest snapshot.",
    parameters: { type: "object", properties: {} },
    resolveContext: pageContext,
    async run(_a, ctx) {
      return observe(ctx, "Snapshot.");
    },
  },
  {
    name: "browser_click",
    toolset: "computer",
    effect: "write",
    available,
    description: "Click an element by its ref from the latest snapshot (e.g. e12).",
    parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
    resolveContext: pageContext,
    async run(a, ctx) {
      const page = await ctx.rt.browser.page(ctx.coworker.id);
      await page.locator(`[data-cfx-ref="${String(a.ref).replace(/^@/, "")}"]`).first().click({ timeout: 8000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 6000 }).catch(() => {});
      return observe(ctx, `Clicked ${a.ref}.`);
    },
  },
  {
    name: "browser_type",
    toolset: "computer",
    effect: "write",
    available,
    description: "Type text into a field by ref (replaces its content). submit=true presses Enter afterwards.",
    parameters: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } }, required: ["ref", "text"] },
    resolveContext: pageContext,
    async run(a, ctx) {
      const page = await ctx.rt.browser.page(ctx.coworker.id);
      const loc = page.locator(`[data-cfx-ref="${String(a.ref).replace(/^@/, "")}"]`).first();
      await loc.fill(String(a.text), { timeout: 8000 });
      if (a.submit) await loc.press("Enter");
      await page.waitForLoadState("domcontentloaded", { timeout: 6000 }).catch(() => {});
      return observe(ctx, `Typed into ${a.ref}${a.submit ? " and submitted" : ""}.`);
    },
  },
  {
    name: "browser_key",
    toolset: "computer",
    effect: "write",
    available,
    description: "Press a key or combo in the browser (e.g. Enter, Escape, Control+A, PageDown).",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    resolveContext: pageContext,
    async run(a, ctx) {
      const page = await ctx.rt.browser.page(ctx.coworker.id);
      await page.keyboard.press(String(a.key));
      return observe(ctx, `Pressed ${a.key}.`);
    },
  },
  {
    name: "browser_back",
    toolset: "computer",
    effect: "read",
    available,
    description: "Go back in browser history.",
    parameters: { type: "object", properties: {} },
    resolveContext: pageContext,
    async run(_a, ctx) {
      const page = await ctx.rt.browser.page(ctx.coworker.id);
      await page.goBack({ timeout: 10_000 }).catch(() => {});
      return observe(ctx, "Went back.");
    },
  },
];
