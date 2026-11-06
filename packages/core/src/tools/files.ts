import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { Tool, ToolContext } from "./types.ts";

/** Each coworker has its own workspace directory; paths can never escape it. */
export function workspacePath(ctx: ToolContext, p = "."): string {
  const root = resolve(ctx.rt.workspaceDir(ctx.coworker.id));
  const full = resolve(root, p);
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`path "${p}" is outside the workspace`);
  return full;
}

const fileContext = (a: any, ctx: ToolContext) => {
  const full = workspacePath(ctx, a.path ?? ".");
  return { file: { path: relative(resolve(ctx.rt.workspaceDir(ctx.coworker.id)), full) || ".", exists: existsSync(full) } };
};

export const fsReadTool: Tool = {
  name: "fs_read",
  toolset: "files",
  effect: "read",
  description: "Read a text file from your workspace.",
  parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] },
  resolveContext: fileContext,
  async run(a, ctx) {
    const text = readFileSync(workspacePath(ctx, a.path), "utf8");
    const lines = text.split("\n");
    const start = Math.max(0, Number(a.offset ?? 0));
    const slice = lines.slice(start, start + Number(a.limit ?? 2000));
    return slice.map((l, i) => `${String(start + i + 1).padStart(5)}  ${l}`).join("\n");
  },
};

export const fsWriteTool: Tool = {
  name: "fs_write",
  toolset: "files",
  // Overwriting existing content is destructive; creating a new file is a write.
  effect: "write",
  description: "Write a text file in your workspace (creates folders as needed). Overwrites if it exists.",
  parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  resolveContext: fileContext,
  async run(a, ctx) {
    const full = workspacePath(ctx, a.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, a.content ?? "");
    return { content: `Wrote ${a.path} (${(a.content ?? "").length} chars).`, ui: "file", data: { path: a.path, preview: String(a.content ?? "").slice(0, 2000) } };
  },
};

export const fsListTool: Tool = {
  name: "fs_list",
  toolset: "files",
  effect: "read",
  description: "List files in your workspace (recursive, up to 300 entries).",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  async run(a, ctx) {
    const root = workspacePath(ctx, a.path ?? ".");
    if (!existsSync(root)) return "(empty)";
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        if (out.length >= 300) return;
        const p = join(d, e);
        const st = statSync(p);
        out.push(`${relative(root, p)}${st.isDirectory() ? "/" : `  (${st.size} B)`}`);
        if (st.isDirectory() && !e.startsWith(".") && e !== "node_modules") walk(p);
      }
    };
    walk(root);
    return out.join("\n") || "(empty)";
  },
};

export const fsDeleteTool: Tool = {
  name: "fs_delete",
  toolset: "files",
  effect: "destructive",
  description: "Delete a file or folder in your workspace.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  resolveContext: fileContext,
  async run(a, ctx) {
    const full = workspacePath(ctx, a.path);
    if (full === resolve(ctx.rt.workspaceDir(ctx.coworker.id))) throw new Error("refusing to delete the workspace root");
    if (!existsSync(full)) return `${a.path} does not exist.`;
    rmSync(full, { recursive: true, force: true });
    return `Deleted ${a.path}.`;
  },
};

export const terminalTool: Tool = {
  name: "terminal",
  toolset: "computer",
  effect: "execute",
  description:
    `Run a shell command in your workspace directory (${process.platform === "win32" ? "PowerShell" : "bash"}, 120s timeout by default). Output is truncated. Prefer non-interactive flags.`,
  parameters: {
    type: "object",
    properties: { command: { type: "string" }, timeout_s: { type: "number" }, cwd: { type: "string", description: "Subdirectory of the workspace." } },
    required: ["command"],
  },
  resolveContext: (a) => ({ command: { text: String(a.command), program: String(a.command).trim().split(/\s+/)[0] } }),
  async run(a, ctx) {
    const cwd = workspacePath(ctx, a.cwd ?? ".");
    mkdirSync(cwd, { recursive: true });
    const timeout = Math.min(Number(a.timeout_s ?? 120), 900) * 1000;
    const started = Date.now();
    const { code, out } = await new Promise<{ code: number | null; out: string }>((res) => {
      // bash on Linux/macOS; PowerShell on Windows (no bash by default there).
      const [shell, shellArgs] = process.platform === "win32" ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", a.command]] : ["bash", ["-lc", a.command]];
      const child = spawn(shell, shellArgs as string[], { cwd, env: { ...process.env, CONFLUX_WORKSPACE: cwd }, signal: ctx.signal, windowsHide: true });
      let out = "";
      const add = (b: Buffer) => {
        if (out.length < 200_000) out += b.toString();
      };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      const t = setTimeout(() => child.kill("SIGKILL"), timeout);
      child.on("close", (code) => {
        clearTimeout(t);
        res({ code, out });
      });
      child.on("error", (e) => {
        clearTimeout(t);
        res({ code: -1, out: out + String(e.message) });
      });
    });
    const body = out.length > 16_000 ? out.slice(0, 6000) + "\n…\n" + out.slice(-9000) : out;
    return {
      content: `exit ${code} (${Date.now() - started} ms)\n${body}`,
      ui: "terminal",
      data: { command: a.command, exitCode: code, output: body.slice(-6000) },
      isError: code !== 0,
    };
  },
};

export const fileTools = [fsReadTool, fsWriteTool, fsListTool, fsDeleteTool, terminalTool];
