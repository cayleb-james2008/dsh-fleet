// Builds single-file React + Tailwind 4 HTML -> ../sidecars/fleet_pane/dist/index.html
// while copying Geist/Geist Mono .woff2 assets to ../sidecars/fleet_pane/dist/fonts/ so
// sidecar index.html stays compact (<500 KB raw / <160 KB gzip) with zero external requests.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = import.meta.dirname;
const STAMP =
  "/* Hallmark · checked: 2026-11-25 · genre: modern-minimal · app scope · built: the project · House Frontend (light + dark) · v1.9.0 */";

function sidecarSingleFile(): Plugin {
  return {
    name: "sidecar-single-file",
    enforce: "post",
    closeBundle() {
      const dist = path.resolve(root, "dist");
      let html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
      html = html.replace(/<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_m, src) => {
        const js = fs
          .readFileSync(path.join(dist, src.replace(/^\.?\//, "")), "utf8")
          .replace(/<\/script/gi, "<\\/script");
        return `<script type="module">${js}</script>`;
      });
      html = html.replace(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_m, href) => {
        const css = fs
          .readFileSync(path.join(dist, href.replace(/^\.?\//, "")), "utf8")
          .replaceAll("../fonts/", "./fonts/")
          .replace(/\/\*![\s\S]*?\*\//g, "")
          .replace(/@layer properties\{[\s\S]*?\}\}\}/g, "")
          .replace(/@property --tw-(?!border-)[^}]+\}/g, "")
          .replace(/-apple-system, BlinkMacSystemFont,[^;)]+/g, "system-ui,sans-serif")
          .replace(/ui-monospace, SFMono-Regular,[^;)]+/g, "monospace")
          .replace(/(-webkit-text-decoration:inherit;)+/g, "")
          .replace(/font-(?:feature|variation)-settings:var\(--default-(?:mono-)?font-(?:feature|variation)-settings,normal\);?/g, "")
          .replace(/--lightningcss-(?:light|dark):[^;]*;/g, "")
          .replace(/--tw-shadow:([^;]+);box-shadow:var\(--tw-inset-shadow\)[^;}]+/g, "box-shadow:$1")
          .replace(/--tw-space-y-reverse:0;margin-block-start:calc\([^;]+\);margin-block-end:calc\(([^;}]+)\s*\*\s*calc\(1 - var\(--tw-space-y-reverse\)\)\)/g, "margin-bottom:$1")
          .replace(/--tw-divide-y-reverse:0;border-bottom-style:var\(--tw-border-style\);border-bottom-width:calc\(([^;]+)\);border-top-style:var\(--tw-border-style\);border-top-width:calc\([^;]+\)/g, "border-bottom:1px solid")
          .replace(/calc\(var\(--spacing\)\s*\*\s*([\d.]+)\)/g, (_, n) => `${Number(n) * 0.25}rem`)
          .replace(/var\(--spacing\)/g, ".25rem")
          .replace(/--spacing:\.25rem;/g, "")
          .replace(/font-(?:feature|variation)-settings:inherit;?/g, "")
          .replace(/letter-spacing:inherit;?/g, "")
          .replace(/a\{color:inherit;text-decoration:inherit\}|b,strong\{font-weight:bolder\}|img,video\{max-width:100%;height:auto\}|::placeholder\{opacity:1\}/g, "")
          .replace(/--font-(?:weight-(?:medium|semibold)|sans|mono):[^;]+;|--leading-snug:[^;]+;|--aspect-video:[^;]+;|--default-(?:mono-)?font-family:[^;}]+;?/g, (m) =>
            m.startsWith("--font-sans") || m.startsWith("--font-mono") ? m : "",
          )
          .replace(/var\(--font-weight-medium\)/g, "500")
          .replace(/var\(--font-weight-semibold\)/g, "600")
          .replace(/var\(--leading-snug\)/g, "1.375")
          .replace(/var\(--aspect-video\)/g, "16/9")
          .replace(/var\(--default-font-family,[^)]+\)/g, "var(--font-sans)")
          .replace(/var\(--default-mono-font-family,[^)]+\)/g, "var(--font-mono)")
          .replace(/code,kbd,samp,pre\{[^}]*\}/g, "")
          .replace(/ui-sans-serif,\s*|ui-monospace,\s*|h4,h5,h6,/g, "")
          .replace(/--radius-(?:card|chip):[^;]+;|--display-weight:600;|--tracking-display:-\.02em;|--ease-house:cubic-bezier\([^)]+\);|--dur-press:\.15s;?/g, "")
          .replace(/var\(--radius-card\)/g, "8px")
          .replace(/var\(--radius-chip\)/g, "6px")
          .replace(/var\(--display-weight\)/g, "600")
          .replace(/var\(--tracking-display\)/g, "-.02em")
          .replace(/var\(--ease-house\)/g, "cubic-bezier(.23,1,.32,1)")
          .replace(/var\(--dur-press\)/g, ".15s")
          .replace(/#ffffff(?![0-9a-f])/gi, "#fff")
          .replace(/#000000(?![0-9a-f])/gi, "#000")
          .replace(/::backdrop\{[^}]*\}|::file-selector-button\{[^}]*\}|abbr:where\(\[title\]\)\{[^}]*\}|:-moz-[^}]+}|::-(?:webkit|moz)-[^{]+\{[^}]*}|small\{[^}]*\}|sub,sup\{[^}]*\}sub\{[^}]*\}sup\{[^}]*\}|progress\{[^}]*\}|summary\{[^}]*\}|hr\{[^}]*\}|table\{[^}]*\}|\[hidden\]:where\([^)]+\)\{[^}]*\}|@layer components;|\/\*\$vite\$:\d+\*\/|:where\(select:is[\s\S]*?20px\}|@supports \(not \(\(-webkit-appearance:[\s\S]*?\}\}\}/g, "")
          .replace(/\b0(\.\d+)/g, "$1");
        return `<style>${STAMP}\n${css}</style>`;
      });
      html = html
        .replace(/--tw-ring-offset-color:#fff/g, "--tw-ring-offset-color:var(--surface)")
        .replace(/\.transition\{[^}]*\}/g, "")
        .replace(/>\s+</g, "><");

      const outDir = path.resolve(root, "../sidecars/fleet_pane/dist");
      const outFontsDir = path.join(outDir, "fonts");
      fs.mkdirSync(outFontsDir, { recursive: true });
      for (const file of fs.readdirSync(path.join(root, "src/fonts"))) {
        if (file.endsWith(".woff2")) {
          fs.copyFileSync(path.join(root, "src/fonts", file), path.join(outFontsDir, file));
        }
      }

      const outHtml = path.join(outDir, "index.html");
      fs.writeFileSync(outHtml, html);
      const gz = zlib.gzipSync(html, { level: 9, memLevel: 9 });
      fs.writeFileSync(`${outHtml}.gz`, gz);
      console.log(`sidecar bundle: ${outHtml} (${(html.length / 1024).toFixed(1)} kB raw, ${(gz.length / 1024).toFixed(1)} kB gz)`);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), sidecarSingleFile()],
  base: "./",
  build: {
    target: "es2022",
    assetsInlineLimit: (filePath) => !filePath.endsWith(".woff2"),
    cssCodeSplit: false,
    chunkSizeWarningLimit: 2000,
    modulePreload: false,
    rolldownOptions: {
      treeshake: true,
      output: {
        comments: { legal: false },
        minify: {
          compress: { dropConsole: true, dropDebugger: true, maxIterations: 4, target: "es2022" },
          mangle: { toplevel: true },
        },
        assetFileNames: (assetInfo) =>
          assetInfo.names?.some((n) => n.endsWith(".woff2")) ? "fonts/[name][extname]" : "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    fs: { allow: [path.resolve(root, "..")] },
    proxy: process.env.API_PORT
      ? {
          "/api": {
            target: `http://127.0.0.1:${process.env.API_PORT}`,
            changeOrigin: true,
            headers: { Origin: `http://127.0.0.1:${process.env.API_PORT}` },
          },
          "/preload.js": {
            target: `http://127.0.0.1:${process.env.API_PORT}`,
            changeOrigin: true,
          },
          "/fonts": {
            target: `http://127.0.0.1:${process.env.API_PORT}`,
            changeOrigin: true,
          },
        }
      : undefined,
  },
});
