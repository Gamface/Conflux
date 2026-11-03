// Bundles the UI into dist/ with esbuild (one dependency, sub-second builds).
import { build, context } from "esbuild";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
const html = readFileSync("index.html", "utf8")
  .replace('<script type="module" src="/src/main.tsx"></script>', '<link rel="stylesheet" href="/assets/app.css" />\n    <script type="module" src="/assets/app.js"></script>');
writeFileSync("dist/index.html", html);
if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
