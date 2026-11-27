// Playwright control-room verification gate for Fleet v1.0 Antigravity Sidecar.
// Verifies 380x900 sidebar & 1440x900 desktop across Light & Dark themes (28 checks).
import { chromium } from "playwright-core";
import { BASE, CHROME_LAUNCH_OPTS, REPO_DIR, runChecks } from "./fixture.mjs";

const browser = await chromium.launch(CHROME_LAUNCH_OPTS);

await runChecks("gate", async (check) => {
  const ctx = await browser.newContext({ viewport: { width: 380, height: 900 } });
  const newMockPage = async () => {
    const p = await ctx.newPage();
    await p.route("**/api/portfolio*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, totalCostUsd: 0, totalTokens: 0, activeSwarms: 0, urgentCount: 0, urgentTriage: [], swarms: [] }) });
    });
    await p.route("**/api/checkpoints*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, checkpoints: [] }) });
    });
    return p;
  };
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
    if (errText === "net::ERR_ABORTED" && /\/api\/swarm(s|\/stream|\/delta)?(\?|$)/.test(req.url())) return;
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
    const nativePage = await newMockPage();
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

  await check("triage Token Burn Guard Strip renders $ spend, cache-hit %, share %, and suppresses High burn below $0.10", async () => {
    const strip = page.locator('#panel-triage [data-testid="token-burn-strip"]');
    if ((await strip.count()) !== 1) return false;
    const txt = (await strip.textContent()) || "";
    const burnUsd = await strip.locator('[data-testid="burn-total-usd"]').textContent();
    const burnCache = await strip.locator('[data-testid="burn-cache-hit"]').textContent();
    const highCount = await strip.locator('[data-testid="high-burn-badge"]').count();
    return (
      txt.includes("Token burn") &&
      txt.includes("builder") &&
      burnUsd === "$0.03" &&
      Boolean(burnCache?.includes("cache hit")) &&
      /Top @builder \d+%/.test(txt) &&
      highCount === 0
    );
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
    const realBurnUsd = await page.locator('#panel-roster [data-testid="burn-total-usd"]').textContent();
    const realBurnCache = await page.locator('#panel-roster [data-testid="burn-cache-hit"]').textContent();
    const realBuilderCap = await page.locator('#panel-roster [data-testid="roster-ctx-cap-builder"]').textContent();
    const realBuilderCost = await page.locator('#panel-roster [data-testid="roster-cost-builder"]').textContent();
    const realBuilderCache = await page.locator('#panel-roster [data-testid="roster-cache-hit-builder"]').textContent();
    const realDelta = await page.evaluate(async () => {
      const r = await fetch("/api/swarm/delta?conversationId=11111111-1111-1111-1111-111111111111&since=0");
      return r.json();
    });
    if (
      !txt ||
      !txt.includes("Token burn") ||
      !txt.includes("builder") ||
      !/\d+%/.test(txt) ||
      realBurnUsd !== "$0.03" ||
      !realBurnCache?.includes("cache hit") ||
      realBuilderCap !== "cap 1M" ||
      realBuilderCost !== "$0.03" ||
      !realBuilderCache?.includes("cache hit") ||
      !realDelta?.cost?.pricingKnown ||
      !realDelta?.byModel?.["gemini-3-pro"] ||
      realDelta?.contextLimit !== 1000000
    ) {
      return false;
    }

    const costPage = await newMockPage();
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

    // E2/E3 verification: collisions banner, swarmOwner, branchFiles/working/conflict diff + pagination, squash_merge/merge_commit & @owner routing
    const wtPage = await newMockPage();
    const wtErrors = [];
    const diffModesSeen = [];
    const diffOffsetsSeen = [];
    const actionsSeen = [];
    const actionBodies = [];
    const controlPosts = [];
    let wtConvSeen = "";
    let diffFetchCount = 0;
    let expect409 = false;
    wtPage.on("pageerror", (err) => wtErrors.push(err.message));
    wtPage.on("console", (msg) => {
      if (msg.type() === "error") {
        if (expect409 && msg.text().includes("status of 409")) return;
        wtErrors.push(msg.text());
      }
    });

    await wtPage.route(/\/api\/swarm(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId: "e3-wt-swarm",
          swarm: "e3-wt-swarm",
          member: "coordinator",
          etag: "e3-wt-v1",
          id: "e3-wt-swarm",
          title: "E3 Worktrees Gate",
          head: 1,
          members: [
            {
              name: "coordinator",
              conversation_id: "e3-wt-swarm",
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
          messages: [{ seq: 1, agent: "coordinator", text: "@all E3 worktree check", time: "12:00:00", ts: Date.now(), mentions: [], all: true }],
          edges: [],
          triage: [],
          usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 20, totalTokens: 120 },
          capabilities: { canSendMessage: true, isSidecar: false, sseStream: false, deltaStream: false },
        }),
      });
    });

    await wtPage.route("**/api/control", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      controlPosts.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, op: body.op, opId: "op-wt-1", status: "dispatched", coordinatorState: { status: "waiting" } }),
      });
    });

    const mockWorktreesBody = JSON.stringify({
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
          swarmOwner: { member: "alpha-dev", status: "waiting", workspaceMode: "share" },
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
          swarmOwner: { member: "beta-dev", status: "working", workspaceMode: "branch" },
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
    });

    await wtPage.route(/\/api\/worktrees(\?.*)?$/, async (route) => {
      const reqUrl = new URL(route.request().url());
      wtConvSeen = reqUrl.searchParams.get("conversationId") || wtConvSeen;
      await route.fulfill({ status: 200, contentType: "application/json", body: mockWorktreesBody });
    });

    await wtPage.route(/\/api\/worktrees\/diff(\?.*)?$/, async (route) => {
      const reqUrl = new URL(route.request().url());
      const mode = reqUrl.searchParams.get("mode") || "working";
      const offset = Number(reqUrl.searchParams.get("offset") || 0);
      diffModesSeen.push(mode);
      diffOffsetsSeen.push(offset);
      diffFetchCount += 1;
      if (mode === "conflict") {
        const isSecond = offset >= 32768;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            worktree: reqUrl.searchParams.get("worktree") || "/mock/beta",
            file: reqUrl.searchParams.get("file") || "src/shared.ts",
            mode: "conflict",
            targetBranch: reqUrl.searchParams.get("targetBranch") || "main",
            diff: isSecond ? "@@ -40 +40 @@\n+export const secondConflictChunk = true;" : "@@ -1 +1 @@\n+<<<<<<< HEAD\n+export const ours = 1;\n+=======\n+export const theirs = 2;\n+>>>>>>> feat/beta",
            offset,
            nextOffset: isSecond ? null : 32768,
            hasMore: !isSecond,
            totalBytes: 49152,
            truncated: !isSecond,
            untracked: false,
            added: isSecond ? 1 : 5,
            removed: 0,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          worktree: reqUrl.searchParams.get("worktree") || "/mock/beta",
          file: reqUrl.searchParams.get("file") || "src/shared.ts",
          mode,
          diff: mode === "branch" ? "@@ -1 +1 @@\n+export const committed = true;" : "@@ -1 +1 @@\n+export const dirty = true;",
          offset: 0,
          nextOffset: null,
          hasMore: false,
          totalBytes: 36,
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
      actionBodies.push(body);
      if (body.action === "dry_run_merge") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            action: "dry_run_merge",
            status: "conflict",
            conflicts: ["src/shared.ts"],
            conflictFiles: ["src/shared.ts"],
            message: "Dry-run merge conflict in src/shared.ts",
          }),
        });
        return;
      }
      if (body.action === "squash_merge") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            action: "squash_merge",
            status: "merged",
            message: "Squash-merged feat/alpha into main",
          }),
        });
        return;
      }
      if (body.action === "merge_commit") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            action: "merge_commit",
            status: "conflict",
            aborted: true,
            conflictFiles: ["src/shared.ts"],
            message: "Merge commit aborted on src/shared.ts conflict",
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
    const alphaOwner = await wtPage.locator('[data-testid="wt-owner-feat/alpha"]').textContent();
    const betaOwner = await wtPage.locator('[data-testid="wt-owner-feat/beta"]').textContent();
    const alphaMerge = await wtPage.locator('[data-testid="wt-mergeability-feat/alpha"]').textContent();
    const betaMerge = await wtPage.locator('[data-testid="wt-mergeability-feat/beta"]').textContent();
    const alphaBranchCount = await wtPage.locator('[data-testid="wt-branch-files-count-feat/alpha"]').textContent();
    const alphaCommits = await wtPage.locator('[data-testid="wt-commits-feat/alpha"]').textContent();

    // Interactive conflictFiles -> mode=conflict hunk + Load next 32 KiB pagination
    await wtPage.locator('[data-testid="wt-conflict-diff-btn-feat/beta-src/shared.ts"]').click();
    await wtPage.waitForSelector('[data-testid="wt-card-feat/beta"] pre');
    const conflictChunk1Txt = await wtPage.locator('[data-testid="wt-card-feat/beta"] pre').textContent();
    await wtPage.locator('[data-testid="wt-diff-load-more-feat/beta"]').click();
    await wtPage.waitForFunction(
      () => (document.querySelector('[data-testid="wt-card-feat/beta"] pre')?.textContent || "").includes("secondConflictChunk"),
    );
    const conflictChunk2Txt = await wtPage.locator('[data-testid="wt-card-feat/beta"] pre').textContent();

    // Switch feat/beta to Branch Diff and open diff peek
    await wtPage.locator('[data-testid="wt-diff-mode-branch-feat/beta"]').click();
    await wtPage.locator('[data-testid="wt-card-feat/beta"] button[aria-label="Diff peek src/shared.ts"]').click();
    await wtPage.waitForSelector('[data-testid="wt-card-feat/beta"] pre');
    const branchPre = await wtPage.locator('[data-testid="wt-card-feat/beta"] pre').textContent();
    const countBeforeAction = diffFetchCount;

    // Dry-Run Merge conflict feedback (must also clear stale diffByKey)
    await wtPage.locator('[data-testid="wt-action-dry-run-feat/beta"]').click();
    await wtPage.waitForSelector('[data-testid="wt-action-conflicts-feat/beta"]');
    const dryRunTxt = await wtPage.locator('[data-testid="wt-action-result-feat/beta"]').textContent();

    // Re-open Branch Diff on feat/beta to confirm diffByKey was cleared after action
    await wtPage.locator('[data-testid="wt-card-feat/beta"] button[aria-label="Diff peek src/shared.ts"]').click();
    await wtPage.waitForSelector('[data-testid="wt-card-feat/beta"] pre');
    const countAfterReopen = diffFetchCount;

    // 1-click Send conflict to @beta-dev via /api/control
    await wtPage.locator('[data-testid="wt-send-conflict-feat/beta"]').click();
    await wtPage.waitForFunction(() => true);

    // Squash Merge with custom commitMessage on feat/alpha
    await wtPage.locator('[data-testid="wt-action-squash-merge-feat/alpha"]').click();
    await wtPage.fill('[data-testid="wt-confirm-msg-feat/alpha"]', "feat: squash alpha lane");
    await wtPage.locator('[data-testid="wt-confirm-submit-feat/alpha"]').click();
    await wtPage.waitForFunction(
      () => (document.querySelector('[data-testid="wt-action-result-feat/alpha"]')?.textContent || "").includes("Squash-merged feat/alpha"),
    );

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
      wtConvSeen === "e3-wt-swarm" &&
      alphaOwner === "@alpha-dev · waiting · share" &&
      betaOwner === "@beta-dev · working · branch" &&
      Boolean(bannerTxt?.includes("src/shared.ts") && bannerTxt.includes("feat/alpha") && bannerTxt.includes("feat/beta")) &&
      alphaMerge === "Merge clean" &&
      betaMerge === "Merge conflict" &&
      Boolean(alphaBranchCount?.includes("2 branch files")) &&
      Boolean(alphaCommits?.includes("feat: alpha lane")) &&
      diffModesSeen.includes("conflict") &&
      diffModesSeen.includes("branch") &&
      diffOffsetsSeen.includes(32768) &&
      Boolean(conflictChunk1Txt?.includes("<<<<<<< HEAD")) &&
      Boolean(conflictChunk2Txt?.includes("secondConflictChunk")) &&
      Boolean(branchPre?.includes("committed = true")) &&
      countAfterReopen > countBeforeAction &&
      Boolean(dryRunTxt?.includes("Dry-run merge conflict") && dryRunTxt.includes("src/shared.ts")) &&
      Boolean(rebaseTxt?.includes("Rebase aborted on src/shared.ts conflict")) &&
      actionsSeen.includes("dry_run_merge") &&
      actionsSeen.includes("squash_merge") &&
      actionsSeen.includes("rebase") &&
      actionBodies.some((b) => b.action === "squash_merge" && b.commitMessage === "feat: squash alpha lane") &&
      controlPosts.some((p) => p.op === "board_post" && typeof p.text === "string" && p.text.startsWith("@beta-dev ") && p.text.includes("src/shared.ts")) &&
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
    const ctrlPage = await newMockPage();
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
    const rosterPage = await newMockPage();
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
    const pPage = await newMockPage();
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
    const wtPage = await newMockPage();
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
    const bPage = await newMockPage();
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
    const rPage = await newMockPage();
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
    const dPage = await newMockPage();
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
    const sPage = await newMockPage();
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

  await check("E1 delta client deduplicates out-of-order/replayed seq, caps 5xx backoff, and aborts cleanly on swarm-switch", async () => {
    const h1Page = await newMockPage();
    await h1Page.setViewportSize({ width: 380, height: 900 });
    const h1PageErrors = [];
    h1Page.on("pageerror", (e) => h1PageErrors.push(e.message));

    const deltaTimestamps = [];
    let deltaStep = 0;
    let swAAbortedOrLate = false;
    let swASlowHits = 0;

    await h1Page.route("**/api/swarms*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          swarms: [
            { id: "h1-sw-a", title: "H1 Delta Swarm A", appData: "gate", head: 1, memberCount: 2, activeCount: 1, waitingCount: 1, killedCount: 0, triageCount: 0, totalTokens: 1000, hasPlan: false, lastActivityTs: Date.now() },
            { id: "h1-sw-b", title: "H1 Delta Swarm B", appData: "gate", head: 1, memberCount: 1, activeCount: 0, waitingCount: 1, killedCount: 0, triageCount: 0, totalTokens: 200, hasPlan: false, lastActivityTs: Date.now() },
          ],
          defaultConversationId: "h1-sw-a",
        }),
      });
    });

    await h1Page.route(/\/api\/swarm(\?.*)?$/, async (route) => {
      const u = new URL(route.request().url());
      const conv = u.searchParams.get("conversationId") || "h1-sw-a";
      if (conv === "h1-sw-b") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            conversationId: "h1-sw-b",
            swarm: "h1-sw-b",
            member: "coordinator",
            etag: "b-v1",
            id: "h1-sw-b",
            title: "H1 Delta Swarm B",
            head: 1,
            members: [
              { name: "coordinator", conversation_id: "h1-sw-b", model: "gemini-3-pro", role: "coordinator", wake_mode: "mentions", wait_since: 1, last_read_seq: 1, unread: 0, killed: false, status: "waiting", steps: 1, activity: "", activityKind: "", replied: false, replyAsk: "", narrator: false, roleWorker: false, failure: null, transcriptMtime: Date.now(), startedAt: new Date().toISOString(), lastStepAt: new Date().toISOString(), usage: { inputTokens: 150, cacheReadTokens: 0, outputTokens: 50, totalTokens: 200 }, posts: 1, lastPostSeq: 1, lastPostTime: "12:00:00", lastPostTs: Date.now() },
            ],
            messages: [{ seq: 1, agent: "coordinator", text: "@all Swarm B active cleanly", time: "12:00:00", ts: Date.now(), mentions: [], all: true }],
            replyRefs: {},
            edges: [],
            triage: [],
            usage: { inputTokens: 150, cacheReadTokens: 0, outputTokens: 50, totalTokens: 200 },
            capabilities: { canSendMessage: false, isSidecar: true, sseStream: false, deltaStream: false },
          }),
        });
        return;
      }

      if (swASlowHits > 0) {
        swAAbortedOrLate = true;
        await new Promise((r) => setTimeout(r, 450));
      }
      swASlowHits += 1;
      await route
        .fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            conversationId: "h1-sw-a",
            swarm: "h1-sw-a",
            member: "coordinator",
            etag: "a-v1",
            id: "h1-sw-a",
            title: "H1 Delta Swarm A",
            head: 1,
            members: [
              { name: "coordinator", conversation_id: "h1-sw-a", model: "gemini-3-pro", role: "coordinator", wake_mode: "mentions", wait_since: 1, last_read_seq: 1, unread: 0, killed: false, status: "waiting", steps: 2, activity: "", activityKind: "", replied: false, replyAsk: "", narrator: false, roleWorker: false, failure: null, transcriptMtime: Date.now(), startedAt: new Date().toISOString(), lastStepAt: new Date().toISOString(), usage: { inputTokens: 800, cacheReadTokens: 0, outputTokens: 200, totalTokens: 1000 }, posts: 1, lastPostSeq: 1, lastPostTime: "12:00:00", lastPostTs: Date.now() },
            ],
            messages: [{ seq: 1, agent: "coordinator", text: "@all Initial A post", time: "12:00:00", ts: Date.now() - 5000, mentions: [], all: true }],
            replyRefs: {},
            edges: [],
            triage: [],
            usage: { inputTokens: 800, cacheReadTokens: 0, outputTokens: 200, totalTokens: 1000 },
            capabilities: { canSendMessage: false, isSidecar: true, sseStream: false, deltaStream: true },
          }),
        })
        .catch(() => {});
    });

    await h1Page.route(/\/api\/swarm\/delta(\?.*)?$/, async (route) => {
      deltaStep += 1;
      deltaTimestamps.push(Date.now());
      if (deltaStep <= 2) {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Transient 500" }) }).catch(() => {});
        return;
      }
      if (deltaStep === 3) {
        await route
          .fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              mode: "delta",
              unchanged: false,
              conversationId: "h1-sw-a",
              swarm: "h1-sw-a",
              etag: "a-v2",
              since: 1,
              head: 4,
              messagesDelta: [
                { seq: 4, agent: "coordinator", text: "@all Fourth out-of-order post", time: "12:04:00", ts: Date.now(), mentions: [], all: true },
                { seq: 1, agent: "coordinator", text: "@all Initial A post", time: "12:00:00", ts: Date.now() - 5000, mentions: [], all: true },
                { seq: 3, agent: "coordinator", text: "@all Third post", time: "12:03:00", ts: Date.now() - 1000, mentions: [], all: true },
                { seq: 3, agent: "coordinator", text: "@all Third post", time: "12:03:00", ts: Date.now() - 1000, mentions: [], all: true },
              ],
              edgesDelta: [{ from: "coordinator", to: "builder", count: 1, direct: 1, viaAll: 0 }],
            }),
          })
          .catch(() => {});
        return;
      }
      if (deltaStep === 4) {
        // Pure replay of seq 3 with edgesDelta should NOT double-count edges or duplicate seq 3
        await route
          .fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              mode: "delta",
              unchanged: false,
              conversationId: "h1-sw-a",
              swarm: "h1-sw-a",
              etag: "a-v2-replay",
              since: 1,
              head: 2,
              messagesDelta: [
                { seq: 3, agent: "coordinator", text: "@all Third post", time: "12:03:00", ts: Date.now() - 1000, mentions: [], all: true },
              ],
              edgesDelta: [{ from: "coordinator", to: "builder", count: 5, direct: 5, viaAll: 0 }],
            }),
          })
          .catch(() => {});
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, unchanged: true, etag: "a-v2-replay", head: 4 }) }).catch(() => {});
    });

    await h1Page.goto(BASE, { waitUntil: "domcontentloaded" });
    await h1Page.locator("#tab-board").click();
    await h1Page.waitForFunction(() => (document.querySelector("#panel-board")?.textContent || "").includes("Fourth out-of-order post"), null, { timeout: 12000 });
    await h1Page.waitForTimeout(250);

    const seqsOrder = await h1Page.evaluate(() =>
      [...document.querySelectorAll("#panel-board [data-seq]")].map((el) => Number(el.getAttribute("data-seq"))),
    );
    const seq1Count = await h1Page.locator('#panel-board [data-seq="1"]').count();
    const seq3Count = await h1Page.locator('#panel-board [data-seq="3"]').count();

    // Trigger rapid swarm switch A -> B while A refresh is slow to confirm clean abort & no stale overwrite
    await h1Page.locator('button[aria-label="Refresh swarm"]').click();
    await h1Page.selectOption('select[aria-label="Active swarm"]', "h1-sw-b");
    await h1Page.waitForFunction(() => (document.querySelector("#panel-board")?.textContent || "").includes("Swarm B active cleanly"));
    await h1Page.waitForTimeout(550);
    const boardAfterSwitch = await h1Page.locator("#panel-board").textContent();

    await h1Page.close();

    const gap1 = deltaTimestamps.length >= 3 ? deltaTimestamps[1] - deltaTimestamps[0] : 0;
    const gap2 = deltaTimestamps.length >= 3 ? deltaTimestamps[2] - deltaTimestamps[1] : 0;
    return (
      deltaStep >= 3 &&
      gap1 >= 1500 &&
      gap2 >= 3000 &&
      seq1Count === 1 &&
      seq3Count === 1 &&
      JSON.stringify(seqsOrder) === "[1,3,4]" &&
      swAAbortedOrLate &&
      Boolean(boardAfterSwitch?.includes("Swarm B active cleanly")) &&
      !boardAfterSwitch?.includes("Fourth out-of-order post") &&
      h1PageErrors.length === 0
    );
  });

  await check("E2 ForensicTranscriptDrawer aborts slow older responses on filter/member/close, closes on Escape, and handles empty/error states at 380px Light & Dark", async () => {
    const e2Page = await newMockPage();
    await e2Page.setViewportSize({ width: 380, height: 900 });
    const e2PageErrors = [];
    e2Page.on("pageerror", (e) => e2PageErrors.push(e.message));

    await e2Page.route("**/api/swarms*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          swarms: [{ id: "e2-sw", title: "E2 Abort Check", appData: "gate", head: 1, memberCount: 2, activeCount: 0, waitingCount: 2, killedCount: 0, triageCount: 0, totalTokens: 0, hasPlan: false, lastActivityTs: Date.now() }],
          defaultConversationId: "e2-sw",
        }),
      });
    });

    await e2Page.route(/\/api\/swarm(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId: "e2-sw",
          swarm: "e2-sw",
          member: "coordinator",
          etag: "e2-v1",
          id: "e2-sw",
          title: "E2 Abort Check",
          head: 1,
          members: [
            { name: "alpha", conversation_id: "e2-alpha", model: "gemini-3-pro", role: "worker", wake_mode: "mentions", wait_since: 1, last_read_seq: 1, unread: 0, killed: false, status: "waiting", steps: 12, activity: "", activityKind: "", replied: false, replyAsk: "", narrator: false, roleWorker: false, failure: null, transcriptMtime: Date.now(), startedAt: new Date().toISOString(), lastStepAt: new Date().toISOString(), usage: { inputTokens: 500, cacheReadTokens: 0, outputTokens: 100, totalTokens: 600 }, posts: 0, lastPostSeq: 0, lastPostTime: "", lastPostTs: null },
            { name: "beta", conversation_id: "e2-beta", model: "gemini-3-flash", role: "worker", wake_mode: "mentions", wait_since: 1, last_read_seq: 1, unread: 0, killed: false, status: "waiting", steps: 0, activity: "", activityKind: "", replied: false, replyAsk: "", narrator: false, roleWorker: false, failure: null, transcriptMtime: Date.now(), startedAt: new Date().toISOString(), lastStepAt: new Date().toISOString(), usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 }, posts: 0, lastPostSeq: 0, lastPostTime: "", lastPostTs: null },
          ],
          messages: [{ seq: 1, agent: "alpha", text: "@all E2 trace check", time: "12:00:00", ts: Date.now(), mentions: [], all: true }],
          replyRefs: {},
          edges: [],
          triage: [],
          usage: { inputTokens: 500, cacheReadTokens: 0, outputTokens: 100, totalTokens: 600 },
          capabilities: { canSendMessage: false, isSidecar: false, sseStream: false, deltaStream: false },
        }),
      });
    });

    let alphaAllCount = 0;
    let betaErrMode = false;
    await e2Page.route("**/api/transcript*", async (route) => {
      const u = new URL(route.request().url());
      const member = u.searchParams.get("member") || "";
      const filter = u.searchParams.get("filter") || "all";
      const before = u.searchParams.get("before");

      if (member === "alpha" && before === "10") {
        // Slow Load older steps response that must be aborted when filter toggles to Errors
        await new Promise((r) => setTimeout(r, 450));
        await route
          .fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              member: "alpha",
              conversationId: "e2-sw",
              totalSteps: 12,
              nextBefore: null,
              hasMore: false,
              steps: [{ stepIndex: 5, type: "PLANNER_RESPONSE", status: "DONE", ts: Date.now(), model: "gemini-3-pro", content: "STALE_OLDER_STEP_5", toolCalls: [] }],
            }),
          })
          .catch(() => {});
        return;
      }

      if (member === "alpha" && filter === "errors") {
        await route
          .fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              member: "alpha",
              conversationId: "e2-sw",
              totalSteps: 1,
              nextBefore: null,
              hasMore: false,
              steps: [{ stepIndex: 99, type: "PLANNER_RESPONSE", status: "ERROR", ts: Date.now(), model: "gemini-3-pro", error: "Current filter error #99", toolCalls: [] }],
            }),
          })
          .catch(() => {});
        return;
      }

      if (member === "alpha") {
        alphaAllCount += 1;
        if (alphaAllCount >= 2) {
          // Slow response when reopening alpha before switching to beta
          await new Promise((r) => setTimeout(r, 450));
        }
        await route
          .fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              member: "alpha",
              conversationId: "e2-sw",
              totalSteps: 12,
              nextBefore: 10,
              hasMore: true,
              steps: [{ stepIndex: 10, type: "PLANNER_RESPONSE", status: "DONE", ts: Date.now(), model: "gemini-3-pro", content: "Latest step #10", toolCalls: [] }],
            }),
          })
          .catch(() => {});
        return;
      }

      if (member === "beta" && betaErrMode) {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Transcript read error for /home/demo/secret" }) }).catch(() => {});
        return;
      }

      await route
        .fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, member: "beta", conversationId: "e2-sw", totalSteps: 0, nextBefore: null, hasMore: false, steps: [] }),
        })
        .catch(() => {});
    });

    await e2Page.goto(BASE, { waitUntil: "domcontentloaded" });
    await e2Page.locator("#tab-roster").click();
    await e2Page.waitForSelector('[data-testid="inspect-trace-btn"][data-member="alpha"]');

    // 1) Slow Load older steps cancelled on filter toggle
    await e2Page.locator('[data-testid="inspect-trace-btn"][data-member="alpha"]').click();
    await e2Page.waitForSelector('[data-testid="trace-step-10"]');
    await e2Page.locator('[data-testid="trace-load-older"]').click();
    await e2Page.locator('[data-testid="trace-filter-errors"]').click();
    await e2Page.waitForSelector('[data-testid="trace-step-99"]');
    await e2Page.waitForTimeout(550);
    const staleOverwroteFilter = (await e2Page.locator('[data-testid="trace-step-5"]').count()) > 0;

    // 2) Rapid close + switch to beta (empty trace) must not be overwritten by slow alpha
    await e2Page.keyboard.press("Escape");
    await e2Page.waitForFunction(() => !document.querySelector('[data-testid="forensic-trace-drawer"]'));
    await e2Page.locator('[data-testid="inspect-trace-btn"][data-member="alpha"]').click();
    await e2Page.keyboard.press("Escape");
    await e2Page.locator('[data-testid="inspect-trace-btn"][data-member="beta"]').click();
    await e2Page.waitForSelector('[data-testid="trace-empty"]');
    await e2Page.waitForTimeout(550);
    const emptyTxt = await e2Page.locator('[data-testid="trace-empty"]').textContent();
    const staleAlphaOverwroteBeta = (await e2Page.locator('[data-testid="trace-step-10"]').count()) > 0;
    const ovLight380 = await e2Page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    // 3) Error state in Dark mode at 380px with ~/ masking + 0px overflow
    await e2Page.keyboard.press("Escape");
    await e2Page.waitForFunction(() => !document.querySelector('[data-testid="forensic-trace-drawer"]'));
    await e2Page.locator('button[aria-label="Open settings"]').click();
    await e2Page.locator('div[role="dialog"] button[role="radio"]:has-text("Dark")').click();
    await e2Page.locator('button[aria-label="Close dialog"]').click();

    betaErrMode = true;
    await e2Page.locator('[data-testid="inspect-trace-btn"][data-member="beta"]').click();
    await e2Page.waitForSelector('[data-testid="trace-error-banner"]');
    const errTxt = await e2Page.locator('[data-testid="trace-error-banner"]').textContent();
    const ovDark380 = await e2Page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await e2Page.keyboard.press("Escape");
    await e2Page.waitForFunction(() => !document.querySelector('[data-testid="forensic-trace-drawer"]'));

    await e2Page.close();
    return (
      !staleOverwroteFilter &&
      !staleAlphaOverwroteBeta &&
      Boolean(emptyTxt?.includes("No transcript steps recorded yet.")) &&
      Boolean(errTxt?.includes("~/secret") && !errTxt.includes("/home/")) &&
      ovLight380 <= 0 &&
      ovDark380 <= 0 &&
      e2PageErrors.length === 0
    );
  });

  await check("E3 guards 0-token, NaN/Infinity, negative savings, and unknown contextLimit across TokenBurnStrip, RosterView, digest, and archive at 380px Light & Dark", async () => {
    const e3Page = await newMockPage();
    await e3Page.setViewportSize({ width: 380, height: 900 });
    const e3Errors = [];
    e3Page.on("pageerror", (e) => e3Errors.push(e.message));
    e3Page.on("console", (msg) => {
      if (msg.type() === "error") e3Errors.push(msg.text());
    });

    let activePhase = "zero";
    await e3Page.route("**/api/swarms*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          swarms: [{ id: "e3-sw", title: "E3 Edge Swarm", appData: "gate", head: 1, memberCount: 2, activeCount: 0, waitingCount: 2, killedCount: 0, triageCount: 0, totalTokens: 0, hasPlan: false, lastActivityTs: Date.now() }],
          defaultConversationId: "e3-sw",
        }),
      });
    });

    await e3Page.route(/\/api\/swarm(\?.*)?$/, async (route) => {
      const zeroSnap = {
        conversationId: "e3-sw",
        swarm: "e3-sw",
        member: "coordinator",
        etag: `e3-${activePhase}`,
        id: "e3-sw",
        title: "E3 Edge Swarm",
        head: 1,
        members: [
          {
            name: "zero-worker",
            conversation_id: "e3-zero-1",
            model: "unknown-local",
            role: "worker",
            wake_mode: "mentions",
            wait_since: 1,
            last_read_seq: 1,
            unread: 0,
            killed: false,
            status: "waiting",
            steps: 0,
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
            contextLimit: "unknown",
            usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 },
            cost: { totalUsd: 0, inputUsd: 0, cacheReadUsd: 0, outputUsd: 0, cacheSavingsUsd: -1.5, cacheHitPct: 0, pricingKnown: false },
            posts: 0,
            lastPostSeq: 0,
            lastPostTime: "",
            lastPostTs: null,
          },
        ],
        messages: [{ seq: 1, agent: "zero-worker", text: "@all Zero token init", time: "12:00:00", ts: Date.now(), mentions: [], all: true }],
        replyRefs: {},
        edges: [],
        triage: [],
        burnSummary: { totalTokens: 0, topWorker: null, highBurnCount: 0, workers: [], costUsd: 0, cacheHitPct: 0, cacheSavingsUsd: -2, pricingKnown: false },
        usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 },
        cost: { totalUsd: 0, inputUsd: 0, cacheReadUsd: 0, outputUsd: 0, cacheSavingsUsd: -2, cacheHitPct: 0, pricingKnown: false },
        capabilities: { canSendMessage: false, isSidecar: false, sseStream: false, deltaStream: false },
      };

      const weirdSnap = {
        ...zeroSnap,
        members: [
          zeroSnap.members[0],
          {
            ...zeroSnap.members[0],
            name: "weird-worker",
            conversation_id: "e3-weird-2",
            model: "gemini-3-pro",
            lastContextTokens: 45000,
            contextLimit: "unknown",
            contextPct: null,
            usage: { inputTokens: 45000, cacheReadTokens: 0, outputTokens: 500, totalTokens: 45500 },
            cost: { totalUsd: 0.06, inputUsd: 0.055, cacheReadUsd: 0, outputUsd: 0.005, cacheSavingsUsd: -4.25, cacheHitPct: 180, pricingKnown: true },
          },
        ],
        burnSummary: {
          totalTokens: 45500,
          highBurnCount: 0,
          costUsd: 0.06,
          cacheHitPct: 180,
          cacheSavingsUsd: -4.25,
          pricingKnown: true,
          topWorker: { name: "weird-worker", totalTokens: 45500, sharePct: 150, level: "normal", costUsd: 0.06, cacheHitPct: 180, cacheSavingsUsd: -4.25, pricingKnown: true },
          workers: [
            { name: "weird-worker", totalTokens: 45500, sharePct: 150, level: "normal", costUsd: 0.06, cacheHitPct: 180, cacheSavingsUsd: -4.25, pricingKnown: true },
            { name: "zero-worker", totalTokens: 0, sharePct: -10, level: "normal", costUsd: 0, cacheHitPct: 0, cacheSavingsUsd: -1, pricingKnown: false },
          ],
        },
        usage: { inputTokens: 45000, cacheReadTokens: 0, outputTokens: 500, totalTokens: 45500 },
        cost: { totalUsd: 0.06, inputUsd: 0.055, cacheReadUsd: 0, outputUsd: 0.005, cacheSavingsUsd: -4.25, cacheHitPct: 180, pricingKnown: true },
      };

      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(activePhase === "zero" ? zeroSnap : weirdSnap) });
    });

    await e3Page.goto(BASE, { waitUntil: "domcontentloaded" });
    await e3Page.waitForSelector("#panel-triage");
    const zeroBurnHidden = (await e3Page.locator('#panel-triage [data-testid="token-burn-strip"]').count()) === 0;
    await e3Page.locator("#tab-roster").click();
    await e3Page.waitForSelector('[data-testid="roster-ctx-cap-zero-worker"]');
    const zeroBadge = await e3Page.locator('[data-testid="roster-ctx-badge-zero-worker"]').textContent();
    const zeroCap = await e3Page.locator('[data-testid="roster-ctx-cap-zero-worker"]').textContent();
    const zeroCost = await e3Page.locator('[data-testid="roster-cost-zero-worker"]').textContent();
    const zeroOv = await e3Page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    // Switch to weird phase (negative savings, >100% cacheHitPct/sharePct, unknown contextLimit with non-zero tokens)
    activePhase = "weird";
    await e3Page.locator('button[aria-label="Refresh swarm"]').click();
    await e3Page.waitForSelector('[data-testid="token-burn-strip"]');
    const rosterTxt = await e3Page.locator("#panel-roster").textContent();
    const weirdBadge = await e3Page.locator('[data-testid="roster-ctx-badge-weird-worker"]').textContent();
    const weirdCap = await e3Page.locator('[data-testid="roster-ctx-cap-weird-worker"]').textContent();
    const burnCacheTxt = await e3Page.locator('#panel-roster [data-testid="burn-cache-hit"]').textContent();
    const ovLight = await e3Page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    await e3Page.locator("#tab-triage").click();
    await e3Page.evaluate(() => {
      window.__e3Digest = "";
      try {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (t) => { window.__e3Digest = String(t); } },
        });
      } catch {}
    });
    await e3Page.locator('[data-testid="copy-handoff-digest"]').click();
    await e3Page.waitForFunction(() => Boolean(window.__e3Digest));
    const e3Digest = await e3Page.evaluate(() => window.__e3Digest);

    const [dlJson] = await Promise.all([
      e3Page.waitForEvent("download"),
      e3Page.locator('[data-testid="export-archive-json"]').click(),
    ]);
    const dlChunks = [];
    for await (const c of await dlJson.createReadStream()) dlChunks.push(c);
    const archiveJsonStr = Buffer.concat(dlChunks).toString("utf8");
    const archiveObj = JSON.parse(archiveJsonStr);

    await e3Page.locator('button[aria-label="Open settings"]').click();
    await e3Page.locator('div[role="dialog"] button[role="radio"]:has-text("Dark")').click();
    await e3Page.locator('button[aria-label="Close dialog"]').click();
    const ovDark = await e3Page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    await e3Page.close();
    return (
      zeroBurnHidden &&
      zeroBadge === "Idle" &&
      zeroCap === "cap unknown" &&
      zeroCost === "Unpriced" &&
      zeroOv <= 0 &&
      weirdBadge === "45.0k ctx" &&
      weirdCap === "cap unknown" &&
      burnCacheTxt === "100% cache hit" &&
      !rosterTxt?.includes("NaN") &&
      !rosterTxt?.includes("Infinity") &&
      !rosterTxt?.includes("saved") &&
      !e3Digest.includes("NaN") &&
      !e3Digest.includes("Infinity") &&
      !e3Digest.includes("saved") &&
      e3Digest.includes("45.0k / unknown ctx") &&
      archiveObj.cost?.cacheSavingsUsd === 0 &&
      archiveObj.cost?.cacheHitPct === 100 &&
      archiveObj.burnSummary?.cacheSavingsUsd === 0 &&
      archiveObj.members?.[0]?.contextLimit === null &&
      ovLight <= 0 &&
      ovDark <= 0 &&
      e3Errors.length === 0
    );
  });

  await check("Wave E1 working-worker Switch Model guard blocks without override, allows allowWorking, and surfaces 409 + honest dispatch toast", async () => {
    const gPage = await newMockPage();
    await gPage.setViewportSize({ width: 340, height: 900 });
    const gErrors = [];
    const controlReqs = [];
    let allow409 = false;
    let forceNext409 = true;
    gPage.on("pageerror", (e) => gErrors.push(e.message));
    gPage.on("console", (msg) => {
      if (msg.type() === "error") {
        if (allow409 && msg.text().includes("status of 409")) return;
        gErrors.push(msg.text());
      }
    });

    await gPage.route("**/api/swarms*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          swarms: [{ id: "e1-guard", title: "Wave E1 Guard", appData: "gate", head: 2, memberCount: 3, activeCount: 1, waitingCount: 2, killedCount: 0, triageCount: 0, totalTokens: 0, hasPlan: false, lastActivityTs: Date.now() }],
          defaultConversationId: "e1-guard",
        }),
      });
    });

    await gPage.route(/\/api\/swarm(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId: "e1-guard",
          swarm: "e1-guard",
          member: "coordinator",
          etag: "e1-g1",
          id: "e1-guard",
          title: "Wave E1 Guard",
          head: 2,
          members: [
            { name: "coordinator", conversation_id: "e1-guard", model: "gemini-3-pro", role: "coordinator", wake_mode: "mentions", wait_since: 2, last_read_seq: 2, unread: 0, killed: false, status: "waiting", steps: 2, activity: "", activityKind: "", replied: false, replyAsk: "", narrator: false, roleWorker: false, failure: null, transcriptMtime: Date.now(), startedAt: new Date().toISOString(), lastStepAt: new Date().toISOString(), usage: { inputTokens: 200, cacheReadTokens: 0, outputTokens: 50, totalTokens: 250 }, posts: 1, lastPostSeq: 1, lastPostTime: "12:00:00", lastPostTs: Date.now() },
            { name: "busy-worker", conversation_id: "e1-busy", model: "gemini-3-pro", role: "worker", wake_mode: "working", wait_since: 0, last_read_seq: 2, unread: 0, killed: false, status: "working", steps: 4, activity: "Editing", activityKind: "tool", replied: false, replyAsk: "", narrator: false, roleWorker: false, failure: null, transcriptMtime: Date.now(), startedAt: new Date().toISOString(), lastStepAt: new Date().toISOString(), usage: { inputTokens: 300, cacheReadTokens: 0, outputTokens: 80, totalTokens: 380 }, posts: 0, lastPostSeq: 0, lastPostTime: "", lastPostTs: null },
            { name: "idle-worker", conversation_id: "e1-idle", model: "gemini-3-pro", role: "worker", wake_mode: "mentions", wait_since: 2, last_read_seq: 2, unread: 0, killed: false, status: "waiting", steps: 3, activity: "", activityKind: "", replied: false, replyAsk: "", narrator: false, roleWorker: false, failure: null, transcriptMtime: Date.now(), startedAt: new Date().toISOString(), lastStepAt: new Date().toISOString(), usage: { inputTokens: 200, cacheReadTokens: 0, outputTokens: 50, totalTokens: 250 }, posts: 0, lastPostSeq: 0, lastPostTime: "", lastPostTs: null },
          ],
          messages: [{ seq: 1, agent: "coordinator", text: "@all Guard check", time: "12:00:00", ts: Date.now(), mentions: [], all: true }],
          replyRefs: {},
          edges: [],
          triage: [],
          ops: [],
          usage: { inputTokens: 700, cacheReadTokens: 0, outputTokens: 180, totalTokens: 880 },
          capabilities: { canSendMessage: true, isSidecar: false, sseStream: false, deltaStream: false },
        }),
      });
    });

    await gPage.route("**/api/control", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      controlReqs.push(body);
      if (body.member === "idle-worker" && forceNext409) {
        forceNext409 = false;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "worker_not_waiting", status: "working" }),
        });
        return;
      }
      if (body.member === "idle-worker") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            op: body.op,
            opId: "op-race-2",
            status: "dispatched",
            coordinatorState: { status: "waiting", failure: { kind: "quota", text: "429 quota" } },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          op: body.op,
          opId: "op-working-1",
          status: "dispatched",
          coordinatorState: { status: "waiting", failure: null },
        }),
      });
    });

    await gPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await gPage.locator("#tab-roster").click();
    await gPage.waitForSelector('[data-testid="switch-model-btn-busy-worker"]');

    await gPage.locator('[data-testid="switch-model-btn-busy-worker"]').click();
    await gPage.waitForSelector('[data-testid="switch-model-working-warn-busy-worker"]');
    const disabledBefore = await gPage.locator('[data-testid="switch-model-submit-busy-worker"]').isDisabled();
    const ov340 = await gPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    await gPage.check('[data-testid="switch-model-override-busy-worker"]');
    const disabledAfter = await gPage.locator('[data-testid="switch-model-submit-busy-worker"]').isDisabled();
    await gPage.locator('[data-testid="switch-model-submit-busy-worker"]').click();
    await gPage.waitForFunction(() => !document.querySelector('[data-testid="switch-model-drawer-busy-worker"]'));
    await gPage.waitForSelector('[role="status"]');
    const toast1 = await gPage.locator('[role="status"]').last().textContent();

    // 409 worker_not_waiting race & unhealthy coordinator warning notice
    allow409 = true;
    await gPage.locator('[data-testid="switch-model-btn-idle-worker"]').click();
    await gPage.locator('[data-testid="switch-model-submit-idle-worker"]').click();
    await gPage.waitForSelector('[data-testid="switch-model-error"]');
    const err409Txt = await gPage.locator('[data-testid="switch-model-error"]').textContent();

    await gPage.locator('[data-testid="switch-model-submit-idle-worker"]').click();
    await gPage.waitForFunction(() => !document.querySelector('[data-testid="switch-model-drawer-idle-worker"]'));
    const toast2 = await gPage.locator('[role="status"]').last().textContent();

    await gPage.setViewportSize({ width: 380, height: 900 });
    await gPage.locator('button[aria-label="Open settings"]').click();
    await gPage.locator('div[role="dialog"] button[role="radio"]:has-text("Dark")').click();
    await gPage.locator('button[aria-label="Close dialog"]').click();
    const ov380Dark = await gPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    await gPage.close();
    const workingCall = controlReqs.find((c) => c.member === "busy-worker");
    return (
      disabledBefore &&
      !disabledAfter &&
      workingCall?.allowWorking === true &&
      Boolean(toast1?.includes("Dispatched op-working-1 (awaiting coordinator)") && !toast1.includes("Switched")) &&
      Boolean(err409Txt?.includes("working")) &&
      Boolean(toast2?.includes("Dispatched op-race-2 (awaiting coordinator)") && toast2.includes("coordinator quota")) &&
      ov340 <= 0 &&
      ov380Dark <= 0 &&
      gErrors.length === 0
    );
  });

  await check("Wave E1 OperatorOpsStrip renders dispatched spinner, verified #seq link, failure/timeout alerts, and Retry/Mark Verified/Dismiss in Roster & Board at 340px", async () => {
    const opsPage = await newMockPage();
    await opsPage.setViewportSize({ width: 340, height: 900 });
    const opsErrors = [];
    const actionCalls = [];
    let getOpsCount = 0;
    opsPage.on("pageerror", (e) => opsErrors.push(e.message));
    opsPage.on("console", (msg) => {
      if (msg.type() === "error") opsErrors.push(msg.text());
    });

    let mockOps = [
      { opId: "op-disp-1", op: "kill_worker", target: "worker-a", status: "dispatched", createdAt: Date.now() - 4000, updatedAt: Date.now() - 4000 },
      { opId: "op-ver-2", op: "board_post", target: "backend", status: "verified", resolvedSeq: 2, createdAt: Date.now() - 12000, updatedAt: Date.now() - 10000 },
      { opId: "op-fail-3", op: "switch_model", target: "worker-b", status: "failed", error: "Worker rejected model switch", createdAt: Date.now() - 20000, updatedAt: Date.now() - 18000 },
      { opId: "op-to-4", op: "spawn_worker", target: "worker-c", status: "timed_out", error: "Coordinator ack timed out", createdAt: Date.now() - 30000, updatedAt: Date.now() - 25000 },
    ];

    await opsPage.route("**/api/swarms*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          swarms: [{ id: "e1-ops", title: "Wave E1 Ops", appData: "gate", head: 2, memberCount: 2, activeCount: 0, waitingCount: 2, killedCount: 0, triageCount: 0, totalTokens: 0, hasPlan: false, lastActivityTs: Date.now() }],
          defaultConversationId: "e1-ops",
        }),
      });
    });

    await opsPage.route(/\/api\/swarm(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId: "e1-ops",
          swarm: "e1-ops",
          member: "coordinator",
          etag: `e1-ops-${mockOps.map((o) => `${o.opId}:${o.status}`).join(",")}`,
          id: "e1-ops",
          title: "Wave E1 Ops",
          head: 2,
          members: [
            { name: "coordinator", conversation_id: "e1-ops", model: "gemini-3-pro", role: "coordinator", wake_mode: "mentions", wait_since: 2, last_read_seq: 2, unread: 0, killed: false, status: "waiting", steps: 2, activity: "", activityKind: "", replied: false, replyAsk: "", narrator: false, roleWorker: false, failure: null, transcriptMtime: Date.now(), startedAt: new Date().toISOString(), lastStepAt: new Date().toISOString(), usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 20, totalTokens: 120 }, posts: 1, lastPostSeq: 1, lastPostTime: "12:00:00", lastPostTs: Date.now() },
          ],
          messages: [
            { seq: 1, agent: "coordinator", text: "@all Ops test start", time: "12:00:00", ts: Date.now() - 20000, mentions: [], all: true },
            { seq: 2, agent: "coordinator", text: "@all Verified board post #2", time: "12:01:00", ts: Date.now() - 10000, mentions: [], all: true },
          ],
          replyRefs: {},
          edges: [],
          triage: [],
          ops: mockOps,
          usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 20, totalTokens: 120 },
          capabilities: { canSendMessage: true, isSidecar: false, sseStream: false, deltaStream: false },
        }),
      });
    });

    await opsPage.route("**/api/ops/action", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      actionCalls.push(body);
      mockOps = mockOps.map((o) => {
        if (o.opId !== body.opId) return o;
        if (body.action === "retry") return { ...o, status: "dispatched", error: undefined, updatedAt: Date.now() };
        if (body.action === "mark_verified") return { ...o, status: "verified", error: undefined, resolvedSeq: 2, updatedAt: Date.now() };
        return { ...o, status: "dismissed", updatedAt: Date.now() };
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, opId: body.opId, action: body.action, ops: mockOps }),
      });
    });

    await opsPage.route(/\/api\/ops(\?.*)?$/, async (route) => {
      getOpsCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, conversationId: "e1-ops", ops: mockOps }),
      });
    });

    await opsPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await opsPage.locator("#tab-roster").click();
    await opsPage.waitForSelector('[data-testid="operator-ops-strip"]');
    await opsPage.waitForSelector('[data-testid="op-spinner-op-disp-1"]');

    const stripTxt = await opsPage.locator('[data-testid="operator-ops-strip"]').textContent();
    const ovRoster340 = await opsPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    await opsPage.locator('[data-testid="op-retry-op-fail-3"]').click();
    await opsPage.waitForFunction(
      () => document.querySelector('[data-testid="op-status-op-fail-3"]')?.textContent === "Pending",
    );

    await opsPage.locator('[data-testid="op-verify-op-to-4"]').click();
    await opsPage.waitForFunction(
      () => document.querySelector('[data-testid="op-status-op-to-4"]')?.textContent === "Verified",
    );

    await opsPage.locator('[data-testid="op-dismiss-op-to-4"]').click();
    await opsPage.waitForFunction(() => !document.querySelector('[data-testid="op-row-op-to-4"]'));

    await opsPage.locator('[data-testid="ops-refresh-btn"]').click();
    await opsPage.waitForFunction(() => true);

    await opsPage.locator('[data-testid="op-seq-op-ver-2"]').click();
    await opsPage.waitForSelector('#panel-board [data-testid="operator-ops-strip"]');
    await opsPage.waitForSelector('[data-seq="2"][data-highlighted="true"]');
    const ovBoard340 = await opsPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    await opsPage.locator('button[aria-label="Open settings"]').click();
    await opsPage.locator('div[role="dialog"] button[role="radio"]:has-text("Dark")').click();
    await opsPage.locator('button[aria-label="Close dialog"]').click();
    const ovBoardDark340 = await opsPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    await opsPage.close();
    return (
      Boolean(stripTxt?.includes("Worker rejected model switch") && stripTxt.includes("Coordinator ack timed out")) &&
      actionCalls.some((c) => c.confirm === true && c.opId === "op-fail-3" && c.action === "retry") &&
      actionCalls.some((c) => c.confirm === true && c.opId === "op-to-4" && c.action === "mark_verified") &&
      actionCalls.some((c) => c.confirm === true && c.opId === "op-to-4" && c.action === "dismiss") &&
      getOpsCount >= 1 &&
      ovRoster340 <= 0 &&
      ovBoard340 <= 0 &&
      ovBoardDark340 <= 0 &&
      opsErrors.length === 0
    );
  });

  await check("Wave E2 Portfolio header pill & Command Drawer render aggregated spend, urgent jump, gate badges, and archive toggle at 340px Light & Dark", async () => {
    const pPage = await newMockPage();
    await pPage.setViewportSize({ width: 340, height: 900 });
    const pErrors = [];
    const archiveCalls = [];
    pPage.on("pageerror", (e) => pErrors.push(e.message));
    pPage.on("console", (msg) => {
      if (msg.type() === "error") pErrors.push(msg.text());
    });

    let swList = [
      { id: "p-sw-1", title: "Alpha Build", appData: "gate", head: 4, memberCount: 3, activeCount: 1, waitingCount: 2, killedCount: 0, triageCount: 1, totalTokens: 12000, hasPlan: true, lastActivityTs: Date.now(), costUsd: 0.45, gateState: "verifying", blockedCount: 0, failureCount: 0, repo: "/home/demo/alpha", archived: false },
      { id: "p-sw-2", title: "Beta Audit", appData: "gate", head: 2, memberCount: 2, activeCount: 0, waitingCount: 2, killedCount: 0, triageCount: 1, totalTokens: 8000, hasPlan: false, lastActivityTs: Date.now(), costUsd: 0.30, gateState: "blocked", blockedCount: 1, failureCount: 1, repo: "/home/demo/beta", archived: false },
    ];

    await pPage.route("**/api/swarms*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ swarms: swList, defaultConversationId: "p-sw-1" }),
      });
    });

    await pPage.route("**/api/portfolio*", async (route) => {
      const active = swList.filter((s) => !s.archived);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          totalCostUsd: active.reduce((sum, s) => sum + s.costUsd, 0),
          totalTokens: active.reduce((sum, s) => sum + s.totalTokens, 0),
          activeSwarms: active.length,
          urgentCount: 1,
          urgentTriage: [
            {
              id: "u-beta-1",
              kind: "quota",
              severity: "urgent",
              member: "scanner",
              conversationId: "p-sw-2",
              swarmId: "p-sw-2",
              swarmTitle: "Beta Audit",
              seq: 2,
              title: "scanner: quota exhausted",
              detail: "429 in /home/demo/beta",
              suggestedPrompt: "@scanner Resume.",
              timestamp: Date.now() - 15000,
            },
          ],
          swarms: swList,
        }),
      });
    });

    await pPage.route("**/api/swarm/archive", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      archiveCalls.push(body);
      swList = swList.map((s) => (s.id === body.conversationId ? { ...s, archived: body.archived } : s));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, conversationId: body.conversationId, archived: body.archived }),
      });
    });

    await pPage.route(/\/api\/swarm(\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      const cid = url.searchParams.get("conversationId") || "p-sw-1";
      const cur = swList.find((s) => s.id === cid) || swList[0];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId: cur.id,
          swarm: cur.id,
          member: "coordinator",
          etag: `p-${cur.id}`,
          id: cur.id,
          title: cur.title,
          head: cur.head,
          members: [
            { name: "coordinator", conversation_id: cur.id, model: "gemini-3-pro", role: "coordinator", wake_mode: "mentions", wait_since: 1, last_read_seq: 1, unread: 0, killed: false, status: "waiting", steps: 2, activity: "", activityKind: "", replied: false, replyAsk: "", narrator: false, roleWorker: false, failure: null, transcriptMtime: Date.now(), startedAt: new Date().toISOString(), lastStepAt: new Date().toISOString(), usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 20, totalTokens: 120 }, posts: 1, lastPostSeq: 1, lastPostTime: "12:00:00", lastPostTs: Date.now() },
          ],
          messages: [{ seq: 1, agent: "coordinator", text: `@all ${cur.title}`, time: "12:00:00", ts: Date.now(), mentions: [], all: true }],
          replyRefs: {},
          edges: [],
          triage: [],
          ops: [],
          pinnedSeqs: [],
          usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 20, totalTokens: 120 },
          capabilities: { canSendMessage: true, isSidecar: false, sseStream: false, deltaStream: false },
        }),
      });
    });

    await pPage.route("**/api/checkpoints*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, checkpoints: [] }) });
    });

    await pPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await pPage.waitForSelector('[data-testid="portfolio-pill-btn"]');
    const pillTxt = await pPage.locator('[data-testid="portfolio-pill-btn"]').textContent();
    const ovPill340 = await pPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    await pPage.locator('[data-testid="portfolio-pill-btn"]').click();
    await pPage.waitForSelector('[data-testid="portfolio-drawer"]');
    const drawerTxt = await pPage.locator('[data-testid="portfolio-drawer"]').textContent();
    const ovLight340 = await pPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    await pPage.locator('[data-testid="portfolio-archive-swarm-p-sw-2"]').click();
    await pPage.waitForFunction(() => !document.querySelector('[data-testid="portfolio-swarm-p-sw-2"]'));
    await pPage.locator('[data-testid="portfolio-show-archived"]').click();
    await pPage.waitForSelector('[data-testid="portfolio-swarm-p-sw-2"]');
    await pPage.locator('[data-testid="portfolio-archive-swarm-p-sw-2"]').click();
    await pPage.waitForFunction(
      () => (document.querySelector('[data-testid="portfolio-archive-swarm-p-sw-2"]')?.textContent || "").trim() === "Archive",
    );

    await pPage.locator('[data-testid="portfolio-jump-urgent-u-beta-1"]').click();
    await pPage.waitForFunction(() => !document.querySelector('[data-testid="portfolio-drawer"]'));
    await pPage.waitForFunction(() => (document.querySelector('select[aria-label="Active swarm"]')?.value || "") === "p-sw-2");
    const jumpedVal = await pPage.locator('select[aria-label="Active swarm"]').inputValue();

    await pPage.locator('button[aria-label="Open settings"]').click();
    await pPage.locator('div[role="dialog"] button[role="radio"]:has-text("Dark")').click();
    await pPage.locator('button[aria-label="Close dialog"]').click();
    await pPage.locator('[data-testid="portfolio-pill-btn"]').click();
    await pPage.waitForSelector('[data-testid="portfolio-drawer"]');
    const ovDark340 = await pPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    await pPage.close();
    return (
      Boolean(pillTxt?.includes("2 swarms · 1 urgent · $0.75")) &&
      Boolean(drawerTxt?.includes("~/beta") && !drawerTxt.includes("/home/") && drawerTxt.includes("Gate: Blocked")) &&
      archiveCalls.some((c) => c.confirm === true && c.conversationId === "p-sw-2" && c.archived === true) &&
      jumpedVal === "p-sw-2" &&
      ovPill340 <= 0 &&
      ovLight340 <= 0 &&
      ovDark340 <= 0 &&
      pErrors.length === 0
    );
  });

  await check("Wave E2 Triage Ack/Snooze/Show acked and persistent /api/pins work cleanly at 340px", async () => {
    const tPage = await newMockPage();
    await tPage.setViewportSize({ width: 340, height: 900 });
    const tErrors = [];
    const ackCalls = [];
    const pinCalls = [];
    tPage.on("pageerror", (e) => tErrors.push(e.message));
    tPage.on("console", (msg) => {
      if (msg.type() === "error") tErrors.push(msg.text());
    });

    let serverPins = [];
    let ackMap = {};

    await tPage.route("**/api/swarms*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          swarms: [{ id: "e2-triage", title: "Triage Ack Gate", appData: "gate", head: 3, memberCount: 2, activeCount: 0, waitingCount: 2, killedCount: 0, triageCount: 2, totalTokens: 500, hasPlan: false, lastActivityTs: Date.now() }],
          defaultConversationId: "e2-triage",
        }),
      });
    });

    await tPage.route("**/api/portfolio*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, totalCostUsd: 0.05, totalTokens: 500, activeSwarms: 1, urgentCount: 1, urgentTriage: [], swarms: [] }),
      });
    });

    await tPage.route(/\/api\/swarm(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId: "e2-triage",
          swarm: "e2-triage",
          member: "coordinator",
          etag: `e2-t-${serverPins.join(",")}-${Object.keys(ackMap).join(",")}`,
          id: "e2-triage",
          title: "Triage Ack Gate",
          head: 3,
          members: [
            { name: "coordinator", conversation_id: "e2-triage", model: "gemini-3-pro", role: "coordinator", wake_mode: "mentions", wait_since: 3, last_read_seq: 3, unread: 0, killed: false, status: "waiting", steps: 2, activity: "", activityKind: "", replied: false, replyAsk: "", narrator: false, roleWorker: false, failure: null, transcriptMtime: Date.now(), startedAt: new Date().toISOString(), lastStepAt: new Date().toISOString(), usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 20, totalTokens: 120 }, posts: 1, lastPostSeq: 1, lastPostTime: "12:00:00", lastPostTs: Date.now() },
            { name: "builder", conversation_id: "e2-b", model: "gemini-3-pro", role: "worker", wake_mode: "mentions", wait_since: 3, last_read_seq: 3, unread: 0, killed: false, status: "waiting", steps: 4, activity: "", activityKind: "", replied: true, replyAsk: "Proceed with /api/pins?", narrator: false, roleWorker: false, failure: null, transcriptMtime: Date.now(), startedAt: new Date().toISOString(), lastStepAt: new Date().toISOString(), usage: { inputTokens: 200, cacheReadTokens: 0, outputTokens: 50, totalTokens: 250 }, posts: 1, lastPostSeq: 2, lastPostTime: "12:01:00", lastPostTs: Date.now() },
          ],
          messages: [
            { seq: 1, agent: "coordinator", text: "@all Start", time: "12:00:00", ts: Date.now(), mentions: [], all: true },
            { seq: 2, agent: "builder", text: "@coordinator Question on pins?", time: "12:01:00", ts: Date.now(), mentions: ["coordinator"], all: false },
            { seq: 3, agent: "builder", text: "@verifier [done] Ready for check", time: "12:02:00", ts: Date.now(), mentions: ["verifier"], all: false },
          ],
          replyRefs: {},
          edges: [],
          pinnedSeqs: serverPins,
          triageAcks: ackMap,
          triage: [
            { id: "ask-builder", kind: "question", severity: "attention", member: "builder", conversationId: "e2-b", seq: 2, title: "builder asked a question", detail: "Proceed with /api/pins?", suggestedPrompt: "@builder Yes.", timestamp: Date.now(), acked: Boolean(ackMap["ask-builder"]), ackAction: ackMap["ask-builder"]?.action || null },
            { id: "verify-builder-3", kind: "verify", severity: "verify", member: "builder", conversationId: "e2-b", seq: 3, title: "builder awaits cold verification (#3)", detail: "[done] Ready for check", suggestedPrompt: "@verifier Verify #3.", timestamp: Date.now(), acked: Boolean(ackMap["verify-builder-3"]), snoozed: ackMap["verify-builder-3"]?.action === "snooze", untilSeq: ackMap["verify-builder-3"]?.untilSeq || null },
          ],
          ops: [],
          usage: { inputTokens: 300, cacheReadTokens: 0, outputTokens: 70, totalTokens: 370 },
          capabilities: { canSendMessage: true, isSidecar: false, sseStream: false, deltaStream: false },
        }),
      });
    });

    await tPage.route("**/api/triage/ack", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      ackCalls.push(body);
      if (body.action === "unack") delete ackMap[body.triageId];
      else ackMap[body.triageId] = { triageId: body.triageId, action: body.action, untilSeq: body.untilSeq };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, acks: ackMap }) });
    });

    await tPage.route("**/api/pins", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      pinCalls.push(body);
      if (body.pinned && !serverPins.includes(body.seq)) serverPins = [...serverPins, body.seq].sort((a, b) => a - b);
      if (!body.pinned) serverPins = serverPins.filter((x) => x !== body.seq);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, pinnedSeqs: serverPins }) });
    });

    await tPage.route("**/api/checkpoints*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, checkpoints: [] }) });
    });

    await tPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await tPage.waitForSelector('[data-testid="triage-ack-ask-builder"]');
    await tPage.locator('[data-testid="triage-ack-ask-builder"]').click();
    await tPage.waitForFunction(() => !document.querySelector('[data-testid="triage-card-ask-builder"]'));

    await tPage.locator('[data-testid="triage-snooze-verify-builder-3"]').click();
    await tPage.waitForFunction(() => !document.querySelector('[data-testid="triage-card-verify-builder-3"]'));

    await tPage.locator('[data-testid="toggle-show-acked"]').click();
    await tPage.waitForSelector('[data-testid="triage-ack-badge-ask-builder"]');
    await tPage.waitForSelector('[data-testid="triage-ack-badge-verify-builder-3"]');
    const badgeSnooze = await tPage.locator('[data-testid="triage-ack-badge-verify-builder-3"]').textContent();

    await tPage.locator('[data-testid="triage-unack-ask-builder"]').click();
    await tPage.locator('[data-testid="toggle-show-acked"]').click();
    await tPage.waitForSelector('[data-testid="triage-card-ask-builder"]');

    await tPage.locator('button[aria-label="Pin #2"]').click();
    await tPage.waitForSelector('#pinned-triage-heading');
    const ov340 = await tPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    await tPage.close();
    return (
      ackCalls.some((c) => c.confirm === true && c.triageId === "ask-builder" && c.action === "ack") &&
      ackCalls.some((c) => c.confirm === true && c.triageId === "verify-builder-3" && c.action === "snooze") &&
      ackCalls.some((c) => c.confirm === true && c.triageId === "ask-builder" && c.action === "unack") &&
      pinCalls.some((c) => c.confirm === true && c.seq === 2 && c.pinned === true) &&
      Boolean(badgeSnooze?.includes("Snoozed")) &&
      ov340 <= 0 &&
      tErrors.length === 0
    );
  });

  await check("Wave E2 Checkpoints create, Compare vs live diff, Restore plan, and Copy/Send Resume Prompt work cleanly in Triage & CommandPalette", async () => {
    const cPage = await newMockPage();
    await cPage.setViewportSize({ width: 380, height: 900 });
    const cErrors = [];
    const cpPosts = [];
    const restoreCalls = [];
    const nudgeCalls = [];
    cPage.on("pageerror", (e) => cErrors.push(e.message));
    cPage.on("console", (msg) => {
      if (msg.type() === "error") cErrors.push(msg.text());
    });

    let cps = [
      {
        id: "cp-1",
        conversationId: "e2-cp",
        label: "Before Wave E2",
        createdAt: Date.now() - 60000,
        head: 2,
        planEtag: "pl-1",
        planGoal: "Initial checkpoint goal",
        worktrees: [{ path: "/home/demo/wt", branch: "feat/e2", head: "aaa111", clean: true, dirtyFiles: 0 }],
      },
    ];
    let liveGoal = "Live diverged goal";

    await cPage.route("**/api/swarms*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          swarms: [{ id: "e2-cp", title: "Checkpoint Swarm", appData: "gate", head: 5, memberCount: 1, activeCount: 0, waitingCount: 1, killedCount: 0, triageCount: 0, totalTokens: 400, hasPlan: true, lastActivityTs: Date.now() }],
          defaultConversationId: "e2-cp",
        }),
      });
    });

    await cPage.route("**/api/portfolio*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, totalCostUsd: 0.1, totalTokens: 400, activeSwarms: 1, urgentCount: 0, urgentTriage: [], swarms: [] }),
      });
    });

    await cPage.route(/\/api\/swarm(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId: "e2-cp",
          swarm: "e2-cp",
          member: "coordinator",
          etag: `cp-snap-${liveGoal}`,
          id: "e2-cp",
          title: "Checkpoint Swarm",
          head: 5,
          members: [
            { name: "coordinator", conversation_id: "e2-cp", model: "gemini-3-pro", role: "coordinator", wake_mode: "mentions", wait_since: 5, last_read_seq: 5, unread: 0, killed: false, status: "waiting", steps: 2, activity: "", activityKind: "", replied: false, replyAsk: "", narrator: false, roleWorker: false, failure: null, transcriptMtime: Date.now(), startedAt: new Date().toISOString(), lastStepAt: new Date().toISOString(), usage: { inputTokens: 200, cacheReadTokens: 0, outputTokens: 40, totalTokens: 240 }, posts: 1, lastPostSeq: 1, lastPostTime: "12:00:00", lastPostTs: Date.now() },
          ],
          messages: [{ seq: 1, agent: "coordinator", text: "@all Checkpoint swarm", time: "12:00:00", ts: Date.now(), mentions: [], all: true }],
          plan: { etag: liveGoal === "Initial checkpoint goal" ? "pl-1" : "pl-2", goal: liveGoal, workstreams: [] },
          replyRefs: {},
          edges: [],
          triage: [],
          ops: [],
          usage: { inputTokens: 200, cacheReadTokens: 0, outputTokens: 40, totalTokens: 240 },
          capabilities: { canSendMessage: true, isSidecar: false, sseStream: false, deltaStream: false },
        }),
      });
    });

    await cPage.route("**/api/checkpoints/restore", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      restoreCalls.push(body);
      if (body.mode === "plan") {
        liveGoal = "Initial checkpoint goal";
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, mode: "plan", checkpointId: body.checkpointId, etag: "pl-1" }) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, mode: "resume_prompt", checkpointId: body.checkpointId, resumePrompt: "@coordinator Resume from Before Wave E2 (#2) in ~/wt." }),
      });
    });

    await cPage.route("**/api/checkpoints*", async (route) => {
      if (route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData() || "{}");
        cpPosts.push(body);
        const created = { id: "cp-2", conversationId: "e2-cp", label: body.label, createdAt: Date.now(), head: 5, planEtag: "pl-2", planGoal: liveGoal, worktrees: [] };
        cps = [created, ...cps];
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, checkpoint: created, checkpoints: cps }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, conversationId: "e2-cp", checkpoints: cps }) });
    });

    await cPage.route("**/api/nudge", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      nudgeCalls.push(body);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, opId: "op-cp-1", status: "dispatched" }) });
    });

    await cPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await cPage.waitForSelector('[data-testid="checkpoint-card-cp-1"]');

    await cPage.locator('[data-testid="checkpoint-compare-cp-1"]').click();
    await cPage.waitForSelector('[data-testid="checkpoint-diff-cp-1"]');
    const diffTxt = await cPage.locator('[data-testid="checkpoint-diff-cp-1"]').textContent();

    await cPage.locator('button[aria-label="Open command palette"]').click();
    await cPage.waitForSelector('[cmdk-input]');
    await cPage.fill('[cmdk-input]', 'Create checkpoint');
    await cPage.keyboard.press('Enter');
    await cPage.waitForSelector('[data-testid="checkpoint-create-form"]');
    await cPage.fill('[data-testid="checkpoint-label-input"]', 'Gate CP 2');
    await cPage.locator('[data-testid="checkpoint-create-submit"]').click();
    await cPage.waitForSelector('[data-testid="checkpoint-card-cp-2"]');

    await cPage.locator('[data-testid="checkpoint-restore-plan-cp-1"]').click();
    await cPage.waitForFunction(() => (document.querySelector('[data-testid="swarm-plan-card"]')?.textContent || "").includes("Initial checkpoint goal"));

    await cPage.locator('[data-testid="checkpoint-resume-prompt-cp-1"]').click();
    await cPage.waitForSelector('[data-testid="checkpoint-resume-drawer-cp-1"]');
    await cPage.locator('[data-testid="checkpoint-send-resume-cp-1"]').click();
    await cPage.waitForFunction(() => !document.querySelector('[data-testid="checkpoint-resume-drawer-cp-1"]'));
    const ov380 = await cPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    await cPage.close();
    return (
      Boolean(diffTxt?.includes("+3 posts (#2 to #5)") && diffTxt.includes("Plan changed")) &&
      cpPosts.some((c) => c.confirm === true && c.label === "Gate CP 2") &&
      restoreCalls.some((c) => c.confirm === true && c.checkpointId === "cp-1" && c.mode === "plan") &&
      restoreCalls.some((c) => c.confirm === true && c.checkpointId === "cp-1" && c.mode === "resume_prompt") &&
      nudgeCalls.some((c) => c.confirm === true && String(c.message || "").includes("Before Wave E2")) &&
      ov380 <= 0 &&
      cErrors.length === 0
    );
  });

  // 26-28: Clean runtime guarantees
  await check("zero console errors", () => consoleErrors.length === 0);
  await check("zero uncaught page errors", () => pageErrors.length === 0);
  await check("zero external network requests and failed local requests", () => externalRequests.length === 0 && failedRequests.length === 0);

  await ctx.close();
});

await browser.close();
