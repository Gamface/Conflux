#!/usr/bin/env node
/**
 * conflux — terminal entry point.
 *   conflux serve                     start the server + web UI
 *   conflux chat [coworker]           chat in the terminal (approvals inline)
 *   conflux run <workflow> k=v …      run a workflow and print its outputs
 *   conflux skills | memory [cw] | doctor
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Runtime, loadConfig, hasPlaywright, hasDesktopDriver, desktopDriver } from "../packages/core/src/index.ts";

process.removeAllListeners("warning");
const [cmd = "serve", ...rest] = process.argv.slice(2);
const c = { dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m", green: "\x1b[32m", reset: "\x1b[0m" };

async function chat(coworkerId = "assistant") {
  const rt = new Runtime(loadConfig(), { quiet: true });
  await rt.start();
  const cw = rt.coworkers.get(coworkerId);
  if (!cw) throw new Error(`unknown coworker ${coworkerId}. Try: ${rt.coworkers.list().map((x) => x.id).join(", ")}`);
  const rl = createInterface({ input: stdin, output: stdout });
  console.log(`${c.bold}${cw.emoji ?? "✦"} ${cw.name}${c.reset} ${c.dim}(${cw.model ?? rt.config.defaultModel}) — /new, /exit${c.reset}`);
  const pendingAsk: string[] = [];
  rt.bus.subscribe(({ channel, event }) => {
    const e = event as any;
    if (channel === "approvals" && e.type === "approval_requested") pendingAsk.push(e.id);
  });
  let threadId: string | undefined;
  for (;;) {
    let input: string;
    try {
      input = (await rl.question(`${c.cyan}› ${c.reset}`)).trim();
    } catch {
      break; // stdin closed
    }
    if (!input) continue;
    if (input === "/exit") break;
    if (input === "/new") {
      threadId = undefined;
      console.log(c.dim + "new conversation" + c.reset);
      continue;
    }
    let inText = false;
    const run = rt.runner.run({
      coworkerId,
      input,
      threadId,
      emit: (e) => {
        if (e.type === "TEXT_MESSAGE_CONTENT") {
          if (!inText) stdout.write("\n");
          inText = true;
          stdout.write(e.delta);
        } else if (e.type === "TEXT_MESSAGE_END") {
          stdout.write("\n");
          inText = false;
        } else if (e.type === "TOOL_CALL_START") stdout.write(`${c.dim}  ⚙ ${e.toolCallName}${c.reset}\n`);
        else if (e.type === "CUSTOM" && e.name === "policy_refused") stdout.write(`${c.red}  ⛔ blocked: ${(e.value as any).rule}${c.reset}\n`);
        else if (e.type === "CUSTOM" && (e.name === "approval_requested" || e.name === "input_requested")) {
          const v = e.value as any;
          void (async () => {
            const q = e.name === "approval_requested"
              ? `${c.yellow}  ✋ ${v.tool} ${JSON.stringify(v.args).slice(0, 160)}\n     ${v.reason}\n     approve? [y/N/note] ${c.reset}`
              : `${c.yellow}  ❓ ${v.question}${v.choices?.length ? ` (${v.choices.join(" / ")})` : ""}\n     › ${c.reset}`;
            const a = (await rl.question(q).catch(() => "")).trim();
            if (e.name === "input_requested") rt.approvals.resolve(v.id, true, a);
            else rt.approvals.resolve(v.id, /^y(es)?$/i.test(a), /^(y|yes|n|no)?$/i.test(a) ? undefined : a);
          })();
        } else if (e.type === "RUN_ERROR") stdout.write(`${c.red}  ${e.message}${c.reset}\n`);
      },
    });
    const r = await run;
    threadId = r.threadId;
    stdout.write(`${c.dim}  ${r.toolCalls} tool call(s) · ${r.usage.input}→${r.usage.output} tokens${c.reset}\n\n`);
  }
  rl.close();
  await rt.stop();
}

async function runWorkflow(id: string, kv: string[]) {
  const rt = new Runtime(loadConfig(), { quiet: true });
  const inputs = Object.fromEntries(kv.map((p) => [p.split("=")[0], p.split("=").slice(1).join("=")]));
  const r = await rt.workflows.run(id, inputs, { emit: (e) => e.type === "STEP_STARTED" && console.error(`${c.dim}▸ ${e.stepName}${c.reset}`) });
  console.log(JSON.stringify(r.status === "succeeded" ? r.outputs : { error: r.error }, null, 2));
  await rt.stop();
  process.exit(r.status === "succeeded" ? 0 : 1);
}

switch (cmd) {
  case "serve":
  case "start": {
    const { startServer } = await import("../apps/server/src/main.ts");
    const s = await startServer();
    process.on("SIGINT", async () => (await s.close(), process.exit(0)));
    break;
  }
  case "chat":
    await chat(rest[0]);
    break;
  case "run":
    await runWorkflow(rest[0], rest.slice(1));
    break;
  case "skills": {
    const rt = new Runtime(loadConfig(), { quiet: true });
    for (const s of rt.skills.list()) console.log(`${c.bold}${s.name}${c.reset} ${c.dim}[${s.source}]${c.reset} — ${s.description}`);
    await rt.stop();
    break;
  }
  case "memory": {
    const rt = new Runtime(loadConfig(), { quiet: true });
    const id = rest[0] ?? "assistant";
    console.log(`${c.bold}User profile${c.reset}\n${rt.memory.entries("user", id).map((e) => `  - ${e}`).join("\n") || "  (empty)"}`);
    console.log(`${c.bold}${id} memory${c.reset}\n${rt.memory.entries("memory", id).map((e) => `  - ${e}`).join("\n") || "  (empty)"}`);
    await rt.stop();
    break;
  }
  case "doctor": {
    const cfg = loadConfig();
    const ok = (b: boolean) => (b ? `${c.green}✓${c.reset}` : `${c.dim}—${c.reset}`);
    console.log(`Node ${process.version}`);
    console.log(`Model         ${cfg.defaultModel} (${cfg.models[cfg.defaultModel]?.provider} ${cfg.models[cfg.defaultModel]?.model})`);
    console.log(`Browser       ${ok(hasPlaywright())} playwright`);
    const d = desktopDriver();
    console.log(`Desktop       ${ok(hasDesktopDriver())} ${d ? `${[d.file, ...d.prefixArgs].join(" ")}  [${d.source}]` : "agent-cu not found — npm i -g agent-cu"}`);
    console.log(`Web search    ${ok(!!(process.env.TAVILY_API_KEY || process.env.BRAVE_API_KEY || process.env.SEARXNG_URL))}`);
    console.log(`MCP servers   ${Object.keys(cfg.mcpServers).join(", ") || "none"}`);
    console.log(`Telegram      ${ok(!!(cfg.channels.telegram && process.env[cfg.channels.telegram.tokenEnv]))}`);
    console.log(`Data dir      ${cfg.dataDir}`);
    break;
  }
  default:
    console.log("usage: conflux [serve | chat [coworker] | run <workflow> k=v… | skills | memory [coworker] | doctor]");
}
