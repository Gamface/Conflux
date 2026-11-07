import { useCallback, useEffect, useState } from "react";
import { api, ApiError, setAccessKey, subscribeEvents, type Coworker } from "./api.ts";
import { Avatar, Button } from "./ui.tsx";
import { Chat } from "./chat/Chat.tsx";
import { Activity } from "./views/Activity.tsx";
import { Spaces } from "./views/Spaces.tsx";
import { Workflows } from "./views/Workflows.tsx";
import { Knowledge } from "./views/Knowledge.tsx";
import { Learning } from "./views/Learning.tsx";
import { Boundaries } from "./views/Boundaries.tsx";
import { Coworkers } from "./views/Coworkers.tsx";
import { Models } from "./views/Models.tsx";

function useHash(): string[] {
  const [h, setH] = useState(location.hash);
  useEffect(() => {
    const f = () => setH(location.hash);
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return h.replace(/^#\/?/, "").split("/").filter(Boolean);
}

type Toast = { id: number; text: string; href?: string };

const NAV = [
  ["activity", "Activity", "◷"],
  ["spaces", "Spaces", "▤"],
  ["workflows", "Workflows", "⋔"],
  ["knowledge", "Knowledge", "❖"],
  ["learning", "Learning", "✧"],
  ["boundaries", "Boundaries", "⛨"],
  ["coworkers", "Coworkers", "☺"],
  ["models", "Models", "◈"],
] as const;

export function App() {
  const route = useHash();
  const [coworkers, setCoworkers] = useState<Coworker[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [needKey, setNeedKey] = useState(false);
  const [busEvent, setBusEvent] = useState<{ channel: string; event: any } | null>(null);
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState<Record<string, number>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem("conflux.theme") ?? "system";
    } catch {
      return "system";
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("conflux.theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toast = (text: string, href?: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, href }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  };

  const loadCoworkers = useCallback(() => {
    api<Coworker[]>("/api/coworkers")
      .then((c) => (setCoworkers(c), setNeedKey(false)))
      .catch((e) => e instanceof ApiError && e.status === 401 && setNeedKey(true));
  }, []);

  const loadPending = useCallback(() => {
    api<any[]>("/api/approvals").then((a) => {
      const by: Record<string, number> = {};
      for (const x of a) by[x.coworker_id] = (by[x.coworker_id] ?? 0) + 1;
      setPending(by);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    api("/api/health").then(setHealth);
    loadCoworkers();
    loadPending();
  }, [loadCoworkers, loadPending]);

  useEffect(() => {
    if (needKey) return;
    let t: number | undefined;
    return subscribeEvents((e) => {
      setBusEvent(e);
      if (["tasks", "schedules", "approvals", "audit", "learning", "pages", "workflows"].includes(e.channel)) {
        clearTimeout(t);
        t = window.setTimeout(() => setTick((x) => x + 1), 250);
      }
      if (e.channel === "approvals") loadPending();
      if (e.channel === "learning" && e.event.type === "learned") toast(`🧠 ${e.event.coworker} learned: ${e.event.saved.join("; ")}`, "#/learning");
      if (e.channel === "learning" && e.event.type === "skill_created") toast(`✧ New skill: ${e.event.name}`, "#/learning");
      if (e.channel === "tasks" && e.event.type === "task_status" && ["succeeded", "failed", "interrupted"].includes(e.event.status)) toast(`Task ${e.event.status}`, "#/activity");
    });
  }, [needKey, loadPending]);

  if (needKey) return <KeyGate onDone={() => loadCoworkers()} />;

  const section = route[0] ?? "chat";
  const cwId = section === "chat" ? route[1] ?? coworkers[0]?.id : undefined;
  const coworker = coworkers.find((c) => c.id === cwId);

  return (
    <div className="app">
      <nav className="sidebar">
        <a className="brand" href="#/">
          <span className="logo"><i /><i /></span> Conflux
        </a>
        <div className="nav-label">Coworkers</div>
        {coworkers.map((c) => (
          <a key={c.id} href={`#/chat/${c.id}`} className={`nav-item ${section === "chat" && cwId === c.id ? "active" : ""}`}>
            <Avatar emoji={c.emoji} color={c.color} size={22} />
            <span className="grow truncate">{c.name}</span>
            {pending[c.id] ? <span className="badge">{pending[c.id]}</span> : null}
          </a>
        ))}
        <div className="nav-label">Workspace</div>
        {NAV.map(([k, label, icon]) => (
          <a key={k} href={`#/${k}`} className={`nav-item ${section === k ? "active" : ""}`}>
            <span className="nav-icon">{icon}</span>
            <span className="grow">{label}</span>
            {k === "activity" && Object.values(pending).reduce((a, b) => a + b, 0) > 0 && <span className="badge">{Object.values(pending).reduce((a, b) => a + b, 0)}</span>}
          </a>
        ))}
        <div className="grow" />
        {health && (
          <div className="sidebar-foot small">
            <a href="#/models" className="model-link"><span className={`dot dot-${health.provider === "mock" ? "running" : "ok"}`} /> {health.provider === "mock" ? "Offline model — connect an LLM →" : `${health.model}`}</a>
            <div className="muted">browser {health.capabilities.browser ? "✓" : "—"} · desktop {health.capabilities.desktop ? "✓" : "—"} · MCP {Object.keys(health.capabilities.mcp ?? {}).length}</div>
            <div className="segmented tiny">
              {["light", "system", "dark"].map((t) => <button key={t} className={theme === t ? "on" : ""} onClick={() => setTheme(t)}>{t}</button>)}
            </div>
          </div>
        )}
      </nav>
      <main className="main">
        {section === "chat" && coworker && (
          <Chat
            key={coworker.id}
            coworker={coworker}
            threadId={route[2]}
            busEvent={busEvent}
            onThread={(id) => (location.hash = id ? `#/chat/${coworker.id}/${id}` : `#/chat/${coworker.id}`)}
            onCoworkerChange={loadCoworkers}
          />
        )}
        {section === "chat" && !coworker && coworkers.length > 0 && <div className="page muted">Unknown coworker.</div>}
        {section === "activity" && <Activity coworkers={coworkers} tick={tick} />}
        {section === "spaces" && <Spaces pageId={route[1]} />}
        {section === "workflows" && <Workflows id={route[1]} />}
        {section === "knowledge" && <Knowledge />}
        {section === "learning" && <Learning coworkers={coworkers} tick={tick} />}
        {section === "boundaries" && <Boundaries coworkers={coworkers} tick={tick} />}
        {section === "coworkers" && <Coworkers coworkers={coworkers} onChange={loadCoworkers} />}
        {section === "models" && <Models onChange={() => (loadCoworkers(), api("/api/health").then(setHealth))} />}
      </main>
      <div className="toasts">
        {toasts.map((t) => (
          <a key={t.id} className="toast" href={t.href ?? "#"}>{t.text}</a>
        ))}
      </div>
    </div>
  );
}

function KeyGate({ onDone }: { onDone: () => void }) {
  const [k, setK] = useState("");
  return (
    <div className="gate">
      <form className="card stack" onSubmit={(e) => (e.preventDefault(), setAccessKey(k), onDone())}>
        <h2><span className="logo"><i /><i /></span> Conflux</h2>
        <p className="muted">This deployment needs an access key (CONFLUX_ACCESS_KEY).</p>
        <input className="input" type="password" autoFocus value={k} onChange={(e) => setK(e.target.value)} placeholder="Access key" />
        <Button kind="primary" type="submit">Continue</Button>
      </form>
    </div>
  );
}
