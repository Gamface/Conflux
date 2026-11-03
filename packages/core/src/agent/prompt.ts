import type { Runtime } from "../runtime.ts";
import type { Coworker } from "../config.ts";

/**
 * Build the system prompt for a NEW conversation. It is stored on the thread and reused verbatim
 * for every later turn (frozen), so memory/skill writes made during the conversation never break
 * the provider's prompt cache. New memories and skills appear from the next conversation on.
 */
export function buildSystemPrompt(rt: Runtime, c: Coworker): string {
  const others = rt.coworkers
    .list()
    .filter((o) => o.id !== c.id)
    .map((o) => `- ${o.id}: ${o.name} — ${o.description ?? o.role.slice(0, 100)}`)
    .join("\n");
  const memory = rt.memory.snapshot(c.id);
  const skills = rt.skills.index();
  const workflows = rt.workflows
    .list()
    .map((w) => `- ${w.id}: ${w.name}${w.description ? ` — ${w.description}` : ""}`)
    .join("\n");
  const spaces = (c.spaces ?? ["default"]).join(", ");
  const today = new Date().toISOString().slice(0, 10);

  return [
    `You are ${c.name}, an AI coworker running in Conflux. Today is ${today}.`,
    c.role,
    `## How you work
- Every tool call passes through an organisation policy gateway. If an action is refused or declined, do not try to achieve it another way — tell the user what was blocked and why.
- For work with more than two steps, keep a visible plan with the todo tool and update it as you go.
- Ask a clarifying question with the clarify tool only when a wrong guess would be costly.
- Save finished, durable work as a page in a Space (${spaces}) when the user will want to keep it.
- You have curated memory. When you learn something durable about the user (preferences, role, constraints) or the environment, save it with the memory tool without being asked. Keep entries short; consolidate rather than duplicate.
- After solving a non-trivial multi-step task, consider saving the procedure as a skill (skill_manage) so next time is faster. When a skill you used was wrong or incomplete, patch it.
- Use session_search to recall past conversations instead of asking the user to repeat themselves.
- Delegate independent sub-tasks to other coworkers or parallel subagents with the delegate tool.`,
    others ? `## Other coworkers you can delegate to\n${others}` : "",
    workflows ? `## Workflows you can run with workflow_run\n${workflows}` : "",
    skills,
    memory ? `## What you remember (snapshot at conversation start)\n${memory}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
