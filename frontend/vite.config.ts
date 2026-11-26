// Builds single-file React + Tailwind 4 HTML -> ../sidecars/fleet_pane/dist/index.html
// while copying Geist/Geist Mono .woff2 assets to ../sidecars/fleet_pane/dist/fonts/ so
// sidecar index.html stays compact (<500 KB raw / <160 KB gzip) with zero external requests.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = import.meta.dirname;
const STAMP =
  "/* Hallmark · checked: 2026-11-25 · genre: modern-minimal · app scope · built: the project · House Frontend (light + dark) · v1.19.0 */";

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
          .replace(/@property --tw-[^}]+\}/g, "")
          .replace(/@layer theme\{:root,:host\{[^}]+\}\}/g, "")
          .replace(/var\(--animate-spin\)/g, "spin 1s linear infinite")
          .replace(/var\(--animate-pulse\)/g, "pulse 2s cubic-bezier(.4,0,.6,1) infinite")
          .replace(/-apple-system, BlinkMacSystemFont,[^;)]+/g, "system-ui,sans-serif")
          .replace(/ui-monospace, SFMono-Regular,[^;)]+/g, "monospace")
          .replace(/(-webkit-text-decoration:inherit;)+/g, "")
          .replace(/font-(?:feature|variation)-settings:var\(--default-(?:mono-)?font-(?:feature|variation)-settings,normal\);?/g, "")
          .replace(/--lightningcss-(?:light|dark):[^;]*;/g, "")
          .replace(/--tw-shadow:([^;]+);box-shadow:var\(--tw-inset-shadow\)[^;}]+/g, "box-shadow:$1")
          .replace(/--tw-space-y-reverse:0;margin-block-start:calc\([^;]+\);margin-block-end:calc\(([^;}]+)\s*\*\s*calc\(1 - var\(--tw-space-y-reverse\)\)\)/g, "margin-bottom:$1")
          .replace(/--tw-divide-y-reverse:0;border-bottom-style:var\(--tw-border-style\);border-top-style:var\(--tw-border-style\);border-top-width:calc\([^;]+\);border-bottom-width:calc\([^;]+\)/g, "border-bottom:1px solid")
          .replace(/var\(--tw-border-style\)/g, "solid")
          .replace(/--tw-outline-style:none;/g, "")
          .replace(/--tw-scale-x:100%;--tw-scale-y:100%;--tw-scale-z:100%;scale:var\(--tw-scale-x\) var\(--tw-scale-y\)/g, "scale:1")
          .replace(/\.transform\{[^}]*\}/g, "")
          .replace(/,video,canvas,audio,iframe,embed,object|,optgroup|,menu/g, "")
          .replace(/--tw-(?:leading|font-weight|tracking):[^;]+;/g, "")
          .replace(/\.visible\{[^}]+\}|\.isolate\{[^}]+\}|\.filter\{[^}]+\}/g, "")
          .replace(/var\(--tw-outline-style\)/g, "solid")
          .replace(/\[hidden\]:where\([^)]+\)\{[^}]*\}/g, "")
          .replace(/font-synthesis:none;|text-wrap:(?:balance|pretty);|scrollbar-width:thin;scrollbar-color:[^;}]+;?/g, "")
          .replace(/@media \(hover:hover\)\{([\s\S]*?)\}\}/g, "$1}")
          .replace(/border-style:solid;border-width:1px/g, "border:1px solid")
          .replace(/outline-style:solid;outline-width:1px/g, "outline:1px solid")
          .replace(/-webkit-text-size-adjust:100%;tab-size:4;|;-webkit-tap-highlight-color:transparent|button,input:where\(\[type=button\],\[type=reset\],\[type=submit\]\)\{appearance:button\}|,h4,h5,h6|ol,/g, "")
          .replace(/\s+\}/g, "}")
          .replace(/font-size:inherit;font-weight:inherit/g, "font:inherit")
          .replace(/border-top-style:solid;border-top-width:1px/g, "border-top:1px solid")
          .replace(/border-bottom-style:solid;border-bottom-width:1px/g, "border-bottom:1px solid")
          .replace(/border-left-style:solid;border-left-width:2px/g, "border-left:2px solid")
          .replace(/cubic-bezier\(\.4,0,\.6,1\)/g, "ease")
          .replace(/calc\(var\(--spacing\)\s*\*\s*(-?[\d.]+)\)/g, (_, n) => `${Number(n) * 0.25}rem`)
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
          .replace(/2147483647px/g, "999px")
          .replace(/#ffffff(?![0-9a-f])/gi, "#fff")
          .replace(/#000000(?![0-9a-f])/gi, "#000")
          .replace(/::backdrop\{[^}]*\}|::file-selector-button\{[^}]*\}|abbr:where\(\[title\]\)\{[^}]*\}|:-moz-[^}]+}|::-(?:webkit|moz)-[^{]+\{[^}]*}|small\{[^}]*\}|sub,sup\{[^}]*\}sub\{[^}]*\}sup\{[^}]*\}|progress\{[^}]*\}|summary\{[^}]*\}|hr\{[^}]*\}|table\{[^}]*\}|\[hidden\]:where\([^)]+\)\{[^}]*\}|@layer components;|\/\*\$vite\$:\d+\*\/|:where\(select:is[\s\S]*?20px\}|@supports \(not \(\(-webkit-appearance:[\s\S]*?\}\}\}/g, "")
          .replace(/\*\s*\{\s*\}/g, "")
          .replace(/\b0(\.\d+)/g, "$1");
        let minCss = "";
        for (let i = 0; i < css.length; ) {
          if (css.startsWith("@layer base{", i) || css.startsWith("@layer utilities{", i)) {
            i = css.indexOf("{", i) + 1;
            let depth = 1;
            const start = i;
            while (i < css.length && depth > 0) {
              if (css[i] === "{") depth++;
              else if (css[i] === "}") depth--;
              i++;
            }
            minCss += css.slice(start, i - 1);
          } else {
            minCss += css[i++];
          }
        }
        return `<style>${STAMP}\n${minCss}</style>`;
      });
      const varRe = /--(?:destructive-foreground|warning-foreground|success-foreground|info-foreground|ink-button-fg|ink-button|elev-primary|elev-raised|elev-lift|violet-soft|warn-soft|blue-soft|bad-soft|ok-soft|disabled|dot-green|dot-amber|dot-red|hairline-s|hairline|surface|track|raised|canvas|board|violet|ink-2|ink-3)(?![a-z0-9-])/g;
      const varMap: Record<string, string> = {
        "--destructive-foreground": "--bf",
        "--warning-foreground": "--wf",
        "--success-foreground": "--of",
        "--info-foreground": "--if",
        "--ink-button-fg": "--ig",
        "--ink-button": "--ib",
        "--elev-primary": "--ep",
        "--elev-raised": "--er",
        "--elev-lift": "--el",
        "--violet-soft": "--vs",
        "--warn-soft": "--ws",
        "--blue-soft": "--bs",
        "--bad-soft": "--es",
        "--ok-soft": "--os",
        "--disabled": "--ds",
        "--dot-green": "--dg",
        "--dot-amber": "--da",
        "--dot-red": "--dr",
        "--hairline-s": "--hs",
        "--hairline": "--hl",
        "--surface": "--sf",
        "--track": "--tr",
        "--raised": "--rs",
        "--canvas": "--cv",
        "--board": "--bd",
        "--violet": "--vl",
        "--ink-2": "--i2",
        "--ink-3": "--i3",
      };
      html = html
        .replace(/--tw-ring-offset-color:#fff/g, "--tw-ring-offset-color:var(--surface)")
        .replace(varRe, (m) => varMap[m] || m)
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
      let gz: Buffer;
      try {
        gz = execFileSync("gzip", ["-9", "-n", "-c", outHtml]);
      } catch {
        gz = zlib.gzipSync(html, { level: 9, memLevel: 9 });
      }
      fs.writeFileSync(`${outHtml}.gz`, gz);
      console.log(`sidecar bundle: ${outHtml} (${(html.length / 1024).toFixed(1)} kB raw, ${(gz.length / 1024).toFixed(1)} kB gz)`);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), sidecarSingleFile()],
  resolve: { alias: { "react/jsx-runtime": path.resolve(root, "src/jsx-rt.js") } },
  base: "./",
  build: {
    target: "es2022",
    assetsInlineLimit: (filePath) => !filePath.endsWith(".woff2"),
    cssCodeSplit: false,
    chunkSizeWarningLimit: 2000,
    modulePreload: false,
    rolldownOptions: {
      treeshake: { moduleSideEffects: (id) => id.endsWith(".css") },
      output: {
        comments: { legal: false },
        minify: {
          compress: { dropConsole: true, dropDebugger: true, maxIterations: 8, target: "es2022" },
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
