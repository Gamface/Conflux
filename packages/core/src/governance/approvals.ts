import type { Db, Row } from "../db.ts";
import { now } from "../db.ts";
import { newId, type EventBus } from "../events.ts";

export type ApprovalKind = "approval" | "question";

export type ApprovalRequest = {
  kind: ApprovalKind;
  runId: string;
  threadId: string;
  coworkerId: string;
  tool?: string;
  args?: unknown;
  reason: string;
  /** For questions: suggested answers the UI renders as buttons. */
  choices?: string[];
};

export type ApprovalOutcome = { approved: boolean; response?: string; timedOut?: boolean };

/**
 * Human-in-the-loop hub. A run that reaches an action needing a person parks here; the UI, a chat
 * channel (Telegram "/approve <id>") or the API resolves it. Pending approvals survive in SQLite so
 * the Activity view can show them, but the waiting promise lives in memory: after a restart the run
 * is marked interrupted and must be retried explicitly (OpenDots semantics), never silently resumed.
 */
export class ApprovalCenter {
  private waiters = new Map<string, (o: ApprovalOutcome) => void>();
  private db: Db;
  private bus: EventBus;

  constructor(db: Db, bus: EventBus) {
    this.db = db;
    this.bus = bus;
    // Anything pending from a previous process can no longer be answered.
    db.run("UPDATE approvals SET status='expired', resolved_at=? WHERE status='pending'", now());
  }

  request(req: ApprovalRequest, timeoutMs = 30 * 60_000, signal?: AbortSignal): { id: string; outcome: Promise<ApprovalOutcome> } {
    const id = newId("apr_");
    this.db.run(
      "INSERT INTO approvals (id, ts, kind, run_id, thread_id, coworker_id, tool, args, reason, status) VALUES (?,?,?,?,?,?,?,?,?, 'pending')",
      id, now(), req.kind, req.runId, req.threadId, req.coworkerId, req.tool, req.args ?? null, req.reason,
    );
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => this.finish(id, { approved: false, timedOut: true }, "expired"), timeoutMs);
      timer.unref?.(); // a waiting approval must never keep the process alive on shutdown
      const onAbort = () => this.finish(id, { approved: false, response: "run cancelled" }, "cancelled");
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(id, (o) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(o);
      });
    });
    this.bus.publish("approvals", { type: "approval_requested", id, ...req });
    return { id, outcome };
  }

  resolve(id: string, approved: boolean, response?: string): boolean {
    const row = this.db.get("SELECT status FROM approvals WHERE id=?", id);
    if (!row || row.status !== "pending") return false;
    this.finish(id, { approved, response }, approved ? "approved" : "denied");
    return true;
  }

  private finish(id: string, o: ApprovalOutcome, status: string): void {
    this.db.run("UPDATE approvals SET status=?, response=?, resolved_at=? WHERE id=? AND status='pending'", status, o.response ?? null, now(), id);
    const w = this.waiters.get(id);
    this.waiters.delete(id);
    this.bus.publish("approvals", { type: "approval_resolved", id, status, response: o.response });
    w?.(o);
  }

  pending(threadId?: string) {
    return threadId
      ? this.db.all("SELECT * FROM approvals WHERE status='pending' AND thread_id=? ORDER BY ts", threadId)
      : this.db.all("SELECT * FROM approvals WHERE status='pending' ORDER BY ts DESC");
  }

  // ── Trust: "approve all" for a conversation ───────────────────────────────
  // A person can say "stop asking in this chat" — for one tool or for everything, optionally for a
  // limited time. Trust only skips the *ask*: Never (deny) rules, grants and the audit trail still apply.

  grantTrust(threadId: string, opts: { tool?: string | null; coworkerId?: string; ttlMs?: number } = {}): Row {
    const id = newId("tru_");
    const tool = opts.tool ?? null;
    // Replace an equivalent grant instead of stacking duplicates.
    this.db.run("DELETE FROM trust WHERE thread_id=? AND COALESCE(tool,'*')=COALESCE(?,'*')", threadId, tool);
    this.db.run(
      "INSERT INTO trust (id, thread_id, coworker_id, tool, created_at, expires_at) VALUES (?,?,?,?,?,?)",
      id, threadId, opts.coworkerId, tool, now(), opts.ttlMs ? now() + opts.ttlMs : null,
    );
    this.bus.publish("approvals", { type: "trust_granted", id, threadId, tool });
    return this.db.get("SELECT * FROM trust WHERE id=?", id)!;
  }

  /** The grant that lets `tool` run without asking in this conversation, if any. */
  trusted(threadId: string, tool: string): Row | undefined {
    return this.db.get(
      "SELECT * FROM trust WHERE thread_id=? AND (tool IS NULL OR tool=?) AND (expires_at IS NULL OR expires_at > ?) ORDER BY tool IS NULL LIMIT 1",
      threadId, tool, now(),
    );
  }

  trustFor(threadId: string): Row[] {
    this.db.run("DELETE FROM trust WHERE expires_at IS NOT NULL AND expires_at <= ?", now());
    return this.db.all("SELECT * FROM trust WHERE thread_id=? ORDER BY created_at", threadId);
  }

  revokeTrust(id: string): void {
    const row = this.db.get("SELECT thread_id FROM trust WHERE id=?", id);
    this.db.run("DELETE FROM trust WHERE id=?", id);
    if (row) this.bus.publish("approvals", { type: "trust_revoked", id, threadId: row.thread_id });
  }

  revokeAllTrust(threadId: string): void {
    this.db.run("DELETE FROM trust WHERE thread_id=?", threadId);
    this.bus.publish("approvals", { type: "trust_revoked", threadId });
  }

  /**
   * Approve, optionally remembering the choice. Also releases every other pending approval in the
   * same conversation that the new grant now covers, so a burst of queued prompts clears at once.
   */
  approve(id: string, opts: { response?: string; remember?: "tool" | "all"; ttlMs?: number } = {}): { ok: boolean; released: string[] } {
    const row = this.db.get("SELECT * FROM approvals WHERE id=?", id);
    if (!row || row.status !== "pending") return { ok: false, released: [] };
    if (opts.remember && row.thread_id) this.grantTrust(row.thread_id, { tool: opts.remember === "tool" ? row.tool : null, coworkerId: row.coworker_id, ttlMs: opts.ttlMs });
    this.resolve(id, true, opts.response);
    const released: string[] = [];
    if (opts.remember && row.thread_id) {
      for (const p of this.pending(row.thread_id)) {
        if (p.kind !== "approval") continue;
        if (opts.remember === "all" || p.tool === row.tool) {
          this.resolve(p.id, true, "auto-approved (trusted in this conversation)");
          released.push(p.id);
        }
      }
    }
    return { ok: true, released };
  }

  /** Approve every pending action request (never clarifying questions), optionally in one conversation. */
  approveAll(threadId?: string, opts: { remember?: boolean; ttlMs?: number } = {}): string[] {
    const ids: string[] = [];
    const threads = new Set<string>();
    if (threadId && opts.remember) {
      this.grantTrust(threadId, { tool: null, ttlMs: opts.ttlMs });
      threads.add(threadId);
    }
    for (const p of this.pending(threadId)) {
      if (p.kind !== "approval") continue;
      if (opts.remember && p.thread_id && !threads.has(p.thread_id)) {
        this.grantTrust(p.thread_id, { tool: null, coworkerId: p.coworker_id, ttlMs: opts.ttlMs });
        threads.add(p.thread_id);
      }
      if (this.resolve(p.id, true, "approved with Approve all")) ids.push(p.id);
    }
    return ids;
  }
}
