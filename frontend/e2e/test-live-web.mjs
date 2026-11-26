// End-to-end verification of standalone `dist-live-web/index.html` (offline single-file demo).
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { CHROME_LAUNCH_OPTS } from "./fixture.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const LIVE_HTML = path.join(ROOT, "dist-live-web/index.html");

const srv = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(LIVE_HTML));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const browser = await chromium.launch(CHROME_LAUNCH_OPTS);
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
  if (msg.type() === "error" && !msg.text().includes("status of 409")) consoleErrs.push(msg.text());
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

await check("loads simulated Antigravity swarm, Token Burn, and Gate Readiness Next-Gate Action in 380px sidebar", async () => {
  const txt = await page.locator("#panel-triage").textContent();
  const burn = await page.locator('#panel-triage [data-testid="token-burn-strip"]').textContent();
  const card = page.locator('#panel-triage [data-testid="gate-readiness-card"]');
  const gateTxt = await card.textContent();
  const velTxt = await card.locator('[data-testid="wave-velocity-pill"]').textContent();
  const recTxt = await page.locator('#panel-triage [data-testid="worker-recovery-strip"]').textContent();
  await card.locator('[data-testid="gate-next-action"]').click();
  const prefilled = await card.locator("#gate-next-nudge").inputValue();
  await card.locator('button:has-text("Cancel")').click();
  return txt.includes("Needs you") && txt.includes("builder asked a question") && burn.includes("Token burn") && /\d+%/.test(burn) && gateTxt.includes("Gate readiness") && /\d+% pass/.test(velTxt || "") && Boolean(recTxt?.includes("verifier")) && prefilled.includes("Re #");
});

await check("plan.json goal & humanized workstreams visible", async () => {
  const txt = await page.locator("#panel-triage").textContent();
  return txt.includes("Deliver native aux-pane Swarm Command Center") && txt.includes("In progress");
});

await check("Roster & Triage show masked 1-line activityPeek for working and waiting workers", async () => {
  await page.waitForSelector('[data-testid="triage-activity-peek-verifier"]');
  const tPeek = await page.locator('[data-testid="triage-activity-peek-verifier"]').textContent();
  await page.locator("#tab-roster").click();
  const rBuilder = await page.locator('[data-testid="roster-activity-peek-builder"]').textContent();
  const rUi = await page.locator('[data-testid="roster-activity-peek-ui-dev"]').textContent();
  await page.locator("#tab-triage").click();
  return (
    tPeek.includes("waiting:") &&
    tPeek.includes("~/workspace/fleet-ui") &&
    !tPeek.includes("/home/") &&
    rBuilder.includes("waiting: Run unit and security tests") &&
    rUi.includes("working: Polishing 380px sidebar responsive grid")
  );
});

await check("Geist woff2 fonts embedded & loaded with zero network font requests", async () => {
  return await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.size >= 2;
  });
});

// Send confirmed nudge to builder right inside Triage
await page.locator('#panel-triage button:text-is("Nudge")').first().click();
await page.locator('#panel-triage button:has-text("Confirm & send")').click();
await page.waitForTimeout(150);

await check("confirmed nudge posts live message to Board feed", async () => {
  await page.locator("#tab-board").click();
  const txt = await page.locator("#panel-board").textContent();
  return txt.includes("Vary: Accept-Encoding");
});

await check("Board #seq pill, Pin #seq, & agent filter work", async () => {
  await page.locator('button[aria-label="Pin #4"]').click();
  const pinnedOk = (await page.locator("#panel-board").textContent()).includes("Pinned (1)");
  await page.locator('#panel-board button[aria-label="Toggle board filters"]').click();
  await page.locator("#panel-board").getByRole("button", { name: "ui-dev", exact: true }).click();
  const txt = await page.locator("#panel-board").textContent();
  return pinnedOk && txt.includes("Adapting Needs-You triage cards");
});

await check("Roster shows live token totals, shimmering activity, and confirmed Broadcast", async () => {
  await page.locator("#tab-roster").click();
  const txt = await page.locator("#panel-roster").textContent();
  if (!txt.includes("Polishing 380px sidebar responsive grid") || !txt.includes("46.5k tok")) return false;
  await page.locator('[data-testid="toggle-broadcast"]').click();
  const box = page.locator('[data-testid="broadcast-composer"]');
  await box.locator("textarea").fill("@all Wave sync check");
  await box.locator('[data-testid="composer-submit"]').click();
  await page.waitForTimeout(150);
  await page.locator("#tab-board").click();
  const boardTxt = await page.locator("#panel-board").textContent();
  return boardTxt.includes("Wave sync check");
});

await check("Graph renders nodes/edges and toggles", async () => {
  await page.locator("#tab-graph").click();
  return (await page.locator("#panel-graph svg g").count()) >= 4;
});

await check("Worktrees shows simulated branch dirtiness, collisions banner, mergeability, and commits", async () => {
  await page.locator("#tab-worktrees").click();
  await page.waitForSelector('[data-testid="worktree-collisions-banner"]');
  const txt = await page.locator("#panel-worktrees").textContent();
  const bannerTxt = await page.locator('[data-testid="worktree-collisions-banner"]').textContent();
  return (
    txt.includes("lane/sidebar-ui") &&
    txt.includes("4 changed") &&
    txt.includes("Ready to land") &&
    txt.includes("Uncommitted edits") &&
    txt.includes("Merge clean") &&
    txt.includes("Dirty tree") &&
    txt.includes("@builder") &&
    txt.includes("@ui-dev") &&
    txt.includes("ui: wire worktree operator controls") &&
    Boolean(bannerTxt?.includes("frontend/src/sidecar.ts")) &&
    Boolean(bannerTxt?.includes("lane/sidecar-backend")) &&
    Boolean(bannerTxt?.includes("lane/sidebar-ui"))
  );
});

await check("Worktrees toggles Working Changes vs Branch Diff and loads branch diff", async () => {
  await page.locator('[data-testid="wt-diff-mode-branch-lane/sidebar-ui"]').click();
  await page.locator('[data-testid="wt-card-lane/sidebar-ui"] button[aria-label="Diff peek frontend/src/types.ts"]').click();
  await page.waitForSelector('[data-testid="wt-card-lane/sidebar-ui"] pre');
  const cardTxt = await page.locator('[data-testid="wt-card-lane/sidebar-ui"]').textContent();
  await page.locator('[data-testid="wt-diff-mode-working-lane/sidebar-ui"]').click();
  const workingTxt = await page.locator('[data-testid="wt-card-lane/sidebar-ui"]').textContent();
  return Boolean(cardTxt?.includes("committed on branch")) && Boolean(workingTxt?.includes("WorktreesView.tsx"));
});

await check("Worktrees Dry-Run Merge & Rebase surface conflicts and FF Merge + Remove Clean work", async () => {
  await page.locator('[data-testid="wt-action-dry-run-lane/sidebar-ui"]').click();
  await page.waitForSelector('[data-testid="wt-action-conflicts-lane/sidebar-ui"]');
  const dryTxt = await page.locator('[data-testid="wt-action-result-lane/sidebar-ui"]').textContent();

  await page.locator('[data-testid="wt-action-rebase-lane/sidebar-ui"]').click();
  await page.locator('[data-testid="wt-confirm-submit-lane/sidebar-ui"]').click();
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="wt-action-result-lane/sidebar-ui"]')?.textContent || "").includes("Rebase hit conflict"),
  );
  const rebaseTxt = await page.locator('[data-testid="wt-action-result-lane/sidebar-ui"]').textContent();

  await page.locator('[data-testid="wt-action-ff-merge-lane/sidecar-backend"]').click();
  await page.locator('[data-testid="wt-confirm-submit-lane/sidecar-backend"]').click();
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="wt-action-result-lane/sidecar-backend"]')?.textContent || "").includes("Fast-forward merged"),
  );

  await page.locator('[data-testid="wt-action-remove-lane/sidecar-backend"]').click();
  await page.locator('[data-testid="wt-confirm-submit-lane/sidecar-backend"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="wt-card-lane/sidecar-backend"]'));

  const overflow380 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  return (
    Boolean(dryTxt?.includes("Dry-run merge detected conflicting changes") && dryTxt.includes("frontend/src/sidecar.ts")) &&
    Boolean(rebaseTxt?.includes("Rebase hit conflict and was aborted cleanly") && rebaseTxt.includes("frontend/src/sidecar.ts")) &&
    overflow380 <= 0
  );
});

await check("Multi-Swarm Switcher switches to secondary audit swarm", async () => {
  await page.selectOption('select[aria-label="Active swarm"]', "demo-audit-0009");
  await page.locator("#tab-board").click();
  const txt = await page.locator("#panel-board").textContent();
  return txt.includes("All traversal, symlink, and loopback checks passed");
});

await check("Triage Copy Handoff Digest & SSE Resync banner work cleanly offline", async () => {
  await page.locator("#tab-triage").click();
  await page.evaluate(() => {
    window.__lwHandoff = "";
    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (t) => { window.__lwHandoff = String(t); } },
      });
    } catch {}
  });
  await page.locator('[data-testid="copy-handoff-digest"]').click();
  await page.waitForFunction(() => Boolean(window.__lwHandoff));
  const clip = await page.evaluate(() => window.__lwHandoff);
  await page.locator('button[aria-label="Open settings"]').click();
  await page.locator('div[role="dialog"] button[role="radio"]:has-text("Paused")').click();
  await page.locator('button[aria-label="Close dialog"]').click();
  await page.waitForSelector('[data-testid="sse-resync-banner"]');
  await page.locator('[data-testid="sse-resync-btn"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="sse-resync-banner"]'));
  return clip.includes("Handoff Digest") && clip.includes("- Active goal:") && !clip.includes("/home/");
});

await check("Full Swarm Archive Export (.md and .json) works offline without /home/ leaks", async () => {
  const readDl = async (selector) => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(selector).click()]);
    const chunks = [];
    for await (const c of await dl.createReadStream()) chunks.push(c);
    return { name: dl.suggestedFilename(), body: Buffer.concat(chunks).toString("utf8") };
  };
  const md = await readDl('[data-testid="export-archive-md"]');
  const js = await readDl('[data-testid="export-archive-json"]');
  const parsed = JSON.parse(js.body);
  return (
    md.name.endsWith(".md") &&
    md.body.includes("## Full Board Transcript") &&
    !md.body.includes("/home/") &&
    js.name.endsWith(".json") &&
    parsed.schema === "fleet.swarm-archive.v1" &&
    parsed.messages.length >= 1 &&
    !js.body.includes("/home/")
  );
});

await check("Native plan.json {goal:{title,line},tasks,threads} and narrator view.json render without crash or /home/ leaks", async () => {
  await page.selectOption('select[aria-label="Active swarm"]', "demo-native-0011");
  await page.locator("#tab-triage").click();
  await page.waitForSelector('[data-testid="narrator-view-card"]');
  const txt = await page.locator("#panel-triage").textContent();
  await page.evaluate(() => {
    window.__nativeClip = "";
    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (t) => { window.__nativeClip = String(t); } },
      });
    } catch {}
  });
  await page.locator('[data-testid="copy-handoff-digest"]').click();
  await page.waitForFunction(() => Boolean(window.__nativeClip));
  const clip = await page.evaluate(() => window.__nativeClip);
  return (
    txt.includes("Native Plan Schema Support") &&
    txt.includes("Render native goal.{title,line}, tasks, threads, and narrator view.json cleanly.") &&
    txt.includes("Plan Normalization Thread") &&
    txt.includes("@api-worker") &&
    txt.includes("~/fleet") &&
    txt.includes("Narrator tracking native plan normalization") &&
    txt.includes("Executing") &&
    txt.includes("~/swarm_store.mjs") &&
    txt.includes("Confirm native schema compatibility before merge") &&
    !txt.includes("/home/") &&
    clip.includes("- Active goal: Render native goal.{title,line}") &&
    !clip.includes("/home/")
  );
});

await check("Live Plan Editor handles 409 conflict reload and persists goal, workstream, and coordinator notify at 380px", async () => {
  await page.locator('[data-testid="edit-plan-btn"]').click();
  await page.waitForSelector('[data-testid="plan-editor"]');

  // Simulate concurrent plan mutation on server so editor holds stale ifMatch etag
  await page.evaluate(async () => {
    await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: true,
        conversationId: "demo-native-0011",
        ifMatch: "plan-v1",
        mode: "patch",
        patch: {
          goalTitle: "Native Plan Schema Support",
          goalLine: "Concurrent disk goal update",
          goal: "Concurrent disk goal update",
        },
      }),
    });
  });

  await page.locator('[data-testid="plan-save-btn"]').click();
  await page.waitForSelector('[data-testid="plan-conflict-banner"]');
  await page.locator('[data-testid="plan-conflict-reload"]').click();
  const reloadedVal = await page.locator('[data-testid="plan-goal-input"]').inputValue();
  if (reloadedVal !== "Concurrent disk goal update") return false;

  await page.fill('[data-testid="plan-goal-input"]', "Persisted live plan edit");
  await page.locator('[data-testid="plan-add-workstream"]').click();
  await page.fill('[data-testid="plan-ws-title-0"]', "Verify live plan CAS write");
  await page.fill('[data-testid="plan-ws-owner-0"]', "ui-worker");
  await page.selectOption('[data-testid="plan-ws-status-0"]', "done");
  await page.check('[data-testid="plan-notify-coord"]');
  await page.locator('[data-testid="plan-save-btn"]').click();
  await page.waitForSelector('[data-testid="swarm-plan-card"]');
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="swarm-plan-card"]')?.textContent || "").includes("Persisted live plan edit"),
  );
  const triageTxt = await page.locator("#panel-triage").textContent();
  const overflow380 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  await page.locator("#tab-board").click();
  const boardTxt = await page.locator("#panel-board").textContent();
  await page.locator("#tab-triage").click();

  return (
    triageTxt.includes("Persisted live plan edit") &&
    triageTxt.includes("Verify live plan CAS write") &&
    triageTxt.includes("Done") &&
    boardTxt.includes("Plan updated: Persisted live plan edit") &&
    overflow380 <= 0
  );
});

await check("Board channel tabs, replyRefs backlinks, and sticky Board Composer post live", async () => {
  await page.selectOption('select[aria-label="Active swarm"]', "demo-coord-0001");
  await page.locator("#tab-board").click();
  await page.waitForSelector('[data-testid="board-channel-tabs"]');
  await page.locator('[data-testid="channel-tab-backend"]').click();
  const backendOnly = await page.locator("#panel-board").textContent();
  await page.locator('[data-testid="channel-tab-all"]').click();

  const refTxt = await page.locator('[data-testid="board-reply-refs-2"]').textContent();
  await page.locator('[data-testid="board-reply-refs-2"] button').first().click();

  await page.locator('[data-testid="board-composer-open"]').click();
  await page.selectOption('[data-testid="board-composer-channel"]', "backend");
  await page.fill('[data-testid="board-composer-reply-seq"]', "2");
  await page.fill('[data-testid="board-composer-input"]', "Live web channel post");
  await page.locator('[data-testid="board-composer-stage"]').click();
  await page.locator('[data-testid="board-composer-submit"]').click();
  await page.waitForFunction(() => (document.querySelector("#panel-board")?.textContent || "").includes("Live web channel post"));

  return (
    Boolean(backendOnly?.includes("CWE-22/59 frame confinement") && !backendOnly.includes("Adapting Needs-You")) &&
    Boolean(refTxt?.includes("#3"))
  );
});

await check("New Swarm Launcher & Command Palette actions work at 360px with 0px overflow", async () => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.locator('[data-testid="open-swarm-launcher"]').click();
  await page.waitForSelector('[data-testid="swarm-launcher-modal"]');
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.locator('button[aria-label="Close dialog"]').click();

  await page.locator('button[aria-label="Open command palette"]').click();
  await page.waitForSelector("[cmdk-input]");
  await page.fill("[cmdk-input]", "Spawn worker");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="spawn-worker-drawer"]');

  await page.fill('[data-testid="spawn-worker-name"]', "qa-check");
  await page.selectOption('[data-testid="spawn-worker-workspace"]', "share");
  await page.selectOption('[data-testid="spawn-worker-channel"]', "backend");
  await page.fill('[data-testid="spawn-worker-brief"]', "Run live-web parity checks");
  await page.locator('[data-testid="spawn-worker-submit"]').click();
  await page.waitForFunction(() => (document.querySelector("#panel-roster")?.textContent || "").includes("qa-check"));

  await page.locator('[data-testid="kill-worker-btn-ui-dev"]').click();
  await page.locator('[data-testid="kill-worker-submit-ui-dev"]').click();
  await page.waitForSelector('[data-testid="kill-worker-409-ui-dev"]');
  const warn409 = await page.locator('[data-testid="kill-worker-409-ui-dev"]').textContent();
  await page.locator('[data-testid="kill-worker-force-ui-dev"]').click();
  await page.waitForFunction(() => !(document.querySelector('[data-testid="kill-worker-btn-ui-dev"]')));

  await page.setViewportSize({ width: 380, height: 900 });
  return ov <= 0 && Boolean(warn409?.includes("4 dirty files, 2 commits ahead"));
});

await check("Quota card 1-click Switch Model clears failure on audit swarm", async () => {
  await page.selectOption('select[aria-label="Active swarm"]', "demo-audit-0009");
  await page.locator("#tab-roster").click();
  await page.waitForSelector('[data-testid="switch-model-btn-scanner"]');
  await page.locator('[data-testid="switch-model-btn-scanner"]').click();
  await page.locator('[data-testid="switch-model-submit-scanner"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="switch-model-drawer-scanner"]'));
  const txt = await page.locator("#panel-roster").textContent();
  return txt.includes("gemini-3-flash") && !txt.includes("429 RESOURCE_EXHAUSTED");
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
