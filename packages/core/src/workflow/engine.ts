import vm from "node:vm";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { newId, noopEmit, type Emit } from "../events.ts";
import { now, type Row } from "../db.ts";
import type { Runtime } from "../runtime.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import { evaluate, validate as validateExpr } from "../governance/expr.ts";
import { providerFor } from "../providers/index.ts";

/**
 * Workflows (Dify): a DAG of typed nodes with variables flowing between them, run with parallel
 * branches, conditional routing and per-node error strategies. Every side-effecting node (tool,
 * http, code, agent) goes through the same policy gateway as a chat turn, so a workflow can never
 * do something its coworker could not.
 *
 * Variables: "{{node.field}}" interpolates; a string that is exactly "{{node.field}}" passes the raw
 * value (objects, lists); { "$expr": "..." } evaluates an expression over the scope.
 */
export type WorkflowInput = { name: string; type?: "string" | "number" | "boolean" | "object" | "array"; required?: boolean; default?: unknown; description?: string };
export type WorkflowNode = { id: string; type: string; title?: string; data?: Record<string, any>; position?: { x: number; y: number } };
export type WorkflowEdge = { source: string; target: string; sourceHandle?: string };
export type WorkflowDef = {
  id: string;
  name: string;
  description?: string;
  coworker?: string;
  inputs: WorkflowInput[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  exposeAsTool?: boolean;
};

export type NodeTrace = { id: string; type: string; title?: string; status: "succeeded" | "failed" | "skipped"; ms: number; inputs?: unknown; outputs?: unknown; error?: string };
export type WorkflowRun = { runId: string; workflowId: string; status: "succeeded" | "failed"; outputs: Record<string, unknown>; trace: NodeTrace[]; error?: string; ms: number };

type Scope = Record<string, any>;
type RunCtx = { rt: Runtime; def: WorkflowDef; tool: ToolContext; emit: Emit; depth: number };
type Executor = (data: any, scope: Scope, c: RunCtx, node: WorkflowNode) => Promise<Record<string, unknown>>;

function getPath(scope: Scope, path: string): unknown {
  let cur: any = scope;
  for (const part of path.trim().split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function resolveVars(value: unknown, scope: Scope): any {
  if (typeof value === "string") {
    const whole = value.match(/^\s*\{\{\s*([\w.-]+)\s*\}\}\s*$/);
    if (whole) return getPath(scope, whole[1]);
    return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, p) => {
      const v = getPath(scope, p);
      return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveVars(v, scope));
  if (value && typeof value === "object") {
    if ("$expr" in (value as any)) return evaluate(String((value as any).$expr), scope);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveVars(v, scope);
    return out;
  }
  return value;
}

async function viaGateway(c: RunCtx, tool: string, args: unknown): Promise<string> {
  // The workflow acts as its coworker: same grants, same policy, same audit trail.
  const r = await c.rt.gateway.execute(tool, args, c.tool);
  if (r.isError) throw new Error(r.content);
  return r.content;
}

const EXECUTORS: Record<string, Executor> = {
  async start(_d, scope) {
    return scope.inputs;
  },
  async llm(d, _s, c) {
    const key = d.model ?? c.tool.coworker.model ?? c.rt.config.defaultModel;
    const profile = c.rt.config.models[key] ?? c.rt.config.models[c.rt.config.defaultModel];
    const r = await providerFor(profile.provider).complete({
      profile,
      system: d.system ?? "You are a precise assistant inside an automated workflow. Answer only with what is asked.",
      messages: [{ role: "user", content: String(d.prompt ?? "") + (d.json ? "\n\nRespond with a single JSON object only." : "") }],
      tools: [],
      signal: c.tool.signal,
    });
    let json: unknown;
    if (d.json) {
      const m = r.text.match(/\{[\s\S]*\}/);
      try {
        json = m ? JSON.parse(m[0]) : undefined;
      } catch {
        json = undefined;
      }
    }
    return { text: r.text, ...(d.json ? { json } : {}), usage: r.usage };
  },
  async agent(d, _s, c) {
    if (c.depth >= 3) throw new Error("agent node nesting too deep");
    const r = await c.rt.runner.run({
      coworkerId: d.coworker ?? c.tool.coworker.id,
      input: String(d.prompt ?? ""),
      initiator: "workflow",
      ephemeral: true,
      depth: c.depth + 1,
      signal: c.tool.signal,
      grants: d.tools,
      onWaiting: c.tool.onWaiting,
      trustThreadId: c.tool.trustThreadId ?? c.tool.threadId,
      emit: (e) => {
        if (e.type === "CUSTOM" && e.name.startsWith("approval_")) c.emit(e);
      },
    });
    if (r.error) throw new Error(r.error);
    return { text: r.text, toolCalls: r.toolCalls };
  },
  async tool(d, _s, c) {
    const text = await viaGateway(c, d.tool, d.args ?? {});
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      /* text result */
    }
    return { text, ...(json !== undefined ? { json } : {}) };
  },
  async http(d, _s, c) {
    const text = await viaGateway(c, "http_request", { method: d.method ?? "GET", url: d.url, headers: d.headers, body: d.body, timeout_ms: d.timeoutMs });
    return JSON.parse(text);
  },
  async code(d, _s, c) {
    const text = await viaGateway(c, "code_run", { code: d.code, inputs: d.inputs ?? {} });
    return JSON.parse(text);
  },
  async template(d) {
    return { text: String(d.template ?? "") };
  },
  async if_else(_d, scope, _c, node) {
    // Conditions are evaluated against the scope, NOT pre-interpolated, so they stay typed.
    for (const cs of (node.data?.cases ?? []) as { id: string; when: string }[]) {
      if (evaluate(cs.when, scope) === true) return { _handle: cs.id, matched: cs.id };
    }
    return { _handle: "else", matched: "else" };
  },
  async knowledge(d, _s, c) {
    const rows = c.rt.knowledge.search(String(d.query ?? ""), { dataset: d.dataset, topK: Number(d.topK ?? 4) });
    return {
      results: rows.map((r) => ({ title: r.title, content: r.content, source: r.source, dataset: r.dataset })),
      text: rows.map((r, i) => `[${i + 1}] ${r.title}: ${r.content}`).join("\n\n"),
    };
  },
  async iteration(d, _s, c) {
    const items = Array.isArray(d.items) ? d.items : [];
    const limit = Math.max(1, Math.min(Number(d.parallel ?? 1), 8));
    const results: unknown[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        const r = await c.rt.workflows.run(d.workflow, { ...(d.inputs ?? {}), [d.itemName ?? "item"]: items[i], index: i }, { parent: c.tool, depth: c.depth + 1 });
        if (r.status !== "succeeded") throw new Error(`iteration ${i}: ${r.error}`);
        results[i] = r.outputs;
      }
    };
    await Promise.all(Array.from({ length: limit }, worker));
    return { results, count: items.length };
  },
  async aggregator(d) {
    const v = (d.variables ?? []).find((x: unknown) => x !== undefined && x !== null && x !== "");
    return { value: v ?? null };
  },
  async end(d) {
    return d.outputs ?? {};
  },
};

export const NODE_TYPES = Object.keys(EXECUTORS);

export class WorkflowEngine {
  private rt: Runtime;
  constructor(rt: Runtime) {
    this.rt = rt;
  }

  seed(dir: string): void {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const def = JSON.parse(readFileSync(join(dir, f), "utf8")) as WorkflowDef;
      if (!this.get(def.id)) this.save(def);
    }
  }

  list(): WorkflowDef[] {
    return this.rt.db.all("SELECT definition FROM workflows ORDER BY name").map((r) => JSON.parse(r.definition));
  }

  get(id: string): WorkflowDef | undefined {
    const r = this.rt.db.get("SELECT definition FROM workflows WHERE id=?", id);
    return r ? JSON.parse(r.definition) : undefined;
  }

  validate(def: WorkflowDef): string[] {
    const errs: string[] = [];
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(def.id ?? "")) errs.push("id must be kebab-case");
    const ids = new Set(def.nodes.map((n) => n.id));
    if (ids.size !== def.nodes.length) errs.push("node ids must be unique");
    for (const n of def.nodes) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n.id)) errs.push(`node id "${n.id}" must be an identifier (letters, digits, _)`);
    if (def.nodes.filter((n) => n.type === "start").length !== 1) errs.push("exactly one start node is required");
    for (const n of def.nodes) if (!EXECUTORS[n.type]) errs.push(`node ${n.id}: unknown type "${n.type}"`);
    for (const e of def.edges) if (!ids.has(e.source) || !ids.has(e.target)) errs.push(`edge ${e.source}→${e.target} references a missing node`);
    const byId = new Map(def.nodes.map((n) => [n.id, n]));
    for (const e of def.edges) {
      const src = byId.get(e.source);
      if (src?.type === "if_else") {
        const handles = [...((src.data?.cases ?? []) as { id: string }[]).map((c) => c.id), "else", "error"];
        if (!e.sourceHandle) errs.push(`connection from "${src.title ?? src.id}" to "${byId.get(e.target)?.title ?? e.target}" must say which case it belongs to`);
        else if (!handles.includes(e.sourceHandle)) errs.push(`"${src.title ?? src.id}" has no case named "${e.sourceHandle}"`);
      }
    }
    for (const n of def.nodes) {
      if (n.type !== "if_else") continue;
      const cases = (n.data?.cases ?? []) as { id: string; when: string }[];
      if (!cases.length) errs.push(`"${n.title ?? n.id}" needs at least one case`);
      for (const c of cases) {
        if (!c.when?.trim()) errs.push(`"${n.title ?? n.id}" case "${c.id}" has no condition`);
        else {
          const bad = validateExpr(c.when);
          if (bad) errs.push(`"${n.title ?? n.id}" case "${c.id}": ${bad}`);
        }
      }
    }
    const reach = new Set<string>();
    const start = def.nodes.find((n) => n.type === "start");
    const walk = (id: string) => { if (reach.has(id)) return; reach.add(id); for (const e of def.edges) if (e.source === id) walk(e.target); };
    if (start) walk(start.id);
    for (const n of def.nodes) if (!reach.has(n.id)) errs.push(`"${n.title ?? n.id}" isn't connected to the start, so it would never run`);
    // Cycle check (Kahn).
    const indeg = new Map([...ids].map((i) => [i, 0]));
    for (const e of def.edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    const q = [...indeg].filter(([, d]) => d === 0).map(([i]) => i);
    let seen = 0;
    while (q.length) {
      const n = q.shift()!;
      seen++;
      for (const e of def.edges.filter((e) => e.source === n)) {
        indeg.set(e.target, indeg.get(e.target)! - 1);
        if (indeg.get(e.target) === 0) q.push(e.target);
      }
    }
    if (seen !== ids.size) errs.push("workflow graph has a cycle (use an iteration node for loops)");
    return errs;
  }

  save(def: WorkflowDef): WorkflowDef {
    const errs = this.validate(def);
    if (errs.length) throw new Error(errs.join("; "));
    this.rt.db.run(
      "INSERT INTO workflows (id, name, definition, updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, definition=excluded.definition, updated_at=excluded.updated_at",
      def.id, def.name, def, now(),
    );
    this.registerTools();
    return def;
  }

  delete(id: string): void {
    this.rt.db.run("DELETE FROM workflows WHERE id=?", id);
    this.registerTools();
  }

  runs(workflowId?: string, limit = 50): Row[] {
    return workflowId
      ? this.rt.db.all("SELECT * FROM workflow_runs WHERE workflow_id=? ORDER BY created_at DESC LIMIT ?", workflowId, limit)
      : this.rt.db.all("SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?", limit);
  }

  /** Workflows marked exposeAsTool become first-class tools named wf_<id>. */
  registerTools(): void {
    this.rt.tools.unregister((t) => t.toolset === "workflows" && t.name.startsWith("wf_"));
    for (const def of this.list().filter((d) => d.exposeAsTool)) {
      const props: Record<string, any> = {};
      for (const i of def.inputs) props[i.name] = { type: i.type ?? "string", description: i.description ?? "" };
      const tool: Tool = {
        name: `wf_${def.id.replace(/-/g, "_")}`,
        toolset: "workflows",
        effect: "read",
        description: `Workflow: ${def.name}. ${def.description ?? ""}`.trim(),
        parameters: { type: "object", properties: props, required: def.inputs.filter((i) => i.required).map((i) => i.name) },
        resolveContext: () => ({ workflow: { id: def.id } }),
        run: async (args, ctx) => {
          const r = await this.run(def.id, args, { parent: ctx });
          if (r.status !== "succeeded") return { content: `Workflow failed: ${r.error}`, isError: true, ui: "workflow", data: r };
          return { content: JSON.stringify(r.outputs, null, 2), ui: "workflow", data: r };
        },
      };
      this.rt.tools.register(tool);
    }
  }

  async run(id: string, rawInputs: Record<string, unknown>, opts: { parent?: ToolContext; emit?: Emit; coworkerId?: string; depth?: number } = {}): Promise<WorkflowRun> {
    const def = this.get(id);
    if (!def) throw new Error(`no workflow "${id}". Available: ${this.list().map((w) => w.id).join(", ")}`);
    const runId = newId("wfr_");
    const started = now();
    const emit = opts.emit ?? opts.parent?.emit ?? noopEmit;
    const coworker = this.rt.coworkers.get(opts.coworkerId ?? def.coworker ?? opts.parent?.coworker.id ?? "assistant") ?? this.rt.coworkers.list()[0];
    const tool: ToolContext = {
      runId: opts.parent?.runId ?? runId,
      threadId: opts.parent?.threadId ?? `workflow:${runId}`,
      coworker,
      initiator: "workflow",
      emit,
      signal: opts.parent?.signal ?? new AbortController().signal,
      rt: this.rt,
      depth: opts.depth ?? opts.parent?.depth ?? 0,
      onWaiting: opts.parent?.onWaiting,
      trustThreadId: opts.parent?.trustThreadId ?? opts.parent?.threadId,
    };
    const c: RunCtx = { rt: this.rt, def, tool, emit, depth: tool.depth };

    const inputs: Record<string, unknown> = {};
    const trace: NodeTrace[] = [];
    this.rt.db.run("INSERT INTO workflow_runs (id, workflow_id, status, inputs, created_at) VALUES (?,?, 'running', ?, ?)", runId, id, rawInputs, started);
    const finish = (status: "succeeded" | "failed", outputs: Record<string, unknown>, error?: string): WorkflowRun => {
      this.rt.db.run("UPDATE workflow_runs SET status=?, outputs=?, trace=?, error=?, finished_at=? WHERE id=?", status, outputs, trace, error, now(), runId);
      this.rt.bus.publish("workflows", { type: "workflow_run", runId, workflowId: id, status });
      return { runId, workflowId: id, status, outputs, trace, error, ms: now() - started };
    };

    try {
      for (const i of def.inputs) {
        let v = rawInputs[i.name] ?? i.default;
        if (v === undefined && i.required) throw new Error(`missing required input "${i.name}"`);
        if (i.type === "number" && typeof v === "string") v = Number(v);
        if (i.type === "boolean" && typeof v === "string") v = v === "true";
        if ((i.type === "object" || i.type === "array") && typeof v === "string") v = JSON.parse(v);
        inputs[i.name] = v;
      }
      const scope: Scope = { inputs };
      const state = new Map<string, "done" | "skipped" | "failed">();
      const handles = new Map<string, string>();
      const incoming = (n: string) => def.edges.filter((e) => e.target === n);
      const edgeActive = (e: WorkflowEdge) => {
        if (state.get(e.source) !== "done") return false;
        const h = handles.get(e.source);
        if (h === undefined) return !e.sourceHandle || e.sourceHandle === "success";
        return e.sourceHandle === h;
      };
      let lastOutputs: Record<string, unknown> = {};
      let endOutputs: Record<string, unknown> | undefined;

      for (let guard = 0; guard < def.nodes.length + 1; guard++) {
        const ready = def.nodes.filter((n) => !state.has(n.id) && incoming(n.id).every((e) => state.has(e.source)));
        if (!ready.length) break;
        await Promise.all(
          ready.map(async (node) => {
            const inc = incoming(node.id);
            if (node.type !== "start" && inc.length && !inc.some(edgeActive)) {
              state.set(node.id, "skipped");
              trace.push({ id: node.id, type: node.type, title: node.title, status: "skipped", ms: 0 });
              return;
            }
            const t0 = now();
            const step = `${node.title ?? node.id}`;
            emit({ type: "STEP_STARTED", stepName: step });
            let data: any;
            try {
              data = node.type === "if_else" ? node.data : resolveVars(node.data ?? {}, scope);
              const out = await withRetry(() => EXECUTORS[node.type](data, scope, c, node), Number(node.data?.retries ?? 0));
              if (typeof out._handle === "string") handles.set(node.id, out._handle);
              scope[node.id] = out;
              state.set(node.id, "done");
              lastOutputs = out;
              if (node.type === "end") endOutputs = out;
              trace.push({ id: node.id, type: node.type, title: node.title, status: "succeeded", ms: now() - t0, inputs: redactTrace(data), outputs: truncate(out) });
            } catch (e) {
              const msg = (e as Error).message;
              const strategy = node.data?.onError ?? "fail";
              trace.push({ id: node.id, type: node.type, title: node.title, status: "failed", ms: now() - t0, inputs: redactTrace(data), error: msg });
              if (strategy === "continue") {
                scope[node.id] = { error: msg, ...(node.data?.defaultOutputs ?? {}) };
                state.set(node.id, "done");
              } else if (strategy === "branch") {
                scope[node.id] = { error: msg };
                handles.set(node.id, "error");
                state.set(node.id, "done");
              } else {
                state.set(node.id, "failed");
                throw new Error(`node "${node.title ?? node.id}" failed: ${msg}`);
              }
            } finally {
              emit({ type: "STEP_FINISHED", stepName: step });
            }
          }),
        );
      }
      return finish("succeeded", endOutputs ?? lastOutputs);
    } catch (e) {
      return finish("failed", {}, (e as Error).message);
    }
  }
}

async function withRetry<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= retries) throw e;
      await new Promise((r) => setTimeout(r, 300 * 2 ** i));
    }
  }
}

function truncate(v: unknown): unknown {
  const s = JSON.stringify(v ?? null);
  return s.length > 4000 ? JSON.parse(JSON.stringify({ _truncated: s.slice(0, 4000) })) : v;
}

function redactTrace(v: unknown): unknown {
  return truncate(JSON.parse(JSON.stringify(v ?? null, (k, val) => (/key|token|secret|password|authorization/i.test(k) ? "[redacted]" : val))));
}

/** Governed primitives used by workflow http/code nodes (and available to coworkers). */
export const httpRequestTool: Tool = {
  name: "http_request",
  toolset: "web",
  effect: (a) => (String(a?.method ?? "GET").toUpperCase() === "GET" ? "read" : "external"),
  description: "Make an HTTP request (any method) and return status, headers and body. Non-GET requests count as external actions.",
  parameters: {
    type: "object",
    properties: { method: { type: "string" }, url: { type: "string" }, headers: { type: "object" }, body: {}, timeout_ms: { type: "number" } },
    required: ["url"],
  },
  resolveContext: (a) => {
    const u = new URL(String(a.url));
    return { page: { url: u.toString(), host: u.hostname }, http: { method: String(a.method ?? "GET").toUpperCase() } };
  },
  async run(a, ctx) {
    const method = String(a.method ?? "GET").toUpperCase();
    const body = a.body === undefined || a.body === null ? undefined : typeof a.body === "string" ? a.body : JSON.stringify(a.body);
    const res = await fetch(a.url, {
      method,
      headers: { ...(typeof a.body === "object" && a.body ? { "content-type": "application/json" } : {}), ...(a.headers ?? {}) },
      body: method === "GET" || method === "HEAD" ? undefined : body,
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(Number(a.timeout_ms ?? 30_000))]),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return JSON.stringify({ status: res.status, ok: res.ok, headers, body: text.slice(0, 50_000), json });
  },
};

export const codeRunTool: Tool = {
  name: "code_run",
  toolset: "workflows",
  effect: "execute",
  description:
    "Run a short JavaScript snippet (function body receiving `inputs`, must `return` a JSON-serialisable object) in an isolated VM context with a 2 s timeout. No network or filesystem.",
  parameters: { type: "object", properties: { code: { type: "string" }, inputs: { type: "object" } }, required: ["code"] },
  async run(a) {
    // node:vm is isolation from Conflux's globals, not a hostile-code sandbox; govern with policy.
    const sandbox = { inputs: JSON.parse(JSON.stringify(a.inputs ?? {})), result: undefined as unknown, JSON, Math, Date };
    vm.runInNewContext(`result = (function(inputs){ ${a.code}\n })(inputs);`, sandbox, { timeout: 2000, microtaskMode: "afterEvaluate" });
    const out = sandbox.result;
    return JSON.stringify(out && typeof out === "object" ? out : { result: out });
  },
};
