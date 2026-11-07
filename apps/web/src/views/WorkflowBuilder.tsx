import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { Button, Pill } from "../ui.tsx";

/**
 * Visual workflow builder: add steps from a palette, drag them on the canvas, connect them, and
 * configure each one in a form. Produces the same JSON the engine runs (and the Definition tab shows).
 */

type Node = { id: string; type: string; title?: string; data?: Record<string, any>; position?: { x: number; y: number } };
type Edge = { source: string; target: string; sourceHandle?: string };
type Input = { name: string; type?: string; required?: boolean; description?: string };
export type Def = { id: string; name: string; description?: string; coworker?: string; exposeAsTool?: boolean; inputs: Input[]; nodes: Node[]; edges: Edge[] };

export const TYPE_COLOR: Record<string, string> = {
  start: "#64748b", end: "#64748b", llm: "#6d5dfc", agent: "#c026d3", tool: "#0ea5a4", http: "#0284c7",
  code: "#ca8a04", template: "#78716c", if_else: "#ea580c", knowledge: "#16a34a", iteration: "#db2777", aggregator: "#57534e",
};

const PALETTE: { type: string; label: string; hint: string; data: Record<string, any>; outputs: string[] }[] = [
  { type: "llm", label: "Ask a model", hint: "Prompt an LLM; optionally get JSON back", data: { prompt: "" }, outputs: ["text", "json"] },
  { type: "agent", label: "Coworker", hint: "Hand a task to a coworker with its tools", data: { coworker: "assistant", prompt: "" }, outputs: ["text"] },
  { type: "tool", label: "Use a tool", hint: "Call any tool (save page, fetch web, search…)", data: { tool: "web_fetch", args: {} }, outputs: ["text", "json"] },
  { type: "knowledge", label: "Search knowledge", hint: "Retrieve passages from a knowledge base", data: { query: "", topK: 4 }, outputs: ["text", "results"] },
  { type: "if_else", label: "If / else", hint: "Branch on a condition", data: { cases: [{ id: "yes", when: "" }] }, outputs: ["matched"] },
  { type: "template", label: "Text template", hint: "Combine values into text", data: { template: "" }, outputs: ["text"] },
  { type: "http", label: "HTTP request", hint: "Call an API", data: { method: "GET", url: "" }, outputs: ["status", "body", "json"] },
  { type: "code", label: "Code (JavaScript)", hint: "Transform data with a short script", data: { code: "return { result: inputs.value };", inputs: {} }, outputs: ["result"] },
  { type: "iteration", label: "For each", hint: "Run another workflow for every item in a list", data: { items: "", workflow: "", itemName: "item", parallel: 2 }, outputs: ["results", "count"] },
  { type: "aggregator", label: "Merge branches", hint: "Take the first value that exists", data: { variables: [] }, outputs: ["value"] },
];
const OUTPUTS: Record<string, string[]> = Object.fromEntries(PALETTE.map((p) => [p.type, p.outputs]));
const LABEL: Record<string, string> = { start: "Start", end: "End", ...Object.fromEntries(PALETTE.map((p) => [p.type, p.label])) };

const W = 180, H = 58;

function nextId(def: Def, type: string): string {
  const base = type === "if_else" ? "branch" : type;
  for (let i = 1; ; i++) if (!def.nodes.some((n) => n.id === `${base}${i}`)) return `${base}${i}`;
}

function autoLayout(def: Def): Def {
  if (def.nodes.every((n) => n.position)) return def;
  const level: Record<string, number> = {};
  const visit = (id: string, d: number, seen = new Set<string>()) => {
    if (seen.has(id) || (level[id] ?? -1) >= d) return;
    level[id] = d;
    seen.add(id);
    for (const e of def.edges.filter((e) => e.source === id)) visit(e.target, d + 1, new Set(seen));
  };
  const start = def.nodes.find((n) => n.type === "start");
  if (start) visit(start.id, 0);
  const rows: Record<number, number> = {};
  return {
    ...def,
    nodes: def.nodes.map((n) => {
      if (n.position) return n;
      const l = level[n.id] ?? 0;
      rows[l] = (rows[l] ?? 0) + 1;
      return { ...n, position: { x: 40 + l * 230, y: 40 + (rows[l] - 1) * 100 } };
    }),
  };
}

/** Nodes that can reach `id` (their outputs are available to it). */
function upstream(def: Def, id: string): string[] {
  const out = new Set<string>();
  const walk = (t: string) => {
    for (const e of def.edges.filter((e) => e.target === t)) if (!out.has(e.source)) (out.add(e.source), walk(e.source));
  };
  walk(id);
  return [...out];
}

export function WorkflowBuilder({ initial, onSaved }: { initial: Def; onSaved: (d: Def) => void }) {
  const [def, setDef] = useState<Def>(() => autoLayout(structuredClone(initial)));
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [coworkers, setCoworkers] = useState<{ id: string; name: string }[]>([]);
  const [tools, setTools] = useState<{ name: string; toolset: string }[]>([]);
  const [models, setModels] = useState<{ key: string; embedding?: boolean }[]>([]);
  const [workflows, setWorkflows] = useState<{ id: string; name: string }[]>([]);
  const [datasets, setDatasets] = useState<string[]>([]);
  const lastField = useRef<{ el: HTMLInputElement | HTMLTextAreaElement; apply: (v: string) => void } | null>(null);

  useEffect(() => {
    api("/api/coworkers").then(setCoworkers);
    api("/api/tools").then(setTools);
    api("/api/models").then(setModels).catch(() => {});
    api("/api/workflows").then((w) => setWorkflows(w.filter((x: any) => x.id !== initial.id)));
    api("/api/knowledge").then((d) => setDatasets(d.map((x: any) => x.dataset))).catch(() => {});
  }, [initial.id]);

  const update = (f: (d: Def) => Def) => {
    setDef((d) => f(structuredClone(d)));
    setDirty(true);
    setErrors([]);
  };
  const node = def.nodes.find((n) => n.id === selected) ?? null;
  const setNode = (patch: Partial<Node>) => update((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === selected ? { ...n, ...patch } : n)) }));
  const setData = (patch: Record<string, any>) => node && setNode({ data: { ...(node.data ?? {}), ...patch } });

  // ── adding / removing steps ──
  const addStep = (type: string) => {
    const p = PALETTE.find((x) => x.type === type)!;
    update((d) => {
      const id = nextId(d, type);
      const after = d.nodes.find((n) => n.id === selected) ?? d.nodes.find((n) => n.type !== "end" && !d.edges.some((e) => e.source === n.id)) ?? d.nodes.find((n) => n.type === "start");
      const pos = after?.position ? { x: after.position.x + 230, y: after.position.y + (after.type === "if_else" ? 0 : 0) } : { x: 60, y: 60 };
      // Make room: shift everything to the right of the insertion point.
      if (after?.position) for (const n of d.nodes) if (n.position && n.position.x >= pos.x && Math.abs(n.position.y - pos.y) < 60) n.position = { ...n.position, x: n.position.x + 230 };
      const newNode: Node = { id, type, title: p.label, data: structuredClone(p.data), position: pos };
      d.nodes.push(newNode);
      if (after && after.type !== "end") {
        if (after.type === "if_else") {
          // Adding onto a branch: use the first case with no steps of its own yet (else the first case).
          const handles: string[] = [...(after.data?.cases ?? []).map((c: any) => c.id), "else"];
          const elseTargets = d.edges.filter((e) => e.source === after.id && e.sourceHandle === "else").map((e) => e.target);
          const h = handles.find((x) => x !== "else" && d.edges.filter((e) => e.source === after.id && e.sourceHandle === x).every((e) => elseTargets.includes(e.target))) ?? handles[0];
          const old = d.edges.filter((e) => e.source === after.id && e.sourceHandle === h);
          d.edges = d.edges.filter((e) => !old.includes(e));
          d.edges.push({ source: after.id, target: id, sourceHandle: h });
          // Rejoin where the branch used to go (or where "else" goes), so both paths reach the end.
          const rejoin = old.length ? old.map((e) => e.target) : elseTargets;
          for (const t of rejoin) d.edges.push({ source: id, target: t });
        } else {
          const outs = d.edges.filter((e) => e.source === after.id);
          d.edges = d.edges.filter((e) => !outs.includes(e));
          d.edges.push({ source: after.id, target: id });
          for (const e of outs) {
            if (type === "if_else") {
              // A new branch starts with both paths going where the chain went; add steps onto a case to fill it.
              d.edges.push({ source: id, target: e.target, sourceHandle: newNode.data!.cases[0].id });
              d.edges.push({ source: id, target: e.target, sourceHandle: "else" });
            } else d.edges.push({ source: id, target: e.target });
          }
        }
      }
      setTimeout(() => setSelected(id), 0);
      return d;
    });
  };
  const removeNode = (id: string) =>
    update((d) => {
      const ins = d.edges.filter((e) => e.target === id);
      const outs = d.edges.filter((e) => e.source === id);
      d.edges = d.edges.filter((e) => e.source !== id && e.target !== id);
      // Reconnect the chain around the removed step when it was a simple link.
      if (ins.length === 1 && outs.length === 1) d.edges.push({ source: ins[0].source, target: outs[0].target, ...(ins[0].sourceHandle ? { sourceHandle: ins[0].sourceHandle } : {}) });
      d.nodes = d.nodes.filter((n) => n.id !== id);
      setSelected(null);
      return d;
    });
  const toggleEdge = (source: string, target: string, handle?: string) =>
    update((d) => {
      const i = d.edges.findIndex((e) => e.source === source && e.target === target && (e.sourceHandle ?? undefined) === handle);
      if (i >= 0) d.edges.splice(i, 1);
      else d.edges.push({ source, target, ...(handle ? { sourceHandle: handle } : {}) });
      return d;
    });

  // Cases name the branches; connections refer to them, so keep both in step.
  const renameCase = (i: number, nextName: string) =>
    update((d) => {
      const n = d.nodes.find((x) => x.id === selected)!;
      const prev = n.data!.cases[i].id;
      n.data!.cases[i].id = nextName;
      for (const e of d.edges) if (e.source === n.id && e.sourceHandle === prev) e.sourceHandle = nextName;
      return d;
    });
  const removeCase = (i: number) =>
    update((d) => {
      const n = d.nodes.find((x) => x.id === selected)!;
      const gone = n.data!.cases[i].id;
      n.data!.cases.splice(i, 1);
      d.edges = d.edges.filter((e) => !(e.source === n.id && e.sourceHandle === gone));
      return d;
    });

  // ── save ──
  const save = async () => {
    setSaving(true);
    try {
      const clean: Def = { ...def, nodes: def.nodes.map((n) => ({ ...n, data: n.data && Object.keys(n.data).length ? n.data : undefined })) };
      const saved = await api<Def>(`/api/workflows/${def.id}`, { method: "PUT", body: clean });
      setDirty(false);
      setErrors([]);
      setSavedAt(Date.now());
      onSaved(saved);
    } catch (e) {
      setErrors((e as Error).message.split("; "));
    } finally {
      setSaving(false);
    }
  };

  // ── canvas drag ──
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  const toSvg = (e: React.PointerEvent) => {
    const pt = svgRef.current!.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svgRef.current!.getScreenCTM()!.inverse());
  };
  const bounds = useMemo(() => {
    const xs = def.nodes.map((n) => n.position?.x ?? 0), ys = def.nodes.map((n) => n.position?.y ?? 0);
    return { minX: Math.min(0, ...xs) - 20, minY: Math.min(0, ...ys) - 30, w: Math.max(900, Math.max(...xs) + W + 80), h: Math.max(260, Math.max(...ys) + H + 70) };
  }, [def.nodes]);

  const variables = useMemo(() => {
    if (!node) return [];
    const vars = def.inputs.filter((i) => i.name).map((i) => `{{inputs.${i.name}}}`);
    for (const id of upstream(def, node.id)) {
      const n = def.nodes.find((x) => x.id === id);
      if (!n || n.type === "start") continue;
      for (const o of n.type === "end" ? [] : OUTPUTS[n.type] ?? ["text"]) vars.push(`{{${id}.${o}}}`);
    }
    return vars;
  }, [def, node]);

  const insertVar = (v: string) => {
    const f = lastField.current;
    if (f && document.body.contains(f.el)) {
      const el = f.el;
      const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? el.value.length;
      f.apply(el.value.slice(0, start) + v + el.value.slice(end));
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + v.length, start + v.length);
      });
    } else navigator.clipboard?.writeText(v).catch(() => {});
  };

  // Field helpers that remember the focused field for variable insertion.
  const text = (label: string, value: string, set: (v: string) => void, opts: { rows?: number; placeholder?: string; mono?: boolean } = {}) => {
    const common = {
      className: `input ${opts.mono ? "mono" : ""}`,
      value: value ?? "",
      placeholder: opts.placeholder,
      onFocus: (e: any) => (lastField.current = { el: e.target, apply: set }),
      onChange: (e: any) => set(e.target.value),
    };
    return (
      <label className="field">
        <span>{label}</span>
        {opts.rows ? <textarea {...common} rows={opts.rows} /> : <input {...common} />}
      </label>
    );
  };
  const json = (label: string, value: unknown, set: (v: any) => void, rows = 3) => <JsonField label={label} value={value} set={set} rows={rows} onFocusField={(el, apply) => (lastField.current = { el, apply })} />;

  const outgoing = (id: string) => def.edges.filter((e) => e.source === id);
  const others = (id: string) => def.nodes.filter((n) => n.id !== id && n.type !== "start");

  return (
    <div className="builder">
      <div className="builder-top card">
        <div className="row gap wrap">
          <label className="field grow"><span>Name</span><input className="input" value={def.name} onChange={(e) => update((d) => ({ ...d, name: e.target.value }))} /></label>
          <label className="field grow"><span>Description <span className="muted small">— coworkers read this to decide when to use it</span></span><input className="input" value={def.description ?? ""} onChange={(e) => update((d) => ({ ...d, description: e.target.value }))} /></label>
          <label className="field"><span>Runs as</span>
            <select className="input" value={def.coworker ?? ""} onChange={(e) => update((d) => ({ ...d, coworker: e.target.value || undefined }))}>
              <option value="">whoever calls it</option>
              {coworkers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="row gap small" style={{ alignSelf: "flex-end", paddingBottom: 8 }}>
            <input type="checkbox" checked={!!def.exposeAsTool} onChange={(e) => update((d) => ({ ...d, exposeAsTool: e.target.checked }))} /> Coworkers can use it as a tool
          </label>
        </div>
        <div className="inputs-editor">
          <span className="small"><b>Inputs</b> <span className="muted">— what you fill in when running it; use as <span className="mono">{"{{inputs.name}}"}</span></span></span>
          {def.inputs.map((inp, i) => (
            <div key={i} className="row gap">
              <input className="input mono" style={{ width: 170 }} placeholder="name" value={inp.name} onChange={(e) => update((d) => ((d.inputs[i].name = e.target.value.replace(/[^\w]/g, "_")), d))} />
              <select className="input" value={inp.type ?? "string"} onChange={(e) => update((d) => ((d.inputs[i].type = e.target.value), d))}>
                {["string", "number", "boolean", "array", "object"].map((t) => <option key={t}>{t}</option>)}
              </select>
              <input className="input grow" placeholder="description (optional)" value={inp.description ?? ""} onChange={(e) => update((d) => ((d.inputs[i].description = e.target.value), d))} />
              <label className="row gap small"><input type="checkbox" checked={!!inp.required} onChange={(e) => update((d) => ((d.inputs[i].required = e.target.checked), d))} /> required</label>
              <Button small kind="ghost" onClick={() => update((d) => (d.inputs.splice(i, 1), d))}>✕</Button>
            </div>
          ))}
          <div><Button small onClick={() => update((d) => (d.inputs.push({ name: `input${d.inputs.length + 1}`, type: "string" }), d))}>+ Input</Button></div>
        </div>
      </div>

      <div className="builder-main">
        <div className="palette">
          <div className="panel-title">Add a step</div>
          <div className="muted small">{node && node.type !== "end" ? `Inserted after “${node.title ?? node.id}”` : "Inserted at the end"}</div>
          {PALETTE.map((p) => (
            <button key={p.type} className="palette-item" onClick={() => addStep(p.type)} title={p.hint}>
              <span className="type-dot" style={{ background: TYPE_COLOR[p.type] }} />
              <span><b>{p.label}</b><span className="muted small"> {p.hint}</span></span>
            </button>
          ))}
        </div>

        <div className="canvas graph-wrap" onPointerDown={(e) => e.target === svgRef.current && setSelected(null)}>
          <svg ref={svgRef} viewBox={`${bounds.minX} ${bounds.minY} ${bounds.w} ${bounds.h}`} width={bounds.w} height={bounds.h} className="graph"
            onPointerMove={(e) => {
              if (!drag.current) return;
              const p = toSvg(e);
              drag.current.moved = true;
              const { id, dx, dy } = drag.current;
              setDef((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, position: { x: Math.round(p.x - dx), y: Math.round(p.y - dy) } } : n)) }));
            }}
            onPointerUp={() => {
              if (drag.current?.moved) setDirty(true);
              drag.current = null;
            }}>
            <defs><marker id="arrow-b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" /></marker></defs>
            {def.edges.map((e, i) => {
              const a = def.nodes.find((n) => n.id === e.source)?.position, b = def.nodes.find((n) => n.id === e.target)?.position;
              if (!a || !b) return null;
              const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
              return (
                <g key={i}>
                  <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke="var(--border-strong)" strokeWidth={1.8} markerEnd="url(#arrow-b)" />
                  {e.sourceHandle && <text x={mx} y={(y1 + y2) / 2 - 6} className="edge-label" textAnchor="middle">{e.sourceHandle}</text>}
                </g>
              );
            })}
            {def.nodes.map((n) => (
              <g key={n.id} transform={`translate(${n.position!.x},${n.position!.y})`} className={`gnode bnode ${selected === n.id ? "sel" : ""}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  const p = toSvg(e);
                  drag.current = { id: n.id, dx: p.x - n.position!.x, dy: p.y - n.position!.y, moved: false };
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                  setSelected(n.id);
                }}>
                <rect width={W} height={H} rx={10} className="gnode-box" />
                <rect width={6} height={H} rx={3} fill={TYPE_COLOR[n.type] ?? "#888"} />
                <text x={16} y={23} className="gnode-title">{(n.title ?? n.id).slice(0, 22)}</text>
                <text x={16} y={42} className="gnode-type">{n.id} · {LABEL[n.type] ?? n.type}</text>
              </g>
            ))}
          </svg>
        </div>

        <div className="inspector card">
          {!node ? (
            <div className="muted small">
              <p><b>How to build:</b></p>
              <ol>
                <li>Click a step on the canvas to select it.</li>
                <li>Pick a step type on the left: it's inserted right after the selected step and connected.</li>
                <li>Fill in the step here. Click a variable chip to insert it where your cursor is.</li>
                <li>Drag steps to rearrange; use <b>Next steps</b> to connect or branch.</li>
                <li><b>Save</b>, then try it on the <b>Run</b> tab.</li>
              </ol>
            </div>
          ) : (
            <div className="stack">
              <div className="row gap">
                <span className="type-dot" style={{ background: TYPE_COLOR[node.type] }} />
                <b className="grow">{LABEL[node.type] ?? node.type}</b>
                <span className="mono small muted">{node.id}</span>
                {node.type !== "start" && <Button small kind="danger" onClick={() => removeNode(node.id)}>Delete step</Button>}
              </div>
              {node.type !== "start" && node.type !== "end" && text("Title", node.title ?? "", (v) => setNode({ title: v }))}

              {variables.length > 0 && node.type !== "start" && (
                <div className="vars">
                  <span className="muted small">Insert a value:</span>
                  {variables.map((v) => <button key={v} className="var-chip mono" onMouseDown={(e) => e.preventDefault()} onClick={() => insertVar(v)}>{v}</button>)}
                </div>
              )}

              {node.type === "start" && <div className="muted small">The start step passes the workflow's <b>Inputs</b> (above) to the next steps as <span className="mono">{"{{inputs.…}}"}</span>.</div>}

              {node.type === "llm" && (<>
                {text("Prompt", node.data?.prompt, (v) => setData({ prompt: v }), { rows: 6, placeholder: "Summarise this:\n{{inputs.text}}" })}
                {text("System instructions (optional)", node.data?.system, (v) => setData({ system: v }), { rows: 2 })}
                <div className="row gap wrap">
                  <label className="field"><span>Model</span>
                    <select className="input" value={node.data?.model ?? ""} onChange={(e) => setData({ model: e.target.value || undefined })}>
                      <option value="">coworker's / default</option>
                      {models.filter((m) => !m.embedding).map((m) => <option key={m.key} value={m.key}>{m.key}</option>)}
                    </select>
                  </label>
                  <label className="row gap small" style={{ alignSelf: "flex-end", paddingBottom: 8 }}><input type="checkbox" checked={!!node.data?.json} onChange={(e) => setData({ json: e.target.checked })} /> Return JSON (available as <span className="mono">{`{{${node.id}.json.…}}`}</span>)</label>
                </div>
              </>)}

              {node.type === "agent" && (<>
                <label className="field"><span>Coworker</span>
                  <select className="input" value={node.data?.coworker ?? "assistant"} onChange={(e) => setData({ coworker: e.target.value })}>
                    {coworkers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                {text("Task", node.data?.prompt, (v) => setData({ prompt: v }), { rows: 6, placeholder: "Research {{inputs.topic}} and reply with 5 bullet points." })}
              </>)}

              {node.type === "tool" && (<>
                <label className="field"><span>Tool</span>
                  <select className="input mono" value={node.data?.tool ?? ""} onChange={(e) => setData({ tool: e.target.value })}>
                    {tools.map((t) => <option key={t.name} value={t.name}>{t.name}  ({t.toolset})</option>)}
                  </select>
                </label>
                {json("Arguments (JSON) — values can use {{…}}", node.data?.args ?? {}, (v) => setData({ args: v }), 5)}
              </>)}

              {node.type === "knowledge" && (<>
                {text("Search for", node.data?.query, (v) => setData({ query: v }), { placeholder: "{{inputs.question}}" })}
                <div className="row gap">
                  <label className="field grow"><span>Dataset</span>
                    <select className="input" value={node.data?.dataset ?? ""} onChange={(e) => setData({ dataset: e.target.value || undefined })}>
                      <option value="">all datasets</option>
                      {datasets.map((d) => <option key={d}>{d}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>Results</span><input className="input" type="number" min={1} max={12} value={node.data?.topK ?? 4} onChange={(e) => setData({ topK: Number(e.target.value) })} /></label>
                </div>
              </>)}

              {node.type === "if_else" && (<>
                <div className="muted small">Each case is a condition. The first true case's branch runs; otherwise <b>else</b>. Example: <span className="mono">classify.json.urgency == "high"</span>, <span className="mono">size(search1.results) &gt; 0</span>.</div>
                {(node.data?.cases ?? []).map((c: any, i: number) => (
                  <div key={i} className="row gap">
                    <input className="input mono" style={{ width: 90 }} value={c.id} onChange={(e) => renameCase(i, e.target.value.replace(/[^\w-]/g, ""))} />
                    <input className="input mono grow" placeholder='inputs.amount > 100' value={c.when} onChange={(e) => { const cases = structuredClone(node.data!.cases); cases[i].when = e.target.value; setData({ cases }); }} />
                    <Button small kind="ghost" onClick={() => removeCase(i)}>✕</Button>
                  </div>
                ))}
                <div><Button small onClick={() => setData({ cases: [...(node.data?.cases ?? []), { id: `case${(node.data?.cases?.length ?? 0) + 1}`, when: "" }] })}>+ Case</Button></div>
              </>)}

              {node.type === "template" && text("Text", node.data?.template, (v) => setData({ template: v }), { rows: 6, placeholder: "Hi {{inputs.name}},\n\n{{llm1.text}}" })}

              {node.type === "http" && (<>
                <div className="row gap">
                  <select className="input" value={node.data?.method ?? "GET"} onChange={(e) => setData({ method: e.target.value })}>{["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => <option key={m}>{m}</option>)}</select>
                  <input className="input mono grow" placeholder="https://api.example.com/…" value={node.data?.url ?? ""} onFocus={(e) => (lastField.current = { el: e.target, apply: (v) => setData({ url: v }) })} onChange={(e) => setData({ url: e.target.value })} />
                </div>
                {json("Headers (JSON)", node.data?.headers ?? {}, (v) => setData({ headers: v }), 2)}
                {node.data?.method !== "GET" && json("Body (JSON)", node.data?.body ?? {}, (v) => setData({ body: v }), 4)}
              </>)}

              {node.type === "code" && (<>
                {json("Inputs (JSON) — available as inputs.* in the code", node.data?.inputs ?? {}, (v) => setData({ inputs: v }), 3)}
                {text("Code (function body; must return an object)", node.data?.code, (v) => setData({ code: v }), { rows: 7, mono: true })}
              </>)}

              {node.type === "iteration" && (<>
                {text("List to loop over", node.data?.items, (v) => setData({ items: v }), { placeholder: "{{inputs.questions}}" })}
                <div className="row gap">
                  <label className="field grow"><span>Workflow to run for each item</span>
                    <select className="input" value={node.data?.workflow ?? ""} onChange={(e) => setData({ workflow: e.target.value })}>
                      <option value="">choose…</option>
                      {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>Item input name</span><input className="input mono" value={node.data?.itemName ?? "item"} onChange={(e) => setData({ itemName: e.target.value })} /></label>
                  <label className="field"><span>In parallel</span><input className="input" type="number" min={1} max={8} value={node.data?.parallel ?? 2} onChange={(e) => setData({ parallel: Number(e.target.value) })} /></label>
                </div>
              </>)}

              {node.type === "aggregator" && text("Values to try, one per line (first non-empty wins)", (node.data?.variables ?? []).join("\n"), (v) => setData({ variables: v.split("\n") }), { rows: 4, placeholder: "{{branch_a.text}}\n{{branch_b.text}}" })}

              {node.type === "end" && (<>
                <div className="muted small">What the workflow returns. Each output has a name and a value.</div>
                {Object.entries(node.data?.outputs ?? {}).map(([k, v], i) => (
                  <div key={i} className="row gap">
                    <input className="input mono" style={{ width: 120 }} value={k} onChange={(e) => { const o = Object.entries(node.data!.outputs); o[i][0] = e.target.value.replace(/[^\w]/g, "_"); setData({ outputs: Object.fromEntries(o) }); }} />
                    <input className="input mono grow" value={String(v)} onFocus={(e) => (lastField.current = { el: e.target, apply: (nv) => { const o = Object.entries(node.data!.outputs); o[i][1] = nv; setData({ outputs: Object.fromEntries(o) }); } })} onChange={(e) => { const o = Object.entries(node.data!.outputs); o[i][1] = e.target.value; setData({ outputs: Object.fromEntries(o) }); }} />
                    <Button small kind="ghost" onClick={() => { const o = Object.entries(node.data!.outputs).filter((_, j) => j !== i); setData({ outputs: Object.fromEntries(o) }); }}>✕</Button>
                  </div>
                ))}
                <div><Button small onClick={() => setData({ outputs: { ...(node.data?.outputs ?? {}), [`output${Object.keys(node.data?.outputs ?? {}).length + 1}`]: "" } })}>+ Output</Button></div>
              </>)}

              {node.type !== "end" && (
                <div className="next-steps">
                  <div className="small"><b>Next steps</b> <span className="muted">— where to go after this step</span></div>
                  {(node.type === "if_else" ? [...(node.data?.cases ?? []).map((c: any) => c.id), "else"] : [undefined]).map((h: string | undefined) => (
                    <div key={h ?? "_"} className="row gap wrap">
                      {h && <Pill tone="warn">{h}</Pill>}
                      {others(node.id).map((o) => {
                        const on = def.edges.some((e) => e.source === node.id && e.target === o.id && (e.sourceHandle ?? undefined) === h);
                        return <button key={o.id} className={`chip ${on ? "on" : ""}`} onClick={() => toggleEdge(node.id, o.id, h)}>{o.title ?? o.id}</button>;
                      })}
                    </div>
                  ))}
                  {outgoing(node.id).length === 0 && <div className="muted small">Not connected to anything yet.</div>}
                </div>
              )}

              {!["start", "end", "if_else", "template", "aggregator"].includes(node.type) && (
                <div className="row gap wrap">
                  <label className="field"><span>If this step fails</span>
                    <select className="input" value={node.data?.onError ?? "fail"} onChange={(e) => setData({ onError: e.target.value })}>
                      <option value="fail">stop the workflow</option>
                      <option value="continue">continue (output has .error)</option>
                      <option value="branch">take the "error" branch</option>
                    </select>
                  </label>
                  <label className="field"><span>Retries</span><input className="input" type="number" min={0} max={5} value={node.data?.retries ?? 0} onChange={(e) => setData({ retries: Number(e.target.value) })} /></label>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="builder-bar">
        {errors.length > 0 && <div className="tool-error grow">{errors.map((e, i) => <div key={i}>• {e}</div>)}</div>}
        {errors.length === 0 && <span className="muted small grow">{dirty ? "Unsaved changes" : savedAt ? "Saved ✓" : "All changes saved"}</span>}
        <Button kind="primary" disabled={saving || !dirty} onClick={save}>{saving ? "Saving…" : "Save workflow"}</Button>
      </div>
    </div>
  );
}

function JsonField({ label, value, set, rows, onFocusField }: { label: string; value: unknown; set: (v: any) => void; rows: number; onFocusField: (el: HTMLTextAreaElement, apply: (v: string) => void) => void }) {
  const [raw, setRaw] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [bad, setBad] = useState(false);
  const apply = (v: string) => {
    setRaw(v);
    try {
      set(JSON.parse(v || "{}"));
      setBad(false);
    } catch {
      setBad(true);
    }
  };
  return (
    <label className="field">
      <span>{label} {bad && <span className="bad small">— not valid JSON yet</span>}</span>
      <textarea className="input mono" rows={rows} value={raw} onFocus={(e) => onFocusField(e.target, apply)} onChange={(e) => apply(e.target.value)} spellCheck={false} />
    </label>
  );
}
