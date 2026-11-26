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
    if (
      !txt.includes("Verify Antigravity-native sidebar UX") ||
      !txt.includes("Sidecar Node store & routes") ||
      !txt.includes("In progress") ||
      txt.includes("in_progress")
    ) {
      return false;
    }

    // Verify raw native Antigravity plan.json {goal:{title,line},tasks,threads} + narrator view.json + POST /api/plan
    const nativePage = await ctx.newPage();
    const nativeErrors = [];
    nativePage.on("pageerror", (err) => nativeErrors.push(err.message));
    nativePage.on("console", (msg) => {
      if (msg.type() === "error") nativeErrors.push(msg.text());
    });

    let mockPlan = {
      goal: {
        title: "Native Goal Title",
        line: "Ship zero-crash native plan view",
      },
      tasks: {
        builder: "Verify /home/demo/sidecar.mjs CAS",
      },
      threads: [
        {
          id: "t-1",
          title: "Native Thread 1",
          goal: "Render threads cleanly",
          tasks: ["builder"],
        },
      ],
    };
    let mockEtag = "native-v1";
    let capturedPlanPost = null;

    await nativePage.route("**/api/swarm*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId: "11111111-1111-1111-1111-111111111111",
          swarm: "11111111-1111-1111-1111-111111111111",
          member: "coordinator",
          etag: mockEtag,
          id: "11111111-1111-1111-1111-111111111111",
          title: "Native Plan Gate",
          head: 1,
          members: [
            {
              name: "coordinator",
              conversation_id: "11111111-1111-1111-1111-111111111111",
              model: "gemini-3-pro",
              role: "coordinator",
              wake_mode: "mentions",
              wait_since: 1,
              last_read_seq: 1,
              unread: 0,
              killed: false,
              status: "waiting",
              steps: 1,
              activity: "",
              activityKind: "",
              replied: false,
              replyAsk: "",
              narrator: false,
              roleWorker: false,
              failure: null,
              transcriptMtime: Date.now(),
              startedAt: new Date().toISOString(),
              lastStepAt: new Date().toISOString(),
              usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 20, totalTokens: 120 },
              posts: 1,
              lastPostSeq: 1,
              lastPostTime: "12:00:00",
              lastPostTs: Date.now(),
            },
          ],
          messages: [{ seq: 1, agent: "coordinator", text: "@all Native fixture", time: "12:00:00", ts: Date.now(), mentions: [], all: true }],
          edges: [],
          view: {
            exists: true,
            source: "narrator",
            json: {
              headline: "Narrator live check",
              phase: "verifying",
              running_summary: "Checking native plan schema",
              now: { builder: "Testing /home/demo/plan.json" },
              attention: ["Verify 409 conflict banner"],
            },
          },
          plan: mockPlan,
          frames: [],
          triage: [],
          usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 20, totalTokens: 120 },
          capabilities: { canSendMessage: false, isSidecar: false, sseStream: false },
        }),
      });
    });

    await nativePage.route("**/api/plan", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      capturedPlanPost = body;
      mockPlan = {
        ...mockPlan,
        goal: {
          title: body.patch?.goalTitle || mockPlan.goal.title,
          line: body.patch?.goalLine || body.patch?.goal || mockPlan.goal.line,
        },
        tasks: body.patch?.tasks || mockPlan.tasks,
      };
      mockEtag = "native-v2";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, plan: mockPlan, etag: mockEtag, notified: false }),
      });
    });

    await nativePage.goto(BASE, { waitUntil: "networkidle" });
    await nativePage.waitForSelector('[data-testid="narrator-view-card"]');
    const nTxt = await nativePage.locator("#panel-triage").textContent();
    const renderOk =
      nTxt.includes("Native Goal Title") &&
      nTxt.includes("Ship zero-crash native plan view") &&
      nTxt.includes("Native Thread 1") &&
      nTxt.includes("~/sidecar.mjs") &&
      nTxt.includes("Narrator live check") &&
      nTxt.includes("Verifying") &&
      nTxt.includes("~/plan.json") &&
      nTxt.includes("Verify 409 conflict banner") &&
      !nTxt.includes("/home/");

    await nativePage.evaluate(() => {
      window.__nativeDigest = "";
      try {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (t) => { window.__nativeDigest = String(t); } },
        });
      } catch {}
    });
    await nativePage.locator('[data-testid="copy-handoff-digest"]').click();
    await nativePage.waitForFunction(() => Boolean(window.__nativeDigest));
    const nDigest = await nativePage.evaluate(() => window.__nativeDigest);
    const digestOk = nDigest.includes("Ship zero-crash native plan view") && !nDigest.includes("/home/");

    await nativePage.locator('[data-testid="edit-plan-btn"]').click();
    await nativePage.fill('[data-testid="plan-goal-input"]', "Updated native goal line");
    await nativePage.locator('[data-testid="plan-save-btn"]').click();
    await nativePage.waitForSelector('[data-testid="swarm-plan-card"]');
    await nativePage.waitForFunction(
      () => (document.querySelector('[data-testid="swarm-plan-card"]')?.textContent || "").includes("Updated native goal line"),
    );
    await nativePage.close();

    return (
      renderOk &&
      digestOk &&
      nativeErrors.length === 0 &&
      Boolean(capturedPlanPost?.confirm) &&
      capturedPlanPost?.patch?.goal === "Updated native goal line"
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

  await check("Bottleneck Heat Bar renders activity counts and Copy blocker masks /home/ paths", async () => {
    const heatTxt = await page.locator('[data-testid="bottleneck-heat-bar"]').textContent();
    await page.evaluate(() => {
      window.__copied = "";
      try {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (t) => { window.__copied = String(t); } },
        });
      } catch {}
    });
    const copyBtn = page.locator('[data-testid^="copy-blocker-"]').first();
    if ((await copyBtn.count()) < 1) return false;
    await copyBtn.click();
    const copied = await page.evaluate(() => window.__copied);
    return (
      Boolean(heatTxt) &&
      heatTxt.includes("working") &&
      heatTxt.includes("waiting") &&
      heatTxt.includes("blocked") &&
      copied.includes("### Blocker:") &&
      !copied.includes("/home/")
    );
  });

  await check("clicking Top #seq on Bottleneck Heat Bar jumps to Board", async () => {
    const topJump = page.locator('[data-testid="top-blocker-jump"]');
    if ((await topJump.count()) !== 1) return false;
    await topJump.click();
    await page.waitForSelector("#panel-board");
    const ok = (await page.locator('#tab-board[aria-selected="true"]').count()) === 1;
    await page.locator("#tab-triage").click();
    await page.waitForSelector("#panel-triage");
    return ok;
  });

  await check("triage Token Burn Guard Strip renders share percentage and High burn badge", async () => {
    const strip = page.locator('#panel-triage [data-testid="token-burn-strip"]');
    if ((await strip.count()) !== 1) return false;
    const txt = await strip.textContent();
    const badge = await strip.locator('[data-testid="high-burn-badge"]').textContent();
    return txt.includes("Token burn") && txt.includes("builder") && /\d+%/.test(badge);
  });

  await check("triage Gate Readiness Card tracks tags and jumps to pending #seq on Board", async () => {
    const card = page.locator('#panel-triage [data-testid="gate-readiness-card"]');
    if ((await card.count()) !== 1) return false;
    const txt = await card.textContent();
    if (!txt.includes("Gate readiness") || !txt.includes("[done]") || !txt.includes("[blocked]")) return false;
    await page.evaluate(() => {
      window.__gateCopied = "";
      try {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (t) => { window.__gateCopied = t; } },
        });
      } catch {}
    });
    const nextBtn = card.locator('[data-testid="gate-next-action"]');
    if ((await nextBtn.count()) !== 1) return false;
    await nextBtn.click();
    await page.waitForFunction(() => Boolean(window.__gateCopied));
    const copiedPrompt = await page.evaluate(() => window.__gateCopied);
    if (!copiedPrompt.includes("Re #")) return false;
    await card.locator('[data-testid="gate-pending-jump"]').click();
    await page.waitForSelector("#panel-board");
    const jumped = (await page.locator('#tab-board[aria-selected="true"]').count()) === 1;
    await page.locator("#tab-triage").click();
    await page.waitForSelector("#panel-triage");
    return jumped;
  });

  await check("triage Wave Velocity pill shows pass rate, counts, and jumps to shipped #seq", async () => {
    const pill = page.locator('#panel-triage [data-testid="wave-velocity-pill"]');
    if ((await pill.count()) !== 1) return false;
    const txt = await pill.textContent();
    if (!txt || !/\d+% pass/.test(txt) || !/1d\s*0v\s*0s\s*0b/.test(txt)) return false;
    await pill.locator('[data-testid="gate-shipped-jump"]').click();
    await page.waitForSelector("#panel-board");
    const jumped = (await page.locator('#tab-board[aria-selected="true"]').count()) === 1;
    await page.locator("#tab-triage").click();
    await page.waitForSelector("#panel-triage");
    return jumped;
  });

  await check("triage Worker attention strip copies recovery prompt and jumps to filtered Board", async () => {
    const strip = page.locator('#panel-triage [data-testid="worker-recovery-strip"]');
    if ((await strip.count()) !== 1) return false;
    await page.evaluate(() => {
      window.__recCopied = "";
      try {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (t) => { window.__recCopied = String(t); } },
        });
      } catch {}
    });
    await strip.locator('[data-testid="recover-worker-verifier"]').click();
    await page.waitForFunction(() => Boolean(window.__recCopied));
    const copied = await page.evaluate(() => window.__recCopied);
    if (!copied.includes("@verifier") || (!copied.includes("unread") && !copied.includes("post status"))) return false;
    await strip.locator('[data-testid="jump-worker-verifier"]').click();
    await page.waitForSelector("#panel-board");
    const verChip = page.locator('#panel-board button:has-text("verifier")');
    const hasVerPill = (await verChip.count()) >= 1;
    await page.locator('#panel-board button:has-text("All (4)")').last().click();
    await page.locator("#tab-triage").click();
    await page.waitForSelector("#panel-triage");
    return hasVerPill;
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

  await check("filtered board export (.md and .json) exports filtered posts without /home/ leaks", async () => {
    const readDownload = async (btn) => {
      const [dl] = await Promise.all([page.waitForEvent("download"), btn.click()]);
      const chunks = [];
      for await (const c of await dl.createReadStream()) chunks.push(c);
      return { name: dl.suggestedFilename(), body: Buffer.concat(chunks).toString("utf8") };
    };
    await page.locator('[aria-label="Board quick filters"] button:has-text("[done]")').click();
    const md = await readDownload(page.locator('[data-testid="export-board-md"]'));
    const js = await readDownload(page.locator('[data-testid="export-board-json"]'));
    await page.locator('[aria-label="Board quick filters"] button:has-text("All")').click();
    const parsed = JSON.parse(js.body);
    return (
      md.name.endsWith(".md") &&
      js.name.endsWith(".json") &&
      md.body.includes("#4") &&
      !md.body.includes("/home/") &&
      !js.body.includes("/home/") &&
      parsed.filter?.quickFilter === "done" &&
      parsed.count === parsed.messages.length &&
      parsed.count >= 1
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

  await check("roster broadcast composer switches target chips and rejects control characters", async () => {
    await page.locator('[data-testid="toggle-broadcast"]').click();
    const box = page.locator('[data-testid="broadcast-composer"]');
    await box.waitFor();
    await box.getByRole("button", { name: "working", exact: true }).click();
    const workingCount = await box.locator('button[aria-pressed="true"]').count();
    await box.locator("textarea").fill("ping\u0007bad");
    const errVisible = (await box.textContent()).includes("Control characters are not allowed.");
    const disabled = await box.locator('[data-testid="composer-submit"]').isDisabled();
    await page.locator('[data-testid="toggle-broadcast"]').click();
    return workingCount >= 1 && errVisible && disabled;
  });

  await check("roster Token Burn Guard Strip shows top consumer share, 1M/200k context ceilings, $ spend, and cache-hit efficiency", async () => {
    const txt = await page.locator('#panel-roster [data-testid="token-burn-strip"]').textContent();
    if (!txt || !txt.includes("Token burn") || !txt.includes("builder") || !/\d+%/.test(txt)) return false;

    const costPage = await ctx.newPage();
    const costErrors = [];
    costPage.on("pageerror", (err) => costErrors.push(err.message));
    costPage.on("console", (msg) => {
      if (msg.type() === "error") costErrors.push(msg.text());
    });

    await costPage.route("**/api/swarms*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          swarms: [
            {
              id: "cost-gate-1",
              title: "Cost & Context Gate",
              appData: "gate",
              head: 1,
              memberCount: 3,
              activeCount: 1,
              waitingCount: 2,
              killedCount: 0,
              triageCount: 0,
              totalTokens: 539000,
              hasPlan: false,
              lastActivityTs: Date.now(),
            },
          ],
          defaultConversationId: "cost-gate-1",
        }),
      });
    });

    await costPage.route(/\/api\/swarm\/delta(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          unchanged: true,
          conversationId: "cost-gate-1",
          swarm: "cost-gate-1",
          member: "coordinator",
          etag: "cost-v1",
          head: 1,
        }),
      });
    });

    await costPage.route(/\/api\/swarm(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId: "cost-gate-1",
          swarm: "cost-gate-1",
          member: "coordinator",
          etag: "cost-v1",
          id: "cost-gate-1",
          title: "Cost & Context Gate",
          head: 1,
          contextLimit: 1000000,
          contextPct: 80,
          cost: {
            totalUsd: 1.49,
            inputUsd: 0.39,
            cacheReadUsd: 0.04,
            outputUsd: 1.06,
            cacheSavingsUsd: 0.42,
            cacheHitPct: 54.2,
            pricingKnown: true,
          },
          members: [
            {
              name: "gemini-worker",
              conversation_id: "cost-gem-1",
              model: "gemini-3-pro",
              role: "worker",
              wake_mode: "working",
              wait_since: 0,
              last_read_seq: 1,
              unread: 0,
              killed: false,
              status: "working",
              steps: 10,
              activity: "Indexing 1M context",
              activityKind: "thinking",
              replied: false,
              replyAsk: "",
              narrator: false,
              roleWorker: false,
              failure: null,
              transcriptMtime: Date.now(),
              startedAt: new Date().toISOString(),
              lastStepAt: new Date().toISOString(),
              lastContextTokens: 300000,
              contextLimit: 1000000,
              contextPct: 30,
              usage: { inputTokens: 120000, cacheReadTokens: 180000, outputTokens: 8000, totalTokens: 308000 },
              cost: {
                totalUsd: 0.25,
                inputUsd: 0.15,
                cacheReadUsd: 0.02,
                outputUsd: 0.08,
                cacheSavingsUsd: 0.20,
                cacheHitPct: 60,
                pricingKnown: true,
              },
              byModel: {
                "gemini-3-pro": { inputTokens: 120000, cacheReadTokens: 180000, outputTokens: 8000, steps: 10 },
              },
              posts: 1,
              lastPostSeq: 1,
              lastPostTime: "12:00:00",
              lastPostTs: Date.now(),
            },
            {
              name: "claude-worker",
              conversation_id: "cost-cld-1",
              model: "claude-sonnet-4-6",
              role: "worker",
              wake_mode: "mentions",
              wait_since: 1,
              last_read_seq: 1,
              unread: 0,
              killed: false,
              status: "waiting",
              steps: 8,
              activity: "",
              activityKind: "",
              replied: false,
              replyAsk: "",
              narrator: false,
              roleWorker: false,
              failure: null,
              transcriptMtime: Date.now(),
              startedAt: new Date().toISOString(),
              lastStepAt: new Date().toISOString(),
              lastContextTokens: 160000,
              contextLimit: 200000,
              contextPct: 80,
              usage: { inputTokens: 80000, cacheReadTokens: 80000, outputTokens: 50000, totalTokens: 210000 },
              cost: {
                totalUsd: 1.24,
                inputUsd: 0.24,
                cacheReadUsd: 0.02,
                outputUsd: 0.98,
                cacheSavingsUsd: 0.22,
                cacheHitPct: 50,
                pricingKnown: true,
              },
              posts: 0,
              lastPostSeq: 0,
              lastPostTime: "",
              lastPostTs: null,
            },
            {
              name: "custom-worker",
              conversation_id: "cost-cst-1",
              model: "local-custom-7b",
              role: "worker",
              wake_mode: "mentions",
              wait_since: 1,
              last_read_seq: 1,
              unread: 0,
              killed: false,
              status: "waiting",
              steps: 2,
              activity: "",
              activityKind: "",
              replied: false,
              replyAsk: "",
              narrator: false,
              roleWorker: false,
              failure: null,
              transcriptMtime: Date.now(),
              startedAt: new Date().toISOString(),
              lastStepAt: new Date().toISOString(),
              lastContextTokens: 20000,
              contextLimit: 200000,
              contextPct: 10,
              usage: { inputTokens: 20000, cacheReadTokens: 0, outputTokens: 1000, totalTokens: 21000 },
              cost: {
                totalUsd: 0,
                inputUsd: 0,
                cacheReadUsd: 0,
                outputUsd: 0,
                cacheSavingsUsd: 0,
                cacheHitPct: 0,
                pricingKnown: false,
              },
              posts: 0,
              lastPostSeq: 0,
              lastPostTime: "",
              lastPostTs: null,
            },
          ],
          messages: [{ seq: 1, agent: "gemini-worker", text: "@all Cost & 1M ceiling check", time: "12:00:00", ts: Date.now(), mentions: [], all: true }],
          replyRefs: {},
          edges: [],
          triage: [],
          burnSummary: {
            totalTokens: 539000,
            costUsd: 1.49,
            cacheHitPct: 54.2,
            cacheSavingsUsd: 0.42,
            pricingKnown: true,
            highBurnCount: 1,
            topWorker: {
              name: "claude-worker",
              totalTokens: 210000,
              sharePct: 83,
              level: "critical",
              costUsd: 1.24,
              cacheHitPct: 50,
              cacheSavingsUsd: 0.22,
              pricingKnown: true,
            },
            workers: [
              { name: "claude-worker", totalTokens: 210000, sharePct: 83, level: "critical", costUsd: 1.24, cacheHitPct: 50, cacheSavingsUsd: 0.22, pricingKnown: true },
              { name: "gemini-worker", totalTokens: 308000, sharePct: 17, level: "normal", costUsd: 0.25, cacheHitPct: 60, cacheSavingsUsd: 0.20, pricingKnown: true },
              { name: "custom-worker", totalTokens: 21000, sharePct: 0, level: "normal", costUsd: 0, cacheHitPct: 0, cacheSavingsUsd: 0, pricingKnown: false },
            ],
          },
          usage: { inputTokens: 220000, cacheReadTokens: 260000, outputTokens: 59000, totalTokens: 539000 },
          capabilities: { canSendMessage: false, isSidecar: false, sseStream: false, deltaStream: false },
        }),
      });
    });

    await costPage.setViewportSize({ width: 380, height: 900 });
    await costPage.goto(BASE, { waitUntil: "networkidle" });
    await costPage.waitForSelector('#panel-triage [data-testid="token-burn-strip"]');
    const burnUsd = await costPage.locator('#panel-triage [data-testid="burn-total-usd"]').textContent();
    const burnCache = await costPage.locator('#panel-triage [data-testid="burn-cache-hit"]').textContent();
    const highBadge = await costPage.locator('#panel-triage [data-testid="high-burn-badge"]').textContent();

    await costPage.evaluate(() => {
      window.__costDigest = "";
      try {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (t) => { window.__costDigest = String(t); } },
        });
      } catch {}
    });
    await costPage.locator('button[aria-label="Copy swarm digest"]').click();
    await costPage.waitForFunction(() => Boolean(window.__costDigest));
    const costDigest = await costPage.evaluate(() => window.__costDigest);

    await costPage.locator("#tab-roster").click();
    await costPage.waitForSelector('[data-testid="roster-ctx-badge-gemini-worker"]');
    const gemBadge = await costPage.locator('[data-testid="roster-ctx-badge-gemini-worker"]').textContent();
    const gemClass = await costPage.locator('[data-testid="roster-ctx-badge-gemini-worker"]').getAttribute("class");
    const gemCap = await costPage.locator('[data-testid="roster-ctx-cap-gemini-worker"]').textContent();
    const gemCost = await costPage.locator('[data-testid="roster-cost-gemini-worker"]').textContent();
    const gemCache = await costPage.locator('[data-testid="roster-cache-hit-gemini-worker"]').textContent();
    const cldBadge = await costPage.locator('[data-testid="roster-ctx-badge-claude-worker"]').textContent();
    const cldClass = await costPage.locator('[data-testid="roster-ctx-badge-claude-worker"]').getAttribute("class");
    const cldCap = await costPage.locator('[data-testid="roster-ctx-cap-claude-worker"]').textContent();
    const cldCost = await costPage.locator('[data-testid="roster-cost-claude-worker"]').textContent();
    const cstCost = await costPage.locator('[data-testid="roster-cost-custom-worker"]').textContent();
    const ovLight380 = await costPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    await costPage.locator('button[aria-label="Open settings"]').click();
    await costPage.locator('div[role="dialog"] button[role="radio"]:has-text("Dark")').click();
    await costPage.locator('button[aria-label="Close dialog"]').click();
    const ovDark380 = await costPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const isDark = await costPage.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark");
    await costPage.close();

    return (
      burnUsd === "$1.49" &&
      Boolean(burnCache?.includes("54% cache hit") && burnCache.includes("$0.42 saved")) &&
      Boolean(highBadge?.includes("@claude-worker") && highBadge.includes("$1.24")) &&
      costDigest.includes("$1.49 spend") &&
      costDigest.includes("54% cache hit") &&
      costDigest.includes("30% of 1M ctx") &&
      gemBadge === "30% ctx" &&
      !gemClass?.includes("text-danger") &&
      gemCap === "cap 1M" &&
      gemCost === "$0.25" &&
      gemCache === "60% cache hit" &&
      cldBadge === "80% ctx" &&
      Boolean(cldClass?.includes("text-danger")) &&
      cldCap === "cap 200k" &&
      cldCost === "$1.24" &&
      cstCost === "Unpriced" &&
      ovLight380 <= 0 &&
      ovDark380 <= 0 &&
      isDark &&
      costErrors.length === 0
    );
  });

  await check("roster Recover and Board (N) direct jump filter Board to worker", async () => {
    if ((await page.locator('#panel-roster [data-testid="roster-recover-verifier"]').count()) !== 1) return false;
    await page.locator('#panel-roster [data-testid="roster-board-builder"]').click();
    await page.waitForSelector("#panel-board");
    const txt = await page.locator("#panel-board").textContent();
    const ok = txt.includes("Sidecar ready for cold check") && (await page.locator('#panel-board button:has-text("All (4)")').count()) === 2;
    await page.locator('#panel-board button:has-text("All (4)")').last().click();
    await page.locator("#tab-roster").click();
    await page.waitForSelector("#panel-roster");
    return ok;
  });

  await check("roster ForensicTranscriptDrawer fetches real sidecar /api/transcript with correlation, tools filter, and ~/ masking", async () => {
    await page.locator('#panel-roster [data-testid="inspect-trace-btn"][data-member="builder"]').click();
    await page.waitForSelector('[data-testid="forensic-trace-drawer"]');
    await page.waitForSelector('[data-testid="trace-step-2"]');
    await page.waitForSelector('[data-testid="trace-step-0"]');
    const s2Text = await page.locator('[data-testid="trace-step-2"]').textContent();
    await page.locator('[data-testid="trace-filter-tools"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="trace-step-2"]') && Boolean(document.querySelector('[data-testid="trace-step-0"]')));
    await page.locator('[data-testid="trace-step-toggle-0"]').click();
    await page.waitForSelector('[data-testid="trace-step-body-0"]');
    const builderArgs = await page.locator('[data-testid="trace-tool-args-0-0"]').textContent();
    await page.locator('[data-testid="trace-close-btn"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="forensic-trace-drawer"]'));

    await page.locator('#panel-roster [data-testid="inspect-trace-btn"][data-member="verifier"]').click();
    await page.waitForSelector('[data-testid="forensic-trace-drawer"]');
    await page.waitForSelector('[data-testid="trace-step-0"]');
    await page.locator('[data-testid="trace-step-toggle-0"]').click();
    await page.waitForSelector('[data-testid="trace-step-body-0"]');
    const verArgs = await page.locator('[data-testid="trace-tool-args-0-0"]').textContent();
    const traceOv = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.locator('[data-testid="trace-close-btn"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="forensic-trace-drawer"]'));

    return (
      Boolean(s2Text?.includes("All 7 backend checks pass")) &&
      Boolean(builderArgs?.includes("Run sidecar security tests")) &&
      Boolean(verArgs?.includes("~/main.mjs")) &&
      !verArgs?.includes("/home/") &&
      traceOv <= 0
    );
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

  await check("worktrees displays safe-land status and copies ~/ command cleanly", async () => {
    const st = page.locator('[data-testid="wt-land-status-lane/verify"]');
    if ((await st.count()) !== 1) return false;
    await page.evaluate(() => {
      window.__wtCopied = "";
      try {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (t) => { window.__wtCopied = String(t); } },
        });
      } catch {}
    });
    await page.locator('[data-testid="wt-land-cmd-lane/verify"]').click();
    await page.waitForFunction(() => Boolean(window.__wtCopied));
    const cmd = await page.evaluate(() => window.__wtCopied);
    return cmd.includes("git") && !cmd.includes("/home/cayleb");
  });

  await check("worktrees Diff peek expands bounded diff hunk cleanly", async () => {
    await page.locator('button[aria-label="Diff peek untracked.txt"]').click();
    await page.waitForSelector('#panel-worktrees pre');
    const preTxt = await page.locator("#panel-worktrees pre").textContent();
    if (!preTxt.includes("(untracked)") || !preTxt.includes("+")) return false;

    // E2 Gap #2 verification: collisions banner, branchFiles/working toggle, dry_run_merge & rebase conflict feedback
    const wtPage = await ctx.newPage();
    const wtErrors = [];
    const diffModesSeen = [];
    const actionsSeen = [];
    let expect409 = false;
    wtPage.on("pageerror", (err) => wtErrors.push(err.message));
    wtPage.on("console", (msg) => {
      if (msg.type() === "error") {
        if (expect409 && msg.text().includes("status of 409")) return;
        wtErrors.push(msg.text());
      }
    });

    await wtPage.route(/\/api\/worktrees(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          roots: [{ path: "/mock/repo", uri: "file:///mock/repo", isGit: true, count: 3, error: "" }],
          collisions: [
            {
              file: "src/shared.ts",
              worktrees: ["/mock/alpha", "/mock/beta"],
              branches: ["feat/alpha", "feat/beta"],
              kind: "mixed",
            },
          ],
          worktrees: [
            {
              id: "m-main",
              root: "/mock/repo",
              name: "repo",
              path: "/mock/repo",
              uri: "file:///mock/repo",
              isMain: true,
              exists: true,
              bare: false,
              detached: false,
              locked: false,
              prunable: false,
              branch: "main",
              head: "1111aaa",
              clean: true,
              landStatus: "main",
              mergeability: "main",
              dirtyFiles: 0,
              untrackedFiles: 0,
              stagedFiles: 0,
              commits: [{ sha: "1111aaa", subject: "chore: root commit", authorTime: "10m ago" }],
              lastCommitSha: "1111aaa",
              lastCommitSubject: "chore: root commit",
              lastCommitAt: Date.now(),
            },
            {
              id: "m-alpha",
              root: "/mock/repo",
              name: "alpha",
              path: "/mock/alpha",
              uri: "file:///mock/alpha",
              isMain: false,
              exists: true,
              bare: false,
              detached: false,
              locked: false,
              prunable: false,
              branch: "feat/alpha",
              head: "2222bbb",
              clean: true,
              baseBranch: "main",
              ahead: 1,
              behind: 0,
              landStatus: "ready",
              mergeability: "clean",
              dirtyFiles: 0,
              untrackedFiles: 0,
              stagedFiles: 0,
              files: [],
              branchFiles: ["src/shared.ts", "src/alpha.ts"],
              commits: [{ sha: "2222bbb", subject: "feat: alpha lane", authorTime: "2m ago" }],
              lastCommitSha: "2222bbb",
              lastCommitSubject: "feat: alpha lane",
              lastCommitAt: Date.now(),
            },
            {
              id: "m-beta",
              root: "/mock/repo",
              name: "beta",
              path: "/mock/beta",
              uri: "file:///mock/beta",
              isMain: false,
              exists: true,
              bare: false,
              detached: false,
              locked: false,
              prunable: false,
              branch: "feat/beta",
              head: "3333ccc",
              clean: false,
              baseBranch: "main",
              ahead: 1,
              behind: 1,
              landStatus: "dirty",
              mergeability: "conflict",
              conflictFiles: ["src/shared.ts"],
              dirtyFiles: 1,
              untrackedFiles: 0,
              stagedFiles: 0,
              files: [{ path: "src/shared.ts", state: "M", uri: "file:///mock/beta/src/shared.ts" }],
              branchFiles: ["src/shared.ts"],
              commits: [{ sha: "3333ccc", subject: "feat: beta lane", authorTime: "1m ago" }],
              lastCommitSha: "3333ccc",
              lastCommitSubject: "feat: beta lane",
              lastCommitAt: Date.now(),
            },
          ],
          rejected: [],
        }),
      });
    });

    await wtPage.route("**/api/worktrees?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          roots: [{ path: "/mock/repo", uri: "file:///mock/repo", isGit: true, count: 3, error: "" }],
          collisions: [
            {
              file: "src/shared.ts",
              worktrees: ["/mock/alpha", "/mock/beta"],
              branches: ["feat/alpha", "feat/beta"],
              kind: "mixed",
            },
          ],
          worktrees: [
            {
              id: "m-main",
              root: "/mock/repo",
              name: "repo",
              path: "/mock/repo",
              uri: "file:///mock/repo",
              isMain: true,
              exists: true,
              bare: false,
              detached: false,
              locked: false,
              prunable: false,
              branch: "main",
              head: "1111aaa",
              clean: true,
              landStatus: "main",
              mergeability: "main",
              dirtyFiles: 0,
              untrackedFiles: 0,
              stagedFiles: 0,
              commits: [{ sha: "1111aaa", subject: "chore: root commit", authorTime: "10m ago" }],
              lastCommitSha: "1111aaa",
              lastCommitSubject: "chore: root commit",
              lastCommitAt: Date.now(),
            },
            {
              id: "m-alpha",
              root: "/mock/repo",
              name: "alpha",
              path: "/mock/alpha",
              uri: "file:///mock/alpha",
              isMain: false,
              exists: true,
              bare: false,
              detached: false,
              locked: false,
              prunable: false,
              branch: "feat/alpha",
              head: "2222bbb",
              clean: true,
              baseBranch: "main",
              ahead: 1,
              behind: 0,
              landStatus: "ready",
              mergeability: "clean",
              dirtyFiles: 0,
              untrackedFiles: 0,
              stagedFiles: 0,
              files: [],
              branchFiles: ["src/shared.ts", "src/alpha.ts"],
              commits: [{ sha: "2222bbb", subject: "feat: alpha lane", authorTime: "2m ago" }],
              lastCommitSha: "2222bbb",
              lastCommitSubject: "feat: alpha lane",
              lastCommitAt: Date.now(),
            },
            {
              id: "m-beta",
              root: "/mock/repo",
              name: "beta",
              path: "/mock/beta",
              uri: "file:///mock/beta",
              isMain: false,
              exists: true,
              bare: false,
              detached: false,
              locked: false,
              prunable: false,
              branch: "feat/beta",
              head: "3333ccc",
              clean: false,
              baseBranch: "main",
              ahead: 1,
              behind: 1,
              landStatus: "dirty",
              mergeability: "conflict",
              conflictFiles: ["src/shared.ts"],
              dirtyFiles: 1,
              untrackedFiles: 0,
              stagedFiles: 0,
              files: [{ path: "src/shared.ts", state: "M", uri: "file:///mock/beta/src/shared.ts" }],
              branchFiles: ["src/shared.ts"],
              commits: [{ sha: "3333ccc", subject: "feat: beta lane", authorTime: "1m ago" }],
              lastCommitSha: "3333ccc",
              lastCommitSubject: "feat: beta lane",
              lastCommitAt: Date.now(),
            },
          ],
          rejected: [],
        }),
      });
    });

    await wtPage.route(/\/api\/worktrees\/diff(\?.*)?$/, async (route) => {
      const reqUrl = new URL(route.request().url());
      const mode = reqUrl.searchParams.get("mode") || "working";
      diffModesSeen.push(mode);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          worktree: reqUrl.searchParams.get("worktree") || "/mock/beta",
          file: reqUrl.searchParams.get("file") || "src/shared.ts",
          mode,
          diff: mode === "branch" ? "@@ -1 +1 @@\n+export const committed = true;" : "@@ -1 +1 @@\n+export const dirty = true;",
          truncated: false,
          untracked: false,
          added: 1,
          removed: 0,
        }),
      });
    });

    await wtPage.route(/\/api\/worktrees\/action(\?.*)?$/, async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      actionsSeen.push(body.action);
      if (body.action === "dry_run_merge") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            action: "dry_run_merge",
            status: "conflict",
            conflicts: ["src/shared.ts"],
            message: "Dry-run merge conflict in src/shared.ts",
          }),
        });
        return;
      }
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          action: body.action,
          status: "conflict",
          aborted: true,
          conflicts: ["src/shared.ts"],
          message: "Rebase aborted on src/shared.ts conflict",
        }),
      });
    });

    await wtPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await wtPage.locator("#tab-worktrees").click();
    await wtPage.waitForSelector("#panel-worktrees");
    await wtPage.fill('input[aria-label="Workspace repository path"]', "/mock/repo");
    await wtPage.locator('#panel-worktrees button:has-text("Inspect")').click();
    await wtPage.waitForSelector('[data-testid="worktree-collisions-banner"]');

    const bannerTxt = await wtPage.locator('[data-testid="worktree-collisions-banner"]').textContent();
    const alphaMerge = await wtPage.locator('[data-testid="wt-mergeability-feat/alpha"]').textContent();
    const betaMerge = await wtPage.locator('[data-testid="wt-mergeability-feat/beta"]').textContent();
    const alphaBranchCount = await wtPage.locator('[data-testid="wt-branch-files-count-feat/alpha"]').textContent();
    const alphaCommits = await wtPage.locator('[data-testid="wt-commits-feat/alpha"]').textContent();

    // Switch feat/beta to Branch Diff and open diff peek
    await wtPage.locator('[data-testid="wt-diff-mode-branch-feat/beta"]').click();
    await wtPage.locator('[data-testid="wt-card-feat/beta"] button[aria-label="Diff peek src/shared.ts"]').click();
    await wtPage.waitForSelector('[data-testid="wt-card-feat/beta"] pre');
    const branchPre = await wtPage.locator('[data-testid="wt-card-feat/beta"] pre').textContent();

    // Dry-Run Merge conflict feedback
    await wtPage.locator('[data-testid="wt-action-dry-run-feat/beta"]').click();
    await wtPage.waitForSelector('[data-testid="wt-action-conflicts-feat/beta"]');
    const dryRunTxt = await wtPage.locator('[data-testid="wt-action-result-feat/beta"]').textContent();

    // Rebase two-step confirmation & conflict feedback
    await wtPage.locator('[data-testid="wt-action-rebase-feat/beta"]').click();
    expect409 = true;
    await wtPage.locator('[data-testid="wt-confirm-submit-feat/beta"]').click();
    await wtPage.waitForFunction(
      () => (document.querySelector('[data-testid="wt-action-result-feat/beta"]')?.textContent || "").includes("Rebase aborted"),
    );
    const rebaseTxt = await wtPage.locator('[data-testid="wt-action-result-feat/beta"]').textContent();
    const wtOverflow = await wtPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await wtPage.close();

    return (
      Boolean(bannerTxt?.includes("src/shared.ts") && bannerTxt.includes("feat/alpha") && bannerTxt.includes("feat/beta")) &&
      alphaMerge === "Merge clean" &&
      betaMerge === "Merge conflict" &&
      Boolean(alphaBranchCount?.includes("2 branch files")) &&
      Boolean(alphaCommits?.includes("feat: alpha lane")) &&
      diffModesSeen.includes("branch") &&
      Boolean(branchPre?.includes("committed = true")) &&
      Boolean(dryRunTxt?.includes("Dry-run merge conflict") && dryRunTxt.includes("src/shared.ts")) &&
      Boolean(rebaseTxt?.includes("Rebase aborted on src/shared.ts conflict")) &&
      actionsSeen.includes("dry_run_merge") &&
      actionsSeen.includes("rebase") &&
      wtOverflow <= 0 &&
      wtErrors.length === 0
    );
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

  await check("Command Palette cross-swarm index filters Board to @builder", async () => {
    await page.locator('button[aria-label="Open command palette"]').click();
    await page.waitForSelector('[cmdk-input]');
    await page.fill("[cmdk-input]", "Filter Board: @builder");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#panel-board");
    const txt = await page.locator("#panel-board").textContent();
    const ok = (await page.locator('#tab-board[aria-selected="true"]').count()) === 1 && txt.includes("Sidecar ready for cold check");
    await page.locator('#panel-board button:has-text("All (4)")').last().click();
    await page.locator("#tab-triage").click();
    return ok;
  });

  await check("Triage Copy Handoff Digest exports goal, gate readiness, deliverables, and worktrees cleanly", async () => {
    await page.evaluate(() => {
      window.__handoffCopied = "";
      try {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (txt) => { window.__handoffCopied = String(txt); } },
        });
      } catch {}
    });
    await page.locator('[data-testid="copy-handoff-digest"]').click();
    await page.waitForFunction(() => Boolean(window.__handoffCopied));
    const clip = await page.evaluate(() => window.__handoffCopied);
    return (
      clip.includes("Handoff Digest") &&
      clip.includes("- Active goal:") &&
      clip.includes("- Gate readiness:") &&
      clip.includes("## Workers") &&
      clip.includes("## Verified deliverables") &&
      clip.includes("## Worktree readiness") &&
      !clip.includes("/home/")
    );
  });

  await check("SSE resync banner appears when paused or disconnected and Resync restores live sync", async () => {
    if ((await page.locator('[data-testid="sse-resync-banner"]').count()) !== 0) return false;
    await page.locator('button[aria-label="Open settings"]').click();
    await page.waitForSelector('div[role="dialog"]');
    await page.locator('div[role="dialog"] button[role="radio"]:has-text("Paused")').click();
    await page.locator('button[aria-label="Close dialog"]').click();
    await page.waitForSelector('[data-testid="sse-resync-banner"]');
    const bannerTxt = await page.locator('[data-testid="sse-resync-banner"]').textContent();
    await page.locator('[data-testid="sse-resync-btn"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="sse-resync-banner"]'));
    return bannerTxt.includes("Live updates paused");
  });

  await check("live per-worker activityPeek renders masked 1-line tool, status, and age on Triage attention and Roster", async () => {
    const tPeek = page.locator('[data-testid="triage-activity-peek-verifier"]');
    await tPeek.waitFor();
    const tTxt = await tPeek.textContent();
    await page.locator("#tab-roster").click();
    await page.waitForSelector("#panel-roster");
    const rBuilder = await page.locator('[data-testid="roster-activity-peek-builder"]').textContent();
    const rVerifier = await page.locator('[data-testid="roster-activity-peek-verifier"]').textContent();
    await page.locator("#tab-triage").click();
    return (
      tTxt.includes("working: Read main.mjs") &&
      !tTxt.includes("/home/") &&
      rBuilder.includes("waiting: Run sidecar security tests") &&
      rVerifier.includes("working: Read main.mjs") &&
      !rBuilder.includes("/home/") &&
      !rVerifier.includes("/home/")
    );
  });

  await check("Triage Full Swarm Archive Export downloads sanitized .md and .json with zero /home/ leaks", async () => {
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
      md.body.includes("## Worktree readiness") &&
      !md.body.includes("/home/") &&
      js.name.endsWith(".json") &&
      parsed.schema === "fleet.swarm-archive.v1" &&
      Array.isArray(parsed.messages) &&
      parsed.messages.length >= 4 &&
      Array.isArray(parsed.members) &&
      !js.body.includes("/home/")
    );
  });

  await check("New Swarm Launcher modal opens from header and Command Palette while swarm is active", async () => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.locator('[data-testid="open-swarm-launcher"]').click();
    await page.waitForSelector('[data-testid="swarm-launcher-modal"]');
    const modalTxt = await page.locator('[data-testid="swarm-launcher-modal"]').textContent();
    const ov1 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.locator('button[aria-label="Close dialog"]').click();

    await page.locator('button[aria-label="Open command palette"]').click();
    await page.waitForSelector("[cmdk-input]");
    await page.fill("[cmdk-input]", "New swarm");
    await page.keyboard.press("Enter");
    await page.waitForSelector('[data-testid="swarm-launcher-modal"]');
    await page.locator('button[aria-label="Close dialog"]').click();
    await page.setViewportSize({ width: 380, height: 900 });
    return Boolean(modalTxt?.includes("Feature and verifier") && modalTxt.includes("Custom swarm")) && ov1 <= 0;
  });

  await check("Command Palette Spawn Worker and Board Post actions jump and open composers", async () => {
    await page.locator('button[aria-label="Open command palette"]').click();
    await page.waitForSelector("[cmdk-input]");
    await page.fill("[cmdk-input]", "Board post");
    await page.keyboard.press("Enter");
    await page.waitForSelector('[data-testid="board-composer-form"]');
    const boardOpen = (await page.locator('[data-testid="board-composer-form"]').count()) === 1;
    await page.locator('[data-testid="board-composer-close"]').click();

    await page.locator('button[aria-label="Open command palette"]').click();
    await page.waitForSelector("[cmdk-input]");
    await page.fill("[cmdk-input]", "Spawn worker");
    await page.keyboard.press("Enter");
    await page.waitForSelector('[data-testid="spawn-worker-drawer"]');
    const spawnOpen = (await page.locator('[data-testid="spawn-worker-drawer"]').count()) === 1;
    await page.locator('button[aria-label="Close spawn worker drawer"]').click();
    await page.locator("#tab-triage").click();
    return boardOpen && spawnOpen;
  });

  await check("Board channel tabs, replyRefs backlinks, and sticky Board Composer work via /api/control", async () => {
    const ctrlPage = await ctx.newPage();
    await ctrlPage.setViewportSize({ width: 360, height: 900 });
    const ctrlErrors = [];
    const controlCalls = [];
    ctrlPage.on("pageerror", (e) => ctrlErrors.push(e.message));
    ctrlPage.on("console", (msg) => {
      if (msg.type() === "error") ctrlErrors.push(msg.text());
    });

    const mockSnap = {
      conversationId: "ctrl-coord-1",
      swarm: "ctrl-coord-1",
      member: "coordinator",
      etag: "ctrl-v1",
      id: "ctrl-coord-1",
      title: "Control Plane Gate",
      head: 3,
      channels: [
        { name: "backend", topic: "Backend API lane", created_by: "coordinator", archived: false },
      ],
      members: [
        {
          name: "coordinator",
          conversation_id: "ctrl-coord-1",
          model: "gemini-3-pro",
          role: "coordinator",
          wake_mode: "mentions",
          wait_since: 3,
          last_read_seq: 3,
          unread: 0,
          killed: false,
          status: "waiting",
          steps: 4,
          activity: "",
          activityKind: "",
          replied: false,
          replyAsk: "",
          narrator: false,
          roleWorker: false,
          failure: null,
          transcriptMtime: Date.now(),
          startedAt: new Date().toISOString(),
          lastStepAt: new Date().toISOString(),
          usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 200, totalTokens: 1200 },
          posts: 1,
          lastPostSeq: 1,
          lastPostTime: "12:00:00",
          lastPostTs: Date.now(),
        },
        {
          name: "builder",
          conversation_id: "ctrl-builder-2",
          model: "gemini-3-pro",
          role: "worker",
          wake_mode: "mentions",
          wait_since: 2,
          last_read_seq: 3,
          unread: 0,
          killed: false,
          status: "waiting",
          steps: 8,
          activity: "",
          activityKind: "",
          replied: false,
          replyAsk: "",
          narrator: false,
          roleWorker: false,
          failure: null,
          transcriptMtime: Date.now(),
          startedAt: new Date().toISOString(),
          lastStepAt: new Date().toISOString(),
          usage: { inputTokens: 2000, cacheReadTokens: 0, outputTokens: 300, totalTokens: 2300 },
          workspace_mode: "share",
          posts: 1,
          lastPostSeq: 2,
          lastPostTime: "12:02:00",
          lastPostTs: Date.now(),
        },
      ],
      messages: [
        { seq: 1, agent: "coordinator", text: "@all Kickoff", time: "12:00:00", ts: Date.now(), mentions: [], all: true },
        { seq: 2, agent: "builder", channel: "backend", text: "@coordinator API ready", time: "12:02:00", ts: Date.now(), mentions: ["coordinator"], all: false },
        { seq: 3, agent: "coordinator", text: "@builder [done] Re #2: Confirmed", time: "12:03:00", ts: Date.now(), mentions: ["builder"], all: false },
      ],
      replyRefs: { 2: [3] },
      edges: [],
      triage: [],
      gateReadiness: {
        state: "verifying",
        pendingSeq: 3,
        nextAction: { kind: "verify", target: "builder", conversationId: "ctrl-builder-2", seq: 3, label: "Nudge @builder", prompt: "@builder Re #3: verify" },
        stages: [{ key: "done", label: "[done]", count: 1, seq: 3 }],
      },
      usage: { inputTokens: 3000, cacheReadTokens: 0, outputTokens: 500, totalTokens: 3500 },
      capabilities: { canSendMessage: true, isSidecar: false, sseStream: false },
    };

    await ctrlPage.route("**/api/swarm*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockSnap) });
    });
    await ctrlPage.route("**/api/control", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      controlCalls.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, op: body.op, coordinatorId: "ctrl-coord-1", directivePreview: body.op, deliveredAt: new Date().toISOString() }),
      });
    });

    await ctrlPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await ctrlPage.locator("#tab-board").click();
    await ctrlPage.waitForSelector('[data-testid="board-channel-tabs"]');
    await ctrlPage.locator('[data-testid="channel-tab-backend"]').click();
    const backendTxt = await ctrlPage.locator("#panel-board").textContent();
    await ctrlPage.locator('[data-testid="channel-tab-all"]').click();

    const refTxt = await ctrlPage.locator('[data-testid="board-reply-refs-2"]').textContent();
    await ctrlPage.locator('[data-testid="board-reply-refs-2"] button').first().click();

    await ctrlPage.locator('[data-testid="board-composer-open"]').click();
    await ctrlPage.selectOption('[data-testid="board-composer-channel"]', "backend");
    await ctrlPage.fill('[data-testid="board-composer-reply-seq"]', "2");
    await ctrlPage.fill('[data-testid="board-composer-input"]', "Ship channel update");
    await ctrlPage.locator('[data-testid="board-composer-stage"]').click();
    await ctrlPage.locator('[data-testid="board-composer-submit"]').click();
    await ctrlPage.waitForFunction(() => !document.querySelector('[data-testid="board-composer-form"]'));

    const ov360 = await ctrlPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await ctrlPage.close();

    const postCall = controlCalls.find((c) => c.op === "board_post");
    return (
      Boolean(backendTxt?.includes("API ready") && !backendTxt.includes("Kickoff")) &&
      Boolean(refTxt?.includes("Replies:") && refTxt.includes("#3")) &&
      Boolean(postCall?.confirm && postCall.channel === "backend" && postCall.replyToSeq === 2 && postCall.text === "Ship channel update") &&
      ov360 <= 0 &&
      ctrlErrors.length === 0
    );
  });

  await check("Roster Spawn Worker, Switch Model on quota card, and Kill Worker 409 flow work via /api/control", async () => {
    const rosterPage = await ctx.newPage();
    await rosterPage.setViewportSize({ width: 360, height: 900 });
    const rosterErrors = [];
    const controlCalls = [];
    let allow409 = false;
    rosterPage.on("pageerror", (e) => rosterErrors.push(e.message));
    rosterPage.on("console", (msg) => {
      if (msg.type() === "error") {
        if (allow409 && msg.text().includes("status of 409")) return;
        rosterErrors.push(msg.text());
      }
    });

    const mockSnap = {
      conversationId: "ctrl-coord-1",
      swarm: "ctrl-coord-1",
      member: "coordinator",
      etag: "ctrl-r1",
      id: "ctrl-coord-1",
      title: "Roster Control Gate",
      head: 2,
      channels: [{ name: "backend", topic: "Backend", created_by: "coordinator", archived: false }],
      members: [
        {
          name: "coordinator",
          conversation_id: "ctrl-coord-1",
          model: "gemini-3-pro",
          role: "coordinator",
          wake_mode: "mentions",
          wait_since: 2,
          last_read_seq: 2,
          unread: 0,
          killed: false,
          status: "waiting",
          steps: 3,
          activity: "",
          activityKind: "",
          replied: false,
          replyAsk: "",
          narrator: false,
          roleWorker: false,
          failure: null,
          transcriptMtime: Date.now(),
          startedAt: new Date().toISOString(),
          lastStepAt: new Date().toISOString(),
          usage: { inputTokens: 800, cacheReadTokens: 0, outputTokens: 100, totalTokens: 900 },
          posts: 1,
          lastPostSeq: 1,
          lastPostTime: "12:00:00",
          lastPostTs: Date.now(),
        },
        {
          name: "scout",
          conversation_id: "ctrl-scout-2",
          model: "gemini-3-pro",
          role: "worker",
          wake_mode: "mentions",
          wait_since: 2,
          last_read_seq: 2,
          unread: 0,
          killed: false,
          status: "waiting",
          steps: 5,
          activity: "",
          activityKind: "",
          replied: false,
          replyAsk: "",
          narrator: false,
          roleWorker: false,
          failure: { kind: "quota", text: "429 RESOURCE_EXHAUSTED" },
          transcriptMtime: Date.now(),
          startedAt: new Date().toISOString(),
          lastStepAt: new Date().toISOString(),
          usage: { inputTokens: 1200, cacheReadTokens: 0, outputTokens: 200, totalTokens: 1400 },
          workspace_mode: "share",
          posts: 0,
          lastPostSeq: 0,
          lastPostTime: "",
          lastPostTs: null,
        },
      ],
      messages: [{ seq: 1, agent: "coordinator", text: "@all Start", time: "12:00:00", ts: Date.now(), mentions: [], all: true }],
      edges: [],
      triage: [],
      gateReadiness: {
        state: "verifying",
        pendingSeq: 1,
        nextAction: { kind: "verify", target: "scout", conversationId: "ctrl-scout-2", seq: 1, label: "Nudge @scout", prompt: "@scout Re #1: check" },
        stages: [{ key: "done", label: "[done]", count: 1, seq: 1 }],
      },
      usage: { inputTokens: 2000, cacheReadTokens: 0, outputTokens: 300, totalTokens: 2300 },
      capabilities: { canSendMessage: true, isSidecar: false, sseStream: false },
    };

    const traceRequests = [];
    const mockTraceSteps = Array.from({ length: 24 }, (_, idx) => {
      const isErr = idx === 21;
      const hasTool = idx % 2 === 0 || isErr;
      return {
        stepIndex: idx,
        type: "PLANNER_RESPONSE",
        status: isErr ? "ERROR" : "DONE",
        ts: Date.now() - (24 - idx) * 15_000,
        durationMs: isErr ? 1450 : 320 + idx * 10,
        model: "gemini-3-pro",
        thinking: idx === 0 ? "Bootstrap trace context" : `Evaluating step #${idx}`,
        content: idx === 0 ? "Initial bootstrap step." : idx === 23 ? "Final check complete." : "",
        error: isErr ? "QuotaError: 429 RESOURCE_EXHAUSTED\n  at callModel (~/sidecars/fleet_pane/runtime.mjs:88:5)" : null,
        toolCalls: hasTool
          ? [
              {
                name: isErr ? "run_command" : "read_file",
                summary: isErr ? "Run model probe command" : `Inspect step #${idx} target`,
                args: isErr
                  ? { CommandLine: "node scripts/probe-quota.mjs --check", WaitMsBeforeAsync: 5000 }
                  : { Path: "~/frontend/src/sidecar.ts", StartLine: 1, EndLine: 50 },
                status: isErr ? "ERROR" : "DONE",
                outputPreview: isErr
                  ? "stdout: probing quota...\nstderr: 429 RESOURCE_EXHAUSTED (exit 1)"
                  : "ok: read 50 lines",
              },
            ]
          : [],
        usage: { inputTokens: 800 + idx * 20, cacheReadTokens: 200, outputTokens: 110 },
      };
    });

    await rosterPage.route("**/api/transcript*", async (route) => {
      const u = new URL(route.request().url());
      const filter = u.searchParams.get("filter") || "all";
      const rawBefore = u.searchParams.get("before");
      const before = rawBefore !== null && rawBefore !== "" ? Number(rawBefore) : null;
      const limit = Math.max(1, Math.min(50, Number(u.searchParams.get("limit") || 20)));
      traceRequests.push({ filter, before, limit, member: u.searchParams.get("member") });
      const filtered = mockTraceSteps.filter((st) => {
        if (filter === "errors") return Boolean(st.error) || st.status === "ERROR";
        if (filter === "tools") return st.toolCalls.length > 0;
        return true;
      });
      const scoped = before !== null ? filtered.filter((st) => st.stepIndex < before) : filtered;
      const pageSteps = scoped.slice(-limit).reverse();
      const nextBefore = pageSteps.length > 0 ? pageSteps[pageSteps.length - 1].stepIndex : null;
      const hasMore = pageSteps.length > 0 && scoped.some((st) => st.stepIndex < nextBefore);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          member: u.searchParams.get("member") || "scout",
          conversationId: u.searchParams.get("conversationId") || "ctrl-coord-1",
          totalSteps: mockTraceSteps.length,
          nextBefore,
          hasMore,
          steps: pageSteps,
        }),
      });
    });

    await rosterPage.route("**/api/swarm*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockSnap) });
    });
    await rosterPage.route("**/api/control", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      controlCalls.push(body);
      if (body.op === "kill_worker" && !body.forceUnmerged) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "unmerged worktree", dirtyFiles: 2, ahead: 1 }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, op: body.op, coordinatorId: "ctrl-coord-1", directivePreview: body.op, deliveredAt: new Date().toISOString() }),
      });
    });

    await rosterPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await rosterPage.setViewportSize({ width: 380, height: 900 });
    await rosterPage.waitForSelector('[data-testid="inspect-trace-btn"][data-member="scout"]');
    await rosterPage.locator('[data-testid="inspect-trace-btn"][data-member="scout"]').click();
    await rosterPage.waitForSelector('[data-testid="forensic-trace-drawer"]');
    await rosterPage.waitForSelector('[data-testid="trace-step-23"]');
    const triageTraceOv = await rosterPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await rosterPage.keyboard.press("Escape");
    await rosterPage.waitForFunction(() => !document.querySelector('[data-testid="forensic-trace-drawer"]'));

    await rosterPage.locator('[data-testid="gate-verdict-toggle"]').click();
    await rosterPage.locator('[data-testid="gate-verdict-submit"]').click();
    await rosterPage.waitForFunction(() => !document.querySelector('[data-testid="gate-verdict-drawer"]'));

    await rosterPage.locator("#tab-roster").click();
    await rosterPage.waitForSelector("#panel-roster");

    await rosterPage.locator('[data-testid="inspect-trace-btn"][data-member="scout"]').click();
    await rosterPage.waitForSelector('[data-testid="forensic-trace-drawer"]');
    await rosterPage.locator('[data-testid="trace-load-older"]').click();
    await rosterPage.waitForSelector('[data-testid="trace-step-0"]');
    await rosterPage.locator('[data-testid="trace-filter-errors"]').click();
    await rosterPage.waitForSelector('[data-testid="trace-step-21"]');
    await rosterPage.locator('[data-testid="trace-step-toggle-21"]').click();
    await rosterPage.waitForSelector('[data-testid="trace-step-body-21"]');
    const traceErrTxt = await rosterPage.locator('[data-testid="trace-step-error-21"]').textContent();
    const traceArgsTxt = await rosterPage.locator('[data-testid="trace-tool-args-21-0"]').textContent();
    const traceOutTxt = await rosterPage.locator('[data-testid="trace-tool-output-21-0"]').textContent();
    const lightTraceOv = await rosterPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await rosterPage.locator('[data-testid="trace-close-btn"]').click();
    await rosterPage.waitForFunction(() => !document.querySelector('[data-testid="forensic-trace-drawer"]'));

    await rosterPage.locator('button[aria-label="Open settings"]').click();
    await rosterPage.locator('div[role="dialog"] button[role="radio"]:has-text("Dark")').click();
    await rosterPage.locator('button[aria-label="Close dialog"]').click();
    await rosterPage.locator('[data-testid="inspect-trace-btn"][data-member="scout"]').click();
    await rosterPage.waitForSelector('[data-testid="forensic-trace-drawer"]');
    const darkTraceOv = await rosterPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await rosterPage.locator('[data-testid="trace-close-btn"]').click();
    await rosterPage.waitForFunction(() => !document.querySelector('[data-testid="forensic-trace-drawer"]'));
    await rosterPage.locator('button[aria-label="Open settings"]').click();
    await rosterPage.locator('div[role="dialog"] button[role="radio"]:has-text("Light")').click();
    await rosterPage.locator('button[aria-label="Close dialog"]').click();
    await rosterPage.setViewportSize({ width: 360, height: 900 });

    await rosterPage.locator('[data-testid="toggle-spawn-worker"]').click();
    await rosterPage.fill('[data-testid="spawn-worker-name"]', "qa-bot");
    await rosterPage.selectOption('[data-testid="spawn-worker-workspace"]', "branch");
    await rosterPage.selectOption('[data-testid="spawn-worker-channel"]', "backend");
    await rosterPage.fill('[data-testid="spawn-worker-brief"]', "Verify control endpoints");
    await rosterPage.locator('[data-testid="spawn-worker-submit"]').click();
    await rosterPage.waitForFunction(() => !document.querySelector('[data-testid="spawn-worker-drawer"]'));

    await rosterPage.locator('[data-testid="switch-model-btn-scout"]').click();
    const reasonVal = await rosterPage.locator('[data-testid="switch-model-reason-scout"]').inputValue();
    await rosterPage.locator('[data-testid="switch-model-submit-scout"]').click();
    await rosterPage.waitForFunction(() => !document.querySelector('[data-testid="switch-model-drawer-scout"]'));

    await rosterPage.locator('[data-testid="kill-worker-btn-scout"]').click();
    allow409 = true;
    await rosterPage.locator('[data-testid="kill-worker-submit-scout"]').click();
    await rosterPage.waitForSelector('[data-testid="kill-worker-409-scout"]');
    const warnTxt = await rosterPage.locator('[data-testid="kill-worker-409-scout"]').textContent();
    await rosterPage.locator('[data-testid="kill-worker-force-scout"]').click();
    await rosterPage.waitForFunction(() => !document.querySelector('[data-testid="kill-worker-confirm-scout"]'));

    const ov360 = await rosterPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await rosterPage.close();

    const verdictCall = controlCalls.find((c) => c.op === "gate_verdict");
    const spawnCall = controlCalls.find((c) => c.op === "spawn_worker");
    const switchCall = controlCalls.find((c) => c.op === "switch_model");
    const forceKillCall = controlCalls.find((c) => c.op === "kill_worker" && c.forceUnmerged === true);
    return (
      verdictCall?.verdict === "verified" &&
      Boolean(spawnCall?.name === "qa-bot" && spawnCall.workspaceMode === "branch" && spawnCall.channel === "backend") &&
      reasonVal === "Quota exhausted" &&
      Boolean(switchCall?.member === "scout" && switchCall.model === "gemini-3-flash") &&
      Boolean(warnTxt?.includes("2 dirty files, 1 commits ahead")) &&
      Boolean(forceKillCall?.member === "scout") &&
      triageTraceOv <= 0 &&
      lightTraceOv <= 0 &&
      darkTraceOv <= 0 &&
      traceRequests.some((r) => r.before !== null) &&
      Boolean(traceErrTxt?.includes("429 RESOURCE_EXHAUSTED")) &&
      Boolean(traceArgsTxt?.includes("probe-quota.mjs")) &&
      Boolean(traceOutTxt?.includes("stderr: 429 RESOURCE_EXHAUSTED")) &&
      ov360 <= 0 &&
      rosterErrors.length === 0
    );
  });

  await check("Triage 409 Conflict reload-and-merge preserves local edits and renders deeply nested plan/view fields safely", async () => {
    const pPage = await ctx.newPage();
    await pPage.setViewportSize({ width: 340, height: 900 });
    const pErrs = [];
    let allow409 = false;
    pPage.on("pageerror", (e) => pErrs.push(e.message));
    pPage.on("console", (msg) => {
      if (msg.type() === "error") {
        if (allow409 && msg.text().includes("status of 409")) return;
        pErrs.push(msg.text());
      }
    });

    let diskEtag = "deep-v1";
    let diskPlan = {
      etag: diskEtag,
      goal: { title: "Nested Goal", line: { summary: "Deep line object" } },
      gate: "npm test",
      tasks: { dev: { description: "Inspect /home/demo/deep/file.ts" } },
      workstreams: [{ id: "ws-1", title: "Disk ws", owner: "dev", status: "running", note: { detail: "Nested note" } }],
      threads: [{ id: "th-1", title: { label: "Nested Thread" }, goal: { text: "Thread goal" }, tasks: ["dev", "dev"] }],
    };
    const postedIfMatches = [];

    await pPage.route("**/api/swarm*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId: "deep-coord-1",
          swarm: "deep-coord-1",
          member: "coordinator",
          etag: `snap-${diskEtag}`,
          id: "deep-coord-1",
          title: "Deep Plan Gate",
          head: 1,
          members: [
            {
              name: "coordinator",
              conversation_id: "deep-coord-1",
              model: "gemini-3-pro",
              role: "coordinator",
              wake_mode: "mentions",
              wait_since: 1,
              last_read_seq: 1,
              unread: 0,
              killed: false,
              status: "waiting",
              steps: 1,
              activity: "",
              activityKind: "",
              replied: false,
              replyAsk: "",
              narrator: false,
              roleWorker: false,
              failure: null,
              transcriptMtime: Date.now(),
              startedAt: new Date().toISOString(),
              lastStepAt: new Date().toISOString(),
              usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 20, totalTokens: 120 },
              posts: 1,
              lastPostSeq: 1,
              lastPostTime: "12:00:00",
              lastPostTs: Date.now(),
            },
          ],
          messages: [{ seq: 1, agent: "coordinator", text: "@all Deep test", time: "12:00:00", ts: Date.now(), mentions: [], all: true }],
          edges: [],
          view: {
            exists: true,
            source: "narrator",
            json: {
              headline: { text: "Deep narrator headline" },
              phase: "verifying",
              running_summary: ["Checking nested", "view fields"],
              now: { dev: ["step A", { detail: "step B in /home/demo/app.ts" }] },
              attention: [{ member: { name: "dev" }, detail: { summary: "Nested alert" } }],
            },
          },
          plan: diskPlan,
          frames: [],
          triage: [{ id: "t-weird", kind: "stuck", severity: "unknown_sev", member: "dev", conversationId: "", seq: 1, title: "Weird severity item", detail: "Check nested", suggestedPrompt: "@dev status", timestamp: Date.now() }],
          usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 20, totalTokens: 120 },
          capabilities: { canSendMessage: false, isSidecar: false, sseStream: false },
        }),
      });
    });

    await pPage.route("**/api/plan", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      postedIfMatches.push(body.ifMatch);
      if (body.ifMatch !== diskEtag) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "plan changed on disk", plan: diskPlan, etag: diskEtag }),
        });
        return;
      }
      diskEtag = "deep-v3";
      diskPlan = { ...diskPlan, etag: diskEtag, gate: body.patch?.gate || diskPlan.gate };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, plan: diskPlan, etag: diskEtag, notified: false }),
      });
    });

    await pPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await pPage.waitForSelector('[data-testid="narrator-view-card"]');
    const initTxt = await pPage.locator("#panel-triage").textContent();

    await pPage.locator('[data-testid="edit-plan-btn"]').click();
    await pPage.waitForSelector('[data-testid="plan-editor"]');
    await pPage.fill('[data-testid="plan-gate-input"]', "npm run custom-gate");

    // Mutate disk plan concurrently before saving
    diskEtag = "deep-v2";
    diskPlan = {
      ...diskPlan,
      etag: diskEtag,
      goal: { title: "Nested Goal", line: "Concurrent disk goal" },
      workstreams: [
        ...diskPlan.workstreams,
        { id: "ws-2", title: "Concurrent disk ws", owner: "qa", status: "done" },
      ],
    };

    allow409 = true;
    await pPage.locator('[data-testid="plan-save-btn"]').click();
    await pPage.waitForSelector('[data-testid="plan-conflict-banner"]');
    const bannerTxt = await pPage.locator('[data-testid="plan-conflict-banner"]').textContent();
    await pPage.locator('[data-testid="plan-conflict-merge"]').click();
    await pPage.waitForFunction(() => !document.querySelector('[data-testid="plan-conflict-banner"]'));

    const preservedGate = await pPage.locator('[data-testid="plan-gate-input"]').inputValue();
    const mergedGoal = await pPage.locator('[data-testid="plan-goal-input"]').inputValue();
    const mergedWs1 = await pPage.locator('[data-testid="plan-ws-title-1"]').inputValue();

    await pPage.locator('[data-testid="plan-save-btn"]').click();
    await pPage.waitForSelector('[data-testid="swarm-plan-card"]');
    const ov340 = await pPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await pPage.close();

    return (
      Boolean(initTxt?.includes("Deep line object") && initTxt.includes("Nested note") && initTxt.includes("Nested Thread") && initTxt.includes("Deep narrator headline") && initTxt.includes("Nested alert") && initTxt.includes("~/deep/file.ts") && !initTxt.includes("[object Object]") && !initTxt.includes("/home/")) &&
      Boolean(bannerTxt?.includes("409 Conflict") && bannerTxt.includes("Concurrent disk goal")) &&
      preservedGate === "npm run custom-gate" &&
      mergedGoal === "Concurrent disk goal" &&
      mergedWs1 === "Concurrent disk ws" &&
      postedIfMatches[0] === "deep-v1" &&
      postedIfMatches[1] === "deep-v2" &&
      ov340 <= 0 &&
      pErrs.length === 0
    );
  });

  await check("Worktrees 340px collision pill wrapping and ff_merge / remove_worktree / rebase / dry_run error banners work with 0px overflow", async () => {
    const wtPage = await ctx.newPage();
    await wtPage.setViewportSize({ width: 340, height: 900 });
    const wtErrs = [];
    let allow409 = false;
    wtPage.on("pageerror", (e) => wtErrs.push(e.message));
    wtPage.on("console", (msg) => {
      if (msg.type() === "error") {
        if (allow409 && msg.text().includes("status of 409")) return;
        wtErrs.push(msg.text());
      }
    });

    await wtPage.route(/\/api\/worktrees(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          roots: [{ path: "/mock/repo", uri: "file:///mock/repo", isGit: true, count: 2, error: "" }],
          collisions: [
            {
              file: "frontend/src/components/WorktreesView.tsx",
              worktrees: ["/mock/alpha", "/mock/beta"],
              branches: ["feat/very-long-branch-alpha-lane", "feat/very-long-branch-beta-lane"],
              kind: "mixed",
            },
          ],
          worktrees: [
            {
              id: "w-main",
              root: "/mock/repo",
              name: "repo",
              path: "/mock/repo",
              uri: "file:///mock/repo",
              isMain: true,
              exists: true,
              bare: false,
              detached: false,
              locked: false,
              prunable: false,
              branch: "main",
              head: "1111aaa",
              clean: true,
              landStatus: "main",
              mergeability: "main",
              dirtyFiles: 0,
              untrackedFiles: 0,
              stagedFiles: 0,
              commits: [],
              lastCommitSha: "1111aaa",
              lastCommitSubject: "root",
              lastCommitAt: Date.now(),
            },
            {
              id: "w-alpha",
              root: "/mock/repo",
              name: "alpha",
              path: "/mock/alpha",
              uri: "file:///mock/alpha",
              isMain: false,
              exists: true,
              bare: false,
              detached: false,
              locked: false,
              prunable: false,
              branch: "feat/very-long-branch-alpha-lane",
              head: "2222bbb",
              clean: true,
              baseBranch: "main",
              ahead: 2,
              behind: 1,
              landStatus: "rebase",
              mergeability: "clean",
              dirtyFiles: 0,
              untrackedFiles: 0,
              stagedFiles: 0,
              files: [],
              branchFiles: ["frontend/src/components/WorktreesView.tsx"],
              commits: [{ sha: "2222bbb", subject: "feat: alpha", authorTime: "1m ago" }],
              lastCommitSha: "2222bbb",
              lastCommitSubject: "feat: alpha",
              lastCommitAt: Date.now(),
            },
          ],
          rejected: [],
        }),
      });
    });

    await wtPage.route(/\/api\/worktrees\/action(\?.*)?$/, async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      if (body.action === "dry_run_merge") {
        // Real backend returns HTTP 200 with ok:true, status:"conflict", clean:false
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            action: "dry_run_merge",
            status: "conflict",
            clean: false,
            conflicts: ["frontend/src/components/WorktreesView.tsx"],
            message: "1 conflict(s) merging into main",
          }),
        });
        return;
      }
      if (body.action === "ff_merge") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, action: "ff_merge", status: "not_ff", message: "Branch cannot be fast-forward merged" }),
        });
        return;
      }
      if (body.action === "remove_worktree") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, action: "remove_worktree", status: "unmerged", message: "Worktree has unmerged commits" }),
        });
        return;
      }
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          action: "rebase",
          status: "conflict",
          aborted: true,
          conflicts: ["frontend/src/components/WorktreesView.tsx"],
          message: "Rebase aborted due to conflicts",
        }),
      });
    });

    await wtPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await wtPage.locator("#tab-worktrees").click();
    await wtPage.fill('input[aria-label="Workspace repository path"]', "/mock/repo");
    await wtPage.locator('#panel-worktrees button:has-text("Inspect")').click();
    await wtPage.waitForSelector('[data-testid="worktree-collisions-banner"]');

    const branch = "feat/very-long-branch-alpha-lane";
    // Dry-run HTTP 200 conflict must render alert banner (not green success)
    await wtPage.locator(`[data-testid="wt-action-dry-run-${branch}"]`).click();
    await wtPage.waitForSelector(`[data-testid="wt-action-result-${branch}"][role="alert"]`);

    // FF Merge 409 not_ff
    allow409 = true;
    await wtPage.locator(`[data-testid="wt-action-ff-merge-${branch}"]`).click();
    await wtPage.locator(`[data-testid="wt-confirm-submit-${branch}"]`).click();
    await wtPage.waitForFunction((b) => (document.querySelector(`[data-testid="wt-action-result-${b}"]`)?.textContent || "").includes("Run Rebase first"), branch);

    // Remove Clean 409 unmerged
    await wtPage.locator(`[data-testid="wt-action-remove-${branch}"]`).click();
    await wtPage.locator(`[data-testid="wt-confirm-submit-${branch}"]`).click();
    await wtPage.waitForFunction((b) => (document.querySelector(`[data-testid="wt-action-result-${b}"]`)?.textContent || "").includes("unmerged commits"), branch);

    // Rebase 409 aborted
    await wtPage.locator(`[data-testid="wt-action-rebase-${branch}"]`).click();
    await wtPage.locator(`[data-testid="wt-confirm-submit-${branch}"]`).click();
    await wtPage.waitForFunction((b) => (document.querySelector(`[data-testid="wt-action-result-${b}"]`)?.textContent || "").includes("aborted"), branch);
    const rebaseTxt = await wtPage.locator(`[data-testid="wt-action-result-${branch}"]`).textContent();

    await wtPage.locator(`[data-testid="wt-action-dismiss-${branch}"]`).click();
    const dismissed = (await wtPage.locator(`[data-testid="wt-action-result-${branch}"]`).count()) === 0;
    const ov340 = await wtPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await wtPage.close();

    return (
      Boolean(rebaseTxt?.includes("aborted") && rebaseTxt.includes("Working tree restored cleanly")) &&
      dismissed &&
      ov340 <= 0 &&
      wtErrs.length === 0
    );
  });

  await check("Board empty channel state, #seq backlink filter-recovery highlight, double-submit lock, and missing-coordinator error", async () => {
    const bPage = await ctx.newPage();
    await bPage.setViewportSize({ width: 340, height: 900 });
    const bErrs = [];
    const controlPosts = [];
    let allow404 = false;
    bPage.on("pageerror", (e) => bErrs.push(e.message));
    bPage.on("console", (msg) => {
      if (msg.type() === "error") {
        if (allow404 && msg.text().includes("status of 404")) return;
        bErrs.push(msg.text());
      }
    });

    await bPage.route("**/api/swarm*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId: "no-coord-1",
          swarm: "no-coord-1",
          member: "worker-a",
          etag: "nc-1",
          id: "no-coord-1",
          title: "No Coordinator Gate",
          head: 2,
          channels: [
            { name: "backend", topic: "Backend APIs", created_by: "worker-a", archived: false },
            { name: "empty-qa", topic: "QA staging channel", created_by: "worker-a", archived: false },
          ],
          members: [
            {
              name: "worker-a",
              conversation_id: "no-coord-worker-a",
              model: "gemini-3-pro",
              role: "worker",
              wake_mode: "mentions",
              wait_since: 2,
              last_read_seq: 2,
              unread: 0,
              killed: false,
              status: "waiting",
              steps: 4,
              activity: "",
              activityKind: "",
              replied: false,
              replyAsk: "",
              narrator: false,
              roleWorker: false,
              failure: null,
              transcriptMtime: Date.now(),
              startedAt: new Date().toISOString(),
              lastStepAt: new Date().toISOString(),
              usage: { inputTokens: 500, cacheReadTokens: 0, outputTokens: 100, totalTokens: 600 },
              posts: 2,
              lastPostSeq: 2,
              lastPostTime: "12:02:00",
              lastPostTs: Date.now(),
            },
          ],
          messages: [
            { seq: 1, agent: "worker-a", text: "Root spec in #main", time: "12:00:00", ts: Date.now() - 60000, mentions: [], all: false },
            { seq: 2, agent: "worker-a", channel: "backend", text: "Implemented #1 endpoint", time: "12:02:00", ts: Date.now(), mentions: [], all: false },
          ],
          replyRefs: { 1: [2] },
          edges: [],
          triage: [],
          usage: { inputTokens: 500, cacheReadTokens: 0, outputTokens: 100, totalTokens: 600 },
          capabilities: { canSendMessage: true, isSidecar: false, sseStream: false },
        }),
      });
    });

    await bPage.route("**/api/control", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      controlPosts.push(body);
      await new Promise((r) => setTimeout(r, 120));
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Coordinator conversation not found" }) });
    });

    await bPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await bPage.locator("#tab-board").click();
    await bPage.waitForSelector('[data-testid="board-channel-tabs"]');

    // 1. Empty channel state
    await bPage.locator('[data-testid="channel-tab-empty-qa"]').click();
    await bPage.waitForSelector('[data-testid="board-empty-channel"]');
    const emptyTxt = await bPage.locator('[data-testid="board-empty-channel"]').textContent();

    // 2. Open composer from empty channel -> missing coordinator warning + double-submit lock + 404 inline error
    await bPage.locator('[data-testid="board-empty-channel-post"]').click();
    await bPage.waitForSelector('[data-testid="board-missing-coordinator"]');
    await bPage.fill('[data-testid="board-composer-input"]', "First empty channel post");
    await bPage.locator('[data-testid="board-composer-stage"]').click();
    allow404 = true;
    await bPage.evaluate(() => {
      const btn = document.querySelector('[data-testid="board-composer-submit"]');
      btn?.click();
      btn?.click();
    });
    await bPage.waitForSelector('[data-testid="board-composer-error"]');
    const ctrlErr = await bPage.locator('[data-testid="board-composer-error"]').textContent();
    await bPage.locator('[data-testid="board-composer-close"]').click();

    // 3. Filter to #backend and click #1 backlink -> clears filter & highlights #1
    await bPage.locator('[data-testid="channel-tab-backend"]').click();
    await bPage.locator('#panel-board button:text-is("#1")').first().click();
    await bPage.waitForSelector('[data-seq="1"][data-highlighted="true"]');
    const ov340 = await bPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await bPage.close();

    return (
      Boolean(emptyTxt?.includes("No posts in #empty-qa yet.") && emptyTxt.includes("QA staging channel")) &&
      controlPosts.length === 1 &&
      Boolean(ctrlErr?.includes("Coordinator conversation not found")) &&
      ov340 <= 0 &&
      bErrs.length === 0
    );
  });

  await check("Roster double-submit locks and missing-coordinator inline error recovery", async () => {
    const rPage = await ctx.newPage();
    await rPage.setViewportSize({ width: 340, height: 900 });
    const rErrs = [];
    const controlPosts = [];
    let allow404 = false;
    rPage.on("pageerror", (e) => rErrs.push(e.message));
    rPage.on("console", (msg) => {
      if (msg.type() === "error") {
        if (allow404 && msg.text().includes("status of 404")) return;
        rErrs.push(msg.text());
      }
    });

    await rPage.route("**/api/swarm*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId: "no-coord-1",
          swarm: "no-coord-1",
          member: "worker-a",
          etag: "nc-r1",
          id: "no-coord-1",
          title: "Roster No Coord",
          head: 1,
          members: [
            {
              name: "worker-a",
              conversation_id: "no-coord-worker-a",
              model: "gemini-3-pro",
              role: "worker",
              wake_mode: "mentions",
              wait_since: 1,
              last_read_seq: 1,
              unread: 0,
              killed: false,
              status: "waiting",
              steps: 4,
              activity: "",
              activityKind: "",
              replied: false,
              replyAsk: "",
              narrator: false,
              roleWorker: false,
              failure: null,
              transcriptMtime: Date.now(),
              startedAt: new Date().toISOString(),
              lastStepAt: new Date().toISOString(),
              usage: { inputTokens: 500, cacheReadTokens: 0, outputTokens: 100, totalTokens: 600 },
              posts: 1,
              lastPostSeq: 1,
              lastPostTime: "12:00:00",
              lastPostTs: Date.now(),
            },
          ],
          messages: [{ seq: 1, agent: "worker-a", text: "Ready", time: "12:00:00", ts: Date.now(), mentions: [], all: false }],
          edges: [],
          triage: [],
          usage: { inputTokens: 500, cacheReadTokens: 0, outputTokens: 100, totalTokens: 600 },
          capabilities: { canSendMessage: true, isSidecar: false, sseStream: false },
        }),
      });
    });

    await rPage.route("**/api/control", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      controlPosts.push(body);
      await new Promise((r) => setTimeout(r, 120));
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Coordinator conversation not found" }) });
    });

    await rPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await rPage.locator("#tab-roster").click();
    await rPage.waitForSelector("#panel-roster");

    await rPage.locator('[data-testid="toggle-spawn-worker"]').click();
    await rPage.waitForSelector('[data-testid="roster-missing-coordinator"]');
    await rPage.fill('[data-testid="spawn-worker-name"]', "qa-lock");
    await rPage.fill('[data-testid="spawn-worker-brief"]', "Test lock");
    allow404 = true;
    await rPage.evaluate(() => {
      const btn = document.querySelector('[data-testid="spawn-worker-submit"]');
      btn?.click();
      btn?.click();
    });
    await rPage.waitForSelector('[data-testid="spawn-worker-error"]');
    const spawnErr = await rPage.locator('[data-testid="spawn-worker-error"]').textContent();

    await rPage.locator('[data-testid="switch-model-btn-worker-a"]').click();
    await rPage.evaluate(() => {
      const btn = document.querySelector('[data-testid="switch-model-submit-worker-a"]');
      btn?.click();
      btn?.click();
    });
    await rPage.waitForSelector('[data-testid="switch-model-error"]');
    const switchErr = await rPage.locator('[data-testid="switch-model-error"]').textContent();

    await rPage.locator('[data-testid="kill-worker-btn-worker-a"]').click();
    await rPage.locator('[data-testid="kill-worker-submit-worker-a"]').click();
    await rPage.waitForSelector('[data-testid="kill-worker-error"]');
    const killErr = await rPage.locator('[data-testid="kill-worker-error"]').textContent();

    const ov340 = await rPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await rPage.close();

    return (
      controlPosts.length === 3 &&
      Boolean(spawnErr?.includes("Coordinator conversation not found")) &&
      Boolean(switchErr?.includes("Coordinator conversation not found")) &&
      Boolean(killErr?.includes("Coordinator conversation not found")) &&
      ov340 <= 0 &&
      rErrs.length === 0
    );
  });

  await check("SidecarApp !canSse delta long-poll merges incremental delta, deduplicates seq, and skips redundant /api/swarms", async () => {
    const dPage = await ctx.newPage();
    await dPage.setViewportSize({ width: 340, height: 900 });
    const dErrs = [];
    const deltaCalls = [];
    let swarmHits = 0;
    let swarmsHits = 0;
    let deltaStep = 0;
    let releaseLastDelta = null;

    dPage.on("pageerror", (e) => dErrs.push(e.message));
    dPage.on("console", (msg) => {
      if (msg.type() === "error") dErrs.push(msg.text());
    });

    const baseMembers = [
      {
        name: "coordinator",
        conversation_id: "delta-coord-1",
        model: "gemini-3-pro",
        role: "coordinator",
        wake_mode: "mentions",
        wait_since: 2,
        last_read_seq: 2,
        unread: 0,
        killed: false,
        status: "waiting",
        steps: 4,
        activity: "",
        activityKind: "",
        replied: false,
        replyAsk: "",
        narrator: false,
        roleWorker: false,
        failure: null,
        transcriptMtime: Date.now(),
        startedAt: new Date().toISOString(),
        lastStepAt: new Date().toISOString(),
        usage: { inputTokens: 800, cacheReadTokens: 0, outputTokens: 100, totalTokens: 900 },
        posts: 1,
        lastPostSeq: 1,
        lastPostTime: "12:00:00",
        lastPostTs: Date.now(),
      },
      {
        name: "builder",
        conversation_id: "delta-builder-2",
        model: "gemini-3-pro",
        role: "worker",
        wake_mode: "mentions",
        wait_since: 1,
        last_read_seq: 2,
        unread: 0,
        killed: false,
        status: "working",
        steps: 6,
        activity: "Building delta channel",
        activityKind: "tool",
        replied: false,
        replyAsk: "",
        narrator: false,
        roleWorker: false,
        failure: null,
        transcriptMtime: Date.now(),
        startedAt: new Date().toISOString(),
        lastStepAt: new Date().toISOString(),
        usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 200, totalTokens: 1200 },
        posts: 1,
        lastPostSeq: 2,
        lastPostTime: "12:01:00",
        lastPostTs: Date.now(),
      },
    ];

    await dPage.route("**/api/swarms*", async (route) => {
      swarmsHits += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          swarms: [
            {
              id: "delta-coord-1",
              title: "Delta Sidecar Gate",
              appData: "gate",
              head: deltaStep >= 2 ? 3 : 2,
              memberCount: 2,
              activeCount: deltaStep >= 2 ? 0 : 1,
              waitingCount: deltaStep >= 2 ? 2 : 1,
              killedCount: 0,
              triageCount: 0,
              totalTokens: 2100,
              hasPlan: false,
              lastActivityTs: Date.now(),
            },
          ],
          defaultConversationId: "delta-coord-1",
        }),
      });
    });

    await dPage.route(/\/api\/swarm(\?.*)?$/, async (route) => {
      swarmHits += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId: "delta-coord-1",
          swarm: "delta-coord-1",
          member: "coordinator",
          etag: "delta-v1",
          id: "delta-coord-1",
          title: "Delta Sidecar Gate",
          head: 2,
          members: baseMembers,
          messages: [
            { seq: 1, agent: "coordinator", text: "@builder Start delta task", time: "12:00:00", ts: Date.now() - 5000, mentions: ["builder"], all: false },
            { seq: 2, agent: "builder", text: "@coordinator Working on #1", time: "12:01:00", ts: Date.now() - 2000, mentions: ["coordinator"], all: false },
          ],
          replyRefs: { 1: [2] },
          edges: [{ from: "coordinator", to: "builder", count: 1, direct: 1, viaAll: 0 }],
          triage: [],
          usage: { inputTokens: 1800, cacheReadTokens: 0, outputTokens: 300, totalTokens: 2100 },
          capabilities: { canSendMessage: true, isSidecar: true, sseStream: false, deltaStream: true },
        }),
      });
    });

    await dPage.route(/\/api\/swarm\/delta(\?.*)?$/, async (route) => {
      const reqUrl = new URL(route.request().url());
      deltaStep += 1;
      deltaCalls.push({
        step: deltaStep,
        since: reqUrl.searchParams.get("since"),
        etag: reqUrl.searchParams.get("etag"),
        waitMs: reqUrl.searchParams.get("waitMs"),
      });

      if (deltaStep === 1) {
        await new Promise((r) => setTimeout(r, 270));
        await route
          .fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true, unchanged: true, etag: "delta-v1", head: 2 }),
          })
          .catch(() => {});
        return;
      }

      if (deltaStep === 2) {
        const updatedMembers = [
          baseMembers[0],
          { ...baseMembers[1], status: "waiting", activity: "", posts: 2, lastPostSeq: 3, lastPostTime: "12:02:00" },
        ];
        await route
          .fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              mode: "delta",
              unchanged: false,
              conversationId: "delta-coord-1",
              swarm: "delta-coord-1",
              etag: "delta-v2",
              since: 2,
              head: 3,
              messagesDelta: [
                { seq: 2, agent: "builder", text: "@coordinator Working on #1", time: "12:01:00", ts: Date.now() - 2000, mentions: ["coordinator"], all: false },
                { seq: 3, agent: "builder", text: "@coordinator [done] Re #2: Delta update landed", time: "12:02:00", ts: Date.now(), mentions: ["coordinator"], all: false },
              ],
              replyRefsDelta: { 2: [3] },
              edgesDelta: [{ from: "builder", to: "coordinator", count: 1, direct: 1, viaAll: 0 }],
              members: updatedMembers,
              triage: [],
              usage: { inputTokens: 2000, cacheReadTokens: 0, outputTokens: 400, totalTokens: 2400 },
            }),
          })
          .catch(() => {});
        return;
      }

      await new Promise((r) => {
        releaseLastDelta = r;
        setTimeout(r, 5000);
      });
      await route
        .fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, unchanged: true, etag: "delta-v2", head: 3 }),
        })
        .catch(() => {});
    });

    await dPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await dPage.locator("#tab-board").click();
    await dPage.waitForFunction(() => (document.querySelector("#panel-board")?.textContent || "").includes("Delta update landed"));

    const seq2Count = await dPage.locator('#panel-board [data-seq="2"]').count();
    const replyRefTxt = await dPage.locator('[data-testid="board-reply-refs-2"]').textContent();
    const ov340 = await dPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    // Pause updates via Settings to verify abort-safe shutdown of parked delta request
    await dPage.locator('button[aria-label="Open settings"]').click();
    await dPage.locator('div[role="dialog"] button[role="radio"]:has-text("Paused")').click();
    await dPage.locator('button[aria-label="Close dialog"]').click();
    await dPage.waitForSelector('[data-testid="sse-resync-banner"]');

    releaseLastDelta?.();
    await dPage.close();

    return (
      swarmHits === 1 &&
      swarmsHits === 2 &&
      deltaCalls.length >= 2 &&
      deltaCalls[0].since === "2" &&
      deltaCalls[0].etag === "delta-v1" &&
      deltaCalls[0].waitMs === "20000" &&
      deltaCalls[1].since === "2" &&
      seq2Count === 1 &&
      Boolean(replyRefTxt?.includes("#3")) &&
      ov340 <= 0 &&
      dErrs.length === 0
    );
  });

  await check("SSE ping consumes /api/swarm/delta (including mode full fallback) without re-fetching /api/swarm", async () => {
    const sPage = await ctx.newPage();
    const sErrs = [];
    let swarmHits = 0;
    const deltaCalls = [];

    sPage.on("pageerror", (e) => sErrs.push(e.message));
    sPage.on("console", (msg) => {
      if (msg.type() === "error") sErrs.push(msg.text());
    });

    await sPage.route("**/api/swarms*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          swarms: [
            {
              id: "sse-delta-1",
              title: "SSE Ping Delta Gate",
              appData: "gate",
              head: 1,
              memberCount: 1,
              activeCount: 0,
              waitingCount: 1,
              killedCount: 0,
              triageCount: 0,
              totalTokens: 500,
              hasPlan: false,
              lastActivityTs: Date.now(),
            },
          ],
          defaultConversationId: "sse-delta-1",
        }),
      });
    });

    await sPage.route(/\/api\/swarm(\?.*)?$/, async (route) => {
      swarmHits += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId: "sse-delta-1",
          swarm: "sse-delta-1",
          member: "coordinator",
          etag: "s-v1",
          id: "sse-delta-1",
          title: "SSE Ping Delta Gate",
          head: 1,
          members: [
            {
              name: "coordinator",
              conversation_id: "sse-delta-1",
              model: "gemini-3-pro",
              role: "coordinator",
              wake_mode: "mentions",
              wait_since: 1,
              last_read_seq: 1,
              unread: 0,
              killed: false,
              status: "waiting",
              steps: 1,
              activity: "",
              activityKind: "",
              replied: false,
              replyAsk: "",
              narrator: false,
              roleWorker: false,
              failure: null,
              transcriptMtime: Date.now(),
              startedAt: new Date().toISOString(),
              lastStepAt: new Date().toISOString(),
              usage: { inputTokens: 400, cacheReadTokens: 0, outputTokens: 100, totalTokens: 500 },
              posts: 1,
              lastPostSeq: 1,
              lastPostTime: "12:00:00",
              lastPostTs: Date.now(),
            },
          ],
          messages: [{ seq: 1, agent: "coordinator", text: "@all Initial SSE post", time: "12:00:00", ts: Date.now(), mentions: [], all: true }],
          replyRefs: {},
          edges: [],
          triage: [],
          usage: { inputTokens: 400, cacheReadTokens: 0, outputTokens: 100, totalTokens: 500 },
          capabilities: { canSendMessage: false, isSidecar: false, sseStream: true, deltaStream: true },
        }),
      });
    });

    await sPage.route(/\/api\/swarm\/stream(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
        body: 'event: swarm\ndata: {"conversationId":"sse-delta-1","swarm":"sse-delta-1","etag":"s-v1"}\n\nevent: ping\ndata: {"ts":1000}\n\n',
      });
    });

    await sPage.route(/\/api\/swarm\/delta(\?.*)?$/, async (route) => {
      const reqUrl = new URL(route.request().url());
      deltaCalls.push({
        since: reqUrl.searchParams.get("since"),
        etag: reqUrl.searchParams.get("etag"),
        waitMs: reqUrl.searchParams.get("waitMs"),
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          mode: "full",
          unchanged: false,
          conversationId: "sse-delta-1",
          swarm: "sse-delta-1",
          member: "coordinator",
          etag: "s-v2",
          id: "sse-delta-1",
          title: "SSE Ping Delta Gate",
          head: 2,
          members: [
            {
              name: "coordinator",
              conversation_id: "sse-delta-1",
              model: "gemini-3-pro",
              role: "coordinator",
              wake_mode: "mentions",
              wait_since: 2,
              last_read_seq: 2,
              unread: 0,
              killed: false,
              status: "waiting",
              steps: 2,
              activity: "",
              activityKind: "",
              replied: false,
              replyAsk: "",
              narrator: false,
              roleWorker: false,
              failure: null,
              transcriptMtime: Date.now(),
              startedAt: new Date().toISOString(),
              lastStepAt: new Date().toISOString(),
              usage: { inputTokens: 500, cacheReadTokens: 0, outputTokens: 150, totalTokens: 650 },
              posts: 2,
              lastPostSeq: 2,
              lastPostTime: "12:01:00",
              lastPostTs: Date.now(),
            },
          ],
          messages: [
            { seq: 1, agent: "coordinator", text: "@all Initial SSE post", time: "12:00:00", ts: Date.now(), mentions: [], all: true },
            { seq: 2, agent: "coordinator", text: "@all SSE ping delta full", time: "12:01:00", ts: Date.now(), mentions: [], all: true },
          ],
          replyRefs: {},
          edges: [],
          triage: [],
          usage: { inputTokens: 500, cacheReadTokens: 0, outputTokens: 150, totalTokens: 650 },
          capabilities: { canSendMessage: false, isSidecar: false, sseStream: true, deltaStream: true },
        }),
      });
    });

    await sPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await sPage.locator("#tab-board").click();
    await sPage.waitForFunction(() => (document.querySelector("#panel-board")?.textContent || "").includes("SSE ping delta full"));
    await sPage.close();

    return (
      swarmHits === 1 &&
      deltaCalls.length >= 1 &&
      deltaCalls[0].since === "1" &&
      deltaCalls[0].waitMs === "0" &&
      sErrs.length === 0
    );
  });

  await check("addArtifactComment bridge helper is wired without error", async () => {
    return await page.evaluate(() => {
      if (typeof window.sidecar?.ui?.addArtifactComment !== "function") return false;
      window.sidecar.ui.addArtifactComment("Fleet gate check");
      return true;
    });
  });

  // 26-28: Clean runtime guarantees
  await check("zero console errors", () => consoleErrors.length === 0);
  await check("zero uncaught page errors", () => pageErrors.length === 0);
  await check("zero external network requests and failed local requests", () => externalRequests.length === 0 && failedRequests.length === 0);

  await ctx.close();
});

await browser.close();
