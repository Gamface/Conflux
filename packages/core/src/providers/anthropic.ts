import { sseData, type Completion, type CompletionRequest, type Provider, type ToolCall } from "./types.ts";

/** Native Anthropic Messages API with streaming, tool use and prompt caching of the frozen system prompt. */
export class AnthropicProvider implements Provider {
  async complete(req: CompletionRequest): Promise<Completion> {
    const p = req.profile;
    const key = process.env[p.apiKeyEnv ?? "ANTHROPIC_API_KEY"];
    if (!key) throw new Error(`missing ${p.apiKeyEnv ?? "ANTHROPIC_API_KEY"}`);

    const messages: any[] = [];
    const push = (role: "user" | "assistant", block: any) => {
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content.push(block);
      else messages.push({ role, content: [block] });
    };
    for (const m of req.messages) {
      if (m.role === "user") push("user", { type: "text", text: m.content || "(empty)" });
      else if (m.role === "tool") push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: m.content });
      else {
        if (m.content) push("assistant", { type: "text", text: m.content });
        for (const t of m.toolCalls ?? []) push("assistant", { type: "tool_use", id: t.id, name: t.name, input: safeJson(t.arguments) });
      }
    }
    const body: any = {
      model: p.model,
      max_tokens: p.maxTokens ?? 8192,
      // The system prompt is frozen per conversation, so it is a perfect cache prefix.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages,
      stream: true,
      ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    };
    if (req.tools.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

    const res = await fetch((p.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "") + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) throw new Error(`model request failed: ${res.status} ${(await res.text()).slice(0, 500)}`);

    let text = "";
    let stopReason = "end_turn";
    const usage = { input: 0, output: 0 };
    const blocks: Record<number, ToolCall | { text: true }> = {};
    for await (const data of sseData(res.body)) {
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      switch (j.type) {
        case "message_start":
          usage.input = (j.message?.usage?.input_tokens ?? 0) + (j.message?.usage?.cache_read_input_tokens ?? 0);
          break;
        case "content_block_start":
          if (j.content_block?.type === "tool_use") {
            blocks[j.index] = { id: j.content_block.id, name: j.content_block.name, arguments: "" };
            req.onToolCallStart?.(j.content_block.id, j.content_block.name);
          } else blocks[j.index] = { text: true };
          break;
        case "content_block_delta":
          if (j.delta?.type === "text_delta") {
            text += j.delta.text;
            req.onText?.(j.delta.text);
          } else if (j.delta?.type === "input_json_delta") {
            const b = blocks[j.index] as ToolCall;
            b.arguments += j.delta.partial_json;
            req.onToolCallArgs?.(b.id, j.delta.partial_json);
          }
          break;
        case "message_delta":
          if (j.delta?.stop_reason) stopReason = j.delta.stop_reason;
          if (j.usage?.output_tokens) usage.output = j.usage.output_tokens;
          break;
        case "error":
          throw new Error(j.error?.message ?? "anthropic stream error");
      }
    }
    const toolCalls = Object.values(blocks).filter((b): b is ToolCall => "id" in b);
    return { text, toolCalls, usage, stopReason };
  }
}

function safeJson(s: string): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}
