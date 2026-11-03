import type { Runtime } from "../../../../packages/core/src/index.ts";

/**
 * Messaging gateway (Hermes "lives where you do"): talk to a coworker from Telegram while it works
 * on the server. Each chat maps to one conversation; approvals and clarifying questions arrive as
 * messages with /approve <id> and /deny <id> replies. Long-polling, no public URL needed.
 *
 * Enable with:  "channels": { "telegram": { "tokenEnv": "TELEGRAM_BOT_TOKEN", "coworker": "assistant", "allowedChatIds": [123] } }
 */
export function startTelegram(rt: Runtime): () => void {
  const cfg = rt.config.channels.telegram;
  const token = cfg ? process.env[cfg.tokenEnv] : undefined;
  if (!cfg || !token) return () => {};
  const api = (method: string, body: unknown) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const threads = new Map<number, string>();
  const pendingByChat = new Map<string, number>();
  let offset = 0;
  let stopped = false;

  const unsub = rt.bus.subscribe(({ channel, event }) => {
    const e = event as any;
    if (channel === "approvals" && e.type === "approval_requested") {
      const chat = [...threads].find(([, t]) => t === e.threadId)?.[0];
      if (chat === undefined) return;
      pendingByChat.set(e.id, chat);
      const text = e.kind === "question"
        ? `❓ ${e.reason}${e.choices?.length ? `\nOptions: ${e.choices.join(" / ")}` : ""}\nReply: /answer ${e.id} <text>`
        : `🛑 Approval needed: ${e.tool}\n${e.reason}\n${JSON.stringify(e.args).slice(0, 600)}\n\n/approve ${e.id}   /deny ${e.id}`;
      void api("sendMessage", { chat_id: chat, text });
    }
  });

  const handle = async (msg: any) => {
    const chat: number = msg.chat.id;
    if (cfg.allowedChatIds?.length && !cfg.allowedChatIds.includes(chat)) return;
    const text: string = msg.text ?? "";
    const cmd = text.match(/^\/(approve|deny|answer)\s+(\S+)\s*(.*)$/s);
    if (cmd) {
      const ok = rt.approvals.resolve(cmd[2], cmd[1] !== "deny", cmd[3] || undefined);
      await api("sendMessage", { chat_id: chat, text: ok ? "✓ Recorded." : "That request is no longer pending." });
      return;
    }
    if (text === "/new") {
      threads.delete(chat);
      await api("sendMessage", { chat_id: chat, text: "Started a new conversation." });
      return;
    }
    await api("sendChatAction", { chat_id: chat, action: "typing" });
    const r = await rt.runner.run({ coworkerId: cfg.coworker, input: text, threadId: threads.get(chat), initiator: "channel" });
    threads.set(chat, r.threadId);
    const reply = r.error ? `⚠️ ${r.error}` : r.text || "(done)";
    for (const part of reply.match(/[\s\S]{1,3900}/g) ?? []) await api("sendMessage", { chat_id: chat, text: part });
  };

  (async () => {
    rt.log("Telegram channel connected for", cfg.coworker);
    while (!stopped) {
      try {
        const r = await api("getUpdates", { offset, timeout: 30 });
        for (const u of r.result ?? []) {
          offset = u.update_id + 1;
          if (u.message) handle(u.message).catch((e) => rt.log("telegram", e.message));
        }
      } catch {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
  return () => {
    stopped = true;
    unsub();
  };
}
