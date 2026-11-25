// Builds single-file React + Tailwind 4 HTML -> ../sidecars/fleet_pane/dist/index.html
// while copying Geist/Geist Mono .woff2 assets to ../sidecars/fleet_pane/dist/fonts/ so
// sidecar index.html stays compact (<500 KB raw / <160 KB gzip) with zero external requests.
import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = import.meta.dirname;
const STAMP =
  "/* Hallmark · checked: 2026-11-25 · genre: modern-minimal · app scope · built: the project · House Frontend (light + dark) · v1.2.0 */";

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
          .replaceAll("../fonts/", "./fonts/");
        return `<style>${STAMP}\n${css}</style>`;
      });
      html = html
        .replace(/--tw-ring-offset-color:#fff/g, "--tw-ring-offset-color:var(--surface)")
        .replace(/\.transition\{[^}]*\}/g, "");

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
      console.log(`sidecar bundle: ${outHtml} (${(html.length / 1024).toFixed(1)} kB raw)`);
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
