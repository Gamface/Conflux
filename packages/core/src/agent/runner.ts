import { newId, noopEmit, type Emit } from "../events.ts";
import { now, type Row } from "../db.ts";
import type { Runtime } from "../runtime.ts";
import type { Coworker } from "../config.ts";
import { providerFor, type ChatMessage, type Completion, type ToolSpec } from "../providers/index.ts";
import type { Initiator, ToolResult } from "../tools/types.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { aguiStep } from "./agui-client.ts";
import { maybeReview } from "../learning/review.ts";

export type RunOptions = {
  coworkerId: string;
  input: string;
  threadId?: string;
  runId?: string;
  initiator?: Initiator;
  emit?: Emit;
  signal?: AbortSignal;
  depth?: number;
  /** Narrow the coworker's grants for this run (subagents). */
  grants?: string[];
  /** Ephemeral runs (subagents, workflow agent nodes) don't create a visible thread. */
  ephemeral?: boolean;
  onWaiting?: (waiting: boolean) => void;
  /** Override the model profile for this run. */
  model?: string;
};

export type RunResult = {
  threadId: string;
  runId: string;
  text: string;
  toolCalls: number;
  usage: { input: number; output: number };
  error?: string;
};

export type StepFn = (args: {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  onText: (d: string) => void;
  onToolCallStart: (id: string, name: string) => void;
  onToolCallArgs: (id: string, d: string) => void;
  threadId: string;
  runId: string;
}) => Promise<Completion>;

/**
 * The turn loop. One implementation serves chat, background tasks, schedules, channels,
 * subagents and workflow agent nodes, with either a native model or an external AG-UI agent
 * as the "brain" — the gateway, persistence and learning loop are the same either way.
 */
export class AgentRunner {
  private rt: Runtime;
  private active = new Map<string, AbortController>();

  constructor(rt: Runtime) {
    this.rt = rt;
  }

  cancel(runId: string): boolean {
    const c = this.active.get(runId);
    c?.abort();
    return !!c;
  }

  activeRuns(): string[] {
    return [...this.active.keys()];
  }

  ensureThread(coworkerId: string, threadId?: string, title?: string): Row {
    const rt = this.rt;
    if (threadId) {
      const t = rt.db.get("SELECT * FROM threads WHERE id=?", threadId);
      if (t) return t;
    }
    const id = threadId ?? newId("thr_");
    rt.db.run(
      "INSERT INTO threads (id, coworker_id, title, created_at, updated_at) VALUES (?,?,?,?,?)",
      id, coworkerId, (title ?? "New conversation").slice(0, 80), now(), now(),
    );
    return rt.db.get("SELECT * FROM threads WHERE id=?", id)!;
  }

  history(threadId: string): ChatMessage[] {
    const rows = this.rt.db.all("SELECT * FROM messages WHERE thread_id=? AND compacted=0 ORDER BY created_at, rowid", threadId);
    return rows.map(rowToMessage);
  }

  private persist(threadId: string, runId: string, m: ChatMessage, ui?: { ui: string; data?: unknown; isError?: boolean }): void {
    const id = newId("msg_");
    const db = this.rt.db;
    db.run(
      "INSERT INTO messages (id, thread_id, run_id, role, content, tool_calls, tool_call_id, name, ui, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      id, threadId, runId, m.role, m.content,
      m.role === "assistant" && m.toolCalls?.length ? m.toolCalls : null,
      m.role === "tool" ? m.toolCallId : null,
      m.role === "tool" ? m.name : null,
      ui ? JSON.stringify(ui, (k, v) => (k === "screenshot" ? undefined : v)) : null,
      now(),
    );
    if (m.content && m.role !== "tool") db.run("INSERT INTO messages_fts (content, thread_id, message_id, role) VALUES (?,?,?,?)", m.content, threadId, id, m.role);
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const rt = this.rt;
    const coworker = rt.coworkers.get(opts.coworkerId);
    if (!coworker) throw new Error(`unknown coworker "${opts.coworkerId}"`);
    const emit = opts.emit ?? noopEmit;
    const runId = opts.runId ?? newId("run_");
    const initiator = opts.initiator ?? "user";
    const depth = opts.depth ?? 0;
    const controller = new AbortController();
    opts.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    this.active.set(runId, controller);

    const thread = this.ensureThread(coworker.id, opts.threadId, opts.input);
    const threadId: string = thread.id;
    let system: string = thread.system_snapshot;
    if (!system) {
      system = buildSystemPrompt(rt, coworker);
      rt.db.run("UPDATE threads SET system_snapshot=? WHERE id=?", system, threadId);
    }
    if (opts.ephemeral) rt.db.run("UPDATE threads SET archived=1 WHERE id=?", threadId);

    const messages = this.history(threadId);
    const userMsg: ChatMessage = { role: "user", content: opts.input };
    messages.push(userMsg);
    this.persist(threadId, runId, userMsg);

    const grants = opts.grants ?? coworker.tools;
    const tools = rt.tools.forCoworker(coworker, rt, grants);
    const specs: ToolSpec[] = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    const step: StepFn = coworker.agui ? aguiStep(coworker) : this.nativeStep(coworker, opts.model);

    const usage = { input: 0, output: 0 };
    let finalText = "";
    let toolCallCount = 0;
    const maxIterations = coworker.maxIterations ?? 24;

    emit({ type: "RUN_STARTED", threadId, runId });
    rt.bus.publish("runs", { type: "run_started", runId, threadId, coworker: coworker.id, initiator });
    try {
      for (let i = 0; i < maxIterations; i++) {
        if (controller.signal.aborted) throw new Error("cancelled");
        await this.compressIfNeeded(threadId, messages, coworker, system);

        const messageId = newId("msg_");
        let textStarted = false;
        const startedCalls = new Set<string>();
        const completion = await step({
          system,
          messages: withSummary(rt, threadId, messages),
          tools: specs,
          signal: controller.signal,
          threadId,
          runId,
          onText: (delta) => {
            if (!textStarted) {
              textStarted = true;
              emit({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
            }
            emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta });
          },
          onToolCallStart: (id, name) => {
            startedCalls.add(id);
            emit({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: name, parentMessageId: messageId });
          },
          onToolCallArgs: (id, delta) => emit({ type: "TOOL_CALL_ARGS", toolCallId: id, delta }),
        });
        if (textStarted) emit({ type: "TEXT_MESSAGE_END", messageId });
        usage.input += completion.usage.input;
        usage.output += completion.usage.output;
        rt.db.run(
          "INSERT INTO usage (ts, run_id, coworker_id, provider, model, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?)",
          now(), runId, coworker.id, coworker.agui ? "agui" : this.profile(coworker, opts.model).provider,
          coworker.agui ? coworker.agui.url : this.profile(coworker, opts.model).model, completion.usage.input, completion.usage.output,
        );

        const assistant: ChatMessage = { role: "assistant", content: completion.text, toolCalls: completion.toolCalls };
        messages.push(assistant);
        this.persist(threadId, runId, assistant);
        if (completion.text) finalText = completion.text;
        if (!completion.toolCalls.length) break;

        for (const call of completion.toolCalls) {
          if (!startedCalls.has(call.id)) {
            emit({ type: "TOOL_CALL_START", toolCallId: call.id, toolCallName: call.name, parentMessageId: messageId });
            emit({ type: "TOOL_CALL_ARGS", toolCallId: call.id, delta: call.arguments });
          }
          emit({ type: "TOOL_CALL_END", toolCallId: call.id });
        }
        const results = await this.executeCalls(completion.toolCalls, {
          runId, threadId, coworker, initiator, emit, signal: controller.signal, rt, depth, onWaiting: opts.onWaiting,
        }, grants);
        toolCallCount += results.length;
        for (const { call, result } of results) {
          const toolMsg: ChatMessage = { role: "tool", content: result.content, toolCallId: call.id, name: call.name };
          messages.push(toolMsg);
          this.persist(threadId, runId, toolMsg, { ui: result.ui ?? "", data: result.data, isError: result.isError });
          emit({ type: "TOOL_CALL_RESULT", toolCallId: call.id, messageId: newId("msg_"), content: result.content, role: "tool" });
          emit({ type: "CUSTOM", name: "tool_ui", value: { toolCallId: call.id, tool: call.name, ui: result.ui, data: result.data, isError: !!result.isError } });
        }
        if (i === maxIterations - 1) finalText ||= "(stopped: reached the iteration budget for this turn)";
      }
      rt.db.run("UPDATE threads SET user_turns = user_turns + ?, updated_at=? WHERE id=?", initiator === "user" || initiator === "channel" ? 1 : 0, now(), threadId);
      emit({ type: "RUN_FINISHED", threadId, runId, result: { text: finalText } });
      rt.bus.publish("runs", { type: "run_finished", runId, threadId, coworker: coworker.id });
      if (!opts.ephemeral && depth === 0 && initiator !== "review") {
        maybeReview(rt, { coworker, threadId, toolCalls: toolCallCount });
      }
      return { threadId, runId, text: finalText, toolCalls: toolCallCount, usage };
    } catch (e) {
      const message = controller.signal.aborted ? "cancelled" : (e as Error).message;
      emit({ type: "RUN_ERROR", message });
      rt.bus.publish("runs", { type: "run_error", runId, threadId, coworker: coworker.id, message });
      if (!opts.ephemeral && !controller.signal.aborted) this.persist(threadId, runId, { role: "assistant", content: `⚠️ ${message}` });
      return { threadId, runId, text: finalText, toolCalls: toolCallCount, usage, error: message };
    } finally {
      this.active.delete(runId);
    }
  }

  /** Read-only calls run concurrently; anything that changes the world runs in order. */
  private async executeCalls(calls: Completion["toolCalls"], ctx: Parameters<Runtime["gateway"]["execute"]>[2], grants: string[]) {
    const rt = this.rt;
    const out: { call: Completion["toolCalls"][number]; result: ToolResult }[] = [];
    const isRead = (name: string) => {
      const t = rt.tools.get(name);
      return t && typeof t.effect === "string" && t.effect === "read";
    };
    if (calls.length > 1 && calls.every((c) => isRead(c.name))) {
      const results = await Promise.all(calls.map((c) => rt.gateway.execute(c.name, c.arguments, ctx, grants)));
      return calls.map((call, i) => ({ call, result: results[i] }));
    }
    for (const call of calls) out.push({ call, result: await rt.gateway.execute(call.name, call.arguments, ctx, grants) });
    return out;
  }

  profile(c: Coworker, override?: string) {
    const key = override ?? c.model ?? this.rt.config.defaultModel;
    const p = this.rt.config.models[key] ?? this.rt.config.models[this.rt.config.defaultModel];
    if (!p) throw new Error(`no model profile "${key}"`);
    return p;
  }

  private nativeStep(c: Coworker, override?: string): StepFn {
    const profile = this.profile(c, override);
    const provider = providerFor(profile.provider);
    return (a) =>
      provider.complete({
        profile, system: a.system, messages: a.messages, tools: a.tools, signal: a.signal,
        onText: a.onText, onToolCallStart: a.onToolCallStart, onToolCallArgs: a.onToolCallArgs,
      });
  }

  /**
   * Context compression — the one sanctioned exception to "never mutate past context". When the
   * live history outgrows its budget, older turns are summarised into the thread summary and
   * marked compacted (still searchable through session_search).
   */
  private async compressIfNeeded(threadId: string, messages: ChatMessage[], c: Coworker, system: string): Promise<void> {
    const { maxChars, keepRecent } = this.rt.config.context;
    const size = messages.reduce((n, m) => n + m.content.length + (m.role === "assistant" ? JSON.stringify(m.toolCalls ?? []).length : 0), 0);
    if (size <= maxChars || messages.length <= keepRecent + 2) return;
    let cut = messages.length - keepRecent;
    while (cut < messages.length && messages[cut].role !== "user") cut++;
    if (cut >= messages.length - 1) return;
    const old = messages.slice(0, cut);
    const transcript = old.map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 2000)}`).join("\n");
    let summary = "";
    try {
      const profile = this.profile(c);
      const r = await providerFor(profile.provider).complete({
        profile,
        system: "You compress conversations. Write a dense summary preserving decisions, facts, open tasks, file names and IDs. No preamble.",
        messages: [{ role: "user", content: transcript.slice(-60_000) }],
        tools: [],
      });
      summary = r.text;
    } catch {
      summary = transcript.slice(-4000);
    }
    const thread = this.rt.db.get("SELECT summary FROM threads WHERE id=?", threadId);
    const merged = [thread?.summary, summary].filter(Boolean).join("\n\n").slice(-12_000);
    this.rt.db.tx(() => {
      this.rt.db.run("UPDATE threads SET summary=? WHERE id=?", merged, threadId);
      const ids = this.rt.db.all("SELECT id FROM messages WHERE thread_id=? AND compacted=0 ORDER BY created_at, rowid LIMIT ?", threadId, cut);
      for (const r of ids) this.rt.db.run("UPDATE messages SET compacted=1 WHERE id=?", r.id);
    });
    messages.splice(0, cut);
    void system;
  }
}

function withSummary(rt: Runtime, threadId: string, messages: ChatMessage[]): ChatMessage[] {
  const t = rt.db.get("SELECT summary FROM threads WHERE id=?", threadId);
  if (!t?.summary) return messages;
  return [{ role: "user", content: `[Summary of the earlier part of this conversation]\n${t.summary}` }, { role: "assistant", content: "Understood." }, ...messages];
}

export function rowToMessage(r: Row): ChatMessage {
  if (r.role === "tool") return { role: "tool", content: r.content, toolCallId: r.tool_call_id, name: r.name ?? "" };
  if (r.role === "assistant") return { role: "assistant", content: r.content, toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined };
  return { role: "user", content: r.content };
}
