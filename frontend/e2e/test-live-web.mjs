// test-live-web.mjs: Comprehensive end-to-end verification of the standalone v0.9.0 browser-only
// live web bundle (dist-live-web/index.html) across desktop 1440x900 and mobile 390x844
// in both Light and Dark themes.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright-core";

const BUNDLE =
  process.env.LIVE_WEB_FILE ||
  path.resolve(import.meta.dirname, "../../dist-live-web/index.html");
const SHOT_DIR =
  process.env.SHOT_DIR ||
  path.resolve(import.meta.dirname, ".out/live-web-shots");
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
  const docTitle = await p.title();
  const verHref = (await p.locator('header a[href*="/releases/tag/"]').first().getAttribute("href")) || "";
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
    "Fleet v0.9.0 rebrand clean: zero dsh-fleet, DeepSeek Harness, or fleet-rs strings on board/title/release URL",
    !/\bdsh[-_ ]?fleet\b|deepseek\s+harness|\bfleet-rs\b/i.test(`${docTitle}\n${bodyText}\n${verHref}`) &&
      verHref.includes("cayleb-james2008/fleet/releases/tag/v0.9.0"),
    `title=${docTitle} href=${verHref}`,
  );
  ok(
    "initial 4 real browser worktree sessions settle with concurrency slots indicator",
    (await p.locator('div[aria-label="Session lanes"] article').count()) >= 4 &&
      (await p.locator('[data-testid="concurrency-indicator"]').isVisible()),
  );

  const metricsStrip = p.locator('[data-testid="board-metrics-strip"]');
  const metricsText = await metricsStrip.innerText();
  const autoHealedCount = Number.parseInt(await p.locator('[data-testid="metric-auto-healed"]').innerText(), 10);
  ok(
    "Bottom metrics bar renders First-pass %, Auto-healed count, Median check, Active/Max, and Daily budget",
    metricsText.includes("First-pass") &&
      metricsText.includes("Median check") &&
      metricsText.includes("0 / 4") &&
      metricsText.includes("4 / 50") &&
      autoHealedCount >= 1,
    `autoHealed=${autoHealedCount}`,
  );

  const overflow1440 = await p.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  ok("1440 desktop has 0px horizontal overflow", overflow1440 <= 0, `overflow=${overflow1440}`);

  // Switch to interactive Multi-Wave DAG Graph view -> verify SVG edges + waves + click node -> Workbench
  await p.locator('[data-testid="view-toggle-dag"]').click();
  await p.waitForTimeout(300);
  const dagNodes = await p.locator('[data-testid="dag-node"]').count();
  const dagEdges = await p.locator('[data-testid="dag-edge"]').count();
  const dagOverflow = await p.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  await p.locator('[data-testid="dag-node"][data-session-id="s-002"]').click();
  await p.waitForTimeout(350);
  const inspector = p.locator('aside[aria-label="Session inspector"]');
  ok(
    "DAG Graph view renders 2+ waves, directed SVG arrows, 0px page overflow, and opens session on node click",
    dagNodes >= 4 && dagEdges >= 1 && dagOverflow <= 0 && (await inspector.isVisible()),
    `nodes=${dagNodes} edges=${dagEdges} overflow=${dagOverflow}`,
  );
  ok(
    "opening auto-healed session from DAG node shows Healed on attempt 1/2 pill",
    (await inspector.locator('[data-testid="inspector-heal-badge"]').innerText()).includes("Healed on attempt 1/2"),
  );

  // Open PR Preview modal from Inspector -> verify Markdown + confirmation gate + dry-run submit
  await inspector.locator('[data-testid="open-pr-preview"]').click();
  await p.waitForTimeout(300);
  const prModal = p.locator('[data-testid="pr-preview-modal"]');
  const prBodyVal = await prModal.locator("#pr-preview-body").inputValue();
  const prDisabledBefore = await prModal.locator('[data-testid="pr-submit-btn"]').isDisabled();
  await prModal.locator("#pr-confirm-checkbox").check();
  await p.waitForTimeout(100);
  const prEnabledAfter = await prModal.locator('[data-testid="pr-submit-btn"]').isEnabled();
  await prModal.locator('[data-testid="pr-submit-btn"]').click();
  await p.waitForTimeout(250);
  const prStatusText = await prModal.locator('[data-testid="pr-create-status"]').innerText();
  ok(
    "PR Preview modal renders generated Markdown, enforces confirmation gate, and submits confirm=true",
    prBodyVal.includes("## Verification") &&
      prBodyVal.includes("## Auto-Heal Timeline") &&
      prDisabledBefore &&
      prEnabledAfter &&
      prStatusText.includes("Dry-run PR verified"),
    `disabledBefore=${prDisabledBefore}`,
  );
  await p.keyboard.press("Escape");
  await p.waitForTimeout(250);

  // Receipt tab with keyboard 'r' -> Auto-Heal Timeline + Multi-Step Check Timeline
  await p.keyboard.press("r");
  await p.waitForTimeout(300);
  const healTimeline = p.locator('main [data-testid="auto-heal-timeline"]');
  await healTimeline.getByRole("button", { name: /Diagnostic steer prompt for attempt 1/ }).click();
  await p.waitForTimeout(200);
  const healText = await healTimeline.innerText();
  const stepCount = await p.locator('main ol[aria-label="Check pipeline steps"] > li').count();
  ok(
    "Receipt view renders Auto-Heal Attempt Timeline (steer prompt + healed badge) and 2-step check timeline",
    healText.includes("Auto-heal attempt 1/2") && stepCount >= 2 && (await p.locator("details").count()) === 0,
    `steps=${stepCount}`,
  );

  // Diff tab with keyboard 'd' -> Split diff zero cross-column bleed + .patch download
  await p.keyboard.press("d");
  await p.waitForTimeout(300);
  const diffViewer = p.locator('main [data-testid="rich-diff-viewer"]');
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
  ok("keyboard t switches to Virtualized Transcript", await p.locator('main [data-testid="virtualized-transcript"]').isVisible());

  // 1-click Goal-to-DAG planner in browser engine
  await p.locator('[data-testid="open-launchpad"]').click();
  await p.waitForTimeout(200);
  await p.locator("#launchpad-goal").fill("Add negative entry guard; then run unit checks");
  await p.locator('[data-testid="goal-launchpad"]').getByRole("button", { name: "Plan DAG" }).click();
  await p.waitForTimeout(300);
  ok("Goal-to-DAG plans multi-wave tasks via /api/plan inside browser engine", await p.locator('[data-testid="planned-dag-preview"]').isVisible());

  // Open Cmd+K Command Palette -> verify Playbooks & DAG action -> launch Two-Wave DAG Rollout playbook
  await p.keyboard.press("Control+k");
  await p.waitForTimeout(250);
  const cmdkText = await p.locator("[cmdk-root]").innerText();
  ok(
    "Ctrl+K opens Global Command Palette with DAG Graph switch, PR preview, and Playbooks group",
    cmdkText.includes("Switch to DAG Graph view") &&
      cmdkText.includes("PR preview") &&
      cmdkText.includes("Two-Wave DAG Rollout"),
  );

  await p.locator("[cmdk-input]").fill("Two-Wave DAG Rollout");
  await p.waitForTimeout(150);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(450);

  const batchTask0Val = await p.locator("#batch-task-0").inputValue();
  ok("Selecting Two-Wave DAG Rollout playbook pre-populates Batch DAG composer", batchTask0Val.includes("Wave 1"));

  await p.getByRole("button", { name: "Save as playbook" }).click();
  await p.waitForTimeout(200);
  await p.locator("#playbook-name").fill("Release Hardening Wave");
  await p.getByRole("button", { name: "Save playbook", exact: true }).click();
  await p.waitForTimeout(300);
  ok(
    "Save as playbook persists custom template into Playbooks bar",
    (await p.locator('section[aria-label="Playbooks"]').innerText()).includes("Release Hardening Wave"),
  );

  await p.getByRole("button", { name: /Dispatch 2 tasks/ }).click();
  await p.waitForTimeout(2400);
  const afterBatchCount = await p.locator('div[aria-label="Session lanes"] article').count();
  ok("Batch fan-out with depends_on DAG executes and settles in-browser", afterBatchCount >= 6, `count=${afterBatchCount}`);

  // IndexedDB persistence across page reload
  await p.reload();
  await p.waitForSelector('div[aria-label="Session lanes"] article', { timeout: 15000 });
  await p.waitForTimeout(800);
  const afterReloadCount = await p.locator('div[aria-label="Session lanes"] article').count();
  ok("IndexedDB persists batch sessions across full page reload", afterReloadCount === afterBatchCount, `${afterReloadCount}/${afterBatchCount}`);

  // Settings-only Light/Dark + Budget Guardrails + Worktrees Inspector + Policy Tester + zero Rune jargon
  const headerThemeCount = await p.locator('header #themeBtn, header [aria-label="Light"], header [aria-label="Dark"]').count();
  ok("Light/Dark switcher absent from top bar in live web bundle (#67)", headerThemeCount === 0);

  await p.getByRole("button", { name: "Engines and settings" }).click();
  await p.waitForTimeout(350);
  const settings = p.locator("#settings");
  const settingsText = await settings.innerText();
  ok(
    "Settings sheet has zero Rune jargon and zero legacy branding",
    !/\brune\b|\bdsh[-_ ]?fleet\b|deepseek\s+harness|\bfleet-rs\b/i.test(settingsText),
  );

  const budgetText = await settings.locator('[data-testid="budget-guardrails"]').innerText();
  ok(
    "Budget Guardrails shows live daily usage and limits inside Settings",
    budgetText.includes("6 / 50") && budgetText.includes("30 min") && budgetText.includes("2 / run"),
  );

  const orphanRowsBefore = await settings.locator('[data-testid="worktree-row"][data-orphan="true"]').count();
  await settings.locator('[data-testid="worktree-row"][data-orphan="true"] [data-testid="worktree-prune-btn"]').first().click();
  await p.waitForTimeout(150);
  await settings.locator('[data-testid="worktree-confirm-prune"]').click();
  await p.waitForTimeout(300);
  const orphanRowsAfter = await settings.locator('[data-testid="worktree-row"][data-orphan="true"]').count();
  ok(
    "Worktrees Inspector detects orphan worktree and prunes it via DELETE /api/repos/worktrees",
    orphanRowsBefore === 1 && orphanRowsAfter === 0,
    `orphans=${orphanRowsBefore}->${orphanRowsAfter}`,
  );

  await settings.getByRole("button", { name: "Test policy" }).click();
  await p.waitForTimeout(250);
  const policyText = await settings.locator('[data-testid="policy-test-result"]').innerText();
  ok(
    "Policy Tester evaluates route inside Settings drawer",
    policyText.includes("Routed engine") && policyText.includes("policies.rn"),
  );

  await settings.getByRole("button", { name: "Dark", exact: true }).click();
  await p.waitForTimeout(250);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(250);
  const darkAttr = await p.evaluate(() => document.documentElement.dataset.theme);
  ok("Dark theme activates from Settings drawer", darkAttr === "dark");
  await ctx.close();

  // Real Mobile 390x844 Settings Tap Test
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
  await mp.waitForTimeout(350);
  await mp.locator("#settings").getByRole("button", { name: "Dark", exact: true }).tap();
  await mp.waitForTimeout(300);
  const mThemeDark = await mp.evaluate(() => document.documentElement.dataset.theme);
  const lumDark = await bgLum();
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
