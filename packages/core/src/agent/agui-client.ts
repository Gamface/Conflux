import { sseData, type ToolCall } from "../providers/types.ts";
import type { Coworker } from "../config.ts";
import type { StepFn } from "./runner.ts";

/**
 * Bring any AG-UI agent (LangGraph, Mastra, CrewAI, Pydantic AI, ADK, hand-written…) as a coworker,
 * as OpenBot does. Conflux's tools are offered to it as AG-UI *client* tools, so when the agent
 * calls one, the call comes back here and runs through the same policy gateway and audit trail as
 * a native coworker. Governance rides the protocol, not the framework.
 */
export function aguiStep(c: Coworker): StepFn {
  return async (a) => {
    const messages = a.messages.map((m, i) => {
      const id = `m${i}`;
      if (m.role === "tool") return { id, role: "tool", content: m.content, toolCallId: m.toolCallId };
      if (m.role === "assistant")
        return {
          id, role: "assistant", content: m.content,
          ...(m.toolCalls?.length ? { toolCalls: m.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } })) } : {}),
        };
      return { id, role: "user", content: m.content };
    });
    const res = await fetch(c.agui!.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...(c.agui!.headers ?? {}) },
      body: JSON.stringify({
        threadId: a.threadId,
        runId: a.runId,
        messages: [{ id: "sys", role: "system", content: a.system }, ...messages],
        tools: a.tools,
        state: {},
        context: [],
        forwardedProps: {},
      }),
      signal: a.signal,
    });
    if (!res.ok || !res.body) throw new Error(`AG-UI agent ${c.agui!.url} returned ${res.status}`);

    let text = "";
    const calls = new Map<string, ToolCall>();
    const resolvedRemotely = new Set<string>();
    for await (const data of sseData(res.body)) {
      let e: any;
      try {
        e = JSON.parse(data);
      } catch {
        continue;
      }
      switch (e.type) {
        case "TEXT_MESSAGE_CONTENT":
        case "TEXT_MESSAGE_CHUNK":
          if (e.delta) {
            text += e.delta;
            a.onText(e.delta);
          }
          break;
        case "TOOL_CALL_START":
          calls.set(e.toolCallId, { id: e.toolCallId, name: e.toolCallName, arguments: "" });
          a.onToolCallStart(e.toolCallId, e.toolCallName);
          break;
        case "TOOL_CALL_ARGS": {
          const tc = calls.get(e.toolCallId);
          if (tc) tc.arguments += e.delta;
          a.onToolCallArgs(e.toolCallId, e.delta);
          break;
        }
        case "TOOL_CALL_RESULT":
          // The agent ran this tool itself (a backend tool of its own); nothing for us to execute.
          resolvedRemotely.add(e.toolCallId);
          break;
        case "RUN_ERROR":
          throw new Error(e.message ?? "AG-UI agent error");
      }
    }
    const toolCalls = [...calls.values()].filter((t) => !resolvedRemotely.has(t.id) && a.tools.some((s) => s.name === t.name));
    return { text, toolCalls, usage: { input: 0, output: 0 }, stopReason: toolCalls.length ? "tool_calls" : "stop" };
  };
}
