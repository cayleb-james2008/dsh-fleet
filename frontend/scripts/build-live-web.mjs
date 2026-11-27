// Produces the 100% self-contained single-file interactive live-web demo
// (dist-live-web/index.html) from sidecars/fleet_pane/dist/index.html +
// ./web-engine.js + inlined Geist woff2 fonts. Zero external network calls.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const srcHtml = path.join(root, "sidecars/fleet_pane/dist/index.html");
const fontsDir = path.join(root, "frontend/src/fonts");
const engineJs = path.join(import.meta.dirname, "web-engine.js");
const outDir = process.env.LIVE_WEB_OUT_DIR || path.join(root, "dist-live-web");
const outFile = path.join(outDir, "index.html");

if (!fs.existsSync(srcHtml)) {
  console.error(`Missing ${srcHtml}: run npm run build first.`);
  process.exit(1);
}

const engineCode = fs.readFileSync(engineJs, "utf8").replace(/<\/script>/gi, "<\\/script>");
let html = fs.readFileSync(srcHtml, "utf8");

// Inline Geist & Geist Mono woff2 fonts into CSS so dist-live-web/index.html is 100% offline/file:// ready.
for (const file of fs.readdirSync(fontsDir)) {
  if (!file.endsWith(".woff2")) continue;
  const b64 = fs.readFileSync(path.join(fontsDir, file)).toString("base64");
  const dataUri = `data:font/woff2;base64,${b64}`;
  html = html.replaceAll(`./fonts/${file}`, dataUri);
}

// Replace /preload.js script tag cleanly with our offline live-web engine simulator.
html = html.replace(
  /<script\s+src="\/preload\.js"\s*><\/script>/i,
  () => `<script>\n${engineCode}\n</script>`,
);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`live web bundle: ${outFile} (${(html.length / 1024).toFixed(1)} kB)`);
