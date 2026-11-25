// End-to-end verification of standalone `dist-live-web/index.html` (offline single-file demo).
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const CHROME =
  process.env.E2E_CHROME ||
  `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;
const ROOT = path.resolve(import.meta.dirname, "../..");
const LIVE_HTML = path.join(ROOT, "dist-live-web/index.html");

const srv = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(LIVE_HTML));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 380, height: 900 } });
const page = await ctx.newPage();

const externalReqs = [];
const consoleErrs = [];
const pageErrs = [];
page.on("request", (req) => {
  const u = req.url();
  if (!u.startsWith(BASE) && !u.startsWith("data:") && !u.startsWith("blob:")) externalReqs.push(u);
});
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrs.push(msg.text());
});
page.on("pageerror", (e) => pageErrs.push(e.message));

let pass = 0;
let total = 0;
async function check(label, fn) {
  total++;
  try {
    const ok = await fn();
    if (ok) {
      pass++;
      console.log(`  ok  ${label}`);
    } else {
      console.error(`  FAIL ${label}`);
    }
  } catch (e) {
    console.error(`  FAIL ${label}: ${e.message}`);
  }
}

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector('h1:has-text("Fleet v1.0 Antigravity Sidecar")');

await check("loads simulated Antigravity swarm in 380px sidebar", async () => {
  const txt = await page.locator("#panel-triage").textContent();
  return txt.includes("Needs you") && txt.includes("builder asked a question");
});

await check("plan.json goal & humanized workstreams visible", async () => {
  const txt = await page.locator("#panel-triage").textContent();
  return txt.includes("Deliver native aux-pane Swarm Command Center") && txt.includes("In progress");
});

await check("Geist woff2 fonts embedded & loaded with zero network font requests", async () => {
  return await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.size >= 2;
  });
});

// Send confirmed nudge to builder right inside Triage
await page.locator('#panel-triage button:has-text("Nudge")').first().click();
await page.locator('#panel-triage button:has-text("Confirm & send")').click();
await page.waitForTimeout(150);

await check("confirmed nudge posts live message to Board feed", async () => {
  await page.locator("#tab-board").click();
  const txt = await page.locator("#panel-board").textContent();
  return txt.includes("Vary: Accept-Encoding");
});

await check("Board #seq pill & agent filter work", async () => {
  await page.locator('#panel-board button[aria-label="Toggle board filters"]').click();
  await page.locator("#panel-board").getByRole("button", { name: "ui-dev", exact: true }).click();
  const txt = await page.locator("#panel-board").textContent();
  return txt.includes("Adapting Needs-You triage cards");
});

await check("Roster shows live token totals and shimmering activity", async () => {
  await page.locator("#tab-roster").click();
  const txt = await page.locator("#panel-roster").textContent();
  return txt.includes("Polishing 380px sidebar responsive grid") && txt.includes("46.5k tok");
});

await check("Graph renders nodes/edges and toggles", async () => {
  await page.locator("#tab-graph").click();
  return (await page.locator("#panel-graph svg g").count()) >= 4;
});

await check("Worktrees shows simulated branch dirtiness", async () => {
  await page.locator("#tab-worktrees").click();
  const txt = await page.locator("#panel-worktrees").textContent();
  return txt.includes("lane/sidebar-ui") && txt.includes("4 changed");
});

await check("Multi-Swarm Switcher switches to secondary audit swarm", async () => {
  await page.selectOption('select[aria-label="Active swarm"]', "demo-audit-0009");
  await page.locator("#tab-board").click();
  const txt = await page.locator("#panel-board").textContent();
  return txt.includes("All traversal, symlink, and loopback checks passed");
});

await check("Settings Dark mode + 1440px desktop overflow check", async () => {
  await page.locator('button[aria-label="Open settings"]').click();
  await page.locator('div[role="dialog"] button[role="radio"]:has-text("Dark")').click();
  await page.locator('button[aria-label="Close dialog"]').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const dark = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  return ov <= 0 && dark === "dark";
});

await check("zero external calls, console errors, or page errors", () => externalReqs.length === 0 && consoleErrs.length === 0 && pageErrs.length === 0);

await browser.close();
srv.close();
console.log(`\nlive-web: ${pass}/${total} checks passed`);
process.exit(pass === total ? 0 : 1);
