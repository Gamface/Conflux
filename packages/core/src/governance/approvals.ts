import type { Db } from "../db.ts";
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

  pending() {
    return this.db.all("SELECT * FROM approvals WHERE status='pending' ORDER BY ts DESC");
  }
}
