import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServerConfig } from "../config.ts";
import type { Runtime } from "../runtime.ts";
import type { Effect, Tool } from "../tools/types.ts";

/**
 * Model Context Protocol client (stdio transport). Every MCP server's tools become Conflux tools
 * named mcp__<server>__<tool>, in toolset "mcp:<server>", so they are granted per coworker and
 * governed by the same policy (MCP tool annotations map onto effects: readOnlyHint → read,
 * destructiveHint → destructive, otherwise external).
 */
class McpConnection {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buf = "";
  readonly name: string;
  private cfg: McpServerConfig;

  constructor(name: string, cfg: McpServerConfig) {
    this.name = name;
    this.cfg = cfg;
  }

  async connect(): Promise<void> {
    this.proc = spawn(this.cfg.command, this.cfg.args ?? [], { env: { ...process.env, ...(this.cfg.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (d: Buffer) => this.onData(d.toString()));
    this.proc.stderr.on("data", () => {});
    this.proc.on("exit", () => {
      for (const p of this.pending.values()) p.reject(new Error(`MCP server ${this.name} exited`));
      this.pending.clear();
    });
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "conflux", version: "0.1.0" } }, 20_000);
    this.notify("notifications/initialized", {});
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
          else p.resolve(msg.result);
        }
      } catch {
        /* ignore non-JSON lines */
      }
    }
  }

  private notify(method: string, params: unknown): void {
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  request(method: string, params: unknown, timeout = 120_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name}.${method} timed out`));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  close(): void {
    this.proc?.kill();
  }
}

export class McpManager {
  private rt: Runtime;
  private conns = new Map<string, McpConnection>();
  readonly status: Record<string, { connected: boolean; tools: number; error?: string }> = {};

  constructor(rt: Runtime) {
    this.rt = rt;
  }

  async start(): Promise<void> {
    await Promise.all(
      Object.entries(this.rt.config.mcpServers)
        .filter(([, c]) => !c.disabled)
        .map(([name, cfg]) => this.connect(name, cfg)),
    );
  }

  async connect(name: string, cfg: McpServerConfig): Promise<void> {
    const conn = new McpConnection(name, cfg);
    try {
      await conn.connect();
      const { tools = [] } = await conn.request("tools/list", {});
      this.conns.set(name, conn);
      for (const t of tools) this.rt.tools.register(this.wrap(name, conn, t));
      this.status[name] = { connected: true, tools: tools.length };
    } catch (e) {
      conn.close();
      this.status[name] = { connected: false, tools: 0, error: (e as Error).message };
      this.rt.log(`MCP server ${name} failed:`, (e as Error).message);
    }
  }

  private wrap(server: string, conn: McpConnection, t: any): Tool {
    const ann = t.annotations ?? {};
    const effect: Effect = ann.readOnlyHint ? "read" : ann.destructiveHint ? "destructive" : "external";
    return {
      name: `mcp__${server}__${t.name}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64),
      toolset: `mcp:${server}`,
      effect,
      description: (t.description ?? `${t.name} (MCP ${server})`).slice(0, 1024),
      parameters: { type: "object", properties: t.inputSchema?.properties ?? {}, required: t.inputSchema?.required ?? [] },
      resolveContext: () => ({ mcp: { server, tool: t.name } }),
      async run(args) {
        const r = await conn.request("tools/call", { name: t.name, arguments: args });
        const text = (r.content ?? [])
          .map((c: any) => (c.type === "text" ? c.text : c.type === "resource" ? JSON.stringify(c.resource) : `[${c.type}]`))
          .join("\n");
        return { content: text || JSON.stringify(r.structuredContent ?? r), isError: !!r.isError };
      },
    };
  }

  stop(): void {
    for (const c of this.conns.values()) c.close();
  }
}
