import { useState } from "react";
import { api } from "../api.ts";
import { Button, JsonBlock, Markdown, Pill, STATUS_TONE } from "../ui.tsx";

export type ToolItem = {
  kind: "tool";
  id: string;
  name: string;
  args: string;
  result?: string;
  ui?: string;
  data?: any;
  isError?: boolean;
  status: "running" | "done";
  steps?: { name: string; done: boolean }[];
};

const TOOL_LABEL: Record<string, string> = {
  memory: "Memory",
  skill_view: "Skill",
  skill_manage: "Skill",
  session_search: "Recall",
  todo: "Plan",
  clarify: "Question",
  web_fetch: "Read page",
  web_search: "Search",
  page_save: "Save page",
  page_search: "Search pages",
  page_read: "Read page",
  knowledge_search: "Knowledge",
  knowledge_add: "Knowledge",
  delegate: "Delegate",
  schedule_create: "Schedule",
  task_create: "Background task",
  workflow_run: "Workflow",
  workflow_save: "Workflow",
  terminal: "Terminal",
  http_request: "HTTP",
  code_run: "Code",
};

function label(name: string): string {
  if (TOOL_LABEL[name]) return TOOL_LABEL[name];
  if (name.startsWith("browser_")) return "Browser";
  if (name.startsWith("desktop_")) return "Desktop";
  if (name.startsWith("fs_")) return "Files";
  if (name.startsWith("wf_")) return "Workflow";
  if (name.startsWith("mcp__")) return name.split("__")[1];
  return name;
}

function parseArgs(s: string): any {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return s;
  }
}

function summary(name: string, a: any): string {
  if (!a || typeof a !== "object") return "";
  return String(a.url ?? a.query ?? a.title ?? a.command ?? a.path ?? a.id ?? a.name ?? a.content ?? a.goal ?? a.ref ?? a.app ?? a.text ?? (a.tasks ? `${a.tasks.length} task(s)` : "") ?? "").slice(0, 90) || (name === "todo" ? "" : "");
}

export function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const args = parseArgs(item.args);
  const tone = item.status === "running" ? "running" : item.isError ? "error" : "ok";
  const body = renderBody(item, args);
  return (
    <div className={`tool-card tool-${tone}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className={`dot dot-${tone}`} />
        <span className="tool-label">{label(item.name)}</span>
        <span className="tool-summary">{summary(item.name, args)}</span>
        <span className="tool-name mono">{item.name}</span>
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {item.steps && item.steps.length > 0 && item.status === "running" && (
        <div className="steps">
          {item.steps.map((s, i) => (
            <span key={i} className={`step ${s.done ? "done" : ""}`}>{s.done ? "✓" : "…"} {s.name}</span>
          ))}
        </div>
      )}
      {body && <div className="tool-body">{body}</div>}
      {open && (
        <div className="tool-raw">
          <div className="muted small">Arguments</div>
          <JsonBlock value={args} />
          {item.result !== undefined && (
            <>
              <div className="muted small">Result</div>
              <JsonBlock value={item.result} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function renderBody(item: ToolItem, args: any) {
  const d = item.data;
  if (item.isError && item.result) return <div className="tool-error">{item.result}</div>;
  switch (item.ui) {
    case "plan":
      return <PlanList todos={d ?? []} />;
    case "browser":
      return (
        <div className="browser-card">
          <div className="browser-bar mono">{d?.url}</div>
          {d?.screenshot ? <img src={`data:image/jpeg;base64,${d.screenshot}`} alt={d?.title ?? "page"} /> : <div className="muted small">{d?.title}</div>}
        </div>
      );
    case "page":
      return (
        <a className="page-card" href={`#/spaces/${d?.id}`}>
          <div className="page-card-title">📄 {d?.title}</div>
          <div className="muted small">Space {d?.space} · revision {d?.revision}</div>
          <div className="page-card-excerpt">{String(d?.excerpt ?? "").slice(0, 220)}</div>
        </a>
      );
    case "workflow":
      return <WorkflowTrace run={d} />;
    case "sources":
      return (
        <ol className="sources">
          {(d ?? []).map((s: any, i: number) => (
            <li key={i}>
              <b>{s.title}</b> <span className="muted small">{s.dataset}</span>
              <div className="small">{s.excerpt}</div>
            </li>
          ))}
        </ol>
      );
    case "search":
      return (
        <ol className="sources">
          {(d ?? []).map((s: any, i: number) => (
            <li key={i}>
              <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
              <div className="small muted">{String(s.snippet ?? "").slice(0, 200)}</div>
            </li>
          ))}
        </ol>
      );
    case "terminal":
      return (
        <pre className="terminal">
          <span className="prompt">$ {d?.command}</span>
          {"\n"}
          {d?.output}
          <span className={d?.exitCode === 0 ? "exit-ok" : "exit-bad"}>{`\n[exit ${d?.exitCode}]`}</span>
        </pre>
      );
    case "file":
      return (
        <div>
          <div className="mono small">📁 {d?.path}</div>
          <pre className="code">{d?.preview}</pre>
        </div>
      );
    case "subagents":
      return (
        <div className="subagents">
          {(d ?? []).map((r: any, i: number) => (
            <div key={i} className="subagent">
              <div className="small"><b>{r.coworker}</b> — {r.goal}</div>
              <Markdown text={r.text} />
            </div>
          ))}
        </div>
      );
    case "web":
      return (
        <div className="small">
          <a href={d?.url} target="_blank" rel="noreferrer"><b>{d?.title || d?.url}</b></a>
          <div className="muted">{d?.excerpt}</div>
        </div>
      );
    case "schedule":
      return <div className="small">⏰ <b>{d?.name}</b> <span className="mono">{d?.cron}</span></div>;
    case "task":
      return <div className="small">⚙️ Background task <a href="#/activity"><b>{d?.title}</b></a> started</div>;
    case "desktop":
      return <pre className="code">{String(d?.snapshot ?? "").slice(0, 1500)}</pre>;
  }
  if (item.name === "memory" && item.result) return <div className="small">🧠 {args?.content ?? item.result} <span className="muted">— {item.result}</span></div>;
  return null;
}

export function PlanList({ todos }: { todos: { id: string; content: string; status: string }[] }) {
  if (!todos.length) return null;
  return (
    <ul className="plan">
      {todos.map((t) => (
        <li key={t.id} className={`plan-${t.status}`}>
          <span className="plan-box">{t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : t.status === "cancelled" ? "✕" : ""}</span>
          {t.content}
        </li>
      ))}
    </ul>
  );
}

export function WorkflowTrace({ run }: { run: any }) {
  if (!run) return null;
  return (
    <div className="wf-trace">
      <div className="row gap small">
        <Pill tone={run.status === "succeeded" ? "ok" : "bad"}>{run.status}</Pill>
        <span className="mono">{run.workflowId}</span>
        <span className="muted">{run.ms} ms</span>
      </div>
      <div className="wf-nodes">
        {(run.trace ?? []).map((n: any) => (
          <div key={n.id} className={`wf-node wf-${n.status}`} title={n.error ?? ""}>
            <span className="wf-type">{n.type}</span>
            <span>{n.title ?? n.id}</span>
            {n.status !== "skipped" && <span className="muted">{n.ms}ms</span>}
          </div>
        ))}
      </div>
      {run.error && <div className="tool-error">{run.error}</div>}
    </div>
  );
}

export type ApprovalItem = { kind: "approval"; id: string; tool: string; args: any; reason: string; effect?: string; status: string; response?: string };
export type QuestionItem = { kind: "question"; id: string; question: string; choices: string[]; status: string; response?: string };

export function ApprovalCard({ item }: { item: ApprovalItem }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const decide = async (approved: boolean) => {
    setBusy(true);
    try {
      await api(`/api/approvals/${item.id}`, { body: { approved, response: note || undefined } });
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pending = item.status === "pending";
  return (
    <div className={`approval ${pending ? "approval-pending" : ""}`}>
      <div className="row gap">
        <span className="approval-icon">✋</span>
        <div className="grow">
          <div><b>Approval needed</b> · <span className="mono">{item.tool}</span> {item.effect && <Pill tone="warn">{item.effect}</Pill>}</div>
          <div className="small muted">{item.reason}</div>
        </div>
        {!pending && <Pill tone={STATUS_TONE[item.status] ?? "neutral"}>{item.status}</Pill>}
      </div>
      <JsonBlock value={item.args} max={1200} />
      {pending && (
        <div className="row gap">
          <input className="input grow" placeholder="Optional note to the agent…" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button kind="danger" disabled={busy} onClick={() => decide(false)}>Deny</Button>
          <Button kind="primary" disabled={busy} onClick={() => decide(true)}>Approve</Button>
        </div>
      )}
    </div>
  );
}

export function QuestionCard({ item }: { item: QuestionItem }) {
  const [text, setText] = useState("");
  const answer = (response: string) => api(`/api/approvals/${item.id}`, { body: { approved: true, response } }).catch((e) => alert(e.message));
  return (
    <div className="approval question">
      <div className="row gap">
        <span className="approval-icon">❓</span>
        <b className="grow">{item.question}</b>
        {item.status !== "pending" && <Pill tone="ok">answered</Pill>}
      </div>
      {item.status === "pending" ? (
        <>
          {item.choices.length > 0 && (
            <div className="row gap wrap">
              {item.choices.map((c) => (
                <Button key={c} onClick={() => answer(c)}>{c}</Button>
              ))}
            </div>
          )}
          <form className="row gap" onSubmit={(e) => (e.preventDefault(), text && answer(text))}>
            <input className="input grow" placeholder="Type an answer…" value={text} onChange={(e) => setText(e.target.value)} />
            <Button kind="primary" type="submit">Answer</Button>
          </form>
        </>
      ) : (
        <div className="small muted">→ {item.response}</div>
      )}
    </div>
  );
}
