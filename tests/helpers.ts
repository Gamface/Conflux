import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime, loadConfig, type Config } from "../packages/core/src/index.ts";
import type { ToolContext } from "../packages/core/src/tools/types.ts";
import { noopEmit } from "../packages/core/src/events.ts";

process.removeAllListeners("warning");

export function makeRuntime(overrides: Partial<Config> = {}): Runtime & { cleanup: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), "conflux-test-"));
  const cfg = loadConfig({ dataDir: dir, configPath: join(dir, "none.json"), overrides: { defaultModel: "mock", ...overrides } });
  cfg.learning.enabled = false;
  const rt = new Runtime(cfg, { quiet: true }) as Runtime & { cleanup: () => Promise<void> };
  rt.cleanup = async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return rt;
}

export function ctxFor(rt: Runtime, coworkerId = "assistant", extra: Partial<ToolContext> = {}): ToolContext {
  return {
    runId: "run_test",
    threadId: rt.runner.ensureThread(coworkerId).id,
    coworker: rt.coworkers.get(coworkerId)!,
    initiator: "user",
    emit: noopEmit,
    signal: new AbortController().signal,
    rt,
    depth: 0,
    ...extra,
  };
}

export async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}
