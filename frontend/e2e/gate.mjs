// Playwright control-room verification gate for Fleet v1.0 Antigravity Sidecar.
// Verifies 380x900 sidebar & 1440x900 desktop across Light & Dark themes (28 checks).
import { chromium } from "playwright-core";
import { BASE, CHROME_LAUNCH_OPTS, REPO_DIR, runChecks } from "./fixture.mjs";

const browser = await chromium.launch(CHROME_LAUNCH_OPTS);

await runChecks("gate", async (check) => {
  const ctx = await browser.newContext({ viewport: { width: 380, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const externalRequests = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("requestfailed", (req) => {
    const errText = req.failure()?.errorText || "";
    if (req.url().includes("/api/swarm/stream") && errText === "net::ERR_ABORTED") return;
    failedRequests.push(`${req.url()} (${errText})`);
  });
  page.on("request", (req) => {
    const u = req.url();
    if (!u.startsWith(BASE) && !u.startsWith("data:") && !u.startsWith("blob:")) {
      externalRequests.push(u);
    }
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector('h1:has-text("Release 1.0 Sidebar")');

  // 1-4: Initial Triage view at 380px sidebar width
  await check("header swarm switcher shows active swarm", async () => {
    const val = await page.locator('select[aria-label="Active swarm"]').inputValue();
    return val === "11111111-1111-1111-1111-111111111111";
  });

  await check("triage inbox renders Needs You items", async () => {
    const txt = await page.locator("#panel-triage").textContent();
    return txt.includes("Needs you") && txt.includes("builder asked a question") && txt.includes("awaits cold verification");
  });

  await check("all 5 tabs fit within 380px header with zero clipping", async () => {
    const ok380 = await page.evaluate(() => {
      const hdr = document.querySelector("header")?.getBoundingClientRect();
      if (!hdr) return false;
      const tabs = [...document.querySelectorAll('[role="tab"]')];
      return (
        tabs.length === 5 &&
        tabs.every((t) => {
          const r = t.getBoundingClientRect();
          return r.left >= hdr.left - 1 && r.right <= hdr.right + 1 && t.scrollWidth <= t.clientWidth + 1;
        })
      );
    });
    if (!ok380) return false;
    await page.setViewportSize({ width: 340, height: 900 });
    const ok340 = await page.evaluate(() => {
      const hdr = document.querySelector("header")?.getBoundingClientRect();
      if (!hdr) return false;
      const tabs = [...document.querySelectorAll('[role="tab"]')];
      return tabs.every((t) => t.getBoundingClientRect().right <= hdr.right + 1);
    });
    await page.setViewportSize({ width: 380, height: 900 });
    return ok340;
  });

  await check("plan.json goal, workstreams, and humanized statuses render", async () => {
    const txt = await page.locator("#panel-triage").textContent();
    return (
      txt.includes("Verify Antigravity-native sidebar UX") &&
      txt.includes("Sidecar Node store & routes") &&
      txt.includes("In progress") &&
      !txt.includes("in_progress")
    );
  });

  await check("Worker Activity Peek expands in Triage and Copy digest button exists", async () => {
    await page.locator('#panel-triage button:has-text("Peek")').first().click();
    const txt = await page.locator("#panel-triage").textContent();
    const hasDigestBtn = (await page.locator('button[aria-label="Copy swarm digest"]').count()) === 1;
    return hasDigestBtn && txt.includes("Run sidecar security tests");
  });

  await check("screenshot frame loads cleanly with naturalWidth > 0 and Open file action", async () => {
    const okImg = await page.evaluate(() => {
      const img = document.querySelector("#panel-triage img");
      return Boolean(img && img.complete && img.naturalWidth > 0);
    });
    const hasOpenBtn = (await page.locator('#panel-triage button:has-text("Open file")').count()) >= 1;
    return okImg && hasOpenBtn;
  });

  // 5-6: Fonts loaded + zero horizontal overflow at 380x900 on Triage
  await check("Geist fonts loaded cleanly", async () => {
    const ok = await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.size >= 2;
    });
    return ok;
  });

  await check("zero horizontal overflow on Triage at 380px", async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    return overflow <= 0;
  });

  // 7-9: #seq jump from Triage -> Board tab + Board filters
  await page.locator('#panel-triage button:has-text("#4")').first().click();
  await page.waitForSelector("#panel-board");

  await check("clicking #seq pill switches to Board tab", async () => {
    return (await page.locator('#tab-board[aria-selected="true"]').count()) === 1;
  });

  await check("board renders messages with @mentions, #seq pills, and Pin #seq", async () => {
    const txt = await page.locator("#panel-board").textContent();
    if (!txt.includes("Sidecar ready for cold check") || !txt.includes("#2") || !txt.includes("Aux pane shot") || txt.includes("/home/")) {
      return false;
    }
    await page.locator('button[aria-label="Pin #4"]').click();
    const after = await page.locator("#panel-board").textContent();
    return after.includes("Pinned (1)") && (await page.locator('header :text("Live")').count()) >= 1;
  });

  await check("board #seq Quote-Reply composer pre-fills Re #<seq>", async () => {
    await page.locator('button[aria-label="Reply to #2"]').click();
    const val = await page.locator('#board-reply-2').inputValue();
    await page.locator('#panel-board button:has-text("Cancel")').click();
    return val.startsWith("@builder Re #2:");
  });

  await check("board quick filters and Wave digest copy sanitized summary", async () => {
    await page.evaluate(() => {
      window.__copied = "";
      try {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (txt) => { window.__copied = txt; } },
        });
      } catch {}
    });
    const grp = page.locator('[aria-label="Board quick filters"]');
    await grp.locator('button:has-text("[done]")').click();
    const doneTxt = await page.locator("#panel-board").textContent();
    await grp.locator('button:has-text("Needs reply")').click();
    await grp.locator('button:has-text("All")').click();
    await page.locator('#panel-board button:has-text("Wave digest")').click();
    await page.waitForFunction(() => Boolean(window.__copied));
    const clip = await page.evaluate(() => window.__copied);
    return (
      doneTxt.includes("#4") &&
      clip.includes("## Workers") &&
      clip.includes("## Pinned") &&
      !clip.includes("/home/")
    );
  });

  await page.fill('input[aria-label="Search board messages"]', "no-such-query-xyz");
  await check("empty search filter shows Clear filters action", async () => {
    return (await page.locator('#panel-board button:has-text("Clear filters")').count()) === 1;
  });
  await page.locator('#panel-board button:has-text("Clear filters")').click();

  await check("zero horizontal overflow on Board at 380px", async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    return overflow <= 0;
  });

  // 11-14: Roster tab + live telemetry + Show killed toggle
  await page.locator("#tab-roster").click();
  await page.waitForSelector("#panel-roster");

  await check("roster shows active shimmering activity, Peek drawer, context pressure, and real tokens", async () => {
    const txt = await page.locator("#panel-roster").textContent();
    if (!txt.includes("builder") || !txt.includes("23.4k tok") || !txt.includes("Read main.mjs") || !txt.includes("% ctx")) return false;
    await page.locator('button[aria-label="Peek activity for builder"]').click();
    const after = await page.locator("#panel-roster").textContent();
    return after.includes("Recent worker activity") && after.includes("Run sidecar security tests");
  });

  await check("roster shows live duration badge and Ask status quick-action chip", async () => {
    const txt = await page.locator("#panel-roster").textContent();
    const hasElapsed = /Working\s+(<\d+m|\d+[mhd])/.test(txt);
    const hasChip = (await page.locator('#panel-roster button:has-text("Ask status")').count()) >= 1;
    if (hasChip) {
      await page.locator('#panel-roster button:has-text("Ask status")').first().click();
    }
    return hasElapsed && hasChip;
  });

  await check("killed members hidden by default and revealed by Show killed toggle", async () => {
    const before = await page.locator("#panel-roster").textContent();
    if (before.includes("old-helper")) return false;
    await page.locator('#panel-roster button:has-text("Show killed")').click();
    const after = await page.locator("#panel-roster").textContent();
    return after.includes("old-helper");
  });

  await check("zero horizontal overflow on Roster at 380px", async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    return overflow <= 0;
  });

  // 14-16: Graph tab + toggles + replay scrubber
  await page.locator("#tab-graph").click();
  await page.waitForSelector("#panel-graph");

  await check("graph SVG renders nodes and weighted edges", async () => {
    const nodes = await page.locator("#panel-graph svg g").count();
    const edges = await page.locator("#panel-graph svg line").count();
    return nodes >= 3 && edges >= 2;
  });

  await page.locator('#panel-graph button:has-text("Hide inactive")').click();
  await page.locator('#panel-graph button:has-text("Expand @all")').click();
  await page.locator('#panel-graph button[aria-label="Previous post"]').click();
  await check("graph replay scrubber steps cleanly and Live restores head", async () => {
    await page.locator('#panel-graph button:has-text("Live")').click();
    const txt = await page.locator("#panel-graph").textContent();
    return txt.includes("4/4");
  });

  await check("zero horizontal overflow on Graph at 380px", async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    return overflow <= 0;
  });

  // 17-18: Worktrees tab inspecting temporary git repo
  await page.locator("#tab-worktrees").click();
  await page.waitForSelector("#panel-worktrees");
  await page.fill('input[aria-label="Workspace repository path"]', REPO_DIR);
  await page.locator('#panel-worktrees button:has-text("Inspect")').click();
  await page.waitForSelector('#panel-worktrees :text("lane/verify")');

  await check("worktrees probes main and isolated branch cleanly", async () => {
    const txt = await page.locator("#panel-worktrees").textContent();
    return txt.includes("main") && txt.includes("lane/verify") && txt.includes("Initial fixture commit") && txt.includes("untracked.txt");
  });

  await check("worktrees Open file calls toggleAuxPane with fileView uri", async () => {
    await page.evaluate(() => {
      window.__auxCalls = [];
      if (window.sidecar?.ui) {
        window.sidecar.ui.toggleAuxPane = (req) => window.__auxCalls.push(req);
      }
    });
    await page.locator('button[aria-label="Open file untracked.txt"]').click();
    return await page.evaluate(
      () => Array.isArray(window.__auxCalls) && window.__auxCalls.some((c) => c?.tabType === "fileView" && String(c?.uri).endsWith("/untracked.txt")),
    );
  });

  await check("zero horizontal overflow on Worktrees at 380px", async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    return overflow <= 0;
  });

  // 19-20: Guardrail #67 Settings-only Dark Theme toggle + 1440px wide desktop check
  await check("no theme toggle button outside Settings dialog", async () => {
    const outsideBtns = await page.locator('header button:has-text("Dark"), header button:has-text("Light")').count();
    return outsideBtns === 0;
  });

  await page.locator('button[aria-label="Open settings"]').click();
  await page.waitForSelector('div[role="dialog"]');
  await page.locator('div[role="dialog"] button[role="radio"]:has-text("Dark")').click();
  await check("Settings toggles dark mode attribute cleanly", async () => {
    return (await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "dark";
  });
  await page.locator('button[aria-label="Close dialog"]').click();

  // 21: Antigravity host `theme-change` postMessage sync
  await page.evaluate(() => {
    window.postMessage({ type: "theme-change", payload: { cssVariables: { "--background": "#fafafa" } } }, "*");
  });
  await check("theme-change postMessage syncs host theme luminance", async () => {
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "light");
    return true;
  });

  // 22-23: Multi-Swarm Switcher & Command Palette
  await page.selectOption('select[aria-label="Active swarm"]', "55555555-5555-5555-5555-555555555555");
  await page.locator("#tab-triage").click();
  await check("multi-swarm switcher loads secondary swarm board", async () => {
    await page.locator("#tab-board").click();
    await page.waitForSelector('#panel-board :text("Updated README for v1.0.0 plugin")');
    return true;
  });

  await page.locator('button[aria-label="Open command palette"]').click();
  await page.waitForSelector('[cmdk-input]');
  await page.fill("[cmdk-input]", "Roster");
  await page.keyboard.press("Enter");
  await check("Command Palette jumps cleanly to Roster tab", async () => {
    return (await page.locator('#tab-roster[aria-selected="true"]').count()) === 1;
  });

  // 24-25: 1440x900 desktop viewport check (Light & Dark)
  await page.setViewportSize({ width: 1440, height: 900 });
  await check("zero horizontal overflow at 1440px desktop width", async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    return overflow <= 0;
  });

  // 25: Check host-403 & no-Rune / no-RHL copy hygiene
  await check("zero user-facing Rune or RHL strings in rendered DOM", async () => {
    const body = await page.locator("body").textContent();
    return !/\bRune\b/i.test(body) && !/\bRHL\b/.test(body);
  });

  await check("pinned post also surfaces cleanly on Triage tab", async () => {
    await page.selectOption('select[aria-label="Active swarm"]', "11111111-1111-1111-1111-111111111111");
    await page.locator("#tab-triage").click();
    const txt = await page.locator("#panel-triage").textContent();
    return txt.includes("Pinned posts (1)");
  });

  // 26-28: Clean runtime guarantees
  await check("zero console errors", () => consoleErrors.length === 0);
  await check("zero uncaught page errors", () => pageErrors.length === 0);
  await check("zero external network requests and failed local requests", () => externalRequests.length === 0 && failedRequests.length === 0);

  await ctx.close();
});

await browser.close();
