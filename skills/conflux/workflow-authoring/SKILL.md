---
name: workflow-authoring
description: Design and save Conflux workflows (DAGs of llm, agent, tool, http, code, if_else, knowledge, iteration nodes). Use when the user wants a repeatable automation, pipeline or "workflow" built.
---

# Authoring workflows

A workflow is JSON saved with `workflow_save`:

```json
{
  "id": "kebab-id", "name": "Human name", "description": "When to use it", "exposeAsTool": true,
  "inputs": [{ "name": "url", "type": "string", "required": true }],
  "nodes": [
    { "id": "start", "type": "start" },
    { "id": "fetch", "type": "tool", "data": { "tool": "web_fetch", "args": { "url": "{{inputs.url}}" } } },
    { "id": "sum", "type": "llm", "data": { "prompt": "Summarise:\n{{fetch.text}}" } },
    { "id": "end", "type": "end", "data": { "outputs": { "summary": "{{sum.text}}" } } }
  ],
  "edges": [{ "source": "start", "target": "fetch" }, { "source": "fetch", "target": "sum" }, { "source": "sum", "target": "end" }]
}
```

## Rules
- Node ids are identifiers (`fetch_page`, not `fetch-page`). Exactly one `start`.
- `{{node.field}}` interpolates; a string that is *only* `{{node.field}}` passes the raw value (lists/objects).
- Outputs: llm → `text` (+ `json` when `"json": true`); agent → `text`; tool → `text` (+ `json`); http → `status, body, json`; code → whatever it returns; knowledge → `results, text`; iteration → `results`; aggregator → `value`.
- Branching: `if_else` with `cases: [{id, when}]` (expressions like `classify.json.urgency == "high"`, `size(retrieve.results) > 0`); edges carry `sourceHandle` = case id or `"else"`. Join branches with an `aggregator`.
- Errors: per node `onError`: `fail` (default) | `continue` | `branch` (then route an edge with `sourceHandle: "error"`); `retries: n` for flaky calls.
- No cycles — loop with `iteration` over a list, calling another workflow.

## Verify
Run it once with `workflow_run` on a realistic input and check every node succeeded before telling the user it is ready.
