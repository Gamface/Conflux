import { sseData, type Completion, type CompletionRequest, type Provider, type ToolCall } from "./types.ts";

/**
 * Any OpenAI-compatible Chat Completions endpoint: OpenAI, OpenRouter, Nous Portal, Together,
 * Ollama, vLLM, LM Studio. Switching model is a config change, never a code change.
 */
export class OpenAIProvider implements Provider {
  async complete(req: CompletionRequest): Promise<Completion> {
    const p = req.profile;
    const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
    const messages: any[] = [{ role: "system", content: req.system }];
    for (const m of req.messages) {
      if (m.role === "tool") messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
      else if (m.role === "assistant")
        messages.push({
          role: "assistant",
          content: m.content || null,
          ...(m.toolCalls?.length
            ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments || "{}" } })) }
            : {}),
        });
      else messages.push({ role: "user", content: m.content });
    }
    const body: any = {
      model: p.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
      ...(p.maxTokens ? { max_tokens: p.maxTokens } : {}),
    };
    if (req.tools.length) body.tools = req.tools.map((t) => ({ type: "function", function: t }));

    const res = await fetch((p.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        "x-title": "Conflux",
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) throw new Error(`model request failed: ${res.status} ${(await res.text()).slice(0, 500)}`);

    let text = "";
    let stopReason = "stop";
    const usage = { input: 0, output: 0 };
    const calls: (ToolCall & { started?: boolean })[] = [];
    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break;
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.usage) {
        usage.input = j.usage.prompt_tokens ?? usage.input;
        usage.output = j.usage.completion_tokens ?? usage.output;
      }
      const choice = j.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) stopReason = choice.finish_reason;
      const d = choice.delta ?? {};
      if (typeof d.content === "string" && d.content) {
        text += d.content;
        req.onText?.(d.content);
      }
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? 0;
        calls[i] ??= { id: tc.id ?? `call_${i}`, name: "", arguments: "" };
        const c = calls[i];
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (!c.started && c.name) {
          c.started = true;
          req.onToolCallStart?.(c.id, c.name);
        }
        if (tc.function?.arguments) {
          c.arguments += tc.function.arguments;
          req.onToolCallArgs?.(c.id, tc.function.arguments);
        }
      }
    }
    return { text, toolCalls: calls.filter(Boolean).map(({ id, name, arguments: a }) => ({ id, name, arguments: a })), usage, stopReason };
  }
}
