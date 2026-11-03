# Configuration

Configuration is layered. Each layer overrides the one before it:

1. Built-in defaults
2. `conflux.config.json` in the working directory (or the path in `CONFLUX_CONFIG`)
3. `data/overrides.json`, written by UI edits to coworkers and policy

Secrets never go in config files. A model profile names an environment variable instead (`apiKeyEnv`).

## Environment

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | Auto-creates a model profile and makes it the default (Anthropic > OpenAI > OpenRouter). |
| `OPENAI_BASE_URL` | Any OpenAI-compatible endpoint (Nous Portal, Together, vLLM…). |
| `OLLAMA_HOST`, `CONFLUX_OLLAMA_MODEL` | Adds an `ollama` profile. |
| `CONFLUX_MODEL`, `CONFLUX_DEFAULT_MODEL` | Override the model name or the default profile key. |
| `PORT` / `CONFLUX_PORT`, `CONFLUX_HOST` | Listen address (default `127.0.0.1:8787`). |
| `CONFLUX_DATA_DIR` | Where the database, memory, skills, workspaces and browser profiles live (default `./data`). |
| `CONFLUX_ACCESS_KEY` | Require a bearer key for the API and UI. **Set this before exposing the server beyond localhost.** |
| `TAVILY_API_KEY` / `BRAVE_API_KEY` / `SEARXNG_URL` | Enable `web_search`. |
| `CONFLUX_DESKTOP_BIN` | Desktop accessibility CLI (default `agent-cu`). |
| `TELEGRAM_BOT_TOKEN` | Used by the Telegram channel when configured. |

## `conflux.config.json`

See [`conflux.config.example.json`](../conflux.config.example.json). The keys:

```jsonc
{
  "defaultModel": "anthropic",
  "models": { "local": { "provider": "openai", "baseUrl": "http://localhost:11434/v1", "model": "qwen3" } },
  "coworkers": [ /* merged by id with the built-in assistant / researcher / operator */ ],
  "policy": { "mode": "enforce", "deny": [], "requireApproval": [], "allow": ["true"], "labels": {} },
  "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } },
  "channels": { "telegram": { "tokenEnv": "TELEGRAM_BOT_TOKEN", "coworker": "assistant", "allowedChatIds": [123456] } },
  "learning": { "enabled": true, "memoryNudgeInterval": 6, "skillNudgeToolCalls": 5 },
  "context": { "maxChars": 120000, "keepRecent": 16 },
  "workers": { "concurrency": 2, "leaseMs": 60000 },
  "computer": { "headless": true, "desktop": true },
  "approvalTimeoutMs": 1800000
}
```

### Coworker

| Field | Meaning |
|---|---|
| `id`, `name`, `emoji`, `color`, `description` | Identity. |
| `role` | Role instructions (the coworker's job). |
| `model` | Key into `models`. |
| `tools` | Grants: `"*"`, `"toolset:web"`, `"browser_*"`, `"mcp__github__*"`, `"!terminal"`. Exclusions win. |
| `policy` | `{ deny, requireApproval, allow }`. These can only narrow the org policy. |
| `spaces` | Spaces it may read and write (`["*"]` for all). |
| `learning` | `{ enabled, memoryNudgeInterval, skillNudgeToolCalls }`. |
| `maxIterations` | Tool-loop budget per turn (default 24). |
| `agui` | `{ url, headers }`. Use an external AG-UI agent instead of a model. |

Toolsets: `learning`, `planning`, `files`, `computer`, `web`, `spaces`, `knowledge`, `orchestration`, `automation`, `workflows`, `mcp:<server>`.

### Policy context

Rules see the following fields:

| Field | Values |
|---|---|
| `tool` | `{name, toolset}` |
| `action.effect` | `read`, `write`, `external`, `execute`, `destructive`, `learn` |
| `coworker.id` | The acting coworker |
| `initiator` | `user`, `task`, `schedule`, `review`, `workflow`, `subagent`, `channel` |
| `args` | The tool's arguments |

Depending on the tool, the server also resolves:

| Context | Fields | Tools |
|---|---|---|
| `page` | `{url, host}` | Browser, `web_fetch`, `http_request` |
| `element` | `{ref, role, name, type, value}` | Browser and desktop ref actions |
| `key` | The key pressed | Keypresses, and `submit: true` |
| `file` | `{path, exists}` | File tools |
| `command` | `{text, program}` | `terminal` |
| `http.method` | The HTTP method | `http_request` |
| `workflow.id` | The workflow | Workflow tools |
| `mcp` | `{server, tool}` | MCP tools |
| `space.name` | The Space written to | `page_save` |
| `app.name` | The desktop app | Desktop tools |
