import type { ToolCall } from "./types.ts";

/**
 * Rescue tool calls a model wrote as TEXT instead of using the API's tool-calling channel.
 *
 * Small and local models (and servers without native tool calling, e.g. some LM Studio / Ollama
 * setups) often reply with the call printed out:
 *   <tool_call>{"name": "memory", "arguments": {...}}</tool_call>        (Hermes / Qwen format)
 *   ```json {"name": "memory", "parameters": {...}} ```                   (fenced)
 *   {"name": "memory", "arguments": {...}}                                (bare, or ending the reply)
 *
 * To avoid treating a JSON *example* in prose as a call, a candidate is accepted only when it names
 * a tool that was actually offered, and either it is tagged/fenced or it is (nearly) the whole reply.
 */
export type Extracted = { calls: ToolCall[]; text: string };

function asCall(obj: any, toolNames: Set<string>): { name: string; args: unknown } | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const fn = obj.function && typeof obj.function === "object" ? obj.function : null;
  const name = fn?.name ?? obj.name ?? obj.tool ?? obj.tool_name ?? obj.function;
  if (typeof name !== "string" || !toolNames.has(name)) return null;
  let args = fn?.arguments ?? obj.arguments ?? obj.parameters ?? obj.args ?? obj.input ?? obj.tool_input ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  return typeof args === "object" && args !== null && !Array.isArray(args) ? { name, args } : null;
}

/** Find balanced top-level {...} spans, respecting strings. */
function jsonObjects(s: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) out.push({ start, end: i + 1 });
    }
  }
  return out;
}

/** Lenient parse: real JSON first, then common model slips (trailing commas, raw newlines in strings). */
function parseLoose(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  let fixed = s.replace(/,\s*([}\]])/g, "$1");
  // Escape raw newlines/tabs that appear inside string literals.
  let out = "", inStr = false, esc = false;
  for (const c of fixed) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      else if (c === "\n") { out += "\\n"; continue; }
      else if (c === "\t") { out += "\\t"; continue; }
    } else if (c === '"') inStr = true;
    out += c;
  }
  fixed = out;
  try {
    return JSON.parse(fixed);
  } catch {
    return undefined;
  }
}

let seq = 0;

export function extractTextToolCalls(text: string, offered: string[]): Extracted {
  const toolNames = new Set(offered);
  if (!text || !toolNames.size || !text.includes("{")) return { calls: [], text };
  const calls: ToolCall[] = [];
  let rest = text;
  const take = (raw: string, whole: string) => {
    const c = asCall(parseLoose(raw), toolNames);
    if (!c) return false;
    calls.push({ id: `textcall_${Date.now().toString(36)}_${++seq}`, name: c.name, arguments: JSON.stringify(c.args) });
    rest = rest.replace(whole, "");
    return true;
  };

  // 1. Tagged: <tool_call>…</tool_call> (also <function_call>, <tool>)
  for (const m of text.matchAll(/<(tool_call|function_call|tool)>\s*([\s\S]*?)\s*<\/\1>/g)) take(m[2], m[0]);
  // 2. Fenced code blocks
  if (!calls.length) for (const m of text.matchAll(/```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/g)) take(m[1].trim(), m[0]);
  // 3. Bare JSON object(s) — only when they are essentially the entire reply.
  if (!calls.length) {
    const spans = jsonObjects(text);
    const jsonChars = spans.reduce((n, s) => n + (s.end - s.start), 0);
    const prose = text.length - jsonChars;
    const last = spans[spans.length - 1];
    // Either (nearly) all JSON, or one call that ends the reply after a short lead-in ("Here is the call: {...}").
    const trailing = spans.length === 1 && last && text.slice(last.end).trim() === "" && last.start <= 600;
    if (spans.length && (prose <= Math.max(160, text.length * 0.25) || trailing)) {
      for (const s of spans) {
        const raw = text.slice(s.start, s.end);
        take(raw, raw);
      }
    }
  }
  if (!calls.length) return { calls: [], text };
  return { calls, text: rest.replace(/\n{3,}/g, "\n\n").trim() };
}
