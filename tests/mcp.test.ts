import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeRuntime, ctxFor, until } from "./helpers.ts";

test("MCP servers' tools are registered, granted per toolset and governed by effect", async () => {
  const rt = makeRuntime({ mcpServers: { echo: { command: process.execPath, args: [join(import.meta.dirname, "fixtures", "mcp-echo-server.mjs")] } } });
  try {
    await rt.mcp.start();
    assert.equal(rt.mcp.status.echo.connected, true);
    assert.equal(rt.mcp.status.echo.tools, 2);
    const r = await rt.gateway.execute("mcp__echo__echo", { text: "hi" }, ctxFor(rt));
    assert.equal(r.content, "echo: hi");
    assert.equal(rt.db.get("SELECT effect FROM audit WHERE tool='mcp__echo__echo'")!.effect, "read");

    // destructiveHint maps to the destructive effect → needs approval under the default policy
    const pending = rt.gateway.execute("mcp__echo__wipe", {}, ctxFor(rt));
    await until(() => rt.approvals.pending().length === 1);
    rt.approvals.resolve(rt.approvals.pending()[0].id, false);
    assert.match((await pending).content, /declined/);

    // Researcher has no mcp:echo grant
    const refused = await rt.gateway.execute("mcp__echo__echo", { text: "x" }, ctxFor(rt, "researcher"));
    assert.match(refused.content, /not been granted/);
  } finally {
    await rt.cleanup();
  }
});
