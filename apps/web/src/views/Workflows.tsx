import { useEffect, useMemo, useState } from "react";
import { api, stream, timeAgo } from "../api.ts";
import { Button, Empty, JsonBlock, PageHeader, Pill } from "../ui.tsx";
import { WorkflowTrace } from "../chat/cards.tsx";
import { WorkflowBuilder } from "./WorkflowBuilder.tsx";

const TYPE_COLOR: Record<string, string> = {
  start: "#64748b", end: "#64748b", llm: "#6d5dfc", agent: "#c026d3", tool: "#0ea5a4", http: "#0284c7",
  code: "#ca8a04", template: "#78716c", if_else: "#ea580c", knowledge: "#16a34a", iteration: "#db2777", aggregator: "#57534e",
};

const BLANK = {
  id: "",
  name: "",
  description: "",
  exposeAsTool: true,
  inputs: [{ name: "text", type: "string", required: true, description: "What to work on" }],
  nodes: [
    { id: "start", type: "start", title: "Start", position: { x: 40, y: 60 } },
    { id: "llm1", type: "llm", title: "Ask a model", data: { prompt: "Rewrite this clearly and concisely:\n\n{{inputs.text}}" }, position: { x: 270, y: 60 } },
    { id: "end", type: "end", title: "End", data: { outputs: { result: "{{llm1.text}}" } }, position: { x: 500, y: 60 } },
  ],
  edges: [{ source: "start", target: "llm1" }, { source: "llm1", target: "end" }],
};

export function Workflows({ id }: { id?: string }) {
  const [list, setList] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [createErr, setCreateErr] = useState("");
  const load = () => api("/api/workflows").then(setList);
  useEffect(() => {
    load();
  }, [id]);
  if (id) return <WorkflowDetail id={id} onSaved={load} />;
  const create = async () => {
    setCreateErr("");
    const name = newName.trim();
    if (!name) return setCreateErr("Give it a name.");
    let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "workflow";
    if (!/^[a-z0-9]/.test(slug)) slug = `wf-${slug}`;
    for (let i = 2; list.some((w) => w.id === slug); i++) slug = `${slug.replace(/-\d+$/, "")}-${i}`;
    try {
      const w = await api(`/api/workflows/${slug}`, { method: "PUT", body: { ...BLANK, id: slug, name, description: newDesc.trim() } });
      location.hash = `#/workflows/${w.id}`;
    } catch (e) {
      setCreateErr((e as Error).message);
    }
  };
  return (
    <div className="page">
      <PageHeader
        title="Workflows"
        subtitle="Repeatable pipelines of model, agent, tool, HTTP, code, branch and retrieval steps. Every step runs through Boundaries."
        actions={!creating && <Button kind="primary" onClick={() => setCreating(true)}>+ New workflow</Button>}
      />
      {creating && (
        <form className="card stack" onSubmit={(e) => (e.preventDefault(), create())}>
          <h3>New workflow</h3>
          <div className="row gap wrap">
            <label className="field grow"><span>Name</span><input className="input" autoFocus placeholder="e.g. Weekly competitor digest" value={newName} onChange={(e) => setNewName(e.target.value)} /></label>
            <label className="field grow"><span>What it does <span className="muted small">(optional)</span></span><input className="input" placeholder="Fetches competitor sites and summarises changes" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} /></label>
          </div>
          {createErr && <div className="tool-error">{createErr}</div>}
          <div className="row gap"><Button kind="primary" type="submit">Create & open builder</Button><Button kind="ghost" onClick={() => setCreating(false)}>Cancel</Button></div>
        </form>
      )}
      {list.length === 0 ? (
        <Empty title="No workflows" />
      ) : (
        <div className="page-grid">
          {list.map((w) => (
            <a key={w.id} href={`#/workflows/${w.id}`} className="page-tile">
              <div className="page-tile-title">{w.name}</div>
              <div className="page-tile-excerpt">{w.description}</div>
              <div className="row gap wrap small">
                <Pill>{w.nodes.length} nodes</Pill>
                {w.exposeAsTool && <Pill tone="accent">tool: wf_{w.id.replace(/-/g, "_")}</Pill>}
                {[...new Set(w.nodes.map((n: any) => n.type))].filter((t) => t !== "start" && t !== "end").map((t: any) => (
                  <span key={t} className="type-chip" style={{ background: TYPE_COLOR[t] }}>{t}</span>
                ))}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function layout(def: any): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {};
  const hasAll = def.nodes.every((n: any) => n.position);
  if (hasAll) {
    for (const n of def.nodes) pos[n.id] = n.position;
    return pos;
  }
  const level: Record<string, number> = {};
  const visit = (id: string, d: number) => {
    if ((level[id] ?? -1) >= d) return;
    level[id] = d;
    for (const e of def.edges.filter((e: any) => e.source === id)) visit(e.target, d + 1);
  };
  const start = def.nodes.find((n: any) => n.type === "start");
  if (start) visit(start.id, 0);
  const rows: Record<number, number> = {};
  for (const n of def.nodes) {
    const l = level[n.id] ?? 0;
    rows[l] = (rows[l] ?? 0) + 1;
    pos[n.id] = { x: 40 + l * 220, y: 40 + (rows[l] - 1) * 110 };
  }
  return pos;
}

function Graph({ def, trace }: { def: any; trace?: any[] }) {
  const pos = useMemo(() => layout(def), [def]);
  const W = 170, H = 54;
  const xs = Object.values(pos).map((p) => p.x), ys = Object.values(pos).map((p) => p.y);
  const minX = Math.min(...xs) - 20, minY = Math.min(...ys) - 30;
  const width = Math.max(...xs) - minX + W + 40, height = Math.max(...ys) - minY + H + 50;
  const status = (id: string) => trace?.find((t) => t.id === id)?.status;
  return (
    <div className="graph-wrap">
      <svg viewBox={`${minX} ${minY} ${width} ${height}`} width={width} height={height} className="graph">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" /></marker>
        </defs>
        {def.edges.map((e: any, i: number) => {
          const a = pos[e.source], b = pos[e.target];
          if (!a || !b) return null;
          const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
          const active = trace && status(e.source) === "succeeded" && status(e.target) === "succeeded";
          return (
            <g key={i}>
              <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke={active ? "var(--ok)" : "var(--border-strong)"} strokeWidth={active ? 2.5 : 1.6} markerEnd="url(#arrow)" />
              {e.sourceHandle && <text x={mx} y={(y1 + y2) / 2 - 6} className="edge-label" textAnchor="middle">{e.sourceHandle}</text>}
            </g>
          );
        })}
        {def.nodes.map((n: any) => {
          const p = pos[n.id];
          const s = status(n.id);
          return (
            <g key={n.id} transform={`translate(${p.x},${p.y})`} className={`gnode ${s ?? ""}`}>
              <rect width={W} height={H} rx={10} className="gnode-box" />
              <rect width={6} height={H} rx={3} fill={TYPE_COLOR[n.type] ?? "#888"} />
              <text x={16} y={22} className="gnode-title">{(n.title ?? n.id).slice(0, 20)}</text>
              <text x={16} y={40} className="gnode-type">{n.type}{s ? ` · ${s}` : ""}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function WorkflowDetail({ id, onSaved }: { id: string; onSaved: () => void }) {
  const [def, setDef] = useState<any>(null);
  const [tab, setTab] = useState<"build" | "run" | "json" | "history">("build");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [run, setRun] = useState<any>(null);
  const [live, setLive] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [json, setJson] = useState("");
  const [err, setErr] = useState("");
  const [runs, setRuns] = useState<any[]>([]);

  useEffect(() => {
    api(`/api/workflows/${id}`).then((d) => {
      setDef(d);
      setJson(JSON.stringify(d, null, 2));
    });
    api(`/api/workflows/${id}/runs`).then(setRuns);
  }, [id]);

  const execute = async () => {
    setBusy(true);
    setRun(null);
    setLive([]);
    try {
      await stream(`/api/workflows/${id}/run?stream=1`, { inputs }, (e) => {
        if (e.type === "STEP_STARTED") setLive((l) => [...l, e.stepName]);
        if (e.type === "WORKFLOW_FINISHED") setRun(e.result);
      });
      api(`/api/workflows/${id}/runs`).then(setRuns);
    } finally {
      setBusy(false);
    }
  };

  const saveJson = async () => {
    try {
      const parsed = JSON.parse(json);
      const saved = await api(`/api/workflows/${id}`, { method: "PUT", body: parsed });
      setDef(saved);
      setErr("");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (!def) return <div className="page muted">Loading…</div>;
  return (
    <div className="page">
      <div className="row gap"><Button kind="ghost" onClick={() => (location.hash = "#/workflows")}>← Workflows</Button></div>
      <PageHeader title={def.name} subtitle={def.description} actions={def.exposeAsTool ? <Pill tone="accent">coworker tool · wf_{def.id.replace(/-/g, "_")}</Pill> : undefined} />
      <div className="segmented" style={{ margin: "4px 0 0" }}>
        <button className={tab === "build" ? "on" : ""} onClick={() => setTab("build")}>Build</button>
        <button className={tab === "run" ? "on" : ""} onClick={() => setTab("run")}>Run</button>
        <button className={tab === "json" ? "on" : ""} onClick={() => (setJson(JSON.stringify(def, null, 2)), setTab("json"))}>Definition (JSON)</button>
        <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>History ({runs.length})</button>
      </div>
      {tab === "build" && <WorkflowBuilder key={def.id} initial={def} onSaved={(d) => (setDef(d), onSaved())} />}
      {tab !== "build" && <Graph def={def} trace={run?.trace} />}
      {tab === "run" && (
        <div className="two-col">
          <div className="card stack">
            {def.inputs.map((i: any) => (
              <label key={i.name} className="field">
                <span>{i.name}{i.required && " *"} <span className="muted small">{i.type ?? "string"}{i.description ? ` — ${i.description}` : ""}</span></span>
                {i.type === "array" || i.type === "object" ? (
                  <textarea className="input mono" rows={3} placeholder={i.type === "array" ? '["one", "two"]' : "{}"} value={inputs[i.name] ?? ""} onChange={(e) => setInputs({ ...inputs, [i.name]: e.target.value })} />
                ) : (
                  <input className="input" value={inputs[i.name] ?? ""} onChange={(e) => setInputs({ ...inputs, [i.name]: e.target.value })} />
                )}
              </label>
            ))}
            <Button kind="primary" disabled={busy} onClick={execute}>{busy ? "Running…" : "▶ Run workflow"}</Button>
            {busy && <div className="steps">{live.map((s, i) => <span key={i} className="step">… {s}</span>)}</div>}
          </div>
          <div className="card stack">
            {run ? (
              <>
                <WorkflowTrace run={run} />
                <div className="muted small">Outputs</div>
                <JsonBlock value={run.outputs} />
              </>
            ) : (
              <div className="muted">Outputs appear here. The graph lights up with each node's status.</div>
            )}
          </div>
        </div>
      )}
      {tab === "json" && (
        <div className="stack">
          <textarea className="input mono json-editor" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
          {err && <div className="tool-error">{err}</div>}
          <div className="row gap">
            <Button kind="primary" onClick={saveJson}>Save definition</Button>
            <Button kind="ghost" onClick={() => confirm("Delete workflow?") && api(`/api/workflows/${id}`, { method: "DELETE" }).then(() => (onSaved(), (location.hash = "#/workflows")))}>Delete</Button>
          </div>
        </div>
      )}
      {tab === "history" && (
        <div className="table">
          {runs.map((r) => (
            <div key={r.id} className="table-row" onClick={() => (setRun({ ...r, workflowId: id, runId: r.id, ms: (r.finished_at ?? r.created_at) - r.created_at }), setTab("run"))}>
              <Pill tone={r.status === "succeeded" ? "ok" : r.status === "failed" ? "bad" : "info"}>{r.status}</Pill>
              <span className="grow mono small">{JSON.stringify(r.inputs).slice(0, 100)}</span>
              <span className="muted small">{timeAgo(r.created_at)}</span>
            </div>
          ))}
          {!runs.length && <Empty title="No runs yet" />}
        </div>
      )}
    </div>
  );
}
