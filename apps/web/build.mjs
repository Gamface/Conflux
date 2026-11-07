// Bundles the UI into dist/ with esbuild (one dependency, sub-second builds).
import { build, context } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const watch = process.argv.includes("--watch");
mkdirSync("dist/assets", { recursive: true });
const options = {
  entryPoints: ["src/main.tsx"],
  bundle: true,
  minify: !watch,
  sourcemap: watch,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  outfile: "dist/assets/app.js",
  loader: { ".css": "css" },
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  logLevel: "info",
};
// index.html is served no-cache; assets are cached as immutable, so their URLs must change
// whenever their content does. A content hash in the query string does exactly that.
function writeHtml() {
  const v = (f) => createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 12);
  const html = readFileSync("index.html", "utf8").replace(
    '<script type="module" src="/src/main.tsx"></script>',
    `<link rel="stylesheet" href="/assets/app.css?v=${v("dist/assets/app.css")}" />\n    <script type="module" src="/assets/app.js?v=${v("dist/assets/app.js")}"></script>`,
  );
  writeFileSync("dist/index.html", html);
}
if (watch) {
  const ctx = await context({ ...options, plugins: [{ name: "html", setup: (b) => b.onEnd(() => writeHtml()) }] });
  await ctx.watch();
} else {
  await build(options);
  writeHtml();
}
