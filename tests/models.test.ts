import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../apps/server/src/main.ts";

process.removeAllListeners("warning");

/** Streams like the real APIs: first turn calls page_save, the turn after a tool result answers. */
function fakeLLM(kind: "openai" | "anthropic", seen: { auth: string[]; requests: any[] }): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    seen.auth.push(String(req.headers.authorization ?? req.headers["x-api-key"] ?? ""));
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "text-embedding-nomic-embed-text-v1.5" }, { id: "tiny-llama" }, { id: "qwen3:8b" }] }));
    }
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    seen.requests.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o: unknown, event?: string) => res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(o)}\n\n`);
    const msgs = body.messages as any[];
    const last = msgs[msgs.length - 1];
    const isTest = JSON.stringify(last).includes("Reply with exactly: OK");
    const hadTool = kind === "openai" ? last.role === "tool" : Array.isArray(last.content) && last.content.some((b: any) => b.type === "tool_result");
    if (kind === "openai") {
      if (isTest || hadTool) {
        for (const piece of (isTest ? ["O", "K"] : ["Saved ", "the page."])) send({ choices: [{ delta: { content: piece } }] });
        send({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
      } else {
        const args = JSON.stringify({ title: "From a real stream", body: "streamed tool call" });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "page_save", arguments: "" } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 15) } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(15) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
      }
      res.write("data: [DONE]\n\n");
    } else {
      send({ type: "message_start", message: { usage: { input_tokens: 12 } } }, "message_start");
      if (isTest || hadTool) {
        send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start");
        for (const t of (isTest ? ["O", "K"] : ["Saved ", "the page."])) send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }, "content_block_delta");
        send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, "message_delta");
      } else {
        const args = JSON.stringify({ title: "From a real stream", body: "streamed tool call" });
        send({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "page_save" } }, "content_block_start");
        send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(0, 20) } }, "content_block_delta");
        send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(20) } }, "content_block_delta");
        send({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }, "message_delta");
      }
      send({ type: "message_stop" }, "message_stop");
    }
    res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${(server.address() as any).port}` })));
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "conflux-models-"));
  const s = await startServer({ port: 0, dataDir: dir, quiet: true });
  const base = `http://127.0.0.1:${s.port}`;
  const call = async (path: string, init?: { method?: string; body?: unknown }) => {
    const r = await fetch(base + path, { method: init?.method ?? (init?.body ? "POST" : "GET"), headers: { "content-type": "application/json" }, body: init?.body ? JSON.stringify(init.body) : undefined });
    return r.json();
  };
  return { s, dir, call, close: async () => (await s.close(), rmSync(dir, { recursive: true, force: true })) };
}

test("Models page flow with an OpenAI-compatible server: discover, test, save, chat with real streamed tool calls", async () => {
  const seen = { auth: [] as string[], requests: [] as any[] };
  const llm = await fakeLLM("openai", seen);
  const app = await boot();
  try {
    const d = await app.call(`/api/models/discover?baseUrl=${encodeURIComponent(llm.url + "/v1")}`);
    assert.deepEqual(d.models, ["qwen3:8b", "tiny-llama", "text-embedding-nomic-embed-text-v1.5"], "chat models first, embedding last");
    assert.deepEqual(d.embedding, ["text-embedding-nomic-embed-text-v1.5"]);

    const t = await app.call("/api/models/test", { body: { provider: "openai", baseUrl: llm.url + "/v1", model: "qwen3:8b", apiKey: "sk-test-123" } });
    assert.equal(t.ok, true, t.error);
    assert.equal(t.reply, "OK");
    assert.equal(seen.auth.at(-1), "Bearer sk-test-123");

    const saved = await app.call("/api/models", { body: { key: "local", provider: "openai", baseUrl: llm.url + "/v1", model: "qwen3:8b", apiKey: "sk-test-123", makeDefault: true } });
    assert.equal(saved.default, true);
    // The key lives in secrets.json, never in overrides.json.
    const overrides = readFileSync(join(app.dir, "overrides.json"), "utf8");
    assert.doesNotMatch(overrides, /sk-test-123/);
    assert.match(readFileSync(join(app.dir, "secrets.json"), "utf8"), /sk-test-123/);
    assert.equal((await app.call("/api/health")).model, "local");

    const r = await app.s.rt.runner.run({ coworkerId: "assistant", input: "save a page please" });
    assert.equal(r.error, undefined);
    assert.equal(r.text, "Saved the page.");
    assert.equal(app.s.rt.pages.list()[0].title, "From a real stream", "tool call assembled from streamed argument chunks");
    assert.equal(seen.requests.at(-1).messages.at(-1).role, "tool", "tool result sent back in OpenAI format");
    assert.ok(seen.requests[1].tools.some((x: any) => x.function.name === "page_save"), "tools offered in OpenAI format");

    const models = await app.call("/api/models");
    assert.equal(models.find((m: any) => m.key === "local").hasKey, true);
    await app.call("/api/models/local", { method: "DELETE" });
    assert.equal((await app.call("/api/health")).model, "mock");
    assert.doesNotMatch(readFileSync(join(app.dir, "secrets.json"), "utf8"), /sk-test-123/, "removing a model deletes its key");
  } finally {
    await app.close();
    llm.server.close();
  }
});

test("Anthropic provider: streamed tool_use + text, key header, frozen system prompt cached", async () => {
  const seen = { auth: [] as string[], requests: [] as any[] };
  const llm = await fakeLLM("anthropic", seen);
  const app = await boot();
  try {
    const saved = await app.call("/api/models", { body: { key: "claude", provider: "anthropic", baseUrl: llm.url, model: "claude-test", apiKey: "sk-ant-xyz", makeDefault: true } });
    assert.equal(saved.default, true);
    const t = await app.call("/api/models/test", { body: { key: "claude" } });
    assert.equal(t.ok, true, t.error);
    assert.equal(seen.auth.at(-1), "sk-ant-xyz");

    const r = await app.s.rt.runner.run({ coworkerId: "assistant", input: "save a page please" });
    assert.equal(r.error, undefined);
    assert.equal(r.text, "Saved the page.");
    assert.equal(app.s.rt.pages.list()[0].title, "From a real stream");
    const req = seen.requests.at(-1);
    assert.equal(req.system[0].cache_control.type, "ephemeral");
    assert.ok(req.messages.at(-1).content.some((b: any) => b.type === "tool_result"));
    assert.ok(r.usage.input > 0 && r.usage.output > 0, "usage recorded from the stream");
  } finally {
    await app.close();
    llm.server.close();
  }
});

test("secrets saved from the UI are loaded at the next start-up", async () => {
  const app = await boot();
  const dir = app.dir;
  try {
    await app.call("/api/models", { body: { key: "later", provider: "openai", baseUrl: "http://127.0.0.1:9/v1", model: "m", apiKey: "sk-persist" } });
    await app.s.close();
    delete process.env.CONFLUX_LATER_API_KEY;
    const again = await startServer({ port: 0, dataDir: dir, quiet: true });
    assert.equal(process.env.CONFLUX_LATER_API_KEY, "sk-persist");
    assert.equal(again.rt.config.models.later.apiKeyEnv, "CONFLUX_LATER_API_KEY");
    await again.close();
  } finally {
    delete process.env.CONFLUX_LATER_API_KEY;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

test("each coworker can have its own model, switch back to default, and never silently pin the default", async () => {
  const app = await boot();
  try {
    for (const key of ["fast", "smart"]) await app.call("/api/models", { body: { key, provider: "openai", baseUrl: "http://127.0.0.1:9/v1", model: `${key}-m`, apiKey: "k" } });
    await app.call("/api/models/default", { method: "PUT", body: { key: "fast" } });

    let cws = await app.call("/api/coworkers");
    const r0 = cws.find((c: any) => c.id === "researcher");
    assert.equal(r0.model, null);
    assert.equal(r0.effectiveModel, "fast");
    assert.equal(r0.usesDefaultModel, true);

    // Saving the editor untouched must NOT pin the current default.
    await app.call("/api/coworkers/researcher", { method: "PUT", body: { ...r0 } });
    await app.call("/api/models/default", { method: "PUT", body: { key: "smart" } });
    cws = await app.call("/api/coworkers");
    assert.equal(cws.find((c: any) => c.id === "researcher").effectiveModel, "smart", "still follows the default");

    // Per-coworker assignment, and it is what the runner actually uses.
    await app.call("/api/coworkers/researcher/model", { method: "PUT", body: { model: "fast" } });
    await app.call("/api/coworkers/operator/model", { method: "PUT", body: { model: "smart" } });
    cws = await app.call("/api/coworkers");
    assert.deepEqual(cws.map((c: any) => [c.id, c.effectiveModel, c.usesDefaultModel]), [["assistant", "smart", true], ["researcher", "fast", false], ["operator", "smart", false]]);
    assert.equal(app.s.rt.runner.profile(app.s.rt.coworkers.get("researcher")!).model, "fast-m");

    // Back to default (null) clears the earlier choice, also after a restart.
    await app.call("/api/coworkers/researcher/model", { method: "PUT", body: { model: null } });
    assert.equal(app.s.rt.coworkers.get("researcher")!.model, null);
    const { loadConfig } = await import("../packages/core/src/config.ts");
    const reloaded = loadConfig({ dataDir: app.dir });
    assert.equal(reloaded.coworkers.find((c) => c.id === "researcher")!.model, null);
    assert.equal(reloaded.coworkers.find((c) => c.id === "operator")!.model, "smart");

    // Unknown models are rejected; removing an assigned model falls back to the default.
    const bad = await app.call("/api/coworkers/operator/model", { method: "PUT", body: { model: "nope" } });
    assert.match(bad.error, /unknown model/);
    await app.call("/api/models/smart", { method: "DELETE" });
    assert.equal(app.s.rt.runner.profile(app.s.rt.coworkers.get("operator")!).model, app.s.rt.config.models[app.s.rt.config.defaultModel].model);

    // An empty Spaces box means "default", not "no spaces".
    const res = await app.call("/api/coworkers/researcher", { method: "PUT", body: { ...app.s.rt.coworkers.get("researcher")!, spaces: [] } });
    assert.equal(res.spaces, null);
  } finally {
    await app.close();
  }
});
