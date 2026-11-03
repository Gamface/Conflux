import { useEffect, useState } from "react";
import { api, type Coworker } from "../api.ts";
import { Avatar, Button, PageHeader, Pill } from "../ui.tsx";

const NEW: Coworker = { id: "", name: "", emoji: "◆", color: "#2563eb", description: "", role: "", tools: ["toolset:web", "toolset:spaces", "toolset:learning", "todo"], spaces: ["default"] };

export function Coworkers({ coworkers, onChange }: { coworkers: Coworker[]; onChange: () => void }) {
  const [edit, setEdit] = useState<Coworker | null>(null);
  const [models, setModels] = useState<any[]>([]);
  const [tools, setTools] = useState<any[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    api("/api/models").then(setModels);
    api("/api/tools").then(setTools);
  }, []);

  const save = async () => {
    if (!edit) return;
    try {
      await api(`/api/coworkers/${edit.id}`, { method: "PUT", body: edit });
      setEdit(null);
      setErr("");
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const toolsets = [...new Set(tools.map((t) => t.toolset))];

  return (
    <div className="page">
      <PageHeader title="Coworkers" subtitle="Agents are configuration: a role, a model, tool grants and boundaries. Bring any AG-UI agent by URL." actions={<Button kind="primary" onClick={() => setEdit({ ...NEW })}>+ New coworker</Button>} />
      {edit ? (
        <div className="card stack">
          <div className="row gap">
            <Avatar emoji={edit.emoji} color={edit.color} size={40} />
            <input className="input" style={{ width: 70 }} value={edit.emoji} onChange={(e) => setEdit({ ...edit, emoji: e.target.value })} />
            <input type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} />
            <input className="input" placeholder="id (kebab-case)" value={edit.id} disabled={coworkers.some((c) => c.id === edit.id) && !!edit.role} onChange={(e) => setEdit({ ...edit, id: e.target.value })} />
            <input className="input grow" placeholder="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          </div>
          <input className="input" placeholder="One-line description" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
          <label className="field"><span>Role instructions</span><textarea className="input" rows={5} value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })} /></label>
          <div className="row gap wrap">
            <label className="field"><span>Model</span>
              <select className="input" value={edit.model ?? ""} onChange={(e) => setEdit({ ...edit, model: e.target.value || undefined })}>
                <option value="">default</option>
                {models.map((m) => <option key={m.key} value={m.key}>{m.key} — {m.model}</option>)}
              </select>
            </label>
            <label className="field grow"><span>External AG-UI agent URL <span className="muted small">(optional — replaces the model)</span></span>
              <input className="input mono" placeholder="http://localhost:8000/agent" value={edit.agui?.url ?? ""} onChange={(e) => setEdit({ ...edit, agui: e.target.value ? { url: e.target.value } : undefined })} />
            </label>
            <label className="field"><span>Spaces</span><input className="input" value={(edit.spaces ?? []).join(", ")} onChange={(e) => setEdit({ ...edit, spaces: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></label>
          </div>
          <label className="field"><span>Tool grants <span className="muted small">— "*", "toolset:web", "browser_*", "!terminal"</span></span>
            <input className="input mono" value={edit.tools.join(", ")} onChange={(e) => setEdit({ ...edit, tools: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
          </label>
          <div className="row gap wrap">
            {toolsets.map((ts) => {
              const g = `toolset:${ts}`;
              const on = edit.tools.includes(g);
              return <button key={ts} className={`chip ${on ? "on" : ""}`} onClick={() => setEdit({ ...edit, tools: on ? edit.tools.filter((t) => t !== g) : [...edit.tools, g] })}>{ts}</button>;
            })}
          </div>
          <label className="field"><span>Extra boundaries — ask first <span className="muted small">(one rule per line; can only narrow the org policy)</span></span>
            <textarea className="input mono" rows={2} value={(edit.policy?.requireApproval ?? []).join("\n")} onChange={(e) => setEdit({ ...edit, policy: { ...edit.policy, requireApproval: e.target.value.split("\n").filter(Boolean) } })} />
          </label>
          <label className="field"><span>Extra boundaries — never</span>
            <textarea className="input mono" rows={2} value={(edit.policy?.deny ?? []).join("\n")} onChange={(e) => setEdit({ ...edit, policy: { ...edit.policy, deny: e.target.value.split("\n").filter(Boolean) } })} />
          </label>
          <label className="row gap small"><input type="checkbox" checked={edit.learning?.enabled !== false} onChange={(e) => setEdit({ ...edit, learning: { ...edit.learning, enabled: e.target.checked } })} /> Learning loop (background memory & skill review)</label>
          {err && <div className="tool-error">{err}</div>}
          <div className="row gap"><Button kind="primary" onClick={save}>Save</Button><Button kind="ghost" onClick={() => setEdit(null)}>Cancel</Button></div>
        </div>
      ) : (
        <div className="page-grid">
          {coworkers.map((c) => (
            <div key={c.id} className="page-tile" onClick={() => setEdit(JSON.parse(JSON.stringify(c)))}>
              <div className="row gap"><Avatar emoji={c.emoji} color={c.color} size={36} /><div className="grow"><div className="page-tile-title">{c.name}</div><div className="muted small mono">{c.id}</div></div></div>
              <div className="page-tile-excerpt">{c.description ?? c.role}</div>
              <div className="row gap wrap small">
                <Pill tone="accent">{c.model}</Pill>
                <Pill>{c.toolCount} tools</Pill>
                {(c.policy?.requireApproval?.length ?? 0) > 0 && <Pill tone="warn">asks first</Pill>}
                {(c.policy?.deny?.length ?? 0) > 0 && <Pill tone="bad">extra limits</Pill>}
                <a href={`#/chat/${c.id}`} onClick={(e) => e.stopPropagation()}>Chat →</a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
