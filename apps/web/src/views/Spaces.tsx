import { useEffect, useRef, useState } from "react";
import { api, ApiError, timeAgo } from "../api.ts";
import { Button, Empty, Markdown, PageHeader, Pill } from "../ui.tsx";

type Page = { id: string; space: string; title: string; body?: string; excerpt?: string; revision: number; author: string; updated_at: number; parent_id?: string };

export function Spaces({ pageId }: { pageId?: string }) {
  const [pages, setPages] = useState<Page[]>([]);
  const [spaces, setSpaces] = useState<string[]>(["default"]);
  const [space, setSpace] = useState<string>("all");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");

  const load = () => {
    api<Page[]>("/api/pages").then(setPages);
    api<string[]>("/api/spaces").then(setSpaces);
  };
  useEffect(load, [pageId]);

  if (pageId) return <PageEditor id={pageId} onBack={() => (location.hash = "#/spaces")} />;

  const shown = pages.filter((p) => (space === "all" || p.space === space) && (!q || (p.title + " " + p.excerpt).toLowerCase().includes(q.toLowerCase())));
  const create = async () => {
    const p = await api<Page>("/api/pages", { body: { title: "Untitled", body: "", space: space === "all" ? "default" : space } });
    location.hash = `#/spaces/${p.id}`;
  };

  return (
    <div className="page">
      <PageHeader title="Spaces" subtitle="Durable work — saved by you and your coworkers." actions={<Button kind="primary" onClick={create}>+ New page</Button>} />
      <div className="row gap wrap toolbar">
        <div className="segmented">
          {["all", ...spaces].map((s) => (
            <button key={s} className={space === s ? "on" : ""} onClick={() => setSpace(s)}>{s}</button>
          ))}
        </div>
        <input className="input grow" placeholder="Search pages…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="segmented">
          <button className={view === "grid" ? "on" : ""} onClick={() => setView("grid")}>Grid</button>
          <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}>List</button>
        </div>
      </div>
      {shown.length === 0 ? (
        <Empty title="No pages here yet">Ask a coworker to "save this as a page", or create one.</Empty>
      ) : (
        <div className={view === "grid" ? "page-grid" : "table"}>
          {shown.map((p) => (
            <a key={p.id} href={`#/spaces/${p.id}`} className={view === "grid" ? "page-tile" : "table-row"}>
              <div className="page-tile-title">{p.title}</div>
              {view === "grid" && <div className="page-tile-excerpt">{p.excerpt}</div>}
              <div className="muted small row gap">
                <Pill>{p.space}</Pill> <span>{p.author === "user" ? "you" : p.author}</span> · <span>{timeAgo(p.updated_at)}</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function PageEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const [page, setPage] = useState<Page | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [status, setStatus] = useState<"saved" | "saving" | "dirty" | "conflict" | "error">("saved");
  const [conflict, setConflict] = useState<Page | null>(null);
  const revRef = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api<Page>(`/api/pages/${id}`).then((p) => {
      setPage(p);
      setTitle(p.title);
      setBody(p.body ?? "");
      revRef.current = p.revision;
      if (!p.body) setMode("edit");
    });
  }, [id]);

  const save = async (t: string, b: string) => {
    setStatus("saving");
    try {
      const p = await api<Page>(`/api/pages/${id}`, { method: "PUT", body: { title: t, body: b, baseRevision: revRef.current } });
      revRef.current = p.revision;
      setPage(p);
      setStatus("saved");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict(e.body.current);
        setStatus("conflict");
      } else setStatus("error");
    }
  };

  const change = (t: string, b: string) => {
    setTitle(t);
    setBody(b);
    setStatus("dirty");
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => save(t, b), 900);
  };

  if (!page) return <div className="page muted">Loading…</div>;
  return (
    <div className="page editor">
      <div className="row gap">
        <Button kind="ghost" onClick={onBack}>← Spaces</Button>
        <Pill>{page.space}</Pill>
        <span className="muted small grow">rev {page.revision} · last edit by {page.author === "user" ? "you" : page.author}</span>
        <span className={`save-state ${status}`}>{{ saved: "Saved", saving: "Saving…", dirty: "Unsaved", conflict: "Conflict", error: "Save failed — draft kept" }[status]}</span>
        <div className="segmented">
          <button className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")}>Edit</button>
          <button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>Preview</button>
        </div>
        <Button kind="ghost" onClick={() => confirm("Delete this page?") && api(`/api/pages/${id}`, { method: "DELETE" }).then(onBack)}>Delete</Button>
      </div>
      {conflict && (
        <div className="notice notice-bad">
          This page changed elsewhere (now revision {conflict.revision}, by {conflict.author}). Your draft is kept.
          <Button small onClick={() => { revRef.current = conflict.revision; setConflict(null); save(title, body); }}>Overwrite with mine</Button>
          <Button small onClick={() => { setTitle(conflict.title); setBody(conflict.body ?? ""); revRef.current = conflict.revision; setConflict(null); setStatus("saved"); }}>Load theirs</Button>
        </div>
      )}
      <input className="title-input" value={title} onChange={(e) => change(e.target.value, body)} />
      {mode === "edit" ? (
        <textarea className="body-input mono" value={body} onChange={(e) => change(title, e.target.value)} placeholder="Write in Markdown…" />
      ) : (
        <div className="doc" onDoubleClick={() => setMode("edit")}><Markdown text={body || "_Empty page — double-click to edit._"} /></div>
      )}
    </div>
  );
}
