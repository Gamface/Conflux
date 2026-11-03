import { useEffect, useState } from "react";
import { api, timeAgo, type Coworker } from "../api.ts";
import { Button, Empty, Markdown, PageHeader, Pill } from "../ui.tsx";

export function Learning({ coworkers, tick }: { coworkers: Coworker[]; tick: number }) {
  const [cw, setCw] = useState(coworkers[0]?.id ?? "assistant");
  const [mem, setMem] = useState<any>(null);
  const [userText, setUserText] = useState("");
  const [memText, setMemText] = useState("");
  const [skills, setSkills] = useState<any[]>([]);
  const [skill, setSkill] = useState<any>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api(`/api/memory/${cw}`).then((m) => {
      setMem(m);
      setUserText(m.user.join("\n"));
      setMemText(m.memory.join("\n"));
    });
  }, [cw, tick]);
  useEffect(() => {
    api("/api/skills").then(setSkills);
  }, [tick]);

  const save = async () => {
    await api(`/api/memory/${cw}`, { method: "PUT", body: { user: userText.split("\n"), memory: memText.split("\n") } }).catch((e) => alert(e.message));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const bar = (u: { used: number; limit: number }) => (
    <div className="meter"><div style={{ width: `${Math.min(100, (u.used / u.limit) * 100)}%` }} /><span>{u.used}/{u.limit}</span></div>
  );

  return (
    <div className="page">
      <PageHeader title="Learning" subtitle="What your coworkers remember and the skills they've built. A background reviewer proposes new entries after conversations; you can edit everything." />
      <div className="two-col">
        <div className="card stack">
          <div className="row gap">
            <h3 className="grow">Memory</h3>
            <select className="input" value={cw} onChange={(e) => setCw(e.target.value)}>
              {coworkers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          {mem && (
            <>
              <label className="field">
                <span>About you <span className="muted small">— shared with every coworker (one entry per line)</span></span>
                {bar(mem.usage.user)}
                <textarea className="input" rows={6} value={userText} onChange={(e) => setUserText(e.target.value)} placeholder="e.g. Prefers concise answers with a TL;DR first" />
              </label>
              <label className="field">
                <span>{coworkers.find((c) => c.id === cw)?.name}'s notes <span className="muted small">— environment facts, conventions, lessons</span></span>
                {bar(mem.usage.memory)}
                <textarea className="input" rows={6} value={memText} onChange={(e) => setMemText(e.target.value)} />
              </label>
              <div className="row gap">
                <Button kind="primary" onClick={save}>{saved ? "Saved ✓" : "Save memory"}</Button>
                <span className="muted small">Takes effect in new conversations (system prompts are frozen per conversation for prompt caching).</span>
              </div>
            </>
          )}
        </div>
        <div className="card stack">
          <h3>Skills <Pill>{skills.length}</Pill></h3>
          {skill ? (
            <div className="stack">
              <div className="row gap">
                <Button kind="ghost" small onClick={() => setSkill(null)}>← All skills</Button>
                <b className="grow">{skill.name}</b>
                <Pill tone={skill.source === "learned" ? "accent" : "neutral"}>{skill.source}</Pill>
                {skill.source === "learned" && <Button small kind="danger" onClick={() => confirm("Delete skill?") && api(`/api/skills/${skill.name}`, { method: "DELETE" }).then(() => (setSkill(null), api("/api/skills").then(setSkills)))}>Delete</Button>}
              </div>
              <Markdown text={skill.content.replace(/^---[\s\S]*?---\n/, "")} />
              {skill.files?.length > 0 && <div className="muted small">Files: {skill.files.join(", ")}</div>}
            </div>
          ) : skills.length ? (
            skills.map((s) => (
              <div key={s.name} className="table-row" onClick={() => api(`/api/skills/${s.name}`).then(setSkill)}>
                <span className="grow">
                  <b>{s.name}</b> {s.category && <span className="muted small">{s.category}</span>}
                  <div className="small muted">{s.description}</div>
                </span>
                <Pill tone={s.source === "learned" ? "accent" : "neutral"}>{s.source === "learned" ? `learned${s.createdBy ? ` by ${s.createdBy}` : ""}` : "bundled"}</Pill>
                <span className="muted small">{s.views} uses</span>
              </div>
            ))
          ) : (
            <Empty title="No skills" />
          )}
        </div>
      </div>
    </div>
  );
}

export { timeAgo };
