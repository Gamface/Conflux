import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureExecutable } from "../packages/core/src/computer/driver.ts";
import { makeRuntime, ctxFor, until } from "./helpers.ts";

const pendingCount = (rt: any) => rt.approvals.pending().length;

test("'Always allow this tool' approves now, then stops asking for that tool in that chat only", async () => {
  const rt = makeRuntime();
  try {
    const c = ctxFor(rt);
    for (const f of ["a.txt", "b.txt", "c.txt"]) await rt.gateway.execute("fs_write", { path: f, content: "x" }, c);
    const first = rt.gateway.execute("fs_delete", { path: "a.txt" }, c);
    await until(() => pendingCount(rt) === 1);
    rt.approvals.approve(rt.approvals.pending()[0].id, { remember: "tool" });
    assert.match((await first).content, /Deleted a.txt/);

    // Same tool, same chat → no prompt.
    const second = await rt.gateway.execute("fs_delete", { path: "b.txt" }, c);
    assert.match(second.content, /Deleted b.txt/);
    assert.equal(pendingCount(rt), 0);
    assert.equal(rt.db.get("SELECT decision FROM audit WHERE tool='fs_delete' ORDER BY ts DESC LIMIT 1")!.decision, "approved (trusted)");

    // Same tool, different chat → still asks.
    const other = ctxFor(rt);
    const third = rt.gateway.execute("fs_delete", { path: "c.txt" }, other);
    await until(() => pendingCount(rt) === 1);
    rt.approvals.resolve(rt.approvals.pending()[0].id, false);
    assert.match((await third).content, /declined/);
  } finally {
    await rt.cleanup();
  }
});

test("'Allow everything' covers every tool in the chat, releases queued prompts, and never overrides Never rules", async () => {
  const rt = makeRuntime();
  try {
    const c = ctxFor(rt, "operator"); // the operator asks before any write/execute/external action
    const p1 = rt.gateway.execute("fs_write", { path: "one.txt", content: "1" }, c);
    const p2 = rt.gateway.execute("fs_write", { path: "two.txt", content: "2" }, c);
    await until(() => pendingCount(rt) === 2);
    const r = rt.approvals.approve(rt.approvals.pending()[0].id, { remember: "all" });
    assert.equal(r.released.length, 1, "the other queued prompt is released too");
    assert.match((await p1).content, /Wrote/);
    assert.match((await p2).content, /Wrote/);

    // A different tool now runs without asking…
    const t = await rt.gateway.execute("terminal", { command: "echo ok" }, c);
    assert.match(t.content, /ok/);
    // …but a Never rule still refuses.
    const never = await rt.gateway.execute("terminal", { command: "sudo reboot" }, c);
    assert.match(never.content, /Refused by policy/);

    // Revoking restores the prompts.
    rt.approvals.revokeAllTrust(c.threadId);
    const again = rt.gateway.execute("fs_write", { path: "three.txt", content: "3" }, c);
    await until(() => pendingCount(rt) === 1);
    rt.approvals.resolve(rt.approvals.pending()[0].id, true);
    await again;
  } finally {
    await rt.cleanup();
  }
});

test("Approve all clears every pending action, skips clarifying questions, and time-limited trust expires", async () => {
  const rt = makeRuntime();
  try {
    const c = ctxFor(rt, "operator");
    const writes = [1, 2, 3].map((i) => rt.gateway.execute("fs_write", { path: `f${i}.txt`, content: "x" }, c));
    const question = rt.approvals.request({ kind: "question", runId: "r", threadId: c.threadId, coworkerId: "operator", tool: "clarify", reason: "Which format?" }).outcome.then((o) => ({ content: String(o.response) }));
    await until(() => pendingCount(rt) === 4);
    const approved = rt.approvals.approveAll(c.threadId);
    assert.equal(approved.length, 3);
    for (const w of writes) assert.match((await w).content, /Wrote/);
    assert.equal(rt.approvals.pending().length, 1, "the question still waits for an actual answer");
    rt.approvals.resolve(rt.approvals.pending()[0].id, true, "PNG");
    assert.match(await question.then((q) => q.content), /PNG/);

    const grant = rt.approvals.grantTrust(c.threadId, { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(rt.approvals.trusted(c.threadId, "fs_write"), undefined, "expired trust no longer applies");
    assert.equal(rt.approvals.trustFor(c.threadId).length, 0);
    void grant;
  } finally {
    await rt.cleanup();
  }
});

test("subagents inherit their parent chat's approve-all", async () => {
  const rt = makeRuntime();
  try {
    const parent = ctxFor(rt, "assistant");
    rt.approvals.grantTrust(parent.threadId, { tool: null });
    // The operator subagent would normally ask before writing a file.
    const r = await rt.gateway.execute("delegate", { tasks: [{ coworker: "operator", goal: "write file note.txt with hello" }] }, parent);
    assert.match(r.content, /Subagent 1 \(operator\)/);
    assert.equal(pendingCount(rt), 0, "no prompt reached the user");
    assert.equal(rt.db.get("SELECT decision FROM audit WHERE coworker_id='operator' AND tool='fs_write'")?.decision, "approved (trusted)");
  } finally {
    await rt.cleanup();
  }
});

test("scrolling and moving around a page are reads, not writes", async () => {
  const rt = makeRuntime();
  try {
    const key = rt.tools.get("browser_key")!;
    const eff = (k: string) => (typeof key.effect === "function" ? key.effect({ key: k }) : key.effect);
    assert.equal(eff("PageDown"), "read");
    assert.equal(eff("ArrowUp"), "read");
    assert.equal(eff("Escape"), "read");
    assert.equal(eff("Enter"), "write");
    assert.equal(eff("Control+S"), "write");
  } finally {
    await rt.cleanup();
  }
});

test("desktop driver: a bundled binary that lost its executable bit is fixed instead of failing with EACCES", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cfx-exec-"));
  try {
    const f = join(dir, "agent-computer-use-linux-x64");
    writeFileSync(f, "#!/bin/sh\necho hi\n");
    chmodSync(f, 0o644);
    assert.equal(ensureExecutable(f), true);
    assert.ok(statSync(f).mode & 0o100, "owner execute bit set");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
