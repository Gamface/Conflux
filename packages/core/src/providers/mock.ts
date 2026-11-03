import type { Completion, CompletionRequest, Provider, ToolCall } from "./types.ts";

/**
 * A deterministic, offline "model" so Conflux is fully usable — and testable — with no API key.
 * It maps recognisable instructions to real tool calls, which exercise the real gateway, policy,
 * approvals, memory, skills, pages, workflows and schedules end to end.
 */
type Intent = { re: RegExp; tool: string; args: (m: RegExpMatchArray) => Record<string, unknown> };

const DAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

function cronFrom(text: string): string {
  const t = text.toLowerCase();
  const at = t.match(/at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  let h = at ? Number(at[1]) % 12 + (at[3] === "pm" ? 12 : at[3] === "am" ? 0 : Number(at[1]) === 12 ? 12 : 0) : 9;
  if (at && !at[3]) h = Number(at[1]);
  const min = at?.[2] ? Number(at[2]) : 0;
  const mins = t.match(/every (\d+) minutes?/);
  if (mins) return `*/${mins[1]} * * * *`;
  if (/every hour|hourly/.test(t)) return "0 * * * *";
  for (const [d, n] of Object.entries(DAYS)) if (t.includes(d)) return `${min} ${h} * * ${n}`;
  if (/weekday/.test(t)) return `${min} ${h} * * 1-5`;
  return `${min} ${h} * * *`;
}

const INTENTS: Intent[] = [
  { re: /^remember (?:that )?(.+)/i, tool: "memory", args: (m) => ({ action: "add", target: /\b(i|my|me|i'm)\b/i.test(m[1]) ? "user" : "memory", content: m[1] }) },
  { re: /(?:search|find).*(?:past|previous|earlier|old) (?:conversations?|chats?|sessions?) (?:about|for|on) (.+)/i, tool: "session_search", args: (m) => ({ query: m[1] }) },
  { re: /^plan:?\s+(.+)/i, tool: "todo", args: (m) => ({ todos: m[1].split(/,\s*|\s+then\s+|;\s*/i).filter(Boolean).map((s, i) => ({ id: String(i + 1), content: s.trim(), status: i === 0 ? "in_progress" : "pending" })) }) },
  { re: /^(?:open|browse|visit|go to)\s+(\S+)/i, tool: "browser_navigate", args: (m) => ({ url: m[1].startsWith("http") ? m[1] : `https://${m[1]}` }) },
  { re: /^fetch\s+(\S+)/i, tool: "web_fetch", args: (m) => ({ url: m[1] }) },
  { re: /^run (?:the )?workflow\s+([\w-]+)\s*(.*)$/i, tool: "workflow_run", args: (m) => ({ id: m[1], inputs: parseInputs(m[2]) }) },
  { re: /^save (?:a |this )?page (?:titled|called|named)\s+"?([^":]+?)"?\s*(?::|with)\s*([\s\S]+)/i, tool: "page_save", args: (m) => ({ title: m[1].trim(), body: m[2].trim() }) },
  { re: /^search (?:the )?(?:pages|spaces?) (?:for )?(.+)/i, tool: "page_search", args: (m) => ({ query: m[1] }) },
  { re: /^search (?:the )?(?:knowledge|docs?|kb) (?:base )?(?:for )?(.+)/i, tool: "knowledge_search", args: (m) => ({ query: m[1] }) },
  { re: /^(?:write|create) (?:a )?file\s+(\S+)\s+(?:with|containing)\s+([\s\S]+)/i, tool: "fs_write", args: (m) => ({ path: m[1], content: m[2] }) },
  { re: /^(?:read|show) (?:the )?file\s+(\S+)/i, tool: "fs_read", args: (m) => ({ path: m[1] }) },
  { re: /^(?:list|ls) (?:the )?files/i, tool: "fs_list", args: () => ({ path: "." }) },
  { re: /^(?:delete|remove) (?:the )?file\s+(\S+)/i, tool: "fs_delete", args: (m) => ({ path: m[1] }) },
  { re: /^(?:run|execute)\s+`([^`]+)`/i, tool: "terminal", args: (m) => ({ command: m[1] }) },
  { re: /^\$\s+(.+)/, tool: "terminal", args: (m) => ({ command: m[1] }) },
  { re: /^(?:every|schedule)\b(.+?):\s*(.+)$/i, tool: "schedule_create", args: (m) => ({ name: m[2].slice(0, 48), cron: cronFrom(m[0]), prompt: m[2] }) },
  { re: /^ask (?:the )?(\w+) to (.+)/i, tool: "delegate", args: (m) => ({ tasks: [{ coworker: m[1].toLowerCase(), goal: m[2] }] }) },
  { re: /^(?:show|view|use) (?:the )?skill\s+([\w-]+)/i, tool: "skill_view", args: (m) => ({ name: m[1] }) },
  { re: /^(?:create|save) (?:a )?skill\s+([\w-]+):\s*([\s\S]+)/i, tool: "skill_manage", args: (m) => ({ action: "create", name: m[1], content: `---\nname: ${m[1]}\ndescription: ${m[2].split("\n")[0].slice(0, 120)}\n---\n\n${m[2]}` }) },
  { re: /^snapshot (?:the )?(?:app )?(.+)/i, tool: "desktop_snapshot", args: (m) => ({ app: m[1] }) },
];

function parseInputs(s: string): Record<string, unknown> {
  s = s.trim().replace(/^with\s+/i, "");
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    const out: Record<string, string> = {};
    const kv = [...s.matchAll(/(\w+)=("[^"]*"|\S+)/g)];
    if (kv.length) for (const [, k, v] of kv) out[k] = v.replace(/^"|"$/g, "");
    else out.query = s;
    return out;
  }
}

let counter = 0;

export class MockProvider implements Provider {
  async complete(req: CompletionRequest): Promise<Completion> {
    const last = req.messages[req.messages.length - 1];
    const toolNames = new Set(req.tools.map((t) => t.name));
    const say = async (text: string): Promise<Completion> => {
      for (const chunk of text.match(/[\s\S]{1,24}/g) ?? []) {
        if (req.signal?.aborted) break;
        req.onText?.(chunk);
        await new Promise((r) => setTimeout(r, 4));
      }
      return { text, toolCalls: [], usage: { input: approxTokens(req), output: Math.ceil(text.length / 4) }, stopReason: "stop" };
    };

    // Background learning review: decide what to save from the transcript.
    if (req.system.includes("[LEARNING REVIEW]") && last?.role === "user") {
      const transcript = last.content;
      const pref = transcript.match(/\bI (?:prefer|like|always|usually|want) ([^.\n]{3,120})/i);
      const known = req.system.toLowerCase();
      if (pref && toolNames.has("memory") && !known.includes(pref[1].trim().toLowerCase())) {
        return this.call("memory", { action: "add", target: "user", content: `Prefers ${pref[1].trim()}` }, req);
      }
      return say("Nothing to save.");
    }

    if (last?.role === "tool") {
      // Summarise the most recent tool results into a final answer.
      const results: string[] = [];
      for (let i = req.messages.length - 1; i >= 0 && req.messages[i].role === "tool"; i--) {
        const m = req.messages[i] as Extract<typeof last, { role: "tool" }>;
        results.unshift(`**${m.name}** → ${m.content.slice(0, 600)}`);
      }
      return say(`Done.\n\n${results.join("\n\n")}`);
    }

    const text = last && last.role === "user" ? last.content.trim() : "";
    for (const intent of INTENTS) {
      const m = text.match(intent.re);
      if (!m) continue;
      if (!toolNames.has(intent.tool)) {
        const alt = intent.tool === "browser_navigate" && toolNames.has("web_fetch") ? "web_fetch" : null;
        if (alt) return this.call(alt, intent.args(m), req);
        return say(`I'd use the \`${intent.tool}\` tool for that, but it isn't available to me here (not granted, or its service isn't configured).`);
      }
      return this.call(intent.tool, intent.args(m), req);
    }

    // Tool-less calls come from workflow LLM nodes and summarisation: answer deterministically.
    if (!req.tools.length || text.length > 160) {
      const body = text.replace(/\s+/g, " ").trim();
      const content = text.replace(/\([^)]*\|[^)]*\)/g, "");
      if (/json/i.test(text)) {
        const urgent = /\b(urgent|asap|outage|down|critical|immediately|broken)\b/i.test(content);
        const category = /\b(bill|invoice|refund|charge|payment)/i.test(content) ? "billing" : /\b(bug|error|crash|broken|down|checkout)/i.test(content) ? "technical" : "general";
        return say(JSON.stringify({ category, urgency: urgent ? "high" : "low", summary: body.slice(-160) }));
      }
      const sentences = (body.match(/[^.!?]+[.!?]/g) ?? [body]).map((x) => x.trim());
      // Extractive answer: pick the sentences that best overlap the question (or the instruction).
      const q = (text.match(/Question:\s*([^\n]+)/i)?.[1] ?? text.split("\n")[0]).toLowerCase();
      const words = new Set(q.split(/\W+/).filter((w) => w.length > 3));
      const scored = sentences
        .map((x, i) => ({ x, i, s: x.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length }))
        .filter((r) => r.s > 0 && !r.x.toLowerCase().includes(q.slice(0, 20)))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .slice(0, 2)
        .sort((a, b) => a.i - b.i)
        .map((r) => r.x.replace(/^#+\s*[^#]*?\s(?=[A-Z])/, ""));
      return say(`(offline model) ${(scored.length ? scored : sentences.slice(-2)).join(" ").slice(0, 600)}`);
    }

    const tools = [...toolNames].slice(0, 40).join(", ");
    return say(
      `You're talking to the built-in **offline model** — add an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY) for real reasoning.\n\n` +
        `It still drives real tools. Try:\n` +
        `- \`remember I prefer short answers\`\n- \`plan: research vendors, compare prices, write summary\`\n- \`save page titled Notes: hello world\`\n` +
        `- \`run workflow summarize-url url=https://example.com\`\n- \`every weekday at 9am: summarise my pages\`\n- \`delete file notes.txt\` (asks for approval)\n\n` +
        `Tools available to me: ${tools}`,
    );
  }

  private async call(name: string, args: Record<string, unknown>, req: CompletionRequest): Promise<Completion> {
    const id = `mock_${++counter}`;
    const call: ToolCall = { id, name, arguments: JSON.stringify(args) };
    req.onToolCallStart?.(id, name);
    req.onToolCallArgs?.(id, call.arguments);
    return { text: "", toolCalls: [call], usage: { input: approxTokens(req), output: 20 }, stopReason: "tool_calls" };
  }
}

function approxTokens(req: CompletionRequest): number {
  return Math.ceil((req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0)) / 4);
}
