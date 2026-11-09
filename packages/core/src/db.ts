import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One SQLite file holds everything durable: threads, the FTS index used for cross-session recall,
 * the audit trail, approvals, tasks, schedules, pages, knowledge and workflow runs.
 *
 * SQLite (with FTS5) keeps the whole platform runnable on a $5 VPS or a laptop with zero services,
 * which is the Hermes deployment story, while the schema mirrors what OpenBot keeps in Postgres.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  coworker_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'New conversation',
  system_snapshot TEXT,
  summary TEXT,
  user_turns INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  run_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tool_calls TEXT,
  tool_call_id TEXT,
  name TEXT,
  ui TEXT,
  compacted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, thread_id UNINDEXED, message_id UNINDEXED, role UNINDEXED);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  run_id TEXT,
  thread_id TEXT,
  coworker_id TEXT,
  initiator TEXT NOT NULL,
  tool TEXT NOT NULL,
  effect TEXT,
  args TEXT,
  context TEXT,
  decision TEXT NOT NULL,
  rule TEXT,
  mode TEXT,
  outcome TEXT,
  result_summary TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts DESC);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'approval',
  run_id TEXT,
  thread_id TEXT,
  coworker_id TEXT,
  tool TEXT,
  args TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  response TEXT,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS trust (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  coworker_id TEXT,
  tool TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS trust_thread ON trust(thread_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  coworker_id TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  plan TEXT,
  result TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  schedule_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  coworker_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  space TEXT NOT NULL DEFAULT 'default',
  parent_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  author TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(title, body, page_id UNINDEXED);

CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  title TEXT NOT NULL,
  chunk INTEGER NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(content, title, dataset UNINDEXED, chunk_id UNINDEXED);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  inputs TEXT,
  outputs TEXT,
  trace TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  run_id TEXT,
  coworker_id TEXT,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skill_usage (
  name TEXT PRIMARY KEY,
  views INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER
);
`;

export type Row = Record<string, any>;

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec(SCHEMA);
  }

  run(sql: string, ...params: any[]): void {
    this.raw.prepare(sql).run(...params.map(normalize));
  }

  get<T = Row>(sql: string, ...params: any[]): T | undefined {
    return this.raw.prepare(sql).get(...params.map(normalize)) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: any[]): T[] {
    return this.raw.prepare(sql).all(...params.map(normalize)) as T[];
  }

  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    this.raw.close();
  }
}

function normalize(v: any): any {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}

/** Turn free text into a safe FTS5 MATCH expression (each token quoted, OR-joined). */
export function ftsQuery(text: string): string {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1)
    .slice(0, 12);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

export const now = (): number => Date.now();
