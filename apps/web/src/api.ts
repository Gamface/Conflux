const KEY_STORAGE = "conflux.accessKey";

export function accessKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}
export function setAccessKey(k: string): void {
  try {
    localStorage.setItem(KEY_STORAGE, k);
  } catch {
    /* storage unavailable */
  }
}

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const k = accessKey();
  return { "content-type": "application/json", ...(k ? { authorization: `Bearer ${k}` } : {}), ...extra };
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, { method: opts.method ?? (opts.body ? "POST" : "GET"), headers: headers(), body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** POST and consume an SSE response (AG-UI events). */
export async function stream(path: string, body: unknown, onEvent: (e: any) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(path, { method: "POST", headers: headers({ accept: "text/event-stream" }), body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) throw new ApiError(res.status, await res.json().catch(() => ({})));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (data) {
        try {
          onEvent(JSON.parse(data));
        } catch {
          /* ignore malformed */
        }
      }
    }
  }
}

/** Process-wide event bus (tasks, approvals, learning, background thread updates). */
export function subscribeEvents(onEvent: (e: { channel: string; event: any }) => void): () => void {
  const k = accessKey();
  let es: EventSource | null = null;
  let stopped = false;
  const open = () => {
    es = new EventSource(`/api/events${k ? `?key=${encodeURIComponent(k)}` : ""}`);
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      es?.close();
      if (!stopped) setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    stopped = true;
    es?.close();
  };
}

export type Coworker = {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  description?: string;
  role: string;
  /** The coworker's own model; null/undefined = use the default. */
  model?: string | null;
  effectiveModel?: string;
  usesDefaultModel?: boolean;
  tools: string[];
  toolCount?: number;
  spaces?: string[] | null;
  policy?: { deny?: string[]; requireApproval?: string[]; allow?: string[] };
  learning?: { enabled?: boolean };
  agui?: { url: string };
};

export const timeAgo = (ts: number): string => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
};
