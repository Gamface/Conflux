import { newId, noopEmit } from "../events.ts";
import { learningFor, type Coworker } from "../config.ts";
import type { Runtime } from "../runtime.ts";
import { providerFor, type ChatMessage } from "../providers/index.ts";

/**
 * The closed learning loop (Hermes): after a turn, a forked reviewer reads the conversation and
 * decides whether anything is worth keeping — a fact about the user, an environment note, or a
 * reusable procedure (a skill). It runs in the background with a whitelist of learning tools only,
 * through the same gateway (initiator = "review"), so an organisation can require approval for
 * learned skills or switch learning off per coworker. The main conversation is never touched.
 */
const REVIEW_TOOLS = ["memory", "skill_manage", "skill_view"];

export type ReviewReason = "memory" | "skill";

export function maybeReview(rt: Runtime, a: { coworker: Coworker; threadId: string; toolCalls: number }): void {
  const s = learningFor(rt.config, a.coworker);
  if (!s.enabled || a.coworker.agui) return;
  const t = rt.db.get("SELECT user_turns FROM threads WHERE id=?", a.threadId);
  const reasons: ReviewReason[] = [];
  if (t && t.user_turns > 0 && t.user_turns % s.memoryNudgeInterval === 0) reasons.push("memory");
  if (a.toolCalls >= s.skillNudgeToolCalls) reasons.push("skill");
  // Explicit preference statements are worth an immediate memory pass.
  const lastUser = rt.db.get("SELECT content FROM messages WHERE thread_id=? AND role='user' ORDER BY created_at DESC, rowid DESC LIMIT 1", a.threadId);
  if (lastUser && /\b(i (prefer|always|usually|like|hate|want)|from now on|call me|my name is)\b/i.test(lastUser.content) && !reasons.includes("memory")) reasons.push("memory");
  if (!reasons.length) return;
  setImmediate(() => {
    runReview(rt, a.coworker, a.threadId, reasons).catch((e) => rt.log("learning review failed", (e as Error).message));
  });
}

export async function runReview(rt: Runtime, coworker: Coworker, threadId: string, reasons: ReviewReason[]): Promise<string[]> {
  const rows = rt.db.all("SELECT role, content, name FROM messages WHERE thread_id=? ORDER BY created_at DESC, rowid DESC LIMIT 40", threadId).reverse();
  const transcript = rows
    .map((r) => (r.role === "tool" ? `TOOL(${r.name}): ${String(r.content).slice(0, 600)}` : `${String(r.role).toUpperCase()}: ${String(r.content).slice(0, 2000)}`))
    .join("\n");
  const skills = rt.skills.list().map((s) => `- ${s.name}: ${s.description}`).join("\n") || "(none)";
  const memory = rt.memory.snapshot(coworker.id) || "(empty)";

  const system = `[LEARNING REVIEW] You are the background learning reviewer for the coworker "${coworker.name}".
Read the conversation and decide what, if anything, is worth keeping for FUTURE conversations.
${reasons.includes("memory") ? "- Memory: save durable facts about the user (target=user: preferences, role, constraints) or about the environment (target=memory). Skip anything transient, already saved, or sensitive (no secrets)." : ""}
${reasons.includes("skill") ? "- Skill: if the assistant completed a non-trivial multi-step procedure that will recur, create a concise skill (SKILL.md with name + description frontmatter and numbered steps, pitfalls, verification). If an existing skill was used and proved wrong or incomplete, patch it instead." : ""}
Be conservative: most turns need nothing. When done (or if nothing is worth saving) reply with one short line saying what you saved.

Current memory:
${memory}

Existing skills:
${skills}`;

  const tools = rt.tools.all().filter((t) => REVIEW_TOOLS.includes(t.name));
  const messages: ChatMessage[] = [{ role: "user", content: `<conversation>\n${transcript}\n</conversation>` }];
  const runId = newId("rev_");
  const profile = rt.runner.profile(coworker);
  const provider = providerFor(profile.provider);
  const saved: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await provider.complete({
      profile, system, messages,
      tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    });
    messages.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls });
    if (!r.toolCalls.length) break;
    for (const call of r.toolCalls) {
      const result = await rt.gateway.execute(
        call.name, call.arguments,
        { runId, threadId, coworker, initiator: "review", emit: noopEmit, signal: new AbortController().signal, rt, depth: 1 },
        REVIEW_TOOLS,
      );
      if (!result.isError && !/already/i.test(result.content)) saved.push(`${call.name}: ${summarize(call.arguments)}`);
      messages.push({ role: "tool", content: result.content, toolCallId: call.id, name: call.name });
    }
  }
  if (saved.length) rt.bus.publish("learning", { type: "learned", coworker: coworker.id, threadId, saved });
  return saved;
}

function summarize(args: string): string {
  try {
    const a = JSON.parse(args);
    return a.content ? String(a.content).split("\n").find((l: string) => l.startsWith("name:"))?.slice(5).trim() ?? String(a.content).slice(0, 120) : a.name ?? args.slice(0, 120);
  } catch {
    return args.slice(0, 120);
  }
}
