import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { DEFAULT_POLICY, type Policy } from "./governance/policy.ts";

export type ProviderKind = "openai" | "anthropic" | "mock";

export type ModelProfile = {
  provider: ProviderKind;
  model: string;
  /** OpenAI-compatible base URL: OpenAI, OpenRouter, Nous Portal, Ollama, vLLM, LM Studio… */
  baseUrl?: string;
  apiKeyEnv?: string;
  maxTokens?: number;
  temperature?: number;
};

export type LearningSettings = {
  enabled: boolean;
  /** Run a background memory review every N user turns (Hermes memory nudge). */
  memoryNudgeInterval: number;
  /** A turn with at least this many tool calls is reviewed for a reusable skill (Hermes skill nudge). */
  skillNudgeToolCalls: number;
};

export type Coworker = {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  description?: string;
  /** Role instructions — the coworker's job, in words. */
  role: string;
  /** Key into `models`. */
  model?: string;
  /** Tool grants: "*", "toolset:web", "browser_*", "!terminal". */
  tools: string[];
  /** Extra boundaries for this coworker; can only narrow the organisation policy. */
  policy?: Partial<Policy>;
  learning?: Partial<LearningSettings>;
  /** Spaces this coworker may read/write pages in. Default: ["default"]. */
  spaces?: string[];
  maxIterations?: number;
  /** Bring-your-own agent: any AG-UI endpoint. Its tool calls are executed through the gateway. */
  agui?: { url: string; headers?: Record<string, string> };
};

export type McpServerConfig = { command: string; args?: string[]; env?: Record<string, string>; disabled?: boolean };

export type Config = {
  dataDir: string;
  host: string;
  port: number;
  accessKey?: string;
  defaultModel: string;
  models: Record<string, ModelProfile>;
  coworkers: Coworker[];
  policy: Policy;
  mcpServers: Record<string, McpServerConfig>;
  channels: {
    telegram?: { tokenEnv: string; coworker: string; allowedChatIds?: number[] };
  };
  approvalTimeoutMs: number;
  context: { maxChars: number; keepRecent: number };
  learning: LearningSettings;
  workers: { concurrency: number; leaseMs: number };
  computer: { headless: boolean; desktop: boolean };
};

const BASE_COWORKERS: Coworker[] = [
  {
    id: "assistant",
    name: "General Assistant",
    emoji: "✦",
    color: "#6d5dfc",
    description: "Everyday work: research, writing, files, browsing and planning.",
    role:
      "You are a capable, concise general assistant. Plan multi-step work with the todo tool, use tools rather than guessing, and save durable results as pages when the user will want to keep them.",
    tools: ["*", "!desktop_*"],
  },
  {
    id: "researcher",
    name: "Researcher",
    emoji: "◎",
    color: "#0ea5a4",
    description: "Reads the web and the knowledge base, and writes sourced briefs.",
    role:
      "You are a meticulous researcher. Cite every claim with its source URL or knowledge document, say plainly what you could not find, and save finished briefs as pages.",
    tools: ["toolset:web", "toolset:knowledge", "toolset:spaces", "toolset:learning", "todo", "browser_*"],
    policy: { deny: ['action.effect == "destructive"'] },
  },
  {
    id: "operator",
    name: "Operator",
    emoji: "⌘",
    color: "#f59e0b",
    description: "Drives desktop apps and the terminal. Everything it does needs your approval.",
    role:
      "You operate computers: the terminal, the browser and desktop apps through their accessibility tree. Snapshot, act on refs, then re-snapshot to verify. Explain each step briefly.",
    tools: ["toolset:computer", "toolset:files", "terminal", "todo", "toolset:learning"],
    policy: { requireApproval: ['action.effect in ["write", "execute", "destructive", "external"]'] },
  },
];

const BASE_POLICY: Policy = {
  ...DEFAULT_POLICY,
  deny: [
    'tool.name == "terminal" && args.command.matches("(^|[;&| ])(sudo|mkfs|shutdown|reboot)\\\\b|rm -rf /($| )")',
    'has(page) && has(element) && element.name.matches("(?i)(place order|pay now|confirm purchase|delete account)")',
  ],
  requireApproval: [
    'action.effect == "destructive"',
    'tool.name == "terminal" && initiator != "user"',
    'tool.name in ["browser_type", "desktop_type"] && has(args.submit) && args.submit == true',
  ],
  allow: ["true"],
  labels: {
    'action.effect == "destructive"': { name: "Destructive actions", description: "Deleting or overwriting things needs a person to say yes." },
    'tool.name == "terminal" && initiator != "user"': { name: "Unattended shell", description: "Background and scheduled runs must ask before running shell commands." },
  },
};

function detectDefaultModels(): { defaultModel: string; models: Record<string, ModelProfile> } {
  const models: Record<string, ModelProfile> = {
    mock: { provider: "mock", model: "conflux-mock" },
  };
  let defaultModel = "mock";
  if (process.env.OPENROUTER_API_KEY) {
    models.openrouter = { provider: "openai", baseUrl: "https://openrouter.ai/api/v1", model: process.env.CONFLUX_MODEL ?? "anthropic/claude-sonnet-4.5", apiKeyEnv: "OPENROUTER_API_KEY" };
    defaultModel = "openrouter";
  }
  if (process.env.OPENAI_API_KEY) {
    models.openai = { provider: "openai", baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", model: process.env.CONFLUX_MODEL ?? "gpt-4.1", apiKeyEnv: "OPENAI_API_KEY" };
    defaultModel = "openai";
  }
  if (process.env.ANTHROPIC_API_KEY) {
    models.anthropic = { provider: "anthropic", model: process.env.CONFLUX_MODEL ?? "claude-sonnet-4-5", apiKeyEnv: "ANTHROPIC_API_KEY", maxTokens: 8192 };
    defaultModel = "anthropic";
  }
  if (process.env.OLLAMA_HOST || process.env.CONFLUX_OLLAMA_MODEL) {
    models.ollama = { provider: "openai", baseUrl: (process.env.OLLAMA_HOST ?? "http://localhost:11434") + "/v1", model: process.env.CONFLUX_OLLAMA_MODEL ?? "llama3.1" };
  }
  return { defaultModel: process.env.CONFLUX_DEFAULT_MODEL ?? defaultModel, models };
}

/**
 * Configuration = built-in defaults ← conflux.config.json ← data/overrides.json (edits from the UI).
 * Secrets never live here: model profiles name an environment variable (`apiKeyEnv`).
 */
export function loadConfig(opts: { configPath?: string; dataDir?: string; overrides?: Partial<Config> } = {}): Config {
  const { defaultModel, models } = detectDefaultModels();
  let cfg: Config = {
    dataDir: resolve(opts.dataDir ?? process.env.CONFLUX_DATA_DIR ?? "./data"),
    host: process.env.CONFLUX_HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? process.env.CONFLUX_PORT ?? 8787),
    accessKey: process.env.CONFLUX_ACCESS_KEY || undefined,
    defaultModel,
    models,
    coworkers: BASE_COWORKERS,
    policy: BASE_POLICY,
    mcpServers: {},
    channels: {},
    approvalTimeoutMs: 30 * 60_000,
    context: { maxChars: 120_000, keepRecent: 16 },
    learning: { enabled: true, memoryNudgeInterval: 6, skillNudgeToolCalls: 5 },
    workers: { concurrency: 2, leaseMs: 60_000 },
    computer: { headless: true, desktop: true },
  };
  const path = opts.configPath ?? process.env.CONFLUX_CONFIG ?? "conflux.config.json";
  if (existsSync(path)) cfg = merge(cfg, JSON.parse(readFileSync(path, "utf8")));
  if (opts.overrides) cfg = merge(cfg, opts.overrides);
  const overridesPath = join(cfg.dataDir, "overrides.json");
  if (existsSync(overridesPath)) cfg = merge(cfg, JSON.parse(readFileSync(overridesPath, "utf8")));
  if (!cfg.models[cfg.defaultModel]) cfg.defaultModel = Object.keys(cfg.models)[0];
  return cfg;
}

function merge(base: Config, extra: Partial<Config>): Config {
  const out: any = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) continue;
    if (k === "coworkers" && Array.isArray(v)) {
      const byId = new Map(base.coworkers.map((c) => [c.id, c]));
      for (const c of v as Coworker[]) byId.set(c.id, { ...(byId.get(c.id) ?? {}), ...c } as Coworker);
      out.coworkers = [...byId.values()];
    } else if (v && typeof v === "object" && !Array.isArray(v) && base[k as keyof Config] && typeof base[k as keyof Config] === "object") {
      out[k] = { ...(base as any)[k], ...v };
    } else out[k] = v;
  }
  return out;
}

/** Persist a UI edit (coworkers, policy) to data/overrides.json without touching the checked-in config. */
export function saveOverride(cfg: Config, patch: Partial<Config>): void {
  const p = join(cfg.dataDir, "overrides.json");
  mkdirSync(dirname(p), { recursive: true });
  const current = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  const next = { ...current, ...patch };
  if (patch.coworkers) {
    const byId = new Map<string, Coworker>((current.coworkers ?? []).map((c: Coworker) => [c.id, c]));
    for (const c of patch.coworkers) byId.set(c.id, c);
    next.coworkers = [...byId.values()];
  }
  writeFileSync(p, JSON.stringify(next, null, 2));
}

export function learningFor(cfg: Config, c: Coworker): LearningSettings {
  return { ...cfg.learning, ...(c.learning ?? {}) };
}
