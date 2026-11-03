import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { Button } from "../ui.tsx";

/**
 * Live view of a coworker's own browser, with "take control": clicks and keys you make here go
 * straight to that browser (and into the audit trail as yours). Use it to sign in once — the
 * coworker's profile keeps the session.
 */
export function ComputerPanel({ coworkerId }: { coworkerId: string }) {
  const [shot, setShot] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [open, setOpen] = useState(false);
  const [control, setControl] = useState(false);
  const [text, setText] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);

  const refresh = () =>
    api(`/api/computer/${coworkerId}`)
      .then((d) => {
        setOpen(d.open);
        if (d.open) {
          setShot(d.screenshot);
          setUrl((u) => (document.activeElement?.id === "cfx-url" ? u : d.url ?? ""));
        }
      })
      .catch(() => {});

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, control ? 1200 : 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coworkerId, control]);

  const act = async (body: any) => {
    try {
      const d = await api(`/api/computer/${coworkerId}/action`, { body });
      setOpen(true);
      setShot(d.screenshot);
      setUrl(d.url);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const click = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!control || !imgRef.current) return;
    const r = imgRef.current.getBoundingClientRect();
    act({ type: "click", x: ((e.clientX - r.left) / r.width) * 1280, y: ((e.clientY - r.top) / r.height) * 800 });
  };

  return (
    <div className="panel computer">
      <div className="panel-title row">
        <span className="grow">Computer</span>
        <Button small kind={control ? "danger" : "primary"} onClick={() => setControl(!control)}>{control ? "Hand back" : "Take control"}</Button>
      </div>
      <form className="row gap" onSubmit={(e) => (e.preventDefault(), act({ type: "navigate", url }))}>
        <input id="cfx-url" className="input grow mono small" value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} disabled={!control} />
      </form>
      {open && shot ? (
        <img ref={imgRef} className={`screen ${control ? "controlling" : ""}`} src={`data:image/jpeg;base64,${shot}`} onClick={click} alt="coworker browser" />
      ) : (
        <div className="screen-empty muted small">The browser opens when the coworker first uses it{control ? " — or enter a URL above" : ""}.</div>
      )}
      {control && (
        <>
          <form className="row gap" onSubmit={(e) => (e.preventDefault(), act({ type: "type", text }), setText(""))}>
            <input className="input grow" placeholder="Type into the focused field…" value={text} onChange={(e) => setText(e.target.value)} />
            <Button small type="submit">Type</Button>
          </form>
          <div className="row gap wrap">
            {["Enter", "Tab", "Escape", "Backspace"].map((k) => (
              <Button key={k} small onClick={() => act({ type: "key", key: k })}>{k}</Button>
            ))}
            <Button small onClick={() => act({ type: "scroll", dy: 500 })}>Scroll ↓</Button>
            <Button small onClick={() => act({ type: "back" })}>← Back</Button>
          </div>
          <div className="muted small">You're driving. Your actions are recorded as yours in the audit trail.</div>
        </>
      )}
    </div>
  );
}
