import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../apps/server/src/main.ts";

process.removeAllListeners("warning");

async function sse(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return text
    .split("\n\n")
    .map((c) => c.split("\n").find((l) => l.startsWith("data:")))
    .filter(Boolean)
    .map((l) => JSON.parse(l!.slice(5)));
}

test("HTTP API: health, AG-UI endpoint, pages with revision checks, access key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conflux-srv-"));
  process.env.CONFLUX_DEFAULT_MODEL = "mock";
  process.env.CONFLUX_ACCESS_KEY = "s3cret";
  const s = await startServer({ port: 0, dataDir: dir, quiet: true });
  delete process.env.CONFLUX_ACCESS_KEY;
  const base = `http://127.0.0.1:${s.port}`;
  const auth = { authorization: "Bearer s3cret" };
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/coworkers`)).status, 401);
    assert.equal((await fetch(`${base}/api/coworkers`, { headers: auth })).status, 200);

    // Standard AG-UI RunAgentInput
    const events = await sse(`${base}/agui/assistant`, { threadId: undefined, messages: [{ id: "1", role: "user", content: "save page titled Hello: world" }] }, auth);
    const types = events.map((e) => e.type);
    assert.equal(types[0], "RUN_STARTED");
    assert.ok(types.includes("TOOL_CALL_START") && types.includes("TOOL_CALL_RESULT"));
    assert.equal(types.at(-1), "RUN_FINISHED");

    const pages = await (await fetch(`${base}/api/pages`, { headers: auth })).json();
    assert.equal(pages[0].title, "Hello");
    const put = (rev: number) => fetch(`${base}/api/pages/${pages[0].id}`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ body: "edit", baseRevision: rev }) });
    assert.equal((await put(1)).status, 200);
    const stale = await put(1);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).current.revision, 2);
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("external AG-UI agent as a coworker: its tool calls run through the gateway", async () => {
  // A minimal AG-UI agent: first turn calls the `memory` tool, second turn answers.
  const agent = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const input = JSON.parse(raw);
    const hasResult = input.messages.some((m: any) => m.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
    if (!hasResult) {
      send({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "memory" });
      send({ type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: JSON.stringify({ action: "add", target: "user", content: "Uses AG-UI" }) });
      send({ type: "TOOL_CALL_END", toolCallId: "t1" });
    } else {
      send({ type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" });
      send({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Saved it." });
      send({ type: "TEXT_MESSAGE_END", messageId: "m1" });
    }
    send({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId });
    res.end();
  });
  await new Promise<void>((r) => agent.listen(0, "127.0.0.1", r));
  const port = (agent.address() as any).port;
  const dir = mkdtempSync(join(tmpdir(), "conflux-agui-"));
  const s = await startServer({ port: 0, dataDir: dir, quiet: true });
  try {
    s.rt.coworkers.upsert({ id: "byo", name: "BYO agent", role: "external", tools: ["memory"], agui: { url: `http://127.0.0.1:${port}/` } });
    const r = await s.rt.runner.run({ coworkerId: "byo", input: "remember this" });
    assert.equal(r.text, "Saved it.");
    assert.deepEqual(s.rt.memory.entries("user", "byo"), ["Uses AG-UI"]);
    assert.equal(s.rt.db.get("SELECT coworker_id FROM audit WHERE tool='memory'")!.coworker_id, "byo");
  } finally {
    await s.close();
    agent.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
