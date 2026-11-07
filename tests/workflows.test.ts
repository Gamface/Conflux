import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRuntime } from "./helpers.ts";

test("support-triage routes urgent tickets to the agent node and others to the template", async () => {
  const rt = makeRuntime();
  try {
    const urgent = await rt.workflows.run("support-triage", { ticket: "Checkout is down, urgent!", customer: "Acme" });
    assert.equal(urgent.status, "succeeded", urgent.error ?? "");
    assert.equal(urgent.outputs.route, "urgent");
    assert.equal(urgent.trace.find((n) => n.id === "standard")!.status, "skipped");
    assert.equal(urgent.trace.find((n) => n.id === "escalate")!.status, "succeeded");

    const normal = await rt.workflows.run("support-triage", { ticket: "Where can I find my invoice?", customer: "Bo" });
    assert.equal(normal.outputs.route, "else");
    assert.equal(normal.outputs.category, "billing");
    assert.match(String(normal.outputs.reply), /Hi Bo/);
    assert.equal(rt.pages.list().length, 2, "each run saved a page through the gateway");
  } finally {
    await rt.cleanup();
  }
});

test("kb-answer uses retrieval and branches on empty results", async () => {
  const rt = makeRuntime();
  try {
    const hit = await rt.workflows.run("kb-answer", { question: "How much can I expense for team meals?" });
    assert.equal(hit.status, "succeeded", hit.error ?? "");
    assert.ok((hit.outputs.sources as any[]).length > 0);
    const miss = await rt.workflows.run("kb-answer", { question: "zebra quantum croissant" });
    assert.match(String(miss.outputs.answer), /couldn't find/);
  } finally {
    await rt.cleanup();
  }
});

test("iteration + code nodes: batch questions in parallel", async () => {
  const rt = makeRuntime();
  try {
    const r = await rt.workflows.run("batch-questions", { questions: JSON.stringify(["How many days of leave?", "Hotel cap?"]) });
    assert.equal(r.status, "succeeded", r.error ?? "");
    assert.equal(r.outputs.count, 2);
    assert.match(String(r.outputs.report), /### How many days of leave\?/);
  } finally {
    await rt.cleanup();
  }
});

test("validation rejects cycles, bad ids and unknown node types", async () => {
  const rt = makeRuntime();
  try {
    const def: any = {
      id: "loop", name: "Loop", inputs: [],
      nodes: [{ id: "start", type: "start" }, { id: "a", type: "template", data: { template: "x" } }, { id: "b", type: "template", data: { template: "y" } }],
      edges: [{ source: "start", target: "a" }, { source: "a", target: "b" }, { source: "b", target: "a" }],
    };
    assert.throws(() => rt.workflows.save(def), /cycle/);
    assert.throws(() => rt.workflows.save({ ...def, edges: [], nodes: [{ id: "start", type: "start" }, { id: "bad-id", type: "nope" }] }), /identifier.*unknown type|unknown type/s);
  } finally {
    await rt.cleanup();
  }
});

test("error strategies: continue keeps going, fail stops; code is governed", async () => {
  const rt = makeRuntime();
  try {
    rt.workflows.save({
      id: "errs", name: "Errs", inputs: [],
      nodes: [
        { id: "start", type: "start" },
        { id: "boom", type: "code", data: { code: "throw new Error('nope')", onError: "continue", defaultOutputs: { value: 7 } } },
        { id: "end", type: "end", data: { outputs: { v: "{{boom.value}}", err: "{{boom.error}}" } } },
      ],
      edges: [{ source: "start", target: "boom" }, { source: "boom", target: "end" }],
    });
    const r = await rt.workflows.run("errs", {});
    assert.equal(r.status, "succeeded");
    assert.equal(r.outputs.v, 7);
    assert.match(String(r.outputs.err), /nope/);

    // The researcher coworker is not granted code_run: a workflow run as it must be refused.
    const asResearcher = await rt.workflows.run("batch-questions", { questions: '["a"]' }, { coworkerId: "researcher" });
    assert.equal(asResearcher.status, "failed");
    assert.match(String(asResearcher.error), /not been granted "code_run"/);
  } finally {
    await rt.cleanup();
  }
});

test("workflows marked exposeAsTool become coworker tools", async () => {
  const rt = makeRuntime();
  try {
    const t = rt.tools.get("wf_summarize_url");
    assert.ok(t);
    assert.deepEqual(t!.parameters.required, ["url"]);
  } finally {
    await rt.cleanup();
  }
});

test("validation explains branch wiring problems in plain words", async () => {
  const rt = makeRuntime();
  try {
    const base: any = {
      id: "branchy", name: "Branchy", inputs: [{ name: "n", type: "number" }],
      nodes: [
        { id: "start", type: "start" },
        { id: "b", type: "if_else", title: "Big?", data: { cases: [{ id: "big", when: "inputs.n > 10" }] } },
        { id: "t", type: "template", title: "Note", data: { template: "big" } },
        { id: "end", type: "end", data: { outputs: { r: "{{t.text}}" } } },
      ],
      edges: [{ source: "start", target: "b" }, { source: "b", target: "t", sourceHandle: "big" }, { source: "b", target: "end", sourceHandle: "else" }, { source: "t", target: "end" }],
    };
    rt.workflows.save(base); // valid
    assert.throws(() => rt.workflows.save({ ...base, edges: [...base.edges, { source: "b", target: "end" }] }), /must say which case/);
    assert.throws(() => rt.workflows.save({ ...base, edges: base.edges.map((e: any) => (e.sourceHandle === "big" ? { ...e, sourceHandle: "yes" } : e)) }), /no case named "yes"/);
    assert.throws(() => rt.workflows.save({ ...base, nodes: base.nodes.map((n: any) => (n.id === "b" ? { ...n, data: { cases: [{ id: "big", when: "" }] } } : n)) }), /has no condition/);
    assert.throws(() => rt.workflows.save({ ...base, nodes: [...base.nodes, { id: "orphan", type: "template", title: "Lonely", data: { template: "x" } }] }), /"Lonely" isn't connected/);
    const big = await rt.workflows.run("branchy", { n: 50 });
    assert.equal(big.outputs.r, "big");
    const small = await rt.workflows.run("branchy", { n: 1 });
    assert.equal(small.trace.find((x) => x.id === "t")!.status, "skipped");
    assert.equal(small.trace.find((x) => x.id === "end")!.status, "succeeded", "the else path still reaches End");
  } finally {
    await rt.cleanup();
  }
});
