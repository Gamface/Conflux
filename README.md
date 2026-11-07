<div align="center">

# Conflux

**Self-hosted AI coworkers that learn, use real computers, run workflows — and stay inside your boundaries.**

One platform built from the best ideas in six open-source agent projects, rebuilt as a single small TypeScript codebase that runs on a laptop or a $5 VPS. It needs no database server, and works with no API key.

[Quick start](#quick-start) · [What's inside](#whats-inside) · [Architecture](docs/ARCHITECTURE.md) · [Feature map](docs/FEATURE-MAP.md) · [Configuration](docs/CONFIGURATION.md)

</div>

---

## Why

Each upstream project gets one thing exceptionally right:

| Project | Its best idea | In Conflux |
|---|---|---|
| **Hermes Agent** (Nous Research) | A closed learning loop: curated memory, self-written skills, session search, frozen prompts for cache efficiency, subagents, cron, messaging gateways | `learning/`, `agent/runner.ts`, `tasks/`, `channels/telegram.ts`, `bin/conflux.ts` |
| **OpenBot** (CopilotKit) | Any agent via **AG-UI**, and *one governed gateway* for every action: CEL-style policy, default-deny, fail-closed, dry-run, audit trail, element resolved server-side | `governance/`, `agent/agui-client.ts`, `/agui/:coworker` |
| **OpenDots** (CopilotKit) | Persistent specialist coworkers, **Spaces** of pages with revision checks, scheduled turns in the original conversation, per-coworker MCP | `stores/pages.ts`, `tasks/queue.ts`, `mcp/client.ts`, Spaces UI |
| **OpenMuse** (CopilotKit) | Visible work: plans, approvals, input requests, durable tasks with pause/resume/cancel/retry and leases, take-control browser | `tools/planning.ts`, `tasks/queue.ts`, Activity UI, Computer panel |
| **Dify** (LangGenius) | Visual **workflows**: typed DAG nodes (LLM, agent, tool, HTTP, code, if/else, iteration, knowledge), RAG datasets, run traces | `workflow/engine.ts`, `stores/knowledge.ts`, Workflows UI |
| **agent-computer-use** (Kortix) | Deterministic desktop control through the accessibility tree: `[@e5] button "7"` refs, snapshot → act → verify, zero vision tokens | `computer/desktop.ts`, `computer/snapshot.ts` (same ref format for the browser) |

### What Conflux adds on top

- **One gateway for everything.** Chat turns, background tasks, schedules, workflow nodes, subagents, MCP tools, external AG-UI agents *and the learning loop itself* all go through the same policy check and audit trail. A workflow can never do something its coworker couldn't.
- **Three-way policy.** `deny` beats `requireApproval`, which beats `allow`. A refused action tells the model not to try another way.
- **One snapshot vocabulary.** Browser pages and native apps both appear as `[@eN] role "name"` refs, and policy rules see the *real* element ("never click Pay"), resolved from the server's own snapshot.
- **Learning that is governed.** Memory and skill writes are tools like any other: you can require approval for learned skills, or turn learning off per coworker. Bundled skills are forked rather than edited when improved.
- **Workflows ⇄ agents.** Workflows can call agents (`agent` node), and agents can run, *author* (`workflow_save`) and receive workflows as first-class tools (`wf_<id>`).
- **Works offline.** A deterministic built-in model drives real tools, so the whole system runs, demos and passes its tests with no key.
- **Zero-service runtime.** Node 22's built-in SQLite + FTS5 holds threads, recall index, audit, tasks, pages, knowledge and runs. There are no runtime npm dependencies in the server.

## Quick start

**Windows (one command):** download [`install.ps1`](install.ps1) into an empty folder, then run `powershell -ExecutionPolicy Bypass -File install.ps1`. It installs Node 22 if needed, Conflux, agent-cu and Chromium, creates a **Conflux** desktop shortcut and starts it.

**Any OS:**

```bash
git clone <this repo> conflux && cd conflux
npm install                 # web UI deps (+ optional playwright for the browser)
npm run build:web
npm start                   # → http://127.0.0.1:8787
```

It runs immediately on the offline model. For real reasoning, set any one key (or point at a local model):

```bash
export ANTHROPIC_API_KEY=…   # or OPENAI_API_KEY, OPENROUTER_API_KEY, or OLLAMA_HOST=http://localhost:11434
npm start
```

Browser automation: `npx playwright install chromium`. Desktop automation (macOS, Windows, Linux): `npm i -g agent-cu`. On Windows, Conflux runs agent-cu's bundled `.exe` directly rather than the npm `.cmd` shim, so typed text never passes through a shell. Any CLI with the same verbs works via `CONFLUX_DESKTOP_BIN`. Check everything with `npm run cli -- doctor`.

**Terminal:** `npm run cli -- chat` (approvals are asked inline) · `npm run cli -- run kb-answer question="How many days of leave?"`

**Docker:** `docker compose up` (bundles Chromium).

### Try these (they all work on the offline model)

| Say | What happens |
|---|---|
| `plan: research vendors, compare prices, write summary` | A live plan card and side panel (todo tool) |
| `remember I prefer concise answers` | Saved to the shared user profile, visible in **Learning**, injected into *new* conversations |
| `run workflow support-triage ticket="Checkout down, urgent" customer=Acme` | DAG runs → if/else → agent node → page saved; the trace streams into chat |
| `delete file draft.txt` | ✋ Approval card. Approve or deny, and both are audited |
| `every weekday at 9am: summarise my pages` | A cron schedule that posts into this conversation |
| `ask the researcher to search the knowledge base for hotel cap` | A subagent runs with the researcher's own grants |
| `open news.ycombinator.com` | Its own persistent Chromium, with a screenshot card. Open 🖥 Computer → **Take control** |

## What's inside

```
packages/core/src
  agent/        runner (turn loop, compression), frozen system prompt, AG-UI client for BYO agents
  governance/   expression language, policy (deny/approve/allow, dry-run), gateway, approvals
  learning/     memory (USER.md + MEMORY.md), skills (agentskills.io format), background review
  tools/        memory, skills, session_search, todo, clarify, files, terminal, web, spaces,
                knowledge, delegate, schedules, tasks, workflow_run/save
  workflow/     DAG engine: start, llm, agent, tool, http, code, template, if_else, knowledge,
                iteration, aggregator, end — parallel branches, retries, error branches
  computer/     per-coworker persistent browser (Playwright), desktop via accessibility CLI
  mcp/          MCP stdio client → governed tools
  tasks/        durable task queue with leases + cron scheduler
  stores/       pages (revisioned), knowledge (chunked, BM25)
apps/server     REST + SSE + AG-UI endpoint, live event bus, take-control API, Telegram channel
apps/web        React UI: Chat, Activity, Spaces, Workflows, Knowledge, Learning, Boundaries, Coworkers
skills/         bundled skills       examples/   workflows + sample knowledge base
bin/conflux.ts  CLI (serve, chat, run, skills, memory, doctor)
```

### Use any coworker from any AG-UI client

```ts
import { HttpAgent } from "@ag-ui/client";
const agent = new HttpAgent({ url: "http://127.0.0.1:8787/agui/researcher" });
```

### Bring your own agent

```json
{ "coworkers": [{ "id": "lg", "name": "LangGraph bot", "role": "…", "tools": ["toolset:web", "memory"],
    "agui": { "url": "http://localhost:8000/agent" } }] }
```

Conflux sends its granted tools as AG-UI client tools. When your agent calls one, it executes here, through the gateway.

## Status

This is an **alpha**. Verified by the test suite (`npm test`, 30 tests) on the offline model:

- the gateway: policy decisions, approvals and audit
- memory, skills, frozen prompts, the review loop and compression
- workflows: branching, iteration, error strategies and governance
- tasks: leases, interruption, pause/cancel and the scheduler
- delegation, MCP over stdio, external AG-UI agents and the HTTP API

CI also runs on Windows, Linux and macOS, plus live jobs:

- real web pages and Chromium browsing, with element-aware policy
- **Windows desktop control:** Notepad is opened, snapshotted, typed into and read back, and a rule refuses its Close button

Not yet verified against live services: the real model endpoints (the live test runs once an `ANTHROPIC_API_KEY` repo secret is added), Telegram and web-search providers.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#roadmap) for the roadmap and known limits. The main ones:

- `code_run` uses `node:vm`, which is isolation, not a hostile-code sandbox.
- There is a single owner per deployment.
- The terminal runs on the host inside a workspace directory. A container sandbox is on the roadmap.

## Credits & licence

MIT. Conflux is an independent re-implementation: no source code was copied from the upstream projects. See [NOTICE](NOTICE). Dify is under a modified Apache 2.0 licence, and only its *concepts* (the workflow node model and datasets) are re-implemented here.
