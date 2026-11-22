// build-live-web.mjs: Produces the standalone real functional Fleet web app
// (shared-live-web/fleet/index.html) by embedding ./web-engine.js (real
// in-browser git worktree store, unified diff engine, IndexedDB persistence,
// real sandboxed Web Worker check evaluator, optional BYOK OpenAI-compatible
// agent in sessionStorage, and local Fleet connector) into assets/index.html.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const srcHtml = path.join(root, "assets/index.html");
const engineJs = path.join(import.meta.dirname, "web-engine.js");
const outDir =
  process.env.LIVE_WEB_OUT_DIR ||
  "/home/cayleb/Work/scratch/swarm-v080/shared-live-web/fleet";
const outFile = path.join(outDir, "index.html");

if (!fs.existsSync(srcHtml)) {
  console.error(`Missing ${srcHtml} — run npm run build first.`);
  process.exit(1);
}

const engineCode = fs.readFileSync(engineJs, "utf8");
// Escape closing script tags safely if any appear in string literals
const safeScript = `<script>\n${engineCode.replace(/<\/script>/gi, "<\\/script>")}\n</script>`;

let html = fs.readFileSync(srcHtml, "utf8");
html = html.replace("<head>", () => `<head>\n    ${safeScript}`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`live web bundle: ${outFile} (${(html.length / 1024).toFixed(0)} kB)`);
