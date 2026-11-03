import type { Tool } from "./types.ts";

type Todo = { id: string; content: string; status: "pending" | "in_progress" | "completed" | "cancelled" };

const plans = new Map<string, Todo[]>();

export function planFor(threadId: string): Todo[] {
  return plans.get(threadId) ?? [];
}

export const todoTool: Tool = {
  name: "todo",
  toolset: "planning",
  effect: "read",
  description:
    "Maintain a visible plan for multi-step work. Send the full list each time (it replaces the previous one). Exactly one item should be in_progress while working. The user sees this as a live plan card.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
          },
          required: ["id", "content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  async run(a, ctx) {
    const todos: Todo[] = (a.todos ?? []).map((t: Todo, i: number) => ({ id: String(t.id ?? i + 1), content: String(t.content), status: t.status ?? "pending" }));
    plans.set(ctx.threadId, todos);
    ctx.emit({ type: "STATE_SNAPSHOT", snapshot: { plan: todos } });
    const task = ctx.rt.db.get("SELECT id FROM tasks WHERE thread_id=? AND status IN ('running','waiting_input') ORDER BY created_at DESC LIMIT 1", ctx.threadId);
    if (task) {
      ctx.rt.db.run("UPDATE tasks SET plan=? WHERE id=?", todos, task.id);
      ctx.rt.bus.publish("tasks", { type: "task_progress", id: task.id, plan: todos });
    }
    const done = todos.filter((t) => t.status === "completed").length;
    return { content: `Plan updated (${done}/${todos.length} done).`, ui: "plan", data: todos };
  },
};

export const clarifyTool: Tool = {
  name: "clarify",
  toolset: "planning",
  effect: "read",
  description:
    "Ask the user one clarifying question and wait for the answer. Offer 2-4 short choices when possible. Use only when a wrong guess would be costly.",
  parameters: {
    type: "object",
    properties: { question: { type: "string" }, choices: { type: "array", items: { type: "string" } } },
    required: ["question"],
  },
  async run(a, ctx) {
    const { id, outcome } = ctx.rt.approvals.request(
      { kind: "question", runId: ctx.runId, threadId: ctx.threadId, coworkerId: ctx.coworker.id, tool: "clarify", args: a, reason: a.question, choices: a.choices },
      ctx.rt.config.approvalTimeoutMs,
      ctx.signal,
    );
    ctx.emit({ type: "CUSTOM", name: "input_requested", value: { id, question: a.question, choices: a.choices ?? [] } });
    ctx.onWaiting?.(true);
    const o = await outcome;
    ctx.onWaiting?.(false);
    ctx.emit({ type: "CUSTOM", name: "input_resolved", value: { id, response: o.response } });
    if (o.timedOut) return "The user did not answer in time. Proceed with the most reasonable assumption and state it.";
    return `User answered: ${o.response ?? (o.approved ? "yes" : "no")}`;
  },
};

export const planningTools = [todoTool, clarifyTool];
