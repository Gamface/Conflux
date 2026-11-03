import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, testExpr, decide, type Policy } from "../packages/core/src/index.ts";
import { mergePolicy } from "../packages/core/src/governance/policy.ts";
import { makeRuntime, ctxFor, until } from "./helpers.ts";

const env = {
  tool: { name: "browser_click", toolset: "computer" },
  action: { effect: "write" },
  page: { host: "shop.example.com", url: "https://shop.example.com/cart" },
  element: { role: "button", name: "Pay now" },
  args: { tags: ["a", "b"], n: 3 },
};

test("expressions: operators, methods, macros", () => {
  assert.equal(testExpr('tool.name == "browser_click" && action.effect in ["write", "destructive"]', env), true);
  assert.equal(testExpr('element.name.matches("(?i)PAY|submit")', env), true);
  assert.equal(testExpr('page.host.endsWith("example.com") && !page.host.startsWith("www")', env), true);
  assert.equal(testExpr("args.tags.exists(t, t == \"b\") && size(args.tags) == 2 && args.n * 2 > 5", env), true);
  assert.equal(testExpr("has(args.missing)", env), false);
  assert.equal(evaluate('args.n > 2 ? "big" : "small"', env), "big");
});

test("expressions fail closed on unknown fields and non-booleans", () => {
  assert.throws(() => testExpr("args.missing == 1", env));
  assert.throws(() => testExpr('tool.name', env));
  assert.throws(() => testExpr("1 +", env));
});

const base: Policy = {
  mode: "enforce",
  deny: ['has(element) && element.name.matches("(?i)pay now")'],
  requireApproval: ['action.effect == "destructive"'],
  allow: ['tool.toolset != "secret"'],
};
const ctx = (over: any = {}) => ({ tool: { name: "x", toolset: "web" }, action: { effect: "read" }, coworker: { id: "a" }, initiator: "user", args: {}, ...over });

test("policy: deny beats approval beats allow; default deny; fail closed", () => {
  assert.equal(decide(base, ctx({ element: { name: "Pay now" }, action: { effect: "destructive" } })).decision, "deny");
  assert.equal(decide(base, ctx({ action: { effect: "destructive" } })).decision, "approve");
  assert.equal(decide(base, ctx()).decision, "allow");
  assert.equal(decide(base, ctx({ tool: { name: "x", toolset: "secret" } })).decision, "deny");
  const broken: Policy = { ...base, deny: ["args.nope == 1"] };
  const d = decide(broken, ctx());
  assert.equal(d.decision, "deny", "an erroring deny rule refuses");
  assert.equal(d.errors.length, 1);
});

test("policy: dry-run records would-be decision but allows", () => {
  const d = decide({ ...base, mode: "dry-run" }, ctx({ element: { name: "Pay now" } }));
  assert.equal(d.decision, "allow");
  assert.equal(d.wouldBe, "deny");
});

test("policy: coworker policy can only narrow", () => {
  const merged = mergePolicy(base, { allow: ['tool.toolset == "web"'], deny: ['tool.name == "y"'] });
  assert.equal(decide(merged, ctx()).decision, "allow");
  assert.equal(decide(merged, ctx({ tool: { name: "z", toolset: "files" } })).decision, "deny");
  assert.equal(decide(merged, ctx({ tool: { name: "y", toolset: "web" } })).decision, "deny");
});

test("gateway: refuses ungranted tools and records the attempt", async () => {
  const rt = makeRuntime();
  try {
    const r = await rt.gateway.execute("terminal", { command: "echo hi" }, ctxFor(rt, "researcher"));
    assert.equal(r.isError, true);
    assert.match(r.content, /not been granted/);
    const row = rt.db.get("SELECT * FROM audit WHERE tool='terminal'");
    assert.equal(row?.decision, "deny");
  } finally {
    await rt.cleanup();
  }
});

test("gateway: approval required for destructive actions, approve and deny paths", async () => {
  const rt = makeRuntime();
  try {
    const c = ctxFor(rt);
    await rt.gateway.execute("fs_write", { path: "a.txt", content: "x" }, c);
    const p1 = rt.gateway.execute("fs_delete", { path: "a.txt" }, c);
    await until(() => rt.approvals.pending().length === 1);
    rt.approvals.resolve(rt.approvals.pending()[0].id, false, "keep it");
    const denied = await p1;
    assert.match(denied.content, /declined.*keep it/);

    const p2 = rt.gateway.execute("fs_delete", { path: "a.txt" }, c);
    await until(() => rt.approvals.pending().length === 1);
    rt.approvals.resolve(rt.approvals.pending()[0].id, true);
    const ok = await p2;
    assert.match(ok.content, /Deleted a.txt/);
    const decisions = rt.db.all("SELECT decision, outcome FROM audit WHERE tool='fs_delete' ORDER BY ts").map((r) => `${r.decision}/${r.outcome}`);
    assert.deepEqual(decisions, ["approve/declined", "approved/ok"]);
  } finally {
    await rt.cleanup();
  }
});

test("gateway: browser element is resolved server-side from the snapshot, not from the model", async () => {
  const rt = makeRuntime();
  try {
    rt.browser.snapshots.set("assistant", '[@e1] link "Home"\n[@e2] button "Pay now"', "https://shop.example.com");
    const fake = rt.tools.get("browser_click")!;
    const original = fake.run;
    let clicked = false;
    fake.run = async () => ((clicked = true), "clicked");
    fake.available = () => true;
    (rt.browser as any).currentUrl = async () => "https://shop.example.com/cart";
    const r = await rt.gateway.execute("browser_click", { ref: "e2" }, ctxFor(rt));
    assert.equal(clicked, false);
    assert.match(r.content, /Refused by policy/);
    const ok = await rt.gateway.execute("browser_click", { ref: "e1" }, ctxFor(rt));
    assert.equal(ok.content, "clicked");
    const stale = await rt.gateway.execute("browser_click", { ref: "e99" }, ctxFor(rt));
    assert.match(stale.content, /could not resolve/);
    fake.run = original;
  } finally {
    await rt.cleanup();
  }
});

test("files: workspace paths cannot escape", async () => {
  const rt = makeRuntime();
  try {
    const r = await rt.gateway.execute("fs_read", { path: "../../etc/passwd" }, ctxFor(rt));
    assert.equal(r.isError, true);
    assert.match(r.content, /outside the workspace/);
  } finally {
    await rt.cleanup();
  }
});
