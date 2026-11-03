import { marked } from "marked";
import { useMemo, type ReactNode } from "react";

marked.setOptions({ gfm: true, breaks: true });

// Neutralise raw HTML (every tag starts with "<"); entities and Markdown syntax are left alone.
function escapeHtml(s: string): string {
  return s.replace(/</g, "&lt;");
}

/** Markdown with raw HTML escaped first, so model output can never inject markup or script. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const out = marked.parse(escapeHtml(text ?? ""), { async: false }) as string;
    return out.replace(/<a href="(?!https?:|mailto:|#|\/)[^"]*"/g, '<a href="#"').replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
  }, [text]);
  return <div className={`md ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Button(p: { children: ReactNode; onClick?: () => void; kind?: "primary" | "ghost" | "danger" | "default"; small?: boolean; disabled?: boolean; title?: string; type?: "button" | "submit" }) {
  return (
    <button type={p.type ?? "button"} title={p.title} disabled={p.disabled} onClick={p.onClick} className={`btn btn-${p.kind ?? "default"}${p.small ? " btn-sm" : ""}`}>
      {p.children}
    </button>
  );
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "bad" | "info" | "accent" }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="row gap">{actions}</div>}
    </header>
  );
}

export function Avatar({ emoji, color, size = 28 }: { emoji?: string; color?: string; size?: number }) {
  return (
    <span className="avatar" style={{ background: color ?? "var(--accent)", width: size, height: size, fontSize: size * 0.5 }}>
      {emoji ?? "✦"}
    </span>
  );
}

export const STATUS_TONE: Record<string, "neutral" | "ok" | "warn" | "bad" | "info" | "accent"> = {
  queued: "neutral",
  running: "info",
  waiting_input: "warn",
  paused: "neutral",
  succeeded: "ok",
  failed: "bad",
  cancelled: "neutral",
  interrupted: "warn",
  pending: "warn",
  approved: "ok",
  denied: "bad",
  expired: "neutral",
  allow: "ok",
  deny: "bad",
  approve: "warn",
  takeover: "accent",
};

export function JsonBlock({ value, max = 4000 }: { value: unknown; max?: number }) {
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="code">{s && s.length > max ? s.slice(0, max) + "\n…" : s}</pre>;
}
