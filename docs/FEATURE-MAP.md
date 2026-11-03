# Feature map

Where each idea came from, where it lives in Conflux, and what changed. Each feature was re-implemented from the upstream projects' documented behaviour; no upstream code was copied.

## Hermes Agent (Nous Research) — the learning agent

| Feature | Conflux | Enhancement |
|---|---|---|
| Curated memory (MEMORY.md / USER.md), char limits, injection scan | `learning/memory.ts`, `memory` tool | User profile shared across coworkers. Editable in the UI with usage meters. Secret detection added. |
| Frozen system-prompt snapshot (prefix-cache invariant) | `agent/prompt.ts`, `threads.system_snapshot` | Anthropic `cache_control` set on the frozen prompt. |
| Autonomous skill creation + self-improvement | `tools/learning.ts` `skill_manage`, `learning/review.ts` | The review runs *through the policy gateway*, so learned skills can require approval. Bundled skills are forked, not mutated. Provenance (`created-by`) and usage counts are recorded. |
| Background review fork with tool whitelist | `learning/review.ts` | Also triggered by explicit preference statements. A "learned" toast appears in the UI. |
| FTS5 session search | `session_search` | Includes compacted history. |
| Context compression | `AgentRunner.compressIfNeeded` | The summary is kept on the thread. Compacted rows are still searchable. |
| Subagent delegation, parallel | `delegate` tool | Subagents can adopt *another coworker's* role and grants, never exceeding them. Depth limit. |
| Cron scheduler with delivery | `tasks/queue.ts` `Scheduler` | Runs land as durable tasks in the original conversation (from OpenDots). |
| Messaging gateway | `apps/server/src/channels/telegram.ts` | Approvals and clarifying questions arrive as messages (`/approve id`). |
| Any model, switch by config | `providers/` | OpenAI-compatible (OpenRouter, Nous Portal, Ollama, vLLM), native Anthropic, and an offline model. |
| TUI / CLI | `bin/conflux.ts` | Inline approvals in the terminal. |
| agentskills.io skill format | `skills/`, `learning/skills.ts` | Same format, so skills are portable. |
| Clarify tool, todo tool | `tools/planning.ts` | The plan streams as `STATE_SNAPSHOT` into a live side panel and onto the task record. |

## OpenBot (CopilotKit) — governed agents over AG-UI

| Feature | Conflux | Enhancement |
|---|---|---|
| Any AG-UI agent as a coworker | `agent/agui-client.ts`, `coworker.agui` | Conflux tools are offered as AG-UI client tools, so the external agent's calls are governed here. |
| One gateway deciding + recording every action | `governance/gateway.ts` | Extended from computer actions to *every* tool, workflow node, MCP call and learning write. |
| CEL policies, default-deny, fail-closed, dry-run, deny list | `governance/expr.ts`, `policy.ts` | A third outcome: `requireApproval`. Coworker policies can only narrow. Rule labels. A dry-run tester in the UI. |
| Element resolved from the server's own snapshot | `computer/snapshot.ts`, `resolveContext` | The same mechanism for browser *and* desktop. The `key` context covers the Enter-to-submit bypass. |
| Audit trail | `audit` table, Boundaries page | Human take-control actions are audited too. Secrets are redacted from arguments. |
| Coworkers as configuration (`agents.yaml`) | `config.ts`, Coworkers page | Edited in the UI and persisted to `data/overrides.json`. |
| Per-coworker computer with its own logins | `computer/browser.ts` | — |
| Take the wheel | Computer panel + `/api/computer/:id/action` | — |
| Single-user mode / sign-in | `CONFLUX_ACCESS_KEY` | — |

## OpenDots (CopilotKit) — persistent coworkers & Spaces

| Feature | Conflux | Enhancement |
|---|---|---|
| Spaces of pages, searchable library, grid/list | `stores/pages.ts`, Spaces page | FTS search, also exposed to agents (`page_search`). |
| Revision checks, autosave that keeps drafts | `PageStore.update(baseRevision)`, editor | The conflict banner offers "overwrite with mine" or "load theirs". |
| Specialist Dots with per-Dot permissions | `coworker.spaces`, `coworker.tools` | — |
| Scheduled turns in their original conversation; Interrupted + Retry after review | `Scheduler`, `TaskQueue` | — |
| Per-Dot MCP servers, owner approval for writes | `mcp/client.ts` | MCP annotations map to effects (`destructiveHint` → needs approval). |
| User-managed memory permitted Dots can use | `USER.md` + Learning page | — |

## OpenMuse (CopilotKit) — visible personal agent

| Feature | Conflux | Enhancement |
|---|---|---|
| Durable task plans, progress, input requests, pause/resume/cancel/retry, SQL leases | `tasks/queue.ts`, Activity page | — |
| Follow-up queue; send/stop in one input pill; drafts retained | Chat composer | — |
| Inline result cards (browser, plan, documents) | `chat/cards.tsx`, `tool_ui` events | Cards are persisted with the thread, so history renders cards too. |
| Take control of the agent's browser | Computer panel | — |
| Access key for self-hosting | `CONFLUX_ACCESS_KEY` | Timing-safe comparison. |

## Dify (LangGenius) — workflows & knowledge

| Feature | Conflux | Enhancement |
|---|---|---|
| Workflow DAG with LLM, agent, tool, HTTP, code, template, if/else, iteration, knowledge retrieval, variable aggregator, end | `workflow/engine.ts` | Every side-effecting node is governed. if/else uses the same expression language as policy. |
| Parallel branches, error strategies (fail / default value / fail branch), retries | `onError`, `retries` | — |
| Run traces + history | `workflow_runs`, Workflows page | A live graph highlights node status. |
| Workflows as tools / APIs | `exposeAsTool` → `wf_<id>`, `POST /api/workflows/:id/run[?stream=1]` | Agents can author workflows (`workflow_save` + the `workflow-authoring` skill). |
| Knowledge datasets, chunking, retrieval test | `stores/knowledge.ts`, Knowledge page | Local BM25, so no embedding service is needed. |

## agent-computer-use (Kortix) — deterministic desktop control

| Feature | Conflux | Enhancement |
|---|---|---|
| Accessibility-tree snapshots with `@eN` refs, selector DSL | `computer/desktop.ts` | The same ref format is reused for the browser, so there is one loop to learn. |
| Snapshot → act → re-snapshot | `desktop-automation` skill | Element-aware policy ("never click Delete in Finder"). |
| Service gating (binary present) | `available()` | `CONFLUX_DESKTOP_BIN` lets you swap in the maintained Cua Driver. |
