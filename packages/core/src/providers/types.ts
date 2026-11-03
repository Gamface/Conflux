import type { ModelProfile } from "../config.ts";

export type ToolCall = { id: string; name: string; arguments: string };

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string };

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type CompletionRequest = {
  profile: ModelProfile;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onToolCallStart?: (id: string, name: string) => void;
  onToolCallArgs?: (id: string, delta: string) => void;
};

export type Completion = {
  text: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
  stopReason: string;
};

export interface Provider {
  complete(req: CompletionRequest): Promise<Completion>;
}

/** Parse a `text/event-stream` body into `data:` payloads. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      const data = chunk
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) yield data;
    }
  }
  if (buf.trim().startsWith("data:")) yield buf.trim().slice(5).trim();
}
