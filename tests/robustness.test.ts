import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTextToolCalls } from "../packages/core/src/providers/text-tool-calls.ts";
import { normalizeSkill } from "../packages/core/src/learning/skills.ts";
import { registerProvider, type Completion, type CompletionRequest } from "../packages/core/src/providers/index.ts";
import { makeRuntime, ctxFor } from "./helpers.ts";

// The exact reply a small local model gave a real user (printed tool call, wrong tool, wrong args).
const REAL_REPLY = `t seems that the \`skill_manage\` tool does not have an \`add\` action. Instead, I will try to update the \`operator skills\` dataset using the \`delegate\` tool.
Here is the corrected attempt:
{"name": "delegate", "parameters": {"action": "update", "content": "{\\n \\"@operator skills\\": {\\n \\"video editing skill\\": \\"|---\\\\n name: Video Editing Skill\\\\n\\" }", "title": "operator skills"}}`;

const TOOLS = ["memory", "skill_manage", "delegate", "page_save"];

test("text tool calls: the real-world reply is recognised as a delegate call", () => {
  const r = extractTextToolCalls(REAL_REPLY, TOOLS);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, "delegate");
  assert.deepEqual(Object.keys(JSON.parse(r.calls[0].arguments)), ["action", "content", "title"]);
  assert.match(r.text, /corrected attempt/);
  assert.doesNotMatch(r.text, /"parameters"/);
});

test("text tool calls: Hermes/Qwen tags, fenced blocks, OpenAI-style function objects", () => {
  const tagged = extractTextToolCalls('Sure.\n<tool_call>\n{"name": "memory", "arguments": {"action": "add", "target": "user", "content": "Uses Kdenlive"}}\n</tool_call>', TOOLS);
  assert.equal(tagged.calls[0].name, "memory");
  assert.equal(tagged.text, "Sure.");
  const fenced = extractTextToolCalls('I will save it.\n```json\n{"tool": "page_save", "args": {"title": "T", "body": "B"}}\n```', TOOLS);
  assert.equal(fenced.calls[0].name, "page_save");
  const fn = extractTextToolCalls('{"function": {"name": "memory", "arguments": "{\\"action\\":\\"list\\",\\"target\\":\\"user\\"}"}}', TOOLS);
  assert.deepEqual(JSON.parse(fn.calls[0].arguments), { action: "list", target: "user" });
  const two = extractTextToolCalls('<tool_call>{"name":"memory","arguments":{"action":"list","target":"user"}}</tool_call><tool_call>{"name":"memory","arguments":{"action":"list","target":"memory"}}</tool_call>', TOOLS);
  assert.equal(two.calls.length, 2);
});

test("text tool calls: JSON examples inside real prose, and unknown tools, are left alone", () => {
  const prose = "To save a page you would send something like {\"name\": \"page_save\", \"arguments\": {\"title\": \"x\"}}. " + "Here is a longer explanation of how pages, spaces and revisions work in practice. ".repeat(6);
  assert.equal(extractTextToolCalls(prose, TOOLS).calls.length, 0);
  assert.equal(extractTextToolCalls('{"name": "rm_rf", "arguments": {}}', TOOLS).calls.length, 0);
  assert.equal(extractTextToolCalls('{"name": "Alice", "age": 3}', TOOLS).calls.length, 0);
});

test("gateway: common wrong action names are accepted; wrong arguments get the exact correct shape", async () => {
  const rt = makeRuntime();
  try {
    const c = ctxFor(rt);
    const ok = await rt.gateway.execute("skill_manage", { action: "add", content: "---\nname: kdenlive-export\ndescription: Export a Kdenlive project\n---\n1. File → Render" }, c);
    assert.match(ok.content, /Created skill "kdenlive-export"/);

    const bad = await rt.gateway.execute("memory", { action: "explode", target: "user" }, c);
    assert.match(bad.content, /"action" must be one of "add", "replace", "remove", "list" \(got "explode"\)/);
    assert.match(bad.content, /- target \(required\): "user" \| "memory"/);

    // The real-world mistake: delegate called with arguments it doesn't take.
    const wrong = await rt.gateway.execute("delegate", { action: "update", content: "{...}", title: "operator skills" }, c);
    assert.match(wrong.content, /"tasks" is required/);
    assert.match(wrong.content, /unknown argument\(s\) "action", "content", "title"/);
    assert.match(wrong.content, /- tasks \(required\): list of \{ goal, coworker, context, tools \}/);
    assert.equal(rt.db.get("SELECT rule FROM audit WHERE tool='delegate'")!.rule, "(invalid arguments)");
  } finally {
    await rt.cleanup();
  }
});

test("skills: a human title and a stray YAML marker are normalised instead of rejected", async () => {
  const fixed = normalizeSkill("|---\nname: Video Editing Skill\ndescription: Edit video in Kdenlive\n---\n1. Open Kdenlive");
  assert.match(fixed, /^---\nname: video-editing-skill\n/);
  const rt = makeRuntime();
  try {
    const s = rt.skills.create("|---\nname: Video Editing Skill\ndescription: Edit video in Kdenlive\n---\n1. Open Kdenlive", "test");
    assert.equal(s.name, "video-editing-skill");
  } finally {
    await rt.cleanup();
  }
});

test("end to end: a model that prints its tool call as text still gets it executed", async () => {
  let turn = 0;
  registerProvider("printer", {
    async complete(req: CompletionRequest): Promise<Completion> {
      const text = turn++ === 0
        ? 'I\'ll remember that.\n<tool_call>{"name": "memory", "arguments": {"action": "save", "target": "profile", "content": "Edits video in Kdenlive"}}</tool_call>'
        : "Saved to your profile.";
      req.onText?.(text);
      return { text, toolCalls: [], usage: { input: 1, output: 1 }, stopReason: "stop" };
    },
  });
  const rt = makeRuntime();
  try {
    (rt.config.models as any).printer = { provider: "printer", model: "p" };
    const events: any[] = [];
    const r = await rt.runner.run({ coworkerId: "assistant", input: "remember I edit video in kdenlive", model: "printer", emit: (e) => events.push(e) });
    assert.equal(r.error, undefined);
    assert.equal(r.text, "Saved to your profile.");
    assert.deepEqual(rt.memory.entries("user", "assistant"), ["Edits video in Kdenlive"], "aliases save→add, profile→user applied");
    assert.ok(events.some((e) => e.type === "CUSTOM" && e.name === "text_replaced"), "UI told to drop the raw JSON");
    assert.ok(events.some((e) => e.type === "TOOL_CALL_START" && e.toolCallName === "memory"));
  } finally {
    await rt.cleanup();
  }
});
