import { useEffect, useState } from "react";
import { api, timeAgo, type Coworker } from "../api.ts";
import { Button, Empty, JsonBlock, PageHeader, Pill, STATUS_TONE } from "../ui.tsx";
import { ApprovalCard, PlanList } from "../chat/cards.tsx";

export function Activity({ coworkers, tick }: { coworkers: Coworker[]; tick: number }) {
  const [tasks, setTasks] = useState<any[]>([]);
  const [schedules, setSchedules] = useState<any[]>([]);
  const [approvals, setApprovals] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ coworker: coworkers[0]?.id ?? "assistant", title: "", prompt: "" });
  const [sched, setSched] = useState({ coworker: coworkers[0]?.id ?? "assistant", name: "", cron: "0 9 * * 1-5", prompt: "" });

  const load = () => {
    api("/api/tasks").then(setTasks);
    api("/api/schedules").then(setSchedules);
    api("/api/approvals").then(setApprovals);
  };
  useEffect(load, [tick]);

  const act = (id: string, a: string) => api(`/api/tasks/${id}/${a}`, { method: "POST" }).then(load).catch((e) => alert(e.message));
  const cw = (id: string) => coworkers.find((c) => c.id === id);

  return (
    <div className="page">
      <PageHeader title="Activity" subtitle="Background tasks, schedules and everything waiting on you." />

      {approvals.length > 0 && (
        <section className="section">
          <h2>Waiting on you <Pill tone="warn">{approvals.length}</Pill></h2>
          <div className="stack">
            {approvals.map((a) =>
              a.kind === "question" ? (
                <div key={a.id} className="card">
                  <b>❓ {a.reason}</b> <span className="muted small">— {a.coworker_id}</span>
                  <div className="row gap">
                    <input className="input grow" id={`ans-${a.id}`} placeholder="Answer…" />
                    <Button kind="primary" onClick={() => api(`/api/approvals/${a.id}`, { body: { approved: true, response: (document.getElementById(`ans-${a.id}`) as HTMLInputElement).value } }).then(load)}>Answer</Button>
                  </div>
                </div>
              ) : (
                <div key={a.id}>
                  <div className="muted small">{cw(a.coworker_id)?.name ?? a.coworker_id} · <a href={`#/chat/${a.coworker_id}/${a.thread_id}`}>open conversation</a></div>
                  <ApprovalCard item={{ kind: "approval", id: a.id, tool: a.tool, args: a.args ? JSON.parse(a.args) : {}, reason: a.reason, status: a.status }} />
                </div>
              ),
            )}
          </div>
        </section>
      )}

      <section className="section">
        <h2>Tasks</h2>
        <form className="card row gap wrap" onSubmit={(e) => {
          e.preventDefault();
          if (!form.prompt) return;
          api("/api/tasks", { body: form }).then(() => (setForm({ ...form, title: "", prompt: "" }), load()));
        }}>
          <select className="input" value={form.coworker} onChange={(e) => setForm({ ...form, coworker: e.target.value })}>
            {coworkers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input className="input" placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <input className="input grow" placeholder="Delegate a long-running task…" value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
          <Button kind="primary" type="submit">Start</Button>
        </form>
        {tasks.length === 0 ? (
          <Empty title="No background tasks yet">Ask a coworker to "do this in the background", or start one above.</Empty>
        ) : (
          <div className="table">
            {tasks.map((t) => (
              <div key={t.id} className="table-row-group">
                <div className="table-row" onClick={() => setOpen(open === t.id ? null : t.id)}>
                  <Pill tone={STATUS_TONE[t.status] ?? "neutral"}>{t.status.replace("_", " ")}</Pill>
                  <span className="grow"><b>{t.title}</b> <span className="muted small">· {cw(t.coworker_id)?.name ?? t.coworker_id}</span></span>
                  {t.plan && <span className="muted small">{t.plan.filter((p: any) => p.status === "completed").length}/{t.plan.length}</span>}
                  <span className="muted small">{timeAgo(t.updated_at)}</span>
                  <span className="row gap" onClick={(e) => e.stopPropagation()}>
                    {["running", "waiting_input", "queued"].includes(t.status) && <Button small onClick={() => act(t.id, "pause")}>Pause</Button>}
                    {t.status === "paused" && <Button small onClick={() => act(t.id, "resume")}>Resume</Button>}
                    {["failed", "interrupted", "cancelled"].includes(t.status) && <Button small onClick={() => act(t.id, "retry")}>{t.status === "interrupted" ? "Retry after review" : "Retry"}</Button>}
                    {!["succeeded", "failed", "cancelled"].includes(t.status) && <Button small kind="ghost" onClick={() => act(t.id, "cancel")}>Cancel</Button>}
                  </span>
                </div>
                {open === t.id && (
                  <div className="table-detail">
                    <div className="muted small">Instruction</div>
                    <div>{t.prompt}</div>
                    {t.plan && <PlanList todos={t.plan} />}
                    {t.error && <div className="tool-error">{t.error}</div>}
                    {t.result && <><div className="muted small">Result</div><JsonBlock value={t.result} /></>}
                    <a href={`#/chat/${t.coworker_id}/${t.thread_id}`}>Open conversation →</a>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <h2>Schedules</h2>
        <form className="card row gap wrap" onSubmit={(e) => {
          e.preventDefault();
          if (!sched.prompt || !sched.name) return;
          api("/api/schedules", { body: sched }).then(() => (setSched({ ...sched, name: "", prompt: "" }), load())).catch((e) => alert(e.message));
        }}>
          <select className="input" value={sched.coworker} onChange={(e) => setSched({ ...sched, coworker: e.target.value })}>
            {coworkers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input className="input" placeholder="Name" value={sched.name} onChange={(e) => setSched({ ...sched, name: e.target.value })} />
          <input className="input mono" style={{ width: 140 }} title="minute hour day month weekday" value={sched.cron} onChange={(e) => setSched({ ...sched, cron: e.target.value })} />
          <input className="input grow" placeholder="Instruction to run each time…" value={sched.prompt} onChange={(e) => setSched({ ...sched, prompt: e.target.value })} />
          <Button kind="primary" type="submit">Schedule</Button>
        </form>
        {schedules.length === 0 ? (
          <Empty title="Nothing scheduled">Try telling a coworker "every weekday at 9am: …"</Empty>
        ) : (
          <div className="table">
            {schedules.map((s) => (
              <div key={s.id} className="table-row">
                <Pill tone={s.enabled ? "ok" : "neutral"}>{s.enabled ? "on" : "paused"}</Pill>
                <span className="grow"><b>{s.name}</b> <span className="muted small">· {cw(s.coworker_id)?.name ?? s.coworker_id}</span><div className="small muted">{s.prompt}</div></span>
                <span className="mono small">{s.cron}</span>
                <span className="muted small">{s.last_run_at ? `last ${timeAgo(s.last_run_at)}` : "never run"}</span>
                <Button small onClick={() => api(`/api/schedules/${s.id}/run`, { method: "POST" }).then(load)}>Run now</Button>
                <Button small onClick={() => api(`/api/schedules/${s.id}`, { method: "PUT", body: { enabled: !s.enabled } }).then(load)}>{s.enabled ? "Pause" : "Enable"}</Button>
                <Button small kind="ghost" onClick={() => confirm("Delete schedule?") && api(`/api/schedules/${s.id}`, { method: "DELETE" }).then(load)}>Delete</Button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
