import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, nextRun } from "../packages/core/src/index.ts";
import { cronMatches } from "../packages/core/src/tasks/cron.ts";
import { Runtime } from "../packages/core/src/index.ts";
import { makeRuntime, until } from "./helpers.ts";

test("cron parsing and matching", () => {
  const s = parseCron("*/15 9-17 * * 1-5");
  assert.equal(cronMatches(s, new Date(2026, 10, 3, 9, 30)), true); // Tue 09:30
  assert.equal(cronMatches(s, new Date(2026, 10, 3, 9, 31)), false);
  assert.equal(cronMatches(s, new Date(2026, 10, 1, 9, 30)), false); // Sunday
  assert.equal(cronMatches(parseCron("0 9 * * mon"), new Date(2026, 10, 2, 9, 0)), true);
  assert.equal(nextRun("0 0 1 1 *", new Date(2026, 5, 1))!.getFullYear(), 2027);
  assert.throws(() => parseCron("61 * * * *"));
  assert.throws(() => parseCron("* * *"));
});

test("background task runs to completion in its own thread", async () => {
  const rt = makeRuntime();
  try {
    rt.tasks.start();
    const t = rt.tasks.create({ coworkerId: "assistant", title: "Save notes", prompt: "save page titled Notes: hello from a task" });
    await until(() => rt.tasks.get(t.id)!.status === "succeeded");
    assert.equal(rt.pages.list()[0].title, "Notes");
    assert.equal(rt.db.get("SELECT initiator FROM audit WHERE tool='page_save'")!.initiator, "task");
  } finally {
    await rt.cleanup();
  }
});

test("task waiting on approval reports waiting_input; cancel stops it", async () => {
  const rt = makeRuntime();
  try {
    rt.tasks.start();
    const t = rt.tasks.create({ coworkerId: "assistant", title: "Delete", prompt: "delete file x.txt" });
    await until(() => rt.tasks.get(t.id)!.status === "waiting_input");
    assert.equal(rt.approvals.pending().length, 1);
    rt.tasks.cancel(t.id);
    await until(() => rt.tasks.get(t.id)!.status === "cancelled");
    assert.equal(rt.approvals.pending().length, 0);
  } finally {
    await rt.cleanup();
  }
});

test("scheduler fires matching schedules once per minute into the original thread", async () => {
  const rt = makeRuntime();
  try {
    const thread = rt.runner.ensureThread("assistant");
    rt.scheduler.create({ coworkerId: "assistant", threadId: thread.id, name: "Morning", cron: "0 9 * * *", prompt: "remember mornings are for deep work" });
    const at = new Date(2026, 10, 3, 9, 0, 5);
    assert.equal(rt.scheduler.tick(at).length, 1);
    assert.equal(rt.scheduler.tick(new Date(2026, 10, 3, 9, 0, 40)).length, 0, "same minute does not fire twice");
    assert.equal(rt.scheduler.tick(new Date(2026, 10, 3, 9, 1)).length, 0);
    const task = rt.tasks.list()[0];
    assert.equal(task.thread_id, thread.id);
    assert.ok(task.schedule_id);
  } finally {
    await rt.cleanup();
  }
});

test("tasks running when the process died are marked interrupted, never silently resumed", async () => {
  const rt = makeRuntime();
  try {
    const t = rt.tasks.create({ coworkerId: "assistant", title: "x", prompt: "hello" });
    rt.db.run("UPDATE tasks SET status='running' WHERE id=?", t.id);
    const rt2 = new Runtime(rt.config, { quiet: true });
    rt2.tasks.start();
    assert.equal(rt2.tasks.get(t.id)!.status, "interrupted");
    assert.equal(rt2.tasks.retry(t.id), true);
    await until(() => rt2.tasks.get(t.id)!.status === "succeeded");
    await rt2.stop();
  } finally {
    await rt.cleanup();
  }
});

test("delegate runs parallel subagents within their own grants", async () => {
  const rt = makeRuntime();
  try {
    const r = await rt.runner.run({ coworkerId: "assistant", input: "ask the researcher to search the knowledge base for hotel cap" });
    assert.equal(r.error, undefined);
    const sub = rt.db.get("SELECT * FROM audit WHERE coworker_id='researcher' AND tool='knowledge_search'");
    assert.equal(sub?.initiator, "subagent");
  } finally {
    await rt.cleanup();
  }
});
