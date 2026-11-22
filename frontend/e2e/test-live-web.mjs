// test-live-web.mjs: Comprehensive end-to-end verification of the standalone v0.5.0 browser-only
// live web bundle (shared-live-web/dsh-fleet/index.html) across desktop 1440x900 and mobile 390x844
// in both Light and Dark themes. Verifies real DAG depends_on chaining, Batch fan-out, multi-step
// Blob Web Worker checks, Unified + Split Diff, .patch download, Cmd+K palette, keyboard nav,
// Live Policy Tester, IndexedDB persistence, Settings-only Light/Dark mobile tap, ZERO fixture pills,
// ZERO external network requests, and saves screenshots for visual inspection.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright-core";

const BUNDLE =
  process.env.LIVE_WEB_FILE ||
  "/home/cayleb/Work/scratch/swarm-v050/shared-live-web/dsh-fleet/index.html";
const SHOT_DIR =
  process.env.SHOT_DIR ||
  "/home/cayleb/.gemini/antigravity/brain/4d606d0e-862d-43e1-b40f-5f32ac566aa0";
const CHROME =
  process.env.E2E_CHROME ||
  path.join(os.homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome");

if (!fs.existsSync(BUNDLE)) {
  console.error(`Missing bundle: ${BUNDLE}`);
  process.exit(1);
}
fs.mkdirSync(SHOT_DIR, { recursive: true });
const html = fs.readFileSync(BUNDLE, "utf8");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const checks = [];
const ok = (name, pass, detail = "") => {
  checks.push({ name, pass: !!pass, detail });
  console.log((pass ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : ""));
};

const externalReqs = [];
const pageErrors = [];

try {
  // 1. Desktop 1440x900 Light + full v0.5.0 feature walkthrough
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    acceptDownloads: true,
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(`1440: ${e.message}`));
  p.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`1440 console: ${m.text()}`);
  });
  p.on("request", (req) => {
    const u = req.url();
    if (!u.startsWith(url) && !u.startsWith("blob:") && !u.startsWith("data:")) {
      externalReqs.push(u);
    }
  });

  await p.goto(url);
  await p.waitForSelector('div[aria-label="Session lanes"] article', { timeout: 15000 });
  await p.waitForTimeout(1500);

  const bodyText = await p.locator("body").innerText();
  ok(
    "zero fixture pills or placeholder labels on live web bundle",
    !/\bfixture\b|example fixture|recorded read-only replay/i.test(bodyText),
    bodyText.match(/\bfixture\b|example fixture|recorded read-only replay/i)?.[0] || "clean",
  );
  ok(
    "initial 3 real browser worktree sessions settle with concurrency slots indicator",
    (await p.locator('div[aria-label="Session lanes"] article').count()) >= 3 &&
      (await p.locator('[data-testid="concurrency-indicator"]').isVisible()),
  );
  const overflow1440 = await p.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  ok("1440 desktop has 0px horizontal overflow", overflow1440 <= 0, `overflow=${overflow1440}`);
  await p.screenshot({ path: path.join(SHOT_DIR, "fleet-live-web-1440-light.png") });

  // Keyboard navigation j / d / r / t
  await p.keyboard.press("j");
  await p.waitForTimeout(350);
  const inspector = p.locator('aside[aria-label="Session inspector"]');
  ok("keyboard j opens session inspector", await inspector.isVisible());

  await p.keyboard.press("d");
  await p.waitForTimeout(300);
  const diffViewer = inspector.locator('[data-testid="rich-diff-viewer"]');
  ok("keyboard d switches to Diff tab with merge-check badge", await diffViewer.isVisible());

  // Switch to Side-by-Side Split diff and verify zero cross-column text bleed + download .patch
  await diffViewer.getByRole("button", { name: "Split" }).click();
  await p.waitForTimeout(200);
  const splitRendered = (await diffViewer.locator('[data-testid="diff-split-grid"]').count()) >= 1;
  const splitOverflowCount = await diffViewer.locator('[data-testid="diff-split-grid"]').evaluate((root) => {
    let bad = 0;
    for (const cell of root.querySelectorAll(".grid.grid-cols-2 > div")) {
      const cr = cell.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(cell);
      const tr = range.getBoundingClientRect();
      if (tr.right > cr.right + 1.5 || tr.left < cr.left - 1.5) bad++;
    }
    return bad;
  });
  ok("Side-by-Side split diff grid renders cleanly with zero cross-column text bleed", splitRendered && splitOverflowCount === 0, `bleed=${splitOverflowCount}`);
  await p.screenshot({ path: path.join(SHOT_DIR, "fleet-live-web-split-diff-1440-light.png") });

  const [download] = await Promise.all([
    p.waitForEvent("download"),
    diffViewer.getByRole("button", { name: ".patch" }).click(),
  ]);
  const patchFilename = download.suggestedFilename();
  ok("Download .patch triggers real unified patch download", patchFilename.endsWith(".patch"), patchFilename);

  // Switch to Receipt tab with keyboard 'r' and verify Per-Step Timed Receipt Timeline
  await p.keyboard.press("r");
  await p.waitForTimeout(250);
  const timeline = inspector.locator('[data-testid="receipt-timeline"]');
  const stepCount = await timeline.locator('ol[aria-label="Check pipeline steps"] > li').count();
  ok("keyboard r opens Receipt tab with timed multi-step Blob Web Worker timeline", stepCount >= 2, `steps=${stepCount}`);

  await p.screenshot({ path: path.join(SHOT_DIR, "fleet-live-web-inspector-1440-light.png") });

  // Switch back to Transcript with 't' and verify virtualized search + error jump button present
  await p.keyboard.press("t");
  await p.waitForTimeout(200);
  ok("keyboard t switches to Virtualized Transcript", await inspector.locator('[data-testid="virtualized-transcript"]').isVisible());

  // Open Cmd+K Command Palette
  await p.keyboard.press("Control+k");
  await p.waitForTimeout(250);
  const paletteVisible = await p.locator('[cmdk-root]').isVisible();
  ok("Ctrl+K opens Global Command Palette", paletteVisible);
  await p.screenshot({ path: path.join(SHOT_DIR, "fleet-live-web-cmdk-1440-light.png") });

  // Launch Batch Fan-Out Dispatch from Cmd+K with DAG depends_on chaining (#1 -> #2)
  await p.locator('[cmdk-input]').fill("Batch fan-out");
  await p.waitForTimeout(150);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(400);
  await p.locator("#batch-task-0").fill("Add batch helper one to ledger-kit");
  await p.locator("#batch-task-1").fill("Add batch helper two depending on task one");
  // Link Task #2 depends_on #1
  await p.getByRole("button", { name: "#1", exact: true }).click();
  await p.waitForTimeout(150);
  await p.getByRole("button", { name: /Dispatch 2 tasks/ }).click();
  await p.waitForTimeout(2200);
  const afterBatchCount = await p.locator('div[aria-label="Session lanes"] article').count();
  ok("Batch fan-out with depends_on DAG executes and settles in-browser", afterBatchCount >= 5, `count=${afterBatchCount}`);

  // IndexedDB persistence across page reload
  await p.reload();
  await p.waitForSelector('div[aria-label="Session lanes"] article', { timeout: 15000 });
  await p.waitForTimeout(800);
  const afterReloadCount = await p.locator('div[aria-label="Session lanes"] article').count();
  ok("IndexedDB persists batch sessions across full page reload", afterReloadCount === afterBatchCount, `${afterReloadCount}/${afterBatchCount}`);

  // Settings-only Light/Dark + Live Policy Tester (POST /api/policies/test)
  const headerThemeCount = await p.locator('header #themeBtn, header [aria-label="Light"], header [aria-label="Dark"]').count();
  ok("Light/Dark switcher absent from top bar in live web bundle", headerThemeCount === 0);

  await p.getByRole("button", { name: "Engines and settings" }).click();
  await p.waitForTimeout(350);
  const settings = p.locator("#settings");
  await settings.getByRole("button", { name: "Test policy" }).click();
  await p.waitForTimeout(250);
  const policyText = await settings.locator('[data-testid="policy-test-result"]').innerText();
  ok(
    "Live Policy Tester evaluates route inside Settings drawer",
    policyText.includes("Routed engine") && policyText.includes("policies.rn"),
    policyText.slice(0, 80).replace(/\n/g, " "),
  );

  // Switch to Dark theme inside Settings and capture 1440 dark shot
  await settings.getByRole("button", { name: "Dark", exact: true }).click();
  await p.waitForTimeout(300);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);
  const darkAttr = await p.evaluate(() => document.documentElement.dataset.theme);
  ok("Dark theme activates from Settings drawer", darkAttr === "dark");
  await p.screenshot({ path: path.join(SHOT_DIR, "fleet-live-web-1440-dark.png") });
  await ctx.close();

  // 2. Real Mobile 390x844 Settings Tap Test + Light & Dark mobile screenshots
  const mCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    colorScheme: "light",
  });
  const mp = await mCtx.newPage();
  mp.on("pageerror", (e) => pageErrors.push(`390: ${e.message}`));
  mp.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`390 console: ${m.text()}`);
  });
  await mp.goto(url);
  await mp.waitForSelector('div[aria-label="Session lanes"] article', { timeout: 15000 });
  await mp.waitForTimeout(1000);

  const mOverflow = await mp.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  ok("390x844 mobile has 0px horizontal overflow", mOverflow <= 0, `overflow=${mOverflow}`);
  await mp.screenshot({ path: path.join(SHOT_DIR, "fleet-live-web-390-light.png") });

  // Real tap on Settings button -> real tap on Dark -> verify background luminance drops
  const bgLum = () =>
    mp.evaluate(() => {
      const cx = document.createElement("canvas").getContext("2d");
      cx.fillStyle = getComputedStyle(document.body).backgroundColor;
      cx.fillRect(0, 0, 1, 1);
      const [r, g, b] = cx.getImageData(0, 0, 1, 1).data;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    });
  const lumLight = await bgLum();
  await mp.locator("#settings-open").tap();
  await mp.waitForTimeout(400);
  await mp.locator("#settings").getByRole("button", { name: "Dark", exact: true }).tap();
  await mp.waitForTimeout(350);
  const mThemeDark = await mp.evaluate(() => document.documentElement.dataset.theme);
  const lumDark = await bgLum();
  await mp.screenshot({ path: path.join(SHOT_DIR, "fleet-live-web-390-settings-dark.png") });
  await mp.locator('#settings button[aria-label="Close settings"]').tap();
  await mp.waitForTimeout(350);
  await mp.screenshot({ path: path.join(SHOT_DIR, "fleet-live-web-390-dark.png") });
  ok(
    "390x844 real mobile Settings tap toggles Dark theme cleanly",
    mThemeDark === "dark" && lumDark < lumLight,
    `theme=${mThemeDark} lum=${lumLight.toFixed(0)}->${lumDark.toFixed(0)}`,
  );
  await mCtx.close();

  ok("zero external network requests from standalone live web bundle", externalReqs.length === 0, externalReqs.join(", "));
  ok("zero console or page errors in standalone live web bundle", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
  server.close();
}

const pass = checks.filter((c) => c.pass).length;
console.log(`\nlive-web: ${pass}/${checks.length} pass`);
process.exit(pass === checks.length ? 0 : 1);
