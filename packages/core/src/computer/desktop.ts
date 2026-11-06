import { execFile } from "node:child_process";
import { resolveDriver, type DriverCommand } from "./driver.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import { SnapshotCache } from "./snapshot.ts";

/**
 * Native desktop control through the accessibility tree, via the `agent-cu` CLI
 * (kortix-ai/agent-computer-use; its maintained successor is the Cua Driver — set
 * CONFLUX_DESKTOP_BIN to point at any CLI with the same verbs). Deterministic refs, no
 * screenshots, zero vision tokens. Service-gated: only offered when the binary is installed and
 * `computer.desktop` is enabled.
 */
let driver: DriverCommand | null | undefined;
export const desktopSnapshots = new SnapshotCache();

/** The resolved driver command (cached), or null when none is installed. */
export function desktopDriver(): DriverCommand | null {
  if (driver === undefined) driver = resolveDriver() ?? null;
  return driver;
}

export function hasDesktopDriver(): boolean {
  return desktopDriver() !== null;
}

function cu(args: string[], signal: AbortSignal, timeout = 30_000): Promise<string> {
  const d = desktopDriver();
  if (!d) return Promise.reject(new Error("desktop driver (agent-cu) is not installed"));
  return new Promise((resolve, reject) => {
    // Never via a shell: typed text is passed as a plain argv entry on every OS.
    execFile(d.file, [...d.prefixArgs, ...args], { timeout, signal, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().slice(0, 2000)));
      else resolve(stdout.toString());
    });
  });
}

const key = (ctx: ToolContext, app?: string) => `${ctx.coworker.id}:${app ?? "_"}`;

async function desktopContext(a: any, ctx: ToolContext): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { app: { name: String(a.app ?? "") } };
  const target = a.ref ?? a.target;
  if (target && /^@?e\d+$/.test(String(target))) {
    const el = desktopSnapshots.element(key(ctx, a.app), String(target));
    if (!el) throw new Error(`unknown ref ${target}; run desktop_snapshot for ${a.app ?? "the app"} first`);
    out.element = el;
  } else if (target) out.element = { ref: "", role: "selector", name: String(target) };
  if (a.submit) out.key = "Enter";
  if (a.combo) out.key = a.combo;
  return out;
}

const available = (rt: any) => rt.config.computer.desktop && hasDesktopDriver();

export const desktopTools: Tool[] = [
  {
    name: "desktop_apps",
    toolset: "computer",
    effect: "read",
    available,
    description: "List running desktop applications.",
    parameters: { type: "object", properties: {} },
    async run(_a, ctx) {
      return cu(["apps"], ctx.signal);
    },
  },
  {
    name: "desktop_snapshot",
    toolset: "computer",
    effect: "read",
    available,
    description: "Snapshot an app's accessibility tree: interactive elements as [@eN] refs. Always snapshot before acting and again to verify.",
    parameters: { type: "object", properties: { app: { type: "string" }, depth: { type: "number" } }, required: ["app"] },
    resolveContext: desktopContext,
    async run(a, ctx) {
      const out = await cu(["snapshot", "-a", a.app, "-i", "-c", ...(a.depth ? ["-d", String(a.depth)] : [])], ctx.signal);
      desktopSnapshots.set(key(ctx, a.app), out);
      return { content: out, ui: "desktop", data: { app: a.app, snapshot: out.slice(0, 4000) } };
    },
  },
  {
    name: "desktop_click",
    toolset: "computer",
    effect: "write",
    available,
    description: "Click an element in a desktop app by ref (@e5) or selector ('button \"Submit\"', 'name~=\"Log\"').",
    parameters: { type: "object", properties: { target: { type: "string" }, app: { type: "string" } }, required: ["target", "app"] },
    resolveContext: desktopContext,
    async run(a, ctx) {
      const t = /^e\d+$/.test(a.target) ? `@${a.target}` : a.target;
      return cu(["click", t, "-a", a.app], ctx.signal);
    },
  },
  {
    name: "desktop_type",
    toolset: "computer",
    effect: "write",
    available,
    description: "Type text into a field (by ref/selector, or the focused field). submit=true presses Enter after.",
    parameters: { type: "object", properties: { text: { type: "string" }, target: { type: "string" }, app: { type: "string" }, submit: { type: "boolean" } }, required: ["text", "app"] },
    resolveContext: desktopContext,
    async run(a, ctx) {
      const args = ["type", a.text, "-a", a.app];
      if (a.target) args.push("-s", /^e\d+$/.test(a.target) ? `@${a.target}` : a.target);
      let out = await cu(args, ctx.signal);
      if (a.submit) out += await cu(["key", "enter", "-a", a.app], ctx.signal);
      return out || "typed";
    },
  },
  {
    name: "desktop_key",
    toolset: "computer",
    effect: "write",
    available,
    description: "Press a key or combo in an app (e.g. cmd+k, enter, escape).",
    parameters: { type: "object", properties: { combo: { type: "string" }, app: { type: "string" } }, required: ["combo", "app"] },
    resolveContext: desktopContext,
    async run(a, ctx) {
      return (await cu(["key", a.combo, "-a", a.app], ctx.signal)) || "ok";
    },
  },
  {
    name: "desktop_text",
    toolset: "computer",
    effect: "read",
    available,
    description: "Read all visible text in an app.",
    parameters: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
    async run(a, ctx) {
      return cu(["text", "-a", a.app], ctx.signal);
    },
  },
  {
    name: "desktop_open",
    toolset: "computer",
    effect: "write",
    available,
    description: "Launch or focus a desktop application by name.",
    parameters: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
    resolveContext: desktopContext,
    async run(a, ctx) {
      return (await cu(["open", a.app], ctx.signal)) || `opened ${a.app}`;
    },
  },
];
