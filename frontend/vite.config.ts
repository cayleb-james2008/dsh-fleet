// Single-file production bundle for Fleet (Rust): React + Tailwind 4 + Geist/Geist Mono -> ../assets/index.html.
import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = import.meta.dirname;
const STAMP = "/* Hallmark · checked: 2026-11-25 · genre: modern-minimal · app scope · built: the project · House Frontend (light + dark) · v0.9.0 */";

function singleFile(): Plugin {
  return {
    name: "single-file",
    enforce: "post",
    closeBundle() {
      const dist = path.resolve(root, "dist");
      let html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
      html = html.replace(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g, (_m, src) => {
        const js = fs.readFileSync(path.join(dist, src.replace(/^\.?\//, "")), "utf8").replace(/<\/script/gi, "<\\/script");
        return `<script type="module">${js}</script>`;
      });
      html = html.replace(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_m, href) => {
        const css = fs.readFileSync(path.join(dist, href.replace(/^\.?\//, "")), "utf8");
        return `<style>${STAMP}\n${css}</style>`;
      });
      html = html.replace(/--tw-ring-offset-color:#fff/g, "--tw-ring-offset-color:var(--surface)").replace(/\.transition\{[^}]*\}/g, "");
      const out = path.resolve(root, "../assets/index.html");
      fs.writeFileSync(out, html);
      console.log(`single file: ${out} (${(html.length / 1024).toFixed(0)} kB)`);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), singleFile()],
  base: "./",
  build: { assetsInlineLimit: 100_000_000, cssCodeSplit: false, chunkSizeWarningLimit: 4000, modulePreload: false },
  server: { fs: { allow: [path.resolve(root, "..")] }, proxy: process.env.API_PORT ? { "/api": { target: `http://127.0.0.1:${process.env.API_PORT}`, changeOrigin: true, headers: { Origin: `http://127.0.0.1:${process.env.API_PORT}` } } } : undefined },
});
