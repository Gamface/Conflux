import type { Tool } from "./types.ts";
import { isGranted } from "./registry.ts";
import { describeCron, parseCron } from "../tasks/cron.ts";

const MAX_DEPTH = 2;

export const delegateTool: Tool = {
  name: "delegate",
  toolset: "orchestration",
  effect: "read",
  description:
    "Hand independent sub-tasks to subagents that work in parallel (up to 4). Each task names a goal and optionally a coworker (by id) whose role and tools it should use, plus context it needs — subagents do not see this conversation. Returns each subagent's final answer.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            goal: { type: "string" },
            coworker: { type: "string" },
            context: { type: "string" },
            tools: { type: "array", items: { type: "string" }, description: "Optional narrower tool grants." },
          },
          required: ["goal"],
        },
      },
    },
    required: ["tasks"],
  },
  async run(a, ctx) {
    if (ctx.depth >= MAX_DEPTH) throw new Error("delegation depth limit reached; do this task yourself");
    const tasks = (a.tasks ?? []).slice(0, 4);
    const rt = ctx.rt;
    const results = await Promise.all(
      tasks.map(async (t: any, i: number) => {
        const child = rt.coworkers.get(t.coworker ?? ctx.coworker.id) ?? ctx.coworker;
        // A subagent never exceeds its own coworker's grants, nor the requested narrowing.
        const names = rt.tools
          .all()
          .filter((tool) => isGranted(child.tools, tool) && (!t.tools?.length || isGranted(t.tools, tool)))
          .filter((tool) => !(tool.name === "delegate" && ctx.depth + 1 >= MAX_DEPTH))
          .filter((tool) => tool.name !== "clarify")
          .map((tool) => tool.name);
        ctx.emit({ type: "CUSTOM", name: "subagent_started", value: { index: i, coworker: child.id, goal: t.goal } });
        const r = await rt.runner.run({
          coworkerId: child.id,
          input: `${t.goal}${t.context ? `\n\nContext:\n${t.context}` : ""}\n\nWork autonomously and finish with a concise final answer.`,
          initiator: "subagent",
          ephemeral: true,
          depth: ctx.depth + 1,
          grants: names,
          signal: ctx.signal,
          onWaiting: ctx.onWaiting,
          trustThreadId: ctx.trustThreadId ?? ctx.threadId,
          emit: (e) => {
            if (e.type === "CUSTOM" && (e.name === "approval_requested" || e.name === "approval_resolved" || e.name === "approval_auto")) ctx.emit(e);
            if (e.type === "TOOL_CALL_START") ctx.emit({ type: "CUSTOM", name: "subagent_progress", value: { index: i, tool: e.toolCallName } });
          },
        });
        ctx.emit({ type: "CUSTOM", name: "subagent_finished", value: { index: i, coworker: child.id, error: r.error } });
        return { coworker: child.id, goal: t.goal, text: r.error ? `failed: ${r.error}` : r.text, toolCalls: r.toolCalls };
      }),
    );
    return {
      content: results.map((r, i) => `## Subagent ${i + 1} (${r.coworker}) — ${r.goal}\n${r.text}`).join("\n\n"),
      ui: "subagents",
      data: results,
    };
  },
};

export const scheduleCreateTool: Tool = {
  name: "schedule_create",
  toolset: "automation",
  effect: "write",
  description:
    "Schedule a recurring instruction (5-field cron, server local time). It runs as a background task in THIS conversation, with results posted here. Example cron: '0 9 * * 1-5' = weekdays 09:00.",
  parameters: {
    type: "object",
    properties: { name: { type: "string" }, cron: { type: "string" }, prompt: { type: "string" }, coworker: { type: "string" } },
    required: ["cron", "prompt"],
  },
  async run(a, ctx) {
    parseCron(a.cron);
    const s = ctx.rt.scheduler.create({
      coworkerId: a.coworker ?? ctx.coworker.id,
      threadId: ctx.threadId,
      name: a.name ?? String(a.prompt).slice(0, 48),
      cron: a.cron,
      prompt: a.prompt,
    });
    return { content: `Scheduled "${s.name}" (${describeCron(s.cron)}). id ${s.id}`, ui: "schedule", data: s };
  },
};

export const scheduleListTool: Tool = {
  name: "schedule_list",
  toolset: "automation",
  effect: "read",
  description: "List scheduled instructions.",
  parameters: { type: "object", properties: {} },
  async run(_a, ctx) {
    const rows = ctx.rt.scheduler.list();
    return rows.length ? rows.map((s) => `- ${s.id} "${s.name}" ${describeCron(s.cron)} ${s.enabled ? "" : "(paused)"} → ${s.coworker_id}`).join("\n") : "No schedules.";
  },
};

export const scheduleDeleteTool: Tool = {
  name: "schedule_delete",
  toolset: "automation",
  effect: "destructive",
  description: "Delete a scheduled instruction by id.",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  async run(a, ctx) {
    ctx.rt.scheduler.delete(a.id);
    return `Deleted schedule ${a.id}.`;
  },
};

export const taskCreateTool: Tool = {
  name: "task_create",
  toolset: "automation",
  effect: "write",
  description:
    "Start a long-running background task that keeps going after this reply (visible in Activity with pause / resume / cancel / retry). Use for work that takes many steps or minutes.",
  parameters: {
    type: "object",
    properties: { title: { type: "string" }, prompt: { type: "string" }, coworker: { type: "string" } },
    required: ["title", "prompt"],
  },
  async run(a, ctx) {
    const t = ctx.rt.tasks.create({ coworkerId: a.coworker ?? ctx.coworker.id, title: a.title, prompt: a.prompt });
    return { content: `Started background task "${t.title}" (id ${t.id}). Track it in Activity.`, ui: "task", data: t };
  },
};

export const workflowRunTool: Tool = {
  name: "workflow_run",
  toolset: "workflows",
  effect: "read",
  description: "Run a saved workflow (a visual DAG of LLM, tool, HTTP, code, branch and retrieval nodes) by id with its inputs, and return its outputs.",
  parameters: {
    type: "object",
    properties: { id: { type: "string" }, inputs: { type: "object" } },
    required: ["id"],
  },
  resolveContext: (a) => ({ workflow: { id: String(a.id) } }),
  async run(a, ctx) {
    const r = await ctx.rt.workflows.run(a.id, a.inputs ?? {}, { parent: ctx });
    if (r.status !== "succeeded") return { content: `Workflow ${a.id} failed: ${r.error}`, isError: true, ui: "workflow", data: r };
    return { content: JSON.stringify(r.outputs, null, 2), ui: "workflow", data: r };
  },
};

export const workflowSaveTool: Tool = {
  name: "workflow_save",
  toolset: "workflows",
  effect: "write",
  description:
    "Create or replace a workflow from a JSON definition: {id, name, description, inputs:[{name,type,required}], nodes:[{id,type,title,data}], edges:[{source,target,sourceHandle?}], exposeAsTool}. Node types: start, llm{prompt,system,json}, agent{coworker,prompt}, tool{tool,args}, http{method,url,headers,body}, code{code,inputs}, template{template}, if_else{cases:[{id,when}]}, knowledge{query,dataset,topK}, iteration{items,workflow,parallel}, aggregator{variables}, end{outputs}. Reference values with {{nodeId.field}} and inputs with {{inputs.name}}. Load the workflow-authoring skill first.",
  parameters: { type: "object", properties: { definition: { type: "object" } }, required: ["definition"] },
  resolveContext: (a) => ({ workflow: { id: String(a.definition?.id ?? "") } }),
  async run(a, ctx) {
    const def = ctx.rt.workflows.save(a.definition);
    return { content: `Saved workflow "${def.id}" (${def.nodes.length} nodes).${def.exposeAsTool ? ` Available as tool wf_${def.id.replace(/-/g, "_")} in new conversations.` : ""}`, ui: "workflow_def", data: def };
  },
};

export const orchestrationTools = [delegateTool, scheduleCreateTool, scheduleListTool, scheduleDeleteTool, taskCreateTool, workflowRunTool, workflowSaveTool];
