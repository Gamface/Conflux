import type { Row } from "../db.ts";
import { now } from "../db.ts";
import { newId } from "../events.ts";
import type { Runtime } from "../runtime.ts";
import { cronMatches, parseCron } from "./cron.ts";

/**
 * Durable background work (OpenMuse Activity + OpenDots scheduled turns).
 *
 * States: queued → running ⇄ waiting_input → succeeded | failed | cancelled
 *         running → paused (cooperative) → queued on resume
 *         running + lease expired (process died) → interrupted → (explicit retry) → queued
 *
 * Interrupted work is never resumed silently: effects may already have happened, so a person
 * reviews the audit trail and presses Retry.
 */
export class TaskQueue {
  private rt: Runtime;
  private running = new Map<string, AbortController>();
  private timer?: NodeJS.Timeout;
  private started = false;

  constructor(rt: Runtime) {
    this.rt = rt;
  }

  start(): void {
    this.started = true;
    const expired = this.rt.db.all("SELECT id FROM tasks WHERE status IN ('running','waiting_input')");
    for (const t of expired) this.setStatus(t.id, "interrupted", { error: "The worker stopped while this task was running. Review its actions, then retry." });
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }

  stop(): void {
    this.started = false;
    clearInterval(this.timer);
    for (const c of this.running.values()) c.abort();
  }

  create(t: { coworkerId: string; title: string; prompt: string; threadId?: string; scheduleId?: string }): Row {
    const id = newId("tsk_");
    const thread = this.rt.runner.ensureThread(t.coworkerId, t.threadId, t.title);
    this.rt.db.run(
      "INSERT INTO tasks (id, thread_id, coworker_id, title, prompt, status, schedule_id, created_at, updated_at) VALUES (?,?,?,?,?, 'queued', ?,?,?)",
      id, thread.id, t.coworkerId, t.title, t.prompt, t.scheduleId, now(), now(),
    );
    this.rt.bus.publish("tasks", { type: "task_created", id });
    setImmediate(() => this.tick());
    return this.get(id)!;
  }

  get(id: string): Row | undefined {
    return this.rt.db.get("SELECT * FROM tasks WHERE id=?", id);
  }

  list(limit = 100): Row[] {
    return this.rt.db.all("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?", limit);
  }

  private setStatus(id: string, status: string, extra: { result?: string; error?: string } = {}): void {
    this.rt.db.run(
      "UPDATE tasks SET status=?, result=COALESCE(?, result), error=?, updated_at=?, lease_until=CASE WHEN ? IN ('running','waiting_input') THEN lease_until ELSE NULL END WHERE id=?",
      status, extra.result, extra.error, now(), status, id,
    );
    this.rt.bus.publish("tasks", { type: "task_status", id, status, error: extra.error });
  }

  pause(id: string): boolean {
    const t = this.get(id);
    if (!t) return false;
    if (t.status === "queued") {
      this.setStatus(id, "paused");
      return true;
    }
    if (t.status === "running" || t.status === "waiting_input") {
      this.running.get(id)?.abort("pause");
      return true;
    }
    return false;
  }

  resume(id: string): boolean {
    const t = this.get(id);
    if (!t || t.status !== "paused") return false;
    this.setStatus(id, "queued");
    return true;
  }

  cancel(id: string): boolean {
    const t = this.get(id);
    if (!t || ["succeeded", "failed", "cancelled"].includes(t.status)) return false;
    const c = this.running.get(id);
    if (c) c.abort("cancel");
    else this.setStatus(id, "cancelled");
    return true;
  }

  retry(id: string): boolean {
    const t = this.get(id);
    if (!t || !["failed", "interrupted", "cancelled"].includes(t.status)) return false;
    this.setStatus(id, "queued");
    return true;
  }

  private tick(): void {
    if (!this.started) return;
    const { concurrency, leaseMs } = this.rt.config.workers;
    // Refresh leases of tasks we own.
    for (const id of this.running.keys()) this.rt.db.run("UPDATE tasks SET lease_until=? WHERE id=?", now() + leaseMs, id);
    while (this.running.size < concurrency) {
      const claimed = this.rt.db.tx(() => {
        const t = this.rt.db.get("SELECT * FROM tasks WHERE status='queued' ORDER BY created_at LIMIT 1");
        if (!t) return undefined;
        this.rt.db.run("UPDATE tasks SET status='running', attempts=attempts+1, lease_until=?, updated_at=? WHERE id=?", now() + leaseMs, now(), t.id);
        return t;
      });
      if (!claimed) break;
      this.execute(claimed);
    }
  }

  private execute(t: Row): void {
    const controller = new AbortController();
    this.running.set(t.id, controller);
    this.rt.bus.publish("tasks", { type: "task_status", id: t.id, status: "running" });
    const isResume = t.attempts > 0 && t.result;
    const input = isResume ? `Continue the task "${t.title}" where you left off.\n\nOriginal instruction:\n${t.prompt}` : t.prompt;
    this.rt.runner
      .run({
        coworkerId: t.coworker_id,
        threadId: t.thread_id,
        input,
        initiator: t.schedule_id ? "schedule" : "task",
        signal: controller.signal,
        emit: (e) => this.rt.bus.publish(`thread:${t.thread_id}`, e),
        onWaiting: (w) => this.setStatus(t.id, w ? "waiting_input" : "running"),
      })
      .then((r) => {
        const reason = controller.signal.reason;
        if (reason === "pause") this.setStatus(t.id, "paused", { result: r.text });
        else if (reason === "cancel") this.setStatus(t.id, "cancelled", { result: r.text });
        else if (r.error) this.setStatus(t.id, "failed", { error: r.error, result: r.text });
        else this.setStatus(t.id, "succeeded", { result: r.text });
      })
      .catch((e) => this.setStatus(t.id, "failed", { error: (e as Error).message }))
      .finally(() => this.running.delete(t.id));
  }
}

export class Scheduler {
  private rt: Runtime;
  private timer?: NodeJS.Timeout;
  private lastMinute = -1;

  constructor(rt: Runtime) {
    this.rt = rt;
  }

  start(): void {
    this.timer = setInterval(() => this.tick(new Date()), 15_000);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  create(s: { coworkerId: string; threadId: string; name: string; cron: string; prompt: string }): Row {
    parseCron(s.cron);
    const id = newId("sch_");
    this.rt.db.run(
      "INSERT INTO schedules (id, coworker_id, thread_id, name, cron, prompt, enabled, created_at) VALUES (?,?,?,?,?,?,1,?)",
      id, s.coworkerId, s.threadId, s.name, s.cron, s.prompt, now(),
    );
    this.rt.bus.publish("schedules", { type: "schedule_created", id });
    return this.rt.db.get("SELECT * FROM schedules WHERE id=?", id)!;
  }

  list(): Row[] {
    return this.rt.db.all("SELECT * FROM schedules ORDER BY created_at DESC");
  }

  setEnabled(id: string, enabled: boolean): void {
    this.rt.db.run("UPDATE schedules SET enabled=? WHERE id=?", enabled, id);
  }

  delete(id: string): void {
    this.rt.db.run("DELETE FROM schedules WHERE id=?", id);
  }

  /** Fire every enabled schedule whose cron matches this minute (once per minute). */
  tick(at: Date): Row[] {
    const minute = Math.floor(at.getTime() / 60_000);
    if (minute === this.lastMinute) return [];
    this.lastMinute = minute;
    const fired: Row[] = [];
    for (const s of this.rt.db.all("SELECT * FROM schedules WHERE enabled=1")) {
      try {
        if (!cronMatches(parseCron(s.cron), at)) continue;
      } catch {
        continue;
      }
      if (s.last_run_at && Math.floor(s.last_run_at / 60_000) === minute) continue;
      this.rt.db.run("UPDATE schedules SET last_run_at=? WHERE id=?", at.getTime(), s.id);
      fired.push(this.rt.tasks.create({ coworkerId: s.coworker_id, threadId: s.thread_id, title: `⏰ ${s.name}`, prompt: s.prompt, scheduleId: s.id }));
    }
    return fired;
  }

  runNow(id: string): Row {
    const s = this.rt.db.get("SELECT * FROM schedules WHERE id=?", id);
    if (!s) throw new Error(`no schedule ${id}`);
    return this.rt.tasks.create({ coworkerId: s.coworker_id, threadId: s.thread_id, title: `⏰ ${s.name}`, prompt: s.prompt, scheduleId: s.id });
  }
}
