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
    if (!txt || !/\d+% pass/.test(txt) || !txt.includes("1d · 0v · 0s · 0b")) return false;
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

  await check("roster Token Burn Guard Strip shows top consumer share", async () => {
    const txt = await page.locator('#panel-roster [data-testid="token-burn-strip"]').textContent();
    return txt.includes("Token burn") && txt.includes("builder") && /\d+%/.test(txt);
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
    return preTxt.includes("(untracked)") && preTxt.includes("+");
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

  // 26-28: Clean runtime guarantees
  await check("zero console errors", () => consoleErrors.length === 0);
  await check("zero uncaught page errors", () => pageErrors.length === 0);
  await check("zero external network requests and failed local requests", () => externalRequests.length === 0 && failedRequests.length === 0);

  await ctx.close();
});

await browser.close();
