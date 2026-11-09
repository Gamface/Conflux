import { test } from "node:test";
import assert from "node:assert/strict";
import { win32 } from "node:path";
const join = win32.join;
import { resolveDriver, type ResolveEnv } from "../packages/core/src/computer/driver.ts";
import { parseSnapshot } from "../packages/core/src/computer/snapshot.ts";
import { desktopDriver } from "../packages/core/src/index.ts";
import { makeRuntime, ctxFor } from "./helpers.ts";

function fakeEnv(files: string[], over: Partial<ResolveEnv> = {}): ResolveEnv {
  const set = new Set(files);
  return { platform: "win32", arch: "x64", env: {}, execPath: "C:/node/node.exe", home: "C:/Users/a", exists: (p) => set.has(p), ensureExecutable: () => true, localPackage: () => undefined, ...over };
}

test("driver: Windows npm global install resolves past the .cmd shim to the bundled .exe", () => {
  const appdata = "C:/Users/a/AppData/Roaming";
  const exe = join(appdata, "npm", "node_modules", "agent-cu", "bin", "agent-computer-use-windows-x64.exe");
  const d = resolveDriver(fakeEnv([join(appdata, "npm", "agent-cu.cmd"), exe], { env: { APPDATA: appdata, PATH: join(appdata, "npm") } }));
  assert.equal(d?.file, exe);
  assert.deepEqual(d?.prefixArgs, []);
});

test("driver: shim on PATH without bundled exe falls back to `node agent-cu.js` (never a shell)", () => {
  const dir = "D:/tools/npm";
  const js = join(dir, "node_modules", "agent-cu", "bin", "agent-cu.js");
  const d = resolveDriver(fakeEnv([join(dir, "agent-cu.cmd"), js], { env: { PATH: dir, PATHEXT: ".EXE;.CMD" } }));
  assert.equal(d?.file, "C:/node/node.exe");
  assert.deepEqual(d?.prefixArgs, [js]);
});

test("driver: a native agent-cu.exe on PATH (cargo install) is used directly; .cmd is never returned", () => {
  const d = resolveDriver(fakeEnv([win32.join("C:/cargo/bin", "agent-cu.exe"), win32.join("C:/npm", "agent-cu.cmd")], { env: { PATH: "C:/npm;C:/cargo/bin", PATHEXT: ".EXE;.CMD" } }));
  assert.equal(d?.file, win32.join("C:/cargo/bin", "agent-cu.exe"));
  const none = resolveDriver(fakeEnv([win32.join("C:/npm", "agent-cu.cmd")], { env: { PATH: "C:/npm", PATHEXT: ".EXE;.CMD" } }));
  assert.equal(none, undefined, "a bare shim with no package behind it is not runnable");
});

test("driver: macOS / Linux layouts and overrides", () => {
  const mac = resolveDriver(fakeEnv(["/opt/homebrew/lib/node_modules/agent-cu/bin/agent-computer-use-macos-arm64"], { platform: "darwin", arch: "arm64", execPath: "/opt/homebrew/bin/node" }));
  assert.match(mac!.file, /macos-arm64$/);
  const linux = resolveDriver(fakeEnv(["/usr/bin/agent-cu"], { platform: "linux", env: { PATH: "/usr/bin" }, execPath: "/usr/bin/node" }));
  assert.equal(linux!.file, "/usr/bin/agent-cu");
  const js = resolveDriver(fakeEnv([], { env: { CONFLUX_DESKTOP_BIN: "/x/cua/cli.js" } }));
  assert.deepEqual([js!.file, ...js!.prefixArgs], ["C:/node/node.exe", "/x/cua/cli.js"]);
  assert.equal(resolveDriver(fakeEnv([])), undefined);
});

// ── Real desktop end-to-end (Windows CI job, or locally with CONFLUX_DESKTOP_E2E=1) ──
const e2e = process.env.CONFLUX_DESKTOP_E2E === "1";

test("desktop e2e: open Notepad, snapshot refs, type through the gateway, read it back, policy refuses Close", { skip: !e2e, timeout: 120_000 }, async () => {
  const rt = makeRuntime();
  rt.config.computer.desktop = true;
  try {
    console.log("driver:", desktopDriver());
    assert.ok(desktopDriver(), "agent-cu should be installed for this job");
    const c = ctxFor(rt, "operator", { initiator: "user" });
    // The operator coworker asks before acting; auto-approve for the test and record what was asked.
    const asked: string[] = [];
    rt.bus.subscribe(({ channel, event }) => {
      const e = event as any;
      if (channel === "approvals" && e.type === "approval_requested") {
        asked.push(e.tool);
        setTimeout(() => rt.approvals.resolve(e.id, true), 10);
      }
    });
    const app = process.env.CONFLUX_E2E_APP ?? "Notepad";
    const open = await rt.gateway.execute("desktop_open", { app }, c);
    console.log("open:", open.content.slice(0, 300));
    assert.notEqual(open.isError, true, open.content);
    await new Promise((r) => setTimeout(r, 4000));

    const apps = await rt.gateway.execute("desktop_apps", {}, c);
    console.log("apps:", apps.content.slice(0, 800));

    const snap = await rt.gateway.execute("desktop_snapshot", { app }, c);
    console.log("snapshot:\n" + snap.content.slice(0, 3000));
    assert.notEqual(snap.isError, true, snap.content);
    const els = parseSnapshot(snap.content);
    assert.ok(els.size > 0, "snapshot should list [@eN] refs");

    const marker = `conflux-${Date.now()}`;
    const typed = await rt.gateway.execute("desktop_type", { app, text: marker }, c);
    console.log("type:", typed.content.slice(0, 300));
    assert.notEqual(typed.isError, true, typed.content);
    await new Promise((r) => setTimeout(r, 800));

    const text = await rt.gateway.execute("desktop_text", { app }, c);
    console.log("text:", text.content.slice(0, 1500));
    assert.match(text.content, new RegExp(marker), "typed text should be readable back from the app");

    // Element-aware policy on the desktop: a rule naming "Close" refuses the click without running it.
    const close = [...els.values()].find((e) => /^close$/i.test(e.name));
    if (close) {
      rt.policy = { ...rt.policy, deny: [...rt.policy.deny, 'has(element) && element.name == "Close"'] };
      const refused = await rt.gateway.execute("desktop_click", { app, target: close.ref }, c);
      assert.match(refused.content, /Refused by policy/);
    } else console.log("no element named Close in snapshot; skipped policy click check");
    assert.ok(asked.includes("desktop_type"), "operator's write actions went through approval");
  } finally {
    await rt.cleanup();
  }
});
