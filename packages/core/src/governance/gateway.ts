import { newId } from "../events.ts";
import { now } from "../db.ts";
import { decide, mergePolicy, type PolicyContext, type PolicyDecision } from "./policy.ts";
import { isGranted } from "../tools/registry.ts";
import { toolEffect, type Tool, type ToolContext, type ToolResult } from "../tools/types.ts";

const MAX_RESULT_CHARS = 24_000;

/**
 * The single door every action goes through — chat turns, background tasks, scheduled runs,
 * workflow tool nodes, subagents and the learning loop alike.
 *
 *   resolve tool → check grant → resolve server-side context → decide → audit → (approve) → act → audit
 *
 * Nothing calls a tool's `run` directly. That is what makes it safe to give a coworker real tools.
 */
export class Gateway {
  async execute(name: string, rawArgs: unknown, ctx: ToolContext, grants?: string[]): Promise<ToolResult> {
    const { rt, coworker } = ctx;
    const started = now();
    const auditId = newId("aud_");
    const tool = rt.tools.get(name);
    const args = coerceArgs(rawArgs);

    const audit = (fields: { decision: string; rule?: string; mode?: string; effect?: string; context?: unknown; outcome?: string; summary?: string }) => {
      rt.db.run(
        `INSERT INTO audit (id, ts, run_id, thread_id, coworker_id, initiator, tool, effect, args, context, decision, rule, mode, outcome, result_summary, duration_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        auditId, started, ctx.runId, ctx.threadId, coworker.id, ctx.initiator, name, fields.effect, redact(args), fields.context,
        fields.decision, fields.rule, fields.mode, fields.outcome, fields.summary, now() - started,
      );
      rt.bus.publish("audit", { type: "audit", id: auditId, tool: name, decision: fields.decision, coworker: coworker.id });
    };

    if (!tool) {
      audit({ decision: "deny", rule: "(unknown tool)", outcome: "refused" });
      return { content: `Error: there is no tool named "${name}".`, isError: true };
    }
    if (!isGranted(grants ?? coworker.tools, tool)) {
      audit({ decision: "deny", rule: "(not granted to coworker)", outcome: "refused" });
      return { content: `Refused: ${coworker.name} has not been granted "${name}".`, isError: true };
    }
    const missing = (tool.parameters.required ?? []).filter((k) => args[k] === undefined || args[k] === null);
    if (missing.length) {
      return { content: `Error: missing required argument(s) ${missing.join(", ")} for ${name}.`, isError: true };
    }

    const effect = toolEffect(tool, args);
    let pctx: PolicyContext;
    try {
      const extra = tool.resolveContext ? await tool.resolveContext(args, ctx) : {};
      pctx = {
        tool: { name: tool.name, toolset: tool.toolset },
        action: { effect },
        coworker: { id: coworker.id },
        initiator: ctx.initiator,
        args,
        ...extra,
      };
    } catch (e) {
      audit({ decision: "deny", rule: "(context resolution failed)", effect, outcome: "refused", summary: (e as Error).message });
      return { content: `Refused: could not resolve what this action targets (${(e as Error).message}).`, isError: true };
    }

    const policy = mergePolicy(rt.policy, coworker.policy);
    const d: PolicyDecision = decide(policy, pctx);
    const ruleText = d.label ? `${d.label.name} (${d.rule})` : d.rule;
    const contextForAudit = { ...pctx, args: undefined, wouldBe: d.wouldBe, errors: d.errors.length ? d.errors : undefined };

    if (d.decision === "deny") {
      audit({ decision: "deny", rule: d.rule, mode: d.mode, effect, context: contextForAudit, outcome: "refused" });
      ctx.emit({ type: "CUSTOM", name: "policy_refused", value: { tool: name, rule: ruleText } });
      return { content: `Refused by policy: ${ruleText}. Do not retry this action another way; tell the user what was blocked.`, isError: true };
    }

    if (d.decision === "approve") {
      const reason = d.label?.description ?? `Rule requires approval: ${d.rule}`;
      const { id, outcome } = rt.approvals.request(
        { kind: "approval", runId: ctx.runId, threadId: ctx.threadId, coworkerId: coworker.id, tool: name, args, reason },
        rt.config.approvalTimeoutMs,
        ctx.signal,
      );
      ctx.emit({ type: "CUSTOM", name: "approval_requested", value: { id, tool: name, args, reason, effect } });
      ctx.onWaiting?.(true);
      const o = await outcome;
      ctx.onWaiting?.(false);
      ctx.emit({ type: "CUSTOM", name: "approval_resolved", value: { id, approved: o.approved, response: o.response } });
      if (!o.approved) {
        audit({ decision: "approve", rule: d.rule, mode: d.mode, effect, context: contextForAudit, outcome: o.timedOut ? "approval-timeout" : "declined", summary: o.response });
        return {
          content: `The user declined this action${o.response ? `: "${o.response}"` : ""}. Do not attempt it another way; adjust the plan or ask.`,
          isError: true,
        };
      }
    }

    try {
      const raw = await tool.run(args, ctx);
      const result: ToolResult = typeof raw === "string" ? { content: raw } : raw;
      if (result.content.length > MAX_RESULT_CHARS) {
        result.content = result.content.slice(0, MAX_RESULT_CHARS) + `\n…[truncated ${result.content.length - MAX_RESULT_CHARS} chars]`;
      }
      audit({
        decision: d.decision === "approve" ? "approved" : d.wouldBe !== d.decision ? `allow (dry-run: would ${d.wouldBe})` : "allow",
        rule: d.rule, mode: d.mode, effect, context: contextForAudit,
        outcome: result.isError ? "error" : "ok", summary: result.content.slice(0, 280),
      });
      return result;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      audit({ decision: d.decision, rule: d.rule, mode: d.mode, effect, context: contextForAudit, outcome: "error", summary: msg.slice(0, 280) });
      return { content: `Error running ${name}: ${msg}`, isError: true };
    }
  }

  /** Evaluate a policy against a hypothetical action without running it (Boundaries page "test"). */
  dryRun(rt: ToolContext["rt"], coworkerId: string, toolName: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const coworker = rt.coworkers.get(coworkerId);
    const tool: Tool | undefined = rt.tools.get(toolName);
    if (!coworker || !tool) throw new Error("unknown coworker or tool");
    const pctx: PolicyContext = {
      tool: { name: tool.name, toolset: tool.toolset },
      action: { effect: toolEffect(tool, args) },
      coworker: { id: coworker.id },
      initiator: "user",
      args,
      ...extra,
    };
    return { granted: isGranted(coworker.tools, tool), ...decide({ ...mergePolicy(rt.policy, coworker.policy), mode: "enforce" }, pctx) };
  }
}

function coerceArgs(raw: unknown): Record<string, any> {
  if (typeof raw === "string") {
    try {
      raw = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return { input: raw };
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, any>) : {};
}

const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|cookie/i;

function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : typeof v === "string" && v.length > 2000 ? v.slice(0, 2000) + "…" : v;
  }
  return out;
}
