import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { Button, PageHeader, Pill } from "../ui.tsx";

type Preset = {
  id: string;
  label: string;
  provider: "openai" | "anthropic";
  baseUrl?: string;
  model: string;
  needsKey: boolean;
  local?: boolean;
  keyUrl?: string;
  hint: string;
};

const PRESETS: Preset[] = [
  { id: "anthropic", label: "Anthropic", provider: "anthropic", model: "claude-sonnet-4-5", needsKey: true, keyUrl: "https://console.anthropic.com/settings/keys", hint: "Claude models. Paste an API key from the Anthropic Console." },
  { id: "openai", label: "OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", needsKey: true, keyUrl: "https://platform.openai.com/api-keys", hint: "GPT models. Paste an API key from the OpenAI platform." },
  { id: "openrouter", label: "OpenRouter", provider: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5", needsKey: true, keyUrl: "https://openrouter.ai/keys", hint: "Hundreds of models behind one key." },
  { id: "ollama", label: "Ollama (local)", provider: "openai", baseUrl: "http://localhost:11434/v1", model: "", needsKey: false, local: true, hint: "Models running on this computer with Ollama. No key needed." },
  { id: "lmstudio", label: "LM Studio (local)", provider: "openai", baseUrl: "http://localhost:1234/v1", model: "", needsKey: false, local: true, hint: "Start LM Studio's local server first (Developer → Start server)." },
  { id: "custom", label: "Other (OpenAI-compatible)", provider: "openai", baseUrl: "", model: "", needsKey: false, hint: "vLLM, Together, Groq, Nous Portal, a LiteLLM proxy… anything with /v1/chat/completions." },
];

type Profile = { key: string; provider: string; model: string; baseUrl?: string; hasKey: boolean; default: boolean };
type TestResult = { ok: boolean; reply?: string; error?: string; ms: number };

export function Models({ onChange }: { onChange: () => void }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [form, setForm] = useState({ key: "", baseUrl: "", model: "", apiKey: "" });
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [embedding, setEmbedding] = useState<string[]>([]);
  const [discoverErr, setDiscoverErr] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [rowTest, setRowTest] = useState<Record<string, TestResult | "running">>({});

  const load = () => api<Profile[]>("/api/models").then(setProfiles);
  useEffect(() => {
    load();
  }, []);

  const choose = (p: Preset) => {
    setPreset(p);
    setForm({ key: p.id === "custom" ? "" : p.id, baseUrl: p.baseUrl ?? "", model: p.model, apiKey: "" });
    setTest(null);
    setErr("");
    setDiscovered(null);
    setDiscoverErr("");
    if (p.local) discover(p.baseUrl!, "");
  };

  const discover = async (baseUrl: string, apiKey: string) => {
    setDiscoverErr("");
    const d = await api(`/api/models/discover?baseUrl=${encodeURIComponent(baseUrl)}${apiKey ? `&apiKey=${encodeURIComponent(apiKey)}` : ""}`);
    if (d.ok) {
      setDiscovered(d.models);
      setEmbedding(d.embedding ?? []);
      const firstChat = d.models.find((m: string) => !(d.embedding ?? []).includes(m));
      setForm((f) => ({ ...f, model: f.model && !(d.embedding ?? []).includes(f.model) ? f.model : firstChat ?? "" }));
    } else {
      setDiscovered(null);
      setDiscoverErr(d.error);
    }
  };

  const body = () => ({ key: form.key.trim(), provider: preset!.provider, baseUrl: preset!.provider === "anthropic" ? undefined : form.baseUrl, model: form.model.trim(), apiKey: form.apiKey || undefined });

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      setTest(await api("/api/models/test", { body: body() }));
    } finally {
      setBusy(false);
    }
  };

  const isEmbedding = embedding.includes(form.model) || /embed|bge-|e5-|gte-|minilm|rerank/i.test(form.model);
  const save = async (makeDefault: boolean) => {
    setErr("");
    try {
      await api("/api/models", { body: { ...body(), makeDefault } });
      setPreset(null);
      await load();
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const testRow = async (key: string) => {
    setRowTest((r) => ({ ...r, [key]: "running" }));
    const t = await api<TestResult>("/api/models/test", { body: { key } });
    setRowTest((r) => ({ ...r, [key]: t }));
  };

  const isDefaultOffline = profiles.find((p) => p.default)?.provider === "mock";

  return (
    <div className="page">
      <PageHeader title="Models" subtitle="Connect the LLMs your coworkers think with. The default is used by every coworker that doesn't pick its own — assign one per coworker from its chat header or the Coworkers page. Keys are stored only on this computer (data/secrets.json)." />

      {isDefaultOffline && !preset && (
        <div className="notice notice-info">You're on the built-in offline model. It drives real tools but can't reason. Connect a model below to make your coworkers smart.</div>
      )}

      <section className="section">
        <h2>Connected</h2>
        <div className="table">
          {profiles.map((p) => {
            const t = rowTest[p.key];
            return (
              <div key={p.key} className="table-row">
                <span className="grow">
                  <b>{p.key}</b> <span className="muted small mono">{p.provider === "mock" ? "built-in" : `${p.provider} · ${p.model}`}</span>
                  {p.baseUrl && <div className="muted small mono">{p.baseUrl}</div>}
                  {t && t !== "running" && <div className={`small ${t.ok ? "ok" : "bad"}`}>{t.ok ? `✓ replied "${t.reply}" in ${t.ms} ms` : `✕ ${t.error}`}</div>}
                </span>
                {!p.hasKey && <Pill tone="bad">key missing</Pill>}
                {(p as any).embedding && <Pill tone="bad">embedding model — can't chat</Pill>}
                {p.default ? <Pill tone="accent">default</Pill> : <Button small onClick={() => api("/api/models/default", { method: "PUT", body: { key: p.key } }).then(() => (load(), onChange()))}>Use as default</Button>}
                {p.provider !== "mock" && <Button small disabled={t === "running"} onClick={() => testRow(p.key)}>{t === "running" ? "Testing…" : "Test"}</Button>}
                {p.provider !== "mock" && <Button small kind="ghost" onClick={() => confirm(`Remove ${p.key}? Its saved key is deleted too.`) && api(`/api/models/${p.key}`, { method: "DELETE" }).then(() => (load(), onChange()))}>Remove</Button>}
              </div>
            );
          })}
        </div>
      </section>

      <section className="section">
        <h2>Connect a model</h2>
        <div className="page-grid">
          {PRESETS.map((p) => (
            <button key={p.id} className={`page-tile preset ${preset?.id === p.id ? "selected" : ""}`} onClick={() => choose(p)}>
              <div className="page-tile-title">{p.label}</div>
              <div className="page-tile-excerpt">{p.hint}</div>
              <div className="row gap small">{p.local ? <Pill tone="ok">local · free</Pill> : <Pill>API key</Pill>}</div>
            </button>
          ))}
        </div>

        {preset && (
          <div className="card stack">
            <h3>{preset.label}</h3>
            <div className="row gap wrap">
              <label className="field">
                <span>Name</span>
                <input className="input mono" value={form.key} placeholder="e.g. groq" onChange={(e) => setForm({ ...form, key: e.target.value.toLowerCase() })} />
              </label>
              {preset.provider !== "anthropic" && (
                <label className="field grow">
                  <span>Server URL</span>
                  <input className="input mono" value={form.baseUrl} placeholder="https://…/v1" onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} onBlur={() => form.baseUrl && (preset.local || preset.id === "custom") && discover(form.baseUrl, form.apiKey)} />
                </label>
              )}
            </div>
            {(preset.needsKey || preset.id === "custom") && (
              <label className="field">
                <span>API key {preset.keyUrl && <a href={preset.keyUrl} target="_blank" rel="noreferrer" className="small">get one ↗</a>} {!preset.needsKey && <span className="muted small">(if your server needs one)</span>}</span>
                <input className="input mono" type="password" autoComplete="off" value={form.apiKey} placeholder={preset.id === "anthropic" ? "sk-ant-…" : "sk-…"} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
              </label>
            )}
            <label className="field">
              <span>Model {preset.local && <Button small kind="ghost" onClick={() => discover(form.baseUrl, form.apiKey)}>↻ refresh list</Button>}</span>
              {discovered && discovered.length > 0 ? (
                <select className="input mono" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
                  {discovered.map((m) => <option key={m} value={m}>{m}{embedding.includes(m) ? "  — embedding model, can't chat" : ""}</option>)}
                </select>
              ) : (
                <input className="input mono" value={form.model} placeholder="model id" onChange={(e) => setForm({ ...form, model: e.target.value })} />
              )}
            </label>
            {preset.local && discoverErr && (
              <div className="notice notice-bad">
                Couldn't reach {form.baseUrl} ({discoverErr}).{" "}
                {preset.id === "ollama" ? "Is Ollama running? Start it, then `ollama pull llama3.1` (or any model) and refresh." : "Start LM Studio's local server, load a model, then refresh."}
              </div>
            )}
            {preset.local && discovered && discovered.length === 0 && <div className="notice notice-info">The server is running but has no models yet. {preset.id === "ollama" ? "Run `ollama pull llama3.1`" : "Load a model in LM Studio"}, then refresh.</div>}
            {isEmbedding && <div className="notice notice-bad">"{form.model}" is an embedding model: it turns text into vectors for search and cannot chat or use tools. Pick a chat model (e.g. qwen, llama, mistral, gemma).</div>}
            {preset.local && <div className="muted small">Small local models may struggle with tool use. 7B+ instruction-tuned models with tool support (Qwen, Llama 3.1+) work best.</div>}

            <div className="row gap">
              <Button disabled={busy || !form.model || (preset.needsKey && !form.apiKey)} onClick={runTest}>{busy ? "Testing…" : "Test connection"}</Button>
              <Button kind="primary" disabled={!form.key || !form.model || isEmbedding || (preset.needsKey && !form.apiKey)} onClick={() => save(true)}>Save & use as default</Button>
              <Button disabled={!form.key || !form.model || isEmbedding || (preset.needsKey && !form.apiKey)} onClick={() => save(false)} title="Add it so you can assign it to specific coworkers">Save only</Button>
              <Button kind="ghost" onClick={() => setPreset(null)}>Cancel</Button>
            </div>
            {test && <div className={`notice ${test.ok ? "notice-ok" : "notice-bad"}`}>{test.ok ? `✓ Connected — the model replied "${test.reply}" in ${test.ms} ms` : `✕ ${test.error}`}</div>}
            {err && <div className="tool-error">{err}</div>}
          </div>
        )}
      </section>
    </div>
  );
}
