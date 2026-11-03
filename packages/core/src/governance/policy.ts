import { test, validate } from "./expr.ts";

/**
 * Action policy, adapted from OpenBot's computer gateway and extended with a third outcome.
 *
 *  - default-deny: nothing is permitted unless an `allow` rule says so
 *  - deny beats everything: a narrow refusal cannot be defeated by a broad grant
 *  - `requireApproval` sits between: permitted, but only once a human says yes ("take the wheel")
 *  - fail-closed: a rule that errors counts as matched for deny/approval and unmatched for allow
 *  - `dry-run` decides and records the would-be outcome, then lets everything through, so a rule can
 *    be written against real traffic before it starts refusing anybody's work
 */
export type PolicyMode = "enforce" | "dry-run";

export type RuleLabel = { name: string; description: string };

export type Policy = {
  mode: PolicyMode;
  deny: string[];
  requireApproval: string[];
  allow: string[];
  labels?: Record<string, RuleLabel>;
};

export type Decision = "allow" | "deny" | "approve";

export type PolicyDecision = {
  decision: Decision;
  /** What enforce mode would have done (equals `decision` in enforce mode). */
  wouldBe: Decision;
  rule?: string;
  label?: RuleLabel;
  mode: PolicyMode;
  errors: { rule: string; error: string }[];
};

export type PolicyContext = {
  tool: { name: string; toolset: string };
  action: { effect: string };
  coworker: { id: string };
  initiator: string;
  args: Record<string, unknown>;
  [extra: string]: unknown;
};

export const DEFAULT_POLICY: Policy = {
  mode: "enforce",
  deny: [],
  requireApproval: [],
  allow: ["true"],
};

function firstMatch(rules: string[], env: Record<string, unknown>, failClosed: boolean, errors: PolicyDecision["errors"]): string | undefined {
  for (const rule of rules) {
    try {
      if (test(rule, env)) return rule;
    } catch (e) {
      errors.push({ rule, error: (e as Error).message });
      if (failClosed) return rule;
    }
  }
  return undefined;
}

export function decide(policy: Policy, ctx: PolicyContext): PolicyDecision {
  const errors: PolicyDecision["errors"] = [];
  const env = ctx as unknown as Record<string, unknown>;
  let wouldBe: Decision;
  let rule: string | undefined;

  const denied = firstMatch(policy.deny, env, true, errors);
  if (denied !== undefined) {
    wouldBe = "deny";
    rule = denied;
  } else {
    const needsApproval = firstMatch(policy.requireApproval, env, true, errors);
    if (needsApproval !== undefined) {
      wouldBe = "approve";
      rule = needsApproval;
    } else {
      const allowed = firstMatch(policy.allow, env, false, errors);
      wouldBe = allowed !== undefined ? "allow" : "deny";
      rule = allowed ?? "(default deny)";
    }
  }
  return {
    decision: policy.mode === "dry-run" ? "allow" : wouldBe,
    wouldBe,
    rule,
    label: rule ? policy.labels?.[rule] : undefined,
    mode: policy.mode,
    errors,
  };
}

/** Merge a coworker's own boundaries onto the organisation policy. Coworkers can only narrow. */
export function mergePolicy(base: Policy, extra?: Partial<Policy>): Policy {
  if (!extra) return base;
  return {
    mode: base.mode,
    deny: [...base.deny, ...(extra.deny ?? [])],
    requireApproval: [...base.requireApproval, ...(extra.requireApproval ?? [])],
    // A coworker allow-list intersects: the action must pass the org allow *and* the coworker allow.
    allow: extra.allow && extra.allow.length ? base.allow.flatMap((a) => extra.allow!.map((b) => `(${a}) && (${b})`)) : base.allow,
    labels: { ...(base.labels ?? {}), ...(extra.labels ?? {}) },
  };
}

export function validatePolicy(p: Policy): { rule: string; error: string }[] {
  const out: { rule: string; error: string }[] = [];
  for (const rule of [...p.deny, ...p.requireApproval, ...p.allow]) {
    const err = validate(rule);
    if (err) out.push({ rule, error: err });
  }
  return out;
}
