import { useEffect, useState } from "react";
import { api, timeAgo, type Coworker } from "../api.ts";
import { Button, JsonBlock, PageHeader, Pill, STATUS_TONE } from "../ui.tsx";

type Policy = { mode: "enforce" | "dry-run"; deny: string[]; requireApproval: string[]; allow: string[]; labels?: Record<string, { name: string; description: string }> };

const EXAMPLES = [
  'action.effect == "destructive"',
  'tool.name == "browser_click" && element.name.matches("(?i)submit|pay|buy")',
  'has(page) && !page.host.endsWith("mycompany.com") && action.effect != "read"',
  'tool.name == "terminal" && command.program in ["rm", "dd", "mkfs"]',
  'coworker.id == "researcher" && tool.toolset == "files"',
  'initiator in ["schedule", "task"] && action.effect == "external"',
];

export function Boundaries({ coworkers, tick }: { coworkers: Coworker[]; tick: number }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [err, setErr] = useState("");
  const [audit, setAudit] = useState<any[]>([]);
  const [filter, setFilter] = useState("");
  const [test, setTest] = useState({ coworker: "assistant", tool: "fs_delete", args: '{"path": "notes.txt"}', context: "{}" });
  const [result, setResult] = useState<any>(null);
  const [tools, setTools] = useState<any[]>([]);

  useEffect(() => {
    api<Policy>("/api/policy").then((p) => (setPolicy(p), setDraft(p)));
    api("/api/tools").then(setTools);
  }, []);
  useEffect(() => {
    api(`/api/audit?limit=300${filter ? `&coworker=${filter}` : ""}`).then(setAudit);
  }, [tick, filter]);

  if (!draft || !policy) return <div className="page muted">Loading…</div>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(policy);

  const save = async () => {
    try {
      const p = await api<Policy>("/api/policy", { method: "PUT", body: draft });
      setPolicy(p);
      setDraft(p);
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const list = (key: "deny" | "requireApproval" | "allow", title: string, help: string, tone: string) => (
    <div className={`rule-list rule-${tone}`}>
      <div className="row gap"><b className="grow">{title}</b><span className="muted small">{help}</span></div>
      {draft[key].map((r, i) => (
        <div key={i} className="row gap rule">
          <input className="input mono grow" value={r} onChange={(e) => setDraft({ ...draft, [key]: draft[key].map((x, j) => (j === i ? e.target.value : x)) })} />
          {draft.labels?.[r] && <span className="muted small" title={draft.labels[r].description}>{draft.labels[r].name}</span>}
          <Button small kind="ghost" onClick={() => setDraft({ ...draft, [key]: draft[key].filter((_, j) => j !== i) })}>✕</Button>
        </div>
      ))}
      <Button small onClick={() => setDraft({ ...draft, [key]: [...draft[key], ""] })}>+ Rule</Button>
    </div>
  );

  return (
    <div className="page">
      <PageHeader
        title="Boundaries"
        subtitle="Every action by every coworker, task, schedule, workflow and subagent is decided here first, then recorded. Deny beats approval beats allow; nothing is allowed unless a rule allows it; a rule that errors fails closed."
        actions={
          <>
            <div className="segmented">
              <button className={draft.mode === "enforce" ? "on" : ""} onClick={() => setDraft({ ...draft, mode: "enforce" })}>Enforce</button>
              <button className={draft.mode === "dry-run" ? "on" : ""} onClick={() => setDraft({ ...draft, mode: "dry-run" })}>Dry-run</button>
            </div>
            <Button kind="primary" disabled={!dirty} onClick={save}>Save policy</Button>
          </>
        }
      />
      {draft.mode === "dry-run" && <div className="notice notice-info">Dry-run: decisions are recorded with what enforce mode <i>would</i> have done, but nothing is blocked. Use it to test new rules against real traffic.</div>}
      {err && <div className="tool-error">{err}</div>}
      <div className="two-col">
        <div className="stack">
          {list("deny", "Never", "refused outright", "bad")}
          {list("requireApproval", "Ask first", "a person must approve", "warn")}
          {list("allow", "Allowed", "everything else is refused", "ok")}
          <details className="card small">
            <summary>Rule language</summary>
            <p>Expressions over <span className="mono">tool.name, tool.toolset, action.effect</span> (read, write, external, execute, destructive, learn), <span className="mono">coworker.id, initiator, args.*</span>, and — resolved by the server, never taken from the model — <span className="mono">page.url, page.host, element.role, element.name, key, file.path, file.exists, command.program, workflow.id, mcp.server</span>.</p>
            <p>Operators: <span className="mono">== != &lt; &gt; && || ! in</span>, <span className="mono">.startsWith() .endsWith() .contains() .matches("(?i)re")</span>, <span className="mono">has(x.y)</span>, <span className="mono">size()</span>, <span className="mono">list.exists(x, …)</span>.</p>
            {EXAMPLES.map((e) => <div key={e} className="mono example">{e}</div>)}
          </details>
        </div>
        <div className="card stack">
          <h3>Test a rule set</h3>
          <div className="row gap">
            <select className="input" value={test.coworker} onChange={(e) => setTest({ ...test, coworker: e.target.value })}>
              {coworkers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select className="input grow" value={test.tool} onChange={(e) => setTest({ ...test, tool: e.target.value })}>
              {tools.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.effect})</option>)}
            </select>
          </div>
          <label className="field"><span className="small">args</span><textarea className="input mono" rows={2} value={test.args} onChange={(e) => setTest({ ...test, args: e.target.value })} /></label>
          <label className="field"><span className="small">context (page, element, …)</span><textarea className="input mono" rows={2} value={test.context} onChange={(e) => setTest({ ...test, context: e.target.value })} /></label>
          <Button onClick={() => {
            try {
              api("/api/policy/test", { body: { coworker: test.coworker, tool: test.tool, args: JSON.parse(test.args || "{}"), context: JSON.parse(test.context || "{}") } }).then(setResult).catch((e) => setResult({ error: e.message }));
            } catch (e) {
              setResult({ error: (e as Error).message });
            }
          }}>Evaluate (saved policy)</Button>
          {result && (
            <div className="stack">
              {result.error ? <div className="tool-error">{result.error}</div> : (
                <>
                  <div className="row gap"><Pill tone={STATUS_TONE[result.wouldBe]}>{result.wouldBe}</Pill>{!result.granted && <Pill tone="bad">tool not granted</Pill>}<span className="mono small">{result.rule}</span></div>
                  {result.errors?.length > 0 && <JsonBlock value={result.errors} />}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <section className="section">
        <div className="row gap">
          <h2 className="grow">Audit trail</h2>
          <select className="input" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All coworkers</option>
            {coworkers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="table audit">
          {audit.map((a) => (
            <details key={a.id} className="table-row-group">
              <summary className="table-row">
                <span className="muted small nowrap">{timeAgo(a.ts)}</span>
                <Pill tone={STATUS_TONE[a.decision.split(" ")[0]] ?? (a.decision === "approved" ? "ok" : "neutral")}>{a.decision}</Pill>
                <span className="mono small">{a.tool}</span>
                {a.effect && <Pill>{a.effect}</Pill>}
                <span className="small">{a.coworker_id}</span>
                <Pill tone="info">{a.initiator}</Pill>
                <span className="grow muted small truncate">{a.result_summary ?? ""}</span>
                <span className={`small ${a.outcome === "ok" ? "ok" : "bad"}`}>{a.outcome}</span>
              </summary>
              <div className="table-detail">
                <div className="small">Rule: <span className="mono">{a.rule ?? "—"}</span> · mode {a.mode ?? "—"} · {a.duration_ms ?? 0} ms</div>
                <JsonBlock value={{ args: a.args ? JSON.parse(a.args) : null, context: a.context ? JSON.parse(a.context) : null }} />
              </div>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
