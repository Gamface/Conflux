import { createServer } from "node:http";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { Runtime, REPO_ROOT, loadConfig } from "../../../packages/core/src/index.ts";
import { buildApi } from "./api.ts";
import { HttpError, json, readBody, serveStatic, type Req } from "./http.ts";
import { startTelegram } from "./channels/telegram.ts";

process.removeAllListeners("warning");

export async function startServer(opts: { port?: number; host?: string; dataDir?: string; quiet?: boolean } = {}) {
  const config = loadConfig({ dataDir: opts.dataDir });
  if (opts.port !== undefined) config.port = opts.port;
  if (opts.host) config.host = opts.host;
  const rt = new Runtime(config, { quiet: opts.quiet });
  await rt.start();
  const api = buildApi(rt);
  const webRoot = join(REPO_ROOT, "apps", "web", "dist");

  const authorized = (req: Req): boolean => {
    if (!config.accessKey) return true;
    const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || req.query.get("key") || "";
    const a = Buffer.from(given);
    const b = Buffer.from(config.accessKey);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const server = createServer(async (rawReq, res) => {
    const req = rawReq as Req;
    const url = new URL(req.url ?? "/", "http://local");
    req.query = url.searchParams;
    res.setHeader("x-content-type-options", "nosniff");
    try {
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/agui/")) {
        if (req.method === "OPTIONS") {
          res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, PUT, DELETE" });
          return res.end();
        }
        if (url.pathname !== "/api/health" && !authorized(req)) throw new HttpError(401, "access key required");
        const m = api.match(req.method ?? "GET", url.pathname);
        if (!m) throw new HttpError(404, `no route ${req.method} ${url.pathname}`);
        req.params = m.params;
        if (req.method !== "GET") req.body = await readBody(req);
        const out = await m.handler(req, res);
        if (!res.headersSent && out !== undefined) json(res, 200, out);
        return;
      }
      if (!serveStatic(webRoot, url.pathname, res)) {
        json(res, 200, { name: "Conflux", hint: "web UI not built — run `npm run build:web`", api: "/api/health" });
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) rt.log("error", req.method, url.pathname, (e as Error).stack);
      if (!res.headersSent) json(res, status, { error: (e as Error).message, ...((e as any).current ? { current: (e as any).current } : {}) });
      else res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  rt.log(`Conflux on http://${config.host}:${port}  (model: ${config.defaultModel}, data: ${config.dataDir})`);
  if (config.accessKey) rt.log("access key required for the API");
  const stopTelegram = startTelegram(rt);

  const close = async () => {
    stopTelegram();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rt.stop();
  };
  return { rt, server, port, close };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startServer();
  const shutdown = async () => {
    await s.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
