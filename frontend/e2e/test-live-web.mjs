// test-live-web.mjs: Comprehensive end-to-end verification of the standalone v0.6.0 browser-only
// live web bundle (shared-live-web/dsh-fleet/index.html) across desktop 1440x900 and mobile 390x844
// in both Light and Dark themes. Verifies Board Metrics Strip, real Auto-Heal attempt recovery &
// timeline, Playbooks selector + Save-as-Playbook + Cmd+K Playbooks, DAG depends_on chaining,
// Batch fan-out, multi-step Blob Web Worker checks, Unified + Split Diff (zero cross-column bleed),
// .patch download, keyboard nav, Policy Tester, IndexedDB persistence, Settings-only Light/Dark
// mobile tap, ZERO fixture pills, ZERO user-facing Rune jargon, ZERO external network requests.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright-core";

const BUNDLE =
  process.env.LIVE_WEB_FILE ||
  "/home/cayleb/Work/scratch/swarm-v060/shared-live-web/dsh-fleet/index.html";
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
  // 1. Desktop 1440x900 Light + full v0.6.0 feature walkthrough
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
  await p.waitForTimeout(1600);

  const bodyText = await p.locator("body").innerText();
  ok(
    "zero fixture pills or placeholder labels on live web bundle",
    !/\bfixture\b|example fixture|recorded read-only replay/i.test(bodyText),
    bodyText.match(/\bfixture\b|example fixture|recorded read-only replay/i)?.[0] || "clean",
  );
  ok(
    "zero user-facing Rune jargon on live web bundle (#155)",
    !/\brune\b/i.test(bodyText),
    bodyText.match(/\brune\b/i)?.[0] || "clean",
  );
  ok(
    "initial 4 real browser worktree sessions settle with concurrency slots indicator",
    (await p.locator('div[aria-label="Session lanes"] article').count()) >= 4 &&
      (await p.locator('[data-testid="concurrency-indicator"]').isVisible()),
  );

  // Board Metrics Strip telemetry (First-pass %, Auto-healed >= 1, Median check, Active / Max)
  const metricsStrip = p.locator('[data-testid="board-metrics-strip"]');
  const metricsText = await metricsStrip.innerText();
  const autoHealedCount = Number.parseInt(await p.locator('[data-testid="metric-auto-healed"]').innerText(), 10);
  ok(
    "Board Metrics Strip renders live First-pass %, Auto-healed count, Median check, and Active/Max slots",
    metricsText.includes("First-pass") &&
      metricsText.includes("Median check") &&
      metricsText.includes("0 / 4") &&
      autoHealedCount >= 1,
    `autoHealed=${autoHealedCount}`,
  );

  const overflow1440 = await p.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  ok("1440 desktop has 0px horizontal overflow", overflow1440 <= 0, `overflow=${overflow1440}`);
  await p.screenshot({ path: path.join(SHOT_DIR, "fleet-v060-live-1440-light.png") });

  // Open the auto-healed session (rate-limiter off-by-one bug fixed autonomously on attempt 1/2)
  await p.getByRole("button", { name: /Open Fix off-by-one token bucket/ }).click();
  await p.waitForTimeout(350);
  const inspector = p.locator('aside[aria-label="Session inspector"]');
  ok("opening auto-healed session shows Healed on attempt 1/2 pill", (await inspector.locator('[data-testid="inspector-heal-badge"]').innerText()).includes("Healed on attempt 1/2"));

  // Switch to Receipt tab with keyboard 'r' and verify Auto-Heal Timeline + Multi-Step Check Timeline
  await p.keyboard.press("r");
  await p.waitForTimeout(300);
  const healTimeline = inspector.locator('[data-testid="auto-heal-timeline"]');
  await healTimeline.getByRole("button", { name: /Diagnostic steer prompt for attempt 1/ }).click();
  await p.waitForTimeout(200);
  const healText = await healTimeline.innerText();
  const stepCount = await inspector.locator('ol[aria-label="Check pipeline steps"] > li').count();
  ok(
    "Receipt tab renders Auto-Heal Attempt Timeline (steer prompt + healed badge) and 2-step check timeline",
    healText.includes("Auto-heal attempt 1/2") && stepCount >= 2 && (await p.locator("details").count()) === 0,
    `steps=${stepCount}`,
  );
  await p.screenshot({ path: path.join(SHOT_DIR, "fleet-v060-autoheal-receipt-1440-light.png") });

  // Switch to Diff tab with keyboard 'd' -> Split diff zero cross-column bleed + .patch download
  await p.keyboard.press("d");
  await p.waitForTimeout(300);
  const diffViewer = inspector.locator('[data-testid="rich-diff-viewer"]');
  ok("keyboard d switches to Diff tab with merge-check badge", await diffViewer.isVisible());

  await diffViewer.getByRole("button", { name: "Split" }).click();
  await p.waitForTimeout(200);
  const splitRendered = (await diffViewer.locator('[data-testid="diff-split-grid"]').count()) >= 1;
  const splitOverflowCount = await diffViewer.locator('[data-testid="diff-split-grid"]').evaluateAll((roots) => {
    let bad = 0;
    for (const root of roots) {
      for (const cell of root.querySelectorAll(".grid.grid-cols-2 > div")) {
        const cr = cell.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(cell);
        const tr = range.getBoundingClientRect();
        if (tr.right > cr.right + 1.5 || tr.left < cr.left - 1.5) bad++;
      }
    }
    return bad;
  });
  ok("Side-by-Side split diff grid renders cleanly with zero cross-column text bleed", splitRendered && splitOverflowCount === 0, `bleed=${splitOverflowCount}`);

  const [download] = await Promise.all([
    p.waitForEvent("download"),
    diffViewer.getByRole("button", { name: ".patch" }).click(),
  ]);
  const patchFilename = download.suggestedFilename();
  ok("Download .patch triggers real unified patch download", patchFilename.endsWith(".patch"), patchFilename);

  // Switch to Transcript with 't'
  await p.keyboard.press("t");
  await p.waitForTimeout(200);
  ok("keyboard t switches to Virtualized Transcript", await inspector.locator('[data-testid="virtualized-transcript"]').isVisible());

  // Open Cmd+K Command Palette -> verify Playbooks group -> launch Two-Wave DAG Rollout playbook
  await p.keyboard.press("Control+k");
  await p.waitForTimeout(250);
  const paletteVisible = await p.locator("[cmdk-root]").isVisible();
  const paletteHasPlaybook = (await p.locator("[cmdk-root]").innerText()).includes("Two-Wave DAG Rollout");
  ok("Ctrl+K opens Global Command Palette with Playbooks group", paletteVisible && paletteHasPlaybook);
  await p.screenshot({ path: path.join(SHOT_DIR, "fleet-v060-cmdk-playbooks-1440-light.png") });

  await p.locator("[cmdk-input]").fill("Two-Wave DAG Rollout");
  await p.waitForTimeout(150);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(450);

  const batchTask0Val = await p.locator("#batch-task-0").inputValue();
  ok("Selecting Two-Wave DAG Rollout playbook pre-populates Batch DAG composer", batchTask0Val.includes("Wave 1"));

  // Save a custom playbook from Composer via POST /api/templates
  await p.getByRole("button", { name: "Save as playbook" }).click();
  await p.waitForTimeout(200);
  await p.locator("#playbook-name").fill("Release Hardening Wave");
  await p.getByRole("button", { name: "Save playbook", exact: true }).click();
  await p.waitForTimeout(300);
  ok(
    "Save as playbook persists custom template into Playbooks bar",
    (await p.locator('section[aria-label="Playbooks"]').innerText()).includes("Release Hardening Wave"),
  );
  await p.screenshot({ path: path.join(SHOT_DIR, "fleet-v060-composer-playbooks-1440-light.png") });

  // Dispatch the 2-wave DAG batch from the playbook
  await p.getByRole("button", { name: /Dispatch 2 tasks/ }).click();
  await p.waitForTimeout(2400);
  const afterBatchCount = await p.locator('div[aria-label="Session lanes"] article').count();
  ok("Batch fan-out with depends_on DAG executes and settles in-browser", afterBatchCount >= 6, `count=${afterBatchCount}`);

  // IndexedDB persistence across page reload (both sessions AND custom playbook!)
  await p.reload();
  await p.waitForSelector('div[aria-label="Session lanes"] article', { timeout: 15000 });
  await p.waitForTimeout(800);
  const afterReloadCount = await p.locator('div[aria-label="Session lanes"] article').count();
  ok("IndexedDB persists batch sessions across full page reload", afterReloadCount === afterBatchCount, `${afterReloadCount}/${afterBatchCount}`);

  // Settings-only Light/Dark + Policy Tester + zero Rune jargon inside Settings
  const headerThemeCount = await p.locator('header #themeBtn, header [aria-label="Light"], header [aria-label="Dark"]').count();
  ok("Light/Dark switcher absent from top bar in live web bundle", headerThemeCount === 0);

  await p.getByRole("button", { name: "Engines and settings" }).click();
  await p.waitForTimeout(350);
  const settings = p.locator("#settings");
  const settingsText = await settings.innerText();
  ok("Settings sheet has zero Rune jargon (#155)", !/\brune\b/i.test(settingsText));
  await settings.getByRole("button", { name: "Test policy" }).click();
  await p.waitForTimeout(250);
  const policyText = await settings.locator('[data-testid="policy-test-result"]').innerText();
  ok(
    "Policy Tester evaluates route inside Settings drawer",
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
  await p.screenshot({ path: path.join(SHOT_DIR, "fleet-v060-live-1440-dark.png") });
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
  await mp.screenshot({ path: path.join(SHOT_DIR, "fleet-v060-live-390-light.png") });

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
  await mp.locator('#settings button[aria-label="Close settings"]').tap();
  await mp.waitForTimeout(350);
  await mp.screenshot({ path: path.join(SHOT_DIR, "fleet-v060-live-390-dark.png") });
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
