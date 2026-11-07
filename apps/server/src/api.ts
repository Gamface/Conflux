import { newId, planFor, rowToMessage, StaleRevisionError, hasPlaywright, hasDesktopDriver, NODE_TYPES, runReview, type Runtime, type Coworker, type WorkflowDef } from "../../../packages/core/src/index.ts";
import { now } from "../../../packages/core/src/db.ts";
import { saveOverride, saveSecret, removeModelOverride, type ModelProfile } from "../../../packages/core/src/config.ts";
import { providerFor } from "../../../packages/core/src/providers/index.ts";
import { HttpError, Router, json, sse } from "./http.ts";

/** REST + AG-UI surface. Every write the UI makes is also something an agent or script can do. */
export function buildApi(rt: Runtime): Router {
  const r = new Router();

  r.get("/api/health", () => ({
    ok: true,
    version: "0.1.0",
    model: rt.config.defaultModel,
    provider: rt.config.models[rt.config.defaultModel]?.provider,
    capabilities: { browser: hasPlaywright(), desktop: rt.config.computer.desktop && hasDesktopDriver(), mcp: rt.mcp.status },
  }));

  // ── Coworkers ────────────────────────────────────────────────────────────
  r.get("/api/coworkers", () =>
    rt.coworkers.list().map((c) => ({
      ...c,
      toolCount: rt.tools.forCoworker(c, rt).length,
      model: c.agui ? "AG-UI" : c.model ?? rt.config.defaultModel,
    })),
  );
  r.get("/api/coworkers/:id/tools", (req) => {
    const c = must(rt.coworkers.get(req.params.id), "coworker");
    return rt.tools.forCoworker(c, rt).map((t) => ({ name: t.name, toolset: t.toolset, description: t.description, effect: typeof t.effect === "string" ? t.effect : "dynamic" }));
  });
  r.put("/api/coworkers/:id", (req) => rt.coworkers.upsert({ ...(req.body as Coworker), id: req.params.id }));
  // ── Models: connect an LLM from the UI ───────────────────────────────────
  r.get("/api/models", () =>
    Object.entries(rt.config.models).map(([key, m]) => ({
      key, provider: m.provider, model: m.model, baseUrl: m.baseUrl, apiKeyEnv: m.apiKeyEnv,
      hasKey: m.provider === "mock" || !m.apiKeyEnv || !!process.env[m.apiKeyEnv],
      default: key === rt.config.defaultModel,
    })),
  );
  r.get("/api/models/discover", async (req) => {
    // List models from an OpenAI-compatible server (Ollama, LM Studio, vLLM, OpenRouter…).
    const base = String(req.query.get("baseUrl") ?? "").replace(/\/$/, "");
    if (!/^https?:\/\//.test(base)) throw new HttpError(400, "baseUrl must start with http:// or https://");
    const key = req.query.get("apiKey") ?? "";
    try {
      const res = await fetch(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, models: [] };
      const j: any = await res.json();
      const models = (j.data ?? j.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean).sort();
      return { ok: true, models };
    } catch (e) {
      return { ok: false, error: (e as Error).message, models: [] };
    }
  });
  const testProfile = async (profile: ModelProfile) => {
    const started = Date.now();
    try {
      const r = await providerFor(profile.provider).complete({
        profile: { ...profile, maxTokens: Math.min(profile.maxTokens ?? 64, 64) },
        system: "You are a connection test.",
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        tools: [],
        signal: AbortSignal.timeout(45_000),
      });
      return { ok: true, reply: r.text.slice(0, 200), ms: Date.now() - started, usage: r.usage };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 600), ms: Date.now() - started };
    }
  };
  r.post("/api/models/test", async (req) => {
    const b = req.body ?? {};
    if (b.key && !b.provider) {
      const p = rt.config.models[b.key];
      if (!p) throw new HttpError(404, "model profile not found");
      return testProfile(p);
    }
    // Unsaved profile: use the typed key just for this call.
    const tmpEnv = `CONFLUX_TEST_KEY_${Date.now()}`;
    if (b.apiKey) process.env[tmpEnv] = String(b.apiKey);
    try {
      return await testProfile({ provider: b.provider, model: b.model, baseUrl: b.baseUrl || undefined, apiKeyEnv: b.apiKey ? tmpEnv : b.apiKeyEnv });
    } finally {
      delete process.env[tmpEnv];
    }
  });
  r.post("/api/models", (req) => {
    const b = req.body ?? {};
    const key = String(b.key ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(key)) throw new HttpError(400, "name must be lowercase letters, digits and dashes");
    if (!["openai", "anthropic"].includes(b.provider)) throw new HttpError(400, "provider must be openai (OpenAI-compatible) or anthropic");
    if (!b.model) throw new HttpError(400, "model is required");
    const existing = rt.config.models[key];
    let apiKeyEnv = existing?.apiKeyEnv;
    if (b.apiKey) {
      apiKeyEnv = `CONFLUX_${key.toUpperCase().replace(/-/g, "_")}_API_KEY`;
      saveSecret(rt.config.dataDir, apiKeyEnv, String(b.apiKey));
    }
    const profile: ModelProfile = { provider: b.provider, model: String(b.model), ...(b.baseUrl ? { baseUrl: String(b.baseUrl).replace(/\/$/, "") } : {}), ...(apiKeyEnv ? { apiKeyEnv } : {}), ...(b.provider === "anthropic" ? { maxTokens: 8192 } : {}) };
    rt.config.models[key] = profile;
    const patch: any = { models: { [key]: profile } };
    if (b.makeDefault) {
      rt.config.defaultModel = key;
      patch.defaultModel = key;
    }
    saveOverride(rt.config, patch);
    return { key, ...profile, default: rt.config.defaultModel === key };
  });
  r.put("/api/models/default", (req) => {
    const key = String(req.body?.key ?? "");
    if (!rt.config.models[key]) throw new HttpError(404, "model profile not found");
    rt.config.defaultModel = key;
    saveOverride(rt.config, { defaultModel: key });
    return { ok: true, default: key };
  });
  r.delete("/api/models/:key", (req) => {
    const key = req.params.key;
    if (key === "mock") throw new HttpError(400, "the offline model cannot be removed");
    const p = rt.config.models[key];
    if (!p) throw new HttpError(404, "model profile not found");
    if (p.apiKeyEnv?.startsWith("CONFLUX_")) saveSecret(rt.config.dataDir, p.apiKeyEnv, null);
    delete rt.config.models[key];
    removeModelOverride(rt.config, key);
    if (rt.config.defaultModel === key) rt.config.defaultModel = "mock";
    return { ok: true };
  });
  r.get("/api/tools", () => rt.tools.all().map((t) => ({ name: t.name, toolset: t.toolset, effect: typeof t.effect === "string" ? t.effect : "dynamic", available: t.available ? t.available(rt) : true })));

  // ── Threads & runs (AG-UI) ───────────────────────────────────────────────
  r.get("/api/threads", (req) => {
    const cw = req.query.get("coworker");
    return cw
      ? rt.db.all("SELECT id, coworker_id, title, updated_at FROM threads WHERE coworker_id=? AND archived=0 ORDER BY updated_at DESC LIMIT 100", cw)
      : rt.db.all("SELECT id, coworker_id, title, updated_at FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 200");
  });
  r.get("/api/threads/:id", (req) => {
    const t = must(rt.db.get("SELECT * FROM threads WHERE id=?", req.params.id), "thread");
    const messages = rt.db.all("SELECT * FROM messages WHERE thread_id=? ORDER BY created_at, rowid", t.id).map((m) => ({ id: m.id, runId: m.run_id, compacted: !!m.compacted, ...rowToMessage(m), ...(m.ui ? { ui: JSON.parse(m.ui) } : {}) }));
    const approvals = rt.db.all("SELECT * FROM approvals WHERE thread_id=? AND status='pending'", t.id);
    return { thread: { ...t, system_snapshot: undefined }, messages, plan: planFor(t.id), approvals };
  });
  r.put("/api/threads/:id", (req) => {
    rt.db.run("UPDATE threads SET title=COALESCE(?, title), archived=COALESCE(?, archived) WHERE id=?", req.body.title, req.body.archived, req.params.id);
    return { ok: true };
  });
  r.delete("/api/threads/:id", (req) => {
    rt.db.run("DELETE FROM messages_fts WHERE thread_id=?", req.params.id);
    rt.db.run("DELETE FROM threads WHERE id=?", req.params.id);
    return { ok: true };
  });

  const streamRun = async (req: any, res: any, coworkerId: string, input: string, threadId?: string, runId?: string) => {
    if (!input?.trim()) throw new HttpError(400, "input is required");
    must(rt.coworkers.get(coworkerId), "coworker");
    const stream = sse(res);
    const id = runId ?? newId("run_");
    req.on("close", () => {
      /* client went away: let the run finish (it is persisted) unless explicitly cancelled */
    });
    await rt.runner.run({ coworkerId, input, threadId, runId: id, initiator: "user", emit: (e) => stream.send(e) });
    stream.close();
  };

  // Native endpoint used by the bundled UI.
  r.post("/api/coworkers/:id/runs", (req, res) => streamRun(req, res, req.params.id, req.body.input, req.body.threadId));
  // Standard AG-UI endpoint: any AG-UI client (e.g. CopilotKit HttpAgent) can talk to any coworker.
  r.post("/agui/:id", (req, res) => {
    const msgs: any[] = req.body.messages ?? [];
    const last = [...msgs].reverse().find((m) => m.role === "user");
    const content = typeof last?.content === "string" ? last.content : Array.isArray(last?.content) ? last.content.map((p: any) => p.text ?? "").join("") : "";
    return streamRun(req, res, req.params.id, content, req.body.threadId, req.body.runId);
  });
  r.post("/api/runs/:id/cancel", (req) => ({ ok: rt.runner.cancel(req.params.id) }));

  // ── Live event bus (activity feed, approvals, background thread updates) ─
  r.get("/api/events", (req, res) => {
    const stream = sse(res);
    const unsub = rt.bus.subscribe(({ channel, event }) => stream.send({ channel, event }));
    req.on("close", unsub);
  });

  // ── Approvals & questions (human in the loop) ────────────────────────────
  r.get("/api/approvals", (req) =>
    req.query.get("status") === "all" ? rt.db.all("SELECT * FROM approvals ORDER BY ts DESC LIMIT 200") : rt.approvals.pending(),
  );
  r.post("/api/approvals/:id", (req) => {
    const ok = rt.approvals.resolve(req.params.id, !!req.body.approved, req.body.response);
    if (!ok) throw new HttpError(409, "approval is no longer pending");
    return { ok };
  });

  // ── Governance ───────────────────────────────────────────────────────────
  r.get("/api/policy", () => rt.policy);
  r.put("/api/policy", (req) => {
    rt.setPolicy(req.body);
    return rt.policy;
  });
  r.post("/api/policy/test", (req) => rt.gateway.dryRun(rt, req.body.coworker ?? "assistant", req.body.tool, req.body.args ?? {}, req.body.context ?? {}));
  r.get("/api/audit", (req) => {
    const limit = Math.min(Number(req.query.get("limit") ?? 200), 1000);
    const cw = req.query.get("coworker");
    return cw ? rt.db.all("SELECT * FROM audit WHERE coworker_id=? ORDER BY ts DESC LIMIT ?", cw, limit) : rt.db.all("SELECT * FROM audit ORDER BY ts DESC LIMIT ?", limit);
  });

  // ── Learning: memory & skills ────────────────────────────────────────────
  r.get("/api/memory/:coworker", (req) => ({
    user: rt.memory.entries("user", req.params.coworker),
    memory: rt.memory.entries("memory", req.params.coworker),
    usage: { user: rt.memory.usage("user", req.params.coworker), memory: rt.memory.usage("memory", req.params.coworker) },
  }));
  r.put("/api/memory/:coworker", (req) => {
    if (req.body.user) rt.memory.setAll("user", req.params.coworker, req.body.user);
    if (req.body.memory) rt.memory.setAll("memory", req.params.coworker, req.body.memory);
    return { ok: true };
  });
  r.get("/api/skills", () => rt.skills.list());
  r.get("/api/skills/:name", (req) => ({ ...must(rt.skills.get(req.params.name), "skill"), ...rt.skills.view(req.params.name) }));
  r.post("/api/skills", (req) => rt.skills.create(req.body.content, "user"));
  r.delete("/api/skills/:name", (req) => {
    rt.skills.delete(req.params.name);
    return { ok: true };
  });
  r.post("/api/threads/:id/review", async (req) => {
    const t = must(rt.db.get("SELECT * FROM threads WHERE id=?", req.params.id), "thread");
    return { saved: await runReview(rt, must(rt.coworkers.get(t.coworker_id), "coworker"), t.id, ["memory", "skill"]) };
  });

  // ── Spaces & pages ───────────────────────────────────────────────────────
  r.get("/api/pages", (req) => rt.pages.list(req.query.get("space") ?? undefined));
  r.get("/api/pages/search", (req) => rt.pages.search(req.query.get("q") ?? ""));
  r.get("/api/spaces", () => [...new Set(["default", ...rt.pages.spaces(), ...rt.coworkers.list().flatMap((c) => c.spaces ?? [])])].filter((s) => s !== "*"));
  r.get("/api/pages/:id", (req) => must(rt.pages.get(req.params.id), "page"));
  r.post("/api/pages", (req) => rt.pages.create({ title: req.body.title ?? "Untitled", body: req.body.body ?? "", space: req.body.space, parentId: req.body.parentId, author: "user" }));
  r.put("/api/pages/:id", (req) => {
    try {
      return rt.pages.update(req.params.id, { title: req.body.title, body: req.body.body, baseRevision: req.body.baseRevision, author: "user" });
    } catch (e) {
      if (e instanceof StaleRevisionError) throw Object.assign(new HttpError(409, e.message), { current: e.current });
      throw e;
    }
  });
  r.delete("/api/pages/:id", (req) => {
    rt.pages.delete(req.params.id);
    return { ok: true };
  });

  // ── Knowledge ────────────────────────────────────────────────────────────
  r.get("/api/knowledge", () => rt.knowledge.datasets());
  r.get("/api/knowledge/search", (req) => rt.knowledge.search(req.query.get("q") ?? "", { dataset: req.query.get("dataset") ?? undefined, topK: 8 }));
  r.get("/api/knowledge/:dataset", (req) => rt.knowledge.documents(req.params.dataset));
  r.post("/api/knowledge/:dataset", (req) => ({ chunks: rt.knowledge.add(req.params.dataset, req.body.title, req.body.content, req.body.source) }));
  r.delete("/api/knowledge/:dataset/:title", (req) => {
    rt.knowledge.removeDocument(req.params.dataset, req.params.title);
    return { ok: true };
  });

  // ── Workflows (Dify-style app API) ───────────────────────────────────────
  r.get("/api/workflows", () => rt.workflows.list());
  r.get("/api/workflow-node-types", () => NODE_TYPES);
  r.get("/api/workflows/:id", (req) => must(rt.workflows.get(req.params.id), "workflow"));
  r.put("/api/workflows/:id", (req) => rt.workflows.save({ ...(req.body as WorkflowDef), id: req.params.id }));
  r.delete("/api/workflows/:id", (req) => {
    rt.workflows.delete(req.params.id);
    return { ok: true };
  });
  r.get("/api/workflows/:id/runs", (req) => rt.workflows.runs(req.params.id).map(parseRun));
  r.post("/api/workflows/:id/run", async (req, res) => {
    if (req.query.get("stream") === "1") {
      const stream = sse(res);
      const result = await rt.workflows.run(req.params.id, req.body.inputs ?? {}, { emit: (e) => stream.send(e), coworkerId: req.body.coworker });
      stream.send({ type: "WORKFLOW_FINISHED", result });
      stream.close();
      return;
    }
    return rt.workflows.run(req.params.id, req.body.inputs ?? {}, { coworkerId: req.body.coworker });
  });

  // ── Activity: tasks & schedules ──────────────────────────────────────────
  r.get("/api/tasks", () => rt.tasks.list().map((t) => ({ ...t, plan: t.plan ? JSON.parse(t.plan) : null })));
  r.post("/api/tasks", (req) => rt.tasks.create({ coworkerId: req.body.coworker ?? "assistant", title: req.body.title ?? String(req.body.prompt).slice(0, 60), prompt: req.body.prompt }));
  for (const action of ["pause", "resume", "cancel", "retry"] as const) {
    r.post(`/api/tasks/:id/${action}`, (req) => {
      const ok = rt.tasks[action](req.params.id);
      if (!ok) throw new HttpError(409, `cannot ${action} this task in its current state`);
      return { ok };
    });
  }
  r.get("/api/schedules", () => rt.scheduler.list());
  r.post("/api/schedules", (req) => {
    const thread = rt.runner.ensureThread(req.body.coworker ?? "assistant", req.body.threadId, `⏰ ${req.body.name}`);
    return rt.scheduler.create({ coworkerId: req.body.coworker ?? "assistant", threadId: thread.id, name: req.body.name, cron: req.body.cron, prompt: req.body.prompt });
  });
  r.put("/api/schedules/:id", (req) => {
    rt.scheduler.setEnabled(req.params.id, !!req.body.enabled);
    return { ok: true };
  });
  r.post("/api/schedules/:id/run", (req) => rt.scheduler.runNow(req.params.id));
  r.delete("/api/schedules/:id", (req) => {
    rt.scheduler.delete(req.params.id);
    return { ok: true };
  });

  // ── Computer: live view + take the wheel ─────────────────────────────────
  r.get("/api/computer/:coworker", async (req) => {
    if (!rt.browser.isOpen(req.params.coworker)) return { open: false };
    const url = await rt.browser.currentUrl(req.params.coworker);
    return { open: true, url, screenshot: await rt.browser.screenshot(req.params.coworker) };
  });
  r.post("/api/computer/:coworker/action", async (req) => {
    const id = req.params.coworker;
    if (!hasPlaywright()) throw new HttpError(501, "browser support is not installed");
    const page = await rt.browser.page(id);
    const a = req.body;
    if (a.type === "navigate") await page.goto(String(a.url).startsWith("http") ? a.url : `https://${a.url}`, { waitUntil: "domcontentloaded" });
    else if (a.type === "click") await page.mouse.click(Number(a.x), Number(a.y));
    else if (a.type === "type") await page.keyboard.type(String(a.text ?? ""));
    else if (a.type === "key") await page.keyboard.press(String(a.key));
    else if (a.type === "scroll") await page.mouse.wheel(0, Number(a.dy ?? 400));
    else if (a.type === "back") await page.goBack().catch(() => {});
    else throw new HttpError(400, "unknown action");
    // Human actions are recorded too: the trail shows who did what on the coworker's computer.
    rt.db.run(
      "INSERT INTO audit (id, ts, coworker_id, initiator, tool, effect, args, decision, outcome) VALUES (?,?,?, 'user', ?, 'write', ?, 'takeover', 'ok')",
      newId("aud_"), now(), id, `takeover_${a.type}`, { ...a, text: a.type === "type" ? `[${String(a.text ?? "").length} chars]` : undefined },
    );
    await page.waitForTimeout(350);
    return { url: page.url(), screenshot: await rt.browser.screenshot(id) };
  });

  // ── Usage ────────────────────────────────────────────────────────────────
  r.get("/api/usage", () => ({
    byCoworker: rt.db.all("SELECT coworker_id, model, SUM(input_tokens) AS input, SUM(output_tokens) AS output, COUNT(*) AS calls FROM usage GROUP BY coworker_id, model"),
    last24h: rt.db.get("SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM usage WHERE ts > ?", now() - 86_400_000),
  }));

  return r;
}

function must<T>(v: T, what: string): NonNullable<T> {
  if (v === undefined || v === null) throw new HttpError(404, `${what} not found`);
  return v as NonNullable<T>;
}

function parseRun(r: any) {
  return { ...r, inputs: safe(r.inputs), outputs: safe(r.outputs), trace: safe(r.trace) };
}
function safe(s: string | null) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return s;
  }
}
