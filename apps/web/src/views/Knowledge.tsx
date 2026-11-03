import { useEffect, useState } from "react";
import { api, timeAgo } from "../api.ts";
import { Button, Empty, PageHeader, Pill } from "../ui.tsx";

export function Knowledge() {
  const [datasets, setDatasets] = useState<any[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [docs, setDocs] = useState<any[]>([]);
  const [form, setForm] = useState({ dataset: "handbook", title: "", content: "", source: "" });
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<any[] | null>(null);

  const load = () => api("/api/knowledge").then((d) => {
    setDatasets(d);
    if (!active && d[0]) setActive(d[0].dataset);
  });
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (active) api(`/api/knowledge/${encodeURIComponent(active)}`).then(setDocs);
  }, [active, datasets]);

  const readFile = (f: File) => f.text().then((t) => setForm((x) => ({ ...x, title: x.title || f.name.replace(/\.\w+$/, ""), content: t, source: f.name })));

  return (
    <div className="page">
      <PageHeader title="Knowledge" subtitle="Datasets your coworkers retrieve from (knowledge_search, workflow knowledge nodes). Local BM25 ranking — no embedding service needed." />
      <div className="two-col">
        <div className="stack">
          <div className="card stack">
            <h3>Add a document</h3>
            <div className="row gap">
              <input className="input" placeholder="dataset" value={form.dataset} onChange={(e) => setForm({ ...form, dataset: e.target.value })} />
              <input className="input grow" placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <textarea className="input" rows={7} placeholder="Paste text or Markdown, or choose a .md/.txt file…" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
            <div className="row gap">
              <input type="file" accept=".md,.txt,.csv,.json,.html" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
              <span className="grow" />
              <Button kind="primary" disabled={!form.title || !form.content} onClick={() => api(`/api/knowledge/${encodeURIComponent(form.dataset)}`, { body: form }).then(() => { setForm({ ...form, title: "", content: "", source: "" }); setActive(form.dataset); load(); })}>Index</Button>
            </div>
          </div>
          <div className="card stack">
            <h3>Test retrieval</h3>
            <form className="row gap" onSubmit={(e) => (e.preventDefault(), api(`/api/knowledge/search?q=${encodeURIComponent(q)}`).then(setHits))}>
              <input className="input grow" placeholder="Ask something…" value={q} onChange={(e) => setQ(e.target.value)} />
              <Button type="submit">Search</Button>
            </form>
            {hits && (hits.length ? hits.map((h, i) => (
              <div key={h.id} className="hit">
                <div className="small"><b>[{i + 1}] {h.title}</b> <Pill>{h.dataset}</Pill> <span className="muted">score {(-h.score).toFixed(2)}</span></div>
                <div className="small">{h.content.slice(0, 300)}</div>
              </div>
            )) : <div className="muted small">No matches.</div>)}
          </div>
        </div>
        <div className="card stack">
          <div className="segmented">
            {datasets.map((d) => <button key={d.dataset} className={active === d.dataset ? "on" : ""} onClick={() => setActive(d.dataset)}>{d.dataset} ({d.documents})</button>)}
          </div>
          {!datasets.length && <Empty title="No datasets yet">Add a document to create one.</Empty>}
          {docs.map((d) => (
            <div key={d.title} className="table-row">
              <span className="grow"><b>{d.title}</b> <span className="muted small">{d.source}</span></span>
              <span className="muted small">{d.chunks} chunks · {timeAgo(d.created_at)}</span>
              <Button small kind="ghost" onClick={() => api(`/api/knowledge/${encodeURIComponent(active!)}/${encodeURIComponent(d.title)}`, { method: "DELETE" }).then(load)}>Remove</Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
