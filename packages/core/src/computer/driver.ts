import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { posix, win32 } from "node:path";
import { homedir } from "node:os";

/**
 * Locate the desktop accessibility driver (agent-cu) on macOS, Linux AND Windows, and return a
 * command that can be spawned WITHOUT a shell.
 *
 * Why this exists: `npm i -g agent-cu` puts a `.cmd` shim on the Windows PATH. Node cannot spawn
 * `.cmd`/`.bat` files without `shell: true`, and running through a shell would let text the model
 * types be interpreted by cmd.exe. So we resolve past the shim to the real thing:
 *   1. the platform binary shipped inside the npm package (agent-computer-use-windows-x64.exe …)
 *   2. otherwise the package's JS launcher, run with this Node (`node agent-cu.js …`)
 *   3. a native executable on PATH (`cargo install` → agent-cu.exe / agent-cu)
 */
export type DriverCommand = { file: string; prefixArgs: string[]; source: string };

const PLATFORM_BINARY: Record<string, string> = {
  "darwin-arm64": "agent-computer-use-macos-arm64",
  "darwin-x64": "agent-computer-use-macos-x64",
  "linux-x64": "agent-computer-use-linux-x64",
  "linux-arm64": "agent-computer-use-linux-arm64",
  "win32-x64": "agent-computer-use-windows-x64.exe",
};

export type ResolveEnv = {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  execPath: string;
  home: string;
  exists: (p: string) => boolean;
  /** Make a file executable if it isn't (POSIX). Returns whether it is executable now. */
  ensureExecutable?: (p: string) => boolean;
  /** Resolve agent-cu/package.json from local node_modules, if installed there. */
  localPackage: () => string | undefined;
};

const req = createRequire(import.meta.url);

export function defaultResolveEnv(): ResolveEnv {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    execPath: process.execPath,
    home: homedir(),
    exists: existsSync,
    localPackage: () => {
      try {
        return P({ platform: process.platform } as ResolveEnv).dirname(req.resolve("agent-cu/package.json"));
      } catch {
        return undefined;
      }
    },
  };
}

/** Where `npm i -g` puts packages, across npm, nvm, nvm-windows, Volta-less setups and Homebrew. */
/** Path semantics follow the TARGET platform, so resolution is testable from any OS. */
const P = (e: ResolveEnv) => (e.platform === "win32" ? win32 : posix);

function globalNodeModules(e: ResolveEnv): string[] {
  const { join, dirname } = P(e);
  const dirs: string[] = [];
  if (e.env.npm_config_prefix) dirs.push(e.platform === "win32" ? join(e.env.npm_config_prefix, "node_modules") : join(e.env.npm_config_prefix, "lib", "node_modules"));
  if (e.platform === "win32") {
    if (e.env.APPDATA) dirs.push(join(e.env.APPDATA, "npm", "node_modules"));
    dirs.push(join(dirname(e.execPath), "node_modules")); // nvm-windows / installer layout
  } else {
    dirs.push(join(dirname(e.execPath), "..", "lib", "node_modules")); // nvm, official tarballs
    dirs.push("/usr/local/lib/node_modules", "/usr/lib/node_modules", "/opt/homebrew/lib/node_modules", join(e.home, ".npm-global", "lib", "node_modules"));
  }
  return dirs;
}

function fromPackageDir(pkg: string, e: ResolveEnv, source: string): DriverCommand | undefined {
  const { join } = P(e);
  const bin = PLATFORM_BINARY[`${e.platform}-${e.arch}`];
  if (bin && e.exists(join(pkg, "bin", bin))) {
    const file = join(pkg, "bin", bin);
    // npm does not always keep the executable bit on bundled binaries (→ EACCES). Fix it in place;
    // if we can't, fall through to the package's node launcher instead of failing every call.
    if (e.platform === "win32" || (e.ensureExecutable ?? ensureExecutable)(file)) return { file, prefixArgs: [], source: `${source} (native binary)` };
  }
  const launcher = join(pkg, "bin", "agent-cu.js");
  if (e.exists(launcher)) return { file: e.execPath, prefixArgs: [launcher], source: `${source} (node launcher)` };
  return undefined;
}

function onPath(name: string, e: ResolveEnv): string[] {
  const { join, delimiter } = P(e);
  const exts = e.platform === "win32" ? (e.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((x) => x.toLowerCase()) : [""];
  const out: string[] = [];
  for (const dir of (e.env.PATH ?? e.env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (e.exists(p)) out.push(p);
    }
  }
  return out;
}

export function resolveDriver(e: ResolveEnv = defaultResolveEnv()): DriverCommand | undefined {
  const { join, dirname, extname } = P(e);
  const override = e.env.CONFLUX_DESKTOP_BIN;
  if (override) {
    if (/\.(c|m)?js$/i.test(override)) return { file: e.execPath, prefixArgs: [override], source: "CONFLUX_DESKTOP_BIN" };
    if (e.platform === "win32" && /\.(cmd|bat)$/i.test(override)) {
      // Resolve a shim the user pointed at to the package behind it.
      const pkg = join(dirname(override), "node_modules", "agent-cu");
      return fromPackageDir(pkg, e, "CONFLUX_DESKTOP_BIN shim");
    }
    if (override.includes("/") || override.includes("\\")) return e.exists(override) ? { file: override, prefixArgs: [], source: "CONFLUX_DESKTOP_BIN" } : undefined;
    const hit = onPath(override, e).find((p) => !/\.(cmd|bat)$/i.test(p));
    return hit ? { file: hit, prefixArgs: [], source: "CONFLUX_DESKTOP_BIN (PATH)" } : undefined;
  }

  const local = e.localPackage();
  if (local) {
    const r = fromPackageDir(local, e, "local node_modules");
    if (r) return r;
  }
  for (const dir of globalNodeModules(e)) {
    const r = fromPackageDir(join(dir, "agent-cu"), e, "global npm");
    if (r) return r;
  }
  for (const p of onPath("agent-cu", e)) {
    if (extname(p).toLowerCase() === ".cmd" || extname(p).toLowerCase() === ".bat") {
      const r = fromPackageDir(join(dirname(p), "node_modules", "agent-cu"), e, "npm shim");
      if (r) return r;
      continue;
    }
    return { file: p, prefixArgs: [], source: "PATH" };
  }
  return undefined;
}

export function ensureExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    try {
      chmodSync(file, 0o755);
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}
