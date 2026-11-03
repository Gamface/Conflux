import { useCallback, useEffect, useRef, useState } from "react";
import { api, stream, timeAgo, type Coworker } from "../api.ts";
import { Avatar, Button, Markdown, Pill } from "../ui.tsx";
import { ApprovalCard, PlanList, QuestionCard, ToolCard, type ApprovalItem, type QuestionItem, type ToolItem } from "./cards.tsx";
import { ComputerPanel } from "./Computer.tsx";

type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming?: boolean }
  | { kind: "notice"; id: string; text: string; tone: "info" | "bad" | "ok" }
  | ToolItem
  | ApprovalItem
  | QuestionItem;

type Thread = { id: string; title: string; updated_at: number };

const SUGGESTIONS = [
  "plan: research three CRM vendors, compare pricing, write a summary page",
  "remember I prefer concise answers with a TL;DR first",
  "run workflow support-triage ticket=\"Checkout is down for all EU users, urgent\" customer=Acme",
  "save page titled Team norms: We ship on Tuesdays. Reviews within 24h.",
  "every weekday at 9am: summarise new pages in my Spaces",
  "delete file draft.txt",
];

let uid = 0;
const nid = () => `i${++uid}`;

export function Chat({ coworker, threadId, onThread, busEvent, onOpenComputer }: {
  coworker: Coworker;
  threadId?: string;
  onThread: (id?: string) => void;
  busEvent: { channel: string; event: any } | null;
  onOpenComputer?: () => void;
}) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [plan, setPlan] = useState<any[]>([]);
  const [input, setInput] = useState("");
  const [queue, setQueue] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [showComputer, setShowComputer] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<string | undefined>(threadId);
  threadRef.current = threadId;

  const loadThreads = useCallback(() => api<Thread[]>(`/api/threads?coworker=${coworker.id}`).then(setThreads).catch(() => {}), [coworker.id]);

  useEffect(() => {
    loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    if (!threadId) {
      setItems([]);
      setPlan([]);
      return;
    }
    if (running) return;
    api(`/api/threads/${threadId}`)
      .then((d) => {
        setItems(fromHistory(d.messages, d.approvals));
        setPlan(d.plan ?? []);
      })
      .catch(() => onThread(undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240) el.scrollTop = el.scrollHeight;
  }, [items]);

  const apply = useCallback((e: any) => {
    setItems((prev) => reduce(prev, e));
    if (e.type === "STATE_SNAPSHOT" && e.snapshot?.plan) setPlan(e.snapshot.plan);
    if (e.type === "RUN_STARTED") setRunId(e.runId);
  }, []);

  // Background work (scheduled runs, tasks) streams into its conversation via the event bus.
  useEffect(() => {
    if (!busEvent || running) return;
    if (busEvent.channel === `thread:${threadRef.current}`) apply(busEvent.event);
    if (busEvent.channel === "learning" && busEvent.event.threadId === threadRef.current && busEvent.event.saved) {
      setItems((p) => [...p, { kind: "notice", id: nid(), tone: "ok", text: `🧠 Learned — ${busEvent.event.saved.join("; ")}` }]);
    }
  }, [busEvent, running, apply]);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      setRunning(true);
      setItems((p) => [...p, { kind: "user", id: nid(), text }]);
      const ac = new AbortController();
      abortRef.current = ac;
      let tid = threadRef.current;
      try {
        await stream(`/api/coworkers/${coworker.id}/runs`, { input: text, threadId: tid }, (e) => {
          if (e.type === "RUN_STARTED" && !tid) {
            tid = e.threadId;
            threadRef.current = tid;
            onThread(tid);
          }
          apply(e);
        }, ac.signal);
      } catch (e) {
        if (!ac.signal.aborted) setItems((p) => [...p, { kind: "notice", id: nid(), tone: "bad", text: (e as Error).message }]);
      } finally {
        setRunning(false);
        setRunId(null);
        abortRef.current = null;
        loadThreads();
      }
    },
    [coworker.id, apply, onThread, loadThreads],
  );

  // Follow-up queue: messages typed while a run is going are sent in order afterwards.
  useEffect(() => {
    if (!running && queue.length) {
      const [next, ...rest] = queue;
      setQueue(rest);
      send(next);
    }
  }, [running, queue, send]);

  const submit = () => {
    const t = input.trim();
    if (!t) return;
    setInput("");
    if (running) setQueue((q) => [...q, t]);
    else send(t);
  };

  const stop = async () => {
    if (runId) await api(`/api/runs/${runId}/cancel`, { method: "POST" }).catch(() => {});
    abortRef.current?.abort();
    setItems((p) => [...p, { kind: "notice", id: nid(), tone: "info", text: "Stopped." }]);
  };

  const hasBrowser = (coworker.tools ?? []).some((t) => t === "*" || t.includes("browser") || t === "toolset:computer");

  return (
    <div className="chat-layout">
      <aside className="threads">
        <div className="threads-head">
          <Button kind="primary" onClick={() => onThread(undefined)}>+ New chat</Button>
        </div>
        <div className="threads-list">
          {threads.map((t) => (
            <a key={t.id} href={`#/chat/${coworker.id}/${t.id}`} className={`thread ${t.id === threadId ? "active" : ""}`}>
              <div className="thread-title">{t.title}</div>
              <div className="muted small">{timeAgo(t.updated_at)}</div>
            </a>
          ))}
          {!threads.length && <div className="muted small pad">No conversations yet.</div>}
        </div>
      </aside>

      <section className="conversation">
        <header className="conv-head">
          <Avatar emoji={coworker.emoji} color={coworker.color} size={34} />
          <div className="grow">
            <div className="conv-title">{coworker.name}</div>
            <div className="muted small">{coworker.description ?? coworker.role.slice(0, 120)}</div>
          </div>
          <Pill tone="accent">{coworker.model}</Pill>
          <Pill>{coworker.toolCount ?? 0} tools</Pill>
          {hasBrowser && (
            <Button small kind={showComputer ? "primary" : "default"} onClick={() => (setShowComputer(!showComputer), onOpenComputer?.())}>🖥 Computer</Button>
          )}
        </header>

        <div className="messages" ref={scrollRef}>
          {items.length === 0 && (
            <div className="welcome">
              <Avatar emoji={coworker.emoji} color={coworker.color} size={56} />
              <h2>What should {coworker.name} work on?</h2>
              <p className="muted">Every action goes through your Boundaries and is recorded in the audit trail.</p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="suggestion" onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {items.map((it) => (
            <ItemView key={it.id} item={it} coworker={coworker} />
          ))}
          {running && !items.some((i) => (i.kind === "assistant" && i.streaming) || (i.kind === "tool" && i.status === "running")) && (
            <div className="typing"><span /><span /><span /></div>
          )}
        </div>

        {queue.length > 0 && (
          <div className="queue">
            <span className="muted small">Queued:</span>
            {queue.map((q, i) => (
              <span key={i} className="queue-chip" onClick={() => setQueue(queue.filter((_, j) => j !== i))} title="Remove">{q.slice(0, 50)} ✕</span>
            ))}
          </div>
        )}
        <div className="composer">
          <textarea
            value={input}
            placeholder={running ? "Queue a follow-up…" : `Message ${coworker.name}…`}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={Math.min(8, Math.max(1, input.split("\n").length))}
          />
          {running ? (
            <button className="send stop" onClick={stop} title="Stop">■</button>
          ) : (
            <button className="send" onClick={submit} disabled={!input.trim()} title="Send">↑</button>
          )}
        </div>
      </section>

      {(plan.length > 0 || showComputer) && (
        <aside className="side-panel">
          {plan.length > 0 && (
            <div className="panel">
              <div className="panel-title">Plan</div>
              <PlanList todos={plan} />
            </div>
          )}
          {showComputer && <ComputerPanel coworkerId={coworker.id} />}
        </aside>
      )}
    </div>
  );
}

function ItemView({ item, coworker }: { item: Item; coworker: Coworker }) {
  switch (item.kind) {
    case "user":
      return <div className="msg msg-user"><div className="bubble">{item.text}</div></div>;
    case "assistant":
      return (
        <div className="msg msg-assistant">
          <Avatar emoji={coworker.emoji} color={coworker.color} size={26} />
          <div className="assistant-body">
            <Markdown text={item.text} />
            {item.streaming && <span className="caret" />}
          </div>
        </div>
      );
    case "tool":
      return <div className="msg-tool"><ToolCard item={item} /></div>;
    case "approval":
      return <div className="msg-tool"><ApprovalCard item={item} /></div>;
    case "question":
      return <div className="msg-tool"><QuestionCard item={item} /></div>;
    case "notice":
      return <div className={`notice notice-${item.tone}`}>{item.text}</div>;
  }
}

function reduce(prev: Item[], e: any): Item[] {
  const upd = <T extends Item>(id: string, f: (x: T) => T) => prev.map((x) => (x.id === id ? f(x as T) : x));
  switch (e.type) {
    case "TEXT_MESSAGE_START":
      return [...prev, { kind: "assistant", id: e.messageId, text: "", streaming: true }];
    case "TEXT_MESSAGE_CONTENT":
      return prev.some((x) => x.id === e.messageId)
        ? upd<any>(e.messageId, (x) => ({ ...x, text: x.text + e.delta }))
        : [...prev, { kind: "assistant", id: e.messageId, text: e.delta, streaming: true }];
    case "TEXT_MESSAGE_END":
      return upd<any>(e.messageId, (x) => ({ ...x, streaming: false }));
    case "TOOL_CALL_START":
      if (prev.some((x) => x.id === e.toolCallId)) return prev;
      return [...prev, { kind: "tool", id: e.toolCallId, name: e.toolCallName, args: "", status: "running", steps: [] }];
    case "TOOL_CALL_ARGS":
      return upd<ToolItem>(e.toolCallId, (x) => ({ ...x, args: x.args + e.delta }));
    case "TOOL_CALL_RESULT":
      return upd<ToolItem>(e.toolCallId, (x) => ({ ...x, result: e.content, status: "done" }));
    case "STEP_STARTED":
    case "STEP_FINISHED": {
      const idx = [...prev].reverse().findIndex((x) => x.kind === "tool" && x.status === "running");
      if (idx < 0) return prev;
      const real = prev.length - 1 - idx;
      const t = prev[real] as ToolItem;
      const steps = [...(t.steps ?? [])];
      if (e.type === "STEP_STARTED") steps.push({ name: e.stepName, done: false });
      else {
        const s = steps.findIndex((s) => s.name === e.stepName && !s.done);
        if (s >= 0) steps[s] = { ...steps[s], done: true };
      }
      return prev.map((x, i) => (i === real ? { ...t, steps } : x));
    }
    case "CUSTOM":
      switch (e.name) {
        case "tool_ui":
          return upd<ToolItem>(e.value.toolCallId, (x) => ({ ...x, ui: e.value.ui, data: e.value.data, isError: e.value.isError }));
        case "approval_requested":
          return [...prev, { kind: "approval", id: e.value.id, tool: e.value.tool, args: e.value.args, reason: e.value.reason, effect: e.value.effect, status: "pending" }];
        case "approval_resolved":
          return upd<ApprovalItem>(e.value.id, (x) => ({ ...x, status: e.value.approved ? "approved" : "denied", response: e.value.response }));
        case "input_requested":
          return [...prev, { kind: "question", id: e.value.id, question: e.value.question, choices: e.value.choices ?? [], status: "pending" }];
        case "input_resolved":
          return upd<QuestionItem>(e.value.id, (x) => ({ ...x, status: "answered", response: e.value.response }));
        case "policy_refused":
          return [...prev, { kind: "notice", id: nid(), tone: "bad", text: `⛔ Blocked by Boundaries: ${e.value.tool} — ${e.value.rule}` }];
        case "subagent_started":
          return [...prev, { kind: "notice", id: nid(), tone: "info", text: `↳ Subagent ${e.value.index + 1} (${e.value.coworker}) started: ${e.value.goal}` }];
      }
      return prev;
    case "RUN_ERROR":
      return [...prev.map((x) => (x.kind === "assistant" ? { ...x, streaming: false } : x)), { kind: "notice", id: nid(), tone: "bad", text: `⚠️ ${e.message}` }];
    case "RUN_FINISHED":
      return prev.map((x) => (x.kind === "assistant" && x.streaming ? { ...x, streaming: false } : x.kind === "tool" && x.status === "running" ? { ...x, status: "done" } : x));
  }
  return prev;
}

function fromHistory(messages: any[], approvals: any[]): Item[] {
  const out: Item[] = [];
  const tools = new Map<string, ToolItem>();
  for (const m of messages) {
    if (m.role === "user") out.push({ kind: "user", id: m.id, text: m.content });
    else if (m.role === "assistant") {
      if (m.content) out.push({ kind: "assistant", id: m.id, text: m.content });
      for (const tc of m.toolCalls ?? []) {
        const t: ToolItem = { kind: "tool", id: tc.id, name: tc.name, args: tc.arguments, status: "done" };
        tools.set(tc.id, t);
        out.push(t);
      }
    } else if (m.role === "tool") {
      const t = tools.get(m.toolCallId);
      if (t) {
        t.result = m.content;
        if (m.ui) Object.assign(t, { ui: m.ui.ui || undefined, data: m.ui.data, isError: m.ui.isError });
      }
    }
  }
  for (const a of approvals ?? []) {
    if (a.kind === "question") out.push({ kind: "question", id: a.id, question: a.reason, choices: [], status: "pending" });
    else out.push({ kind: "approval", id: a.id, tool: a.tool, args: a.args ? JSON.parse(a.args) : {}, reason: a.reason, status: "pending" });
  }
  return out;
}
