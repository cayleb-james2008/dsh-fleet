// Pure client-side Antigravity Swarm Sidecar simulator for `dist-live-web/index.html`.
// Zero external calls; provides stateful /api/swarms, /api/swarm, /api/plan, /api/worktrees, /api/nudge, /api/frame.
(function () {
  window.__FLEET_LIVE_WEB__ = true;

  var COORD_ID = "demo-coord-0001";
  var BUILDER_ID = "demo-builder-0002";
  var VERIFIER_ID = "demo-verifier-0003";
  var UI_ID = "demo-ui-0004";
  var AUDIT_COORD_ID = "demo-audit-0009";
  var NATIVE_COORD_ID = "demo-native-0011";

  var now = Date.now();
  var t = function (secAgo) {
    return now - secAgo * 1000;
  };

  var state = {
    swarms: {
      [COORD_ID]: {
        id: COORD_ID,
        title: "Fleet v1.0 Antigravity Sidecar",
        head: 5,
        member: "coordinator",
        plan: {
          title: "Fleet Antigravity Plugin",
          goal: "Deliver native aux-pane Swarm Command Center with live telemetry and worktrees.",
          gate: "npm test && npm run check:ui",
          workstreams: [
            { id: "ws-backend", title: "Sidecar Node backend + frame security", owner: "builder", status: "done" },
            { id: "ws-ui", title: "Sidebar-first Aux Pane UI (380px + 1440px)", owner: "ui-dev", status: "running" },
            { id: "ws-verify", title: "Cold Playwright & sloplint verification", owner: "verifier", status: "pending" },
          ],
          milestones: [
            { title: "Plugin Manifest & Skill", status: "done" },
            { title: "Sidecar Tests Pass", status: "done" },
            { title: "Cold Verification", status: "in_progress" },
          ],
        },
        members: [
          {
            name: "coordinator",
            conversation_id: COORD_ID,
            model: "gemini-3-pro",
            role: "coordinator",
            wake_mode: "mentions",
            wait_since: 4,
            last_read_seq: 5,
            unread: 0,
            killed: false,
            status: "waiting",
            steps: 14,
            activity: "",
            activityKind: "",
            replied: false,
            replyAsk: "",
            narrator: false,
            roleWorker: false,
            failure: null,
            transcriptMtime: t(40),
            startedAt: new Date(t(900)).toISOString(),
            lastStepAt: new Date(t(40)).toISOString(),
            usage: { inputTokens: 18400, cacheReadTokens: 12000, outputTokens: 1420, totalTokens: 31820 },
            workspace_mode: "inherit",
            posts: 2,
            lastPostSeq: 3,
            lastPostTime: "13:42:10",
            lastPostTs: t(180),
          },
          {
            name: "builder",
            conversation_id: BUILDER_ID,
            model: "gemini-3-pro",
            role: "worker",
            wake_mode: "mentions",
            wait_since: 5,
            last_read_seq: 5,
            unread: 0,
            killed: false,
            status: "waiting",
            steps: 22,
            activity: "Run unit and security tests",
            activityKind: "tool",
            replied: true,
            replyAsk: "Should we enable strict gzip Vary header on /api/swarm too?",
            narrator: false,
            roleWorker: false,
            failure: null,
            transcriptMtime: t(22),
            startedAt: new Date(t(850)).toISOString(),
            lastStepAt: new Date(t(22)).toISOString(),
            lastContextTokens: 96000,
            thinkingHeading: "Verifying Host-403 and CWE-59 frame guard",
            recentTools: [
              { name: "run_command", summary: "Run unit and security tests", time: new Date(t(30)).toISOString() },
              { name: "edit_file", summary: "Edit swarm_store.mjs", time: new Date(t(90)).toISOString() },
            ],
            usage: { inputTokens: 24200, cacheReadTokens: 19400, outputTokens: 2850, totalTokens: 46450 },
            workspace_mode: "share",
            workspace: "/workspace/scratch/fleet-builder",
            posts: 2,
            lastPostSeq: 4,
            lastPostTime: "13:44:05",
            lastPostTs: t(65),
          },
          {
            name: "ui-dev",
            conversation_id: UI_ID,
            model: "gemini-3-pro",
            role: "worker",
            wake_mode: "working",
            wait_since: 0,
            last_read_seq: 4,
            unread: 1,
            killed: false,
            status: "working",
            steps: 18,
            activity: "Polishing 380px sidebar responsive grid",
            activityKind: "thinking",
            replied: false,
            replyAsk: "",
            narrator: false,
            roleWorker: false,
            failure: null,
            transcriptMtime: t(4),
            startedAt: new Date(t(600)).toISOString(),
            lastStepAt: new Date(t(4)).toISOString(),
            usage: { inputTokens: 16800, cacheReadTokens: 9100, outputTokens: 1950, totalTokens: 27850 },
            workspace_mode: "share",
            workspace: "/workspace/scratch/fleet-ui",
            posts: 1,
            lastPostSeq: 5,
            lastPostTime: "13:45:01",
            lastPostTs: t(12),
          },
          {
            name: "verifier",
            conversation_id: VERIFIER_ID,
            model: "gemini-3-flash",
            role: "worker",
            wake_mode: "mentions",
            wait_since: 2,
            last_read_seq: 3,
            unread: 2,
            killed: false,
            status: "waiting",
            steps: 6,
            activity: "Inspecting ~/workspace/fleet-ui diff",
            activityKind: "tool",
            replied: false,
            replyAsk: "",
            narrator: false,
            roleWorker: false,
            failure: null,
            transcriptMtime: t(95),
            startedAt: new Date(t(300)).toISOString(),
            lastStepAt: new Date(t(95)).toISOString(),
            usage: { inputTokens: 4100, cacheReadTokens: 1200, outputTokens: 420, totalTokens: 5720 },
            workspace_mode: "inherit",
            posts: 0,
            lastPostSeq: 0,
            lastPostTime: "",
            lastPostTs: null,
          },
        ],
        messages: [
          {
            seq: 1,
            agent: "coordinator",
            text: "@all Launching Fleet v1.0 sidecar plugin build. Writers stay in share worktrees.",
            time: "13:38:00",
            ts: t(420),
            mentions: [],
            all: true,
          },
          {
            seq: 2,
            agent: "builder",
            text: "@coordinator Implemented sidecar store, CWE-22/59 frame confinement, and 7 unit tests.",
            time: "13:41:12",
            ts: t(230),
            mentions: ["coordinator"],
            all: false,
          },
          {
            seq: 3,
            agent: "coordinator",
            text: "@ui-dev Sync /api/worktrees panel after #2 lands.",
            time: "13:42:10",
            ts: t(180),
            mentions: ["ui-dev"],
            all: false,
          },
          {
            seq: 4,
            agent: "builder",
            text: "@verifier [done] Sidecar HTTP + Host-403 + prompt 413 checks pass (7/7).",
            time: "13:44:05",
            ts: t(65),
            mentions: ["verifier"],
            all: false,
          },
          {
            seq: 5,
            agent: "ui-dev",
            text: "@coordinator Adapting Needs-You triage cards and @mention graph for 380px aux pane.",
            time: "13:45:01",
            ts: t(12),
            mentions: ["coordinator"],
            all: false,
          },
        ],
        frames: [],
      },
      [AUDIT_COORD_ID]: {
        id: AUDIT_COORD_ID,
        title: "Security & Bundle Audit",
        head: 2,
        member: "coordinator",
        plan: {
          title: "Cold Security Signoff",
          goal: "Verify raw-TCP framing and CSP headers cleanly.",
          gate: "node --test",
          workstreams: [{ id: "sec", title: "Raw TCP fuzz", owner: "auditor", status: "done" }],
        },
        members: [
          {
            name: "coordinator",
            conversation_id: AUDIT_COORD_ID,
            model: "gemini-3-pro",
            role: "coordinator",
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
            failure: null,
            transcriptMtime: t(3600),
            startedAt: new Date(t(4200)).toISOString(),
            lastStepAt: new Date(t(3600)).toISOString(),
            usage: { inputTokens: 6400, cacheReadTokens: 2000, outputTokens: 510, totalTokens: 8910 },
            posts: 1,
            lastPostSeq: 1,
            lastPostTime: "12:30:00",
            lastPostTs: t(3900),
          },
          {
            name: "auditor",
            conversation_id: "demo-auditor-0010",
            model: "gemini-3-flash",
            role: "worker",
            wake_mode: "mentions",
            wait_since: 2,
            last_read_seq: 2,
            unread: 0,
            killed: true,
            status: "killed",
            steps: 9,
            activity: "",
            activityKind: "",
            replied: false,
            replyAsk: "",
            narrator: false,
            roleWorker: false,
            failure: null,
            transcriptMtime: t(3500),
            startedAt: new Date(t(3900)).toISOString(),
            lastStepAt: new Date(t(3500)).toISOString(),
            usage: { inputTokens: 9200, cacheReadTokens: 3400, outputTokens: 890, totalTokens: 13490 },
            posts: 1,
            lastPostSeq: 2,
            lastPostTime: "12:36:14",
            lastPostTs: t(3500),
          },
        ],
        messages: [
          {
            seq: 1,
            agent: "coordinator",
            text: "@auditor Run CWE-22, CWE-59, and Host-403 regression checks.",
            time: "12:30:00",
            ts: t(3900),
            mentions: ["auditor"],
            all: false,
          },
          {
            seq: 2,
            agent: "auditor",
            text: "@coordinator [verified] All traversal, symlink, and loopback checks passed.",
            time: "12:36:14",
            ts: t(3500),
            mentions: ["coordinator"],
            all: false,
          },
        ],
        frames: [],
      },
      [NATIVE_COORD_ID]: {
        id: NATIVE_COORD_ID,
        title: "Native Antigravity Swarm",
        head: 2,
        member: "coordinator",
        planVersion: 1,
        plan: {
          goal: {
            title: "Native Plan Schema Support",
            line: "Render native goal.{title,line}, tasks, threads, and narrator view.json cleanly.",
          },
          tasks: {
            "api-worker": "Implement POST /api/plan atomic CAS writes",
            "ui-worker": "Normalize plan.json and render live editor in /home/demo/fleet",
          },
          threads: [
            {
              id: "gap-1",
              title: "Plan Normalization Thread",
              goal: "Support Antigravity native goal object, tasks map, and threads",
              tasks: ["api-worker", "ui-worker"],
            },
          ],
        },
        view: {
          exists: true,
          source: "narrator",
          json: {
            headline: "Narrator tracking native plan normalization",
            phase: "executing",
            running_summary: "Two workers active on plan normalization and live editing.",
            now: {
              "api-worker": "Testing CAS write path in /home/demo/swarm_store.mjs",
              "ui-worker": "Verifying 380px plan editor layout",
            },
            attention: ["Confirm native schema compatibility before merge"],
          },
        },
        members: [
          {
            name: "coordinator",
            conversation_id: NATIVE_COORD_ID,
            model: "gemini-3-pro",
            role: "coordinator",
            wake_mode: "mentions",
            wait_since: 2,
            last_read_seq: 2,
            unread: 0,
            killed: false,
            status: "waiting",
            steps: 6,
            activity: "",
            activityKind: "",
            replied: false,
            replyAsk: "",
            narrator: false,
            roleWorker: false,
            failure: null,
            transcriptMtime: t(120),
            startedAt: new Date(t(600)).toISOString(),
            lastStepAt: new Date(t(120)).toISOString(),
            usage: { inputTokens: 8200, cacheReadTokens: 3100, outputTokens: 640, totalTokens: 11940 },
            posts: 1,
            lastPostSeq: 1,
            lastPostTime: "14:00:00",
            lastPostTs: t(300),
          },
          {
            name: "ui-worker",
            conversation_id: "demo-ui-worker-0012",
            model: "gemini-3-pro",
            role: "worker",
            wake_mode: "working",
            wait_since: 0,
            last_read_seq: 2,
            unread: 0,
            killed: false,
            status: "working",
            steps: 10,
            activity: "Building Live Plan Editor",
            activityKind: "tool",
            replied: false,
            replyAsk: "",
            narrator: false,
            roleWorker: false,
            failure: null,
            transcriptMtime: t(15),
            startedAt: new Date(t(450)).toISOString(),
            lastStepAt: new Date(t(15)).toISOString(),
            usage: { inputTokens: 11400, cacheReadTokens: 4200, outputTokens: 980, totalTokens: 16580 },
            posts: 1,
            lastPostSeq: 2,
            lastPostTime: "14:04:12",
            lastPostTs: t(40),
          },
        ],
        messages: [
          {
            seq: 1,
            agent: "coordinator",
            text: "@all Native swarm started with goal.{title,line} plan.json.",
            time: "14:00:00",
            ts: t(300),
            mentions: [],
            all: true,
          },
          {
            seq: 2,
            agent: "ui-worker",
            text: "@coordinator Normalized plan.json and narrator view.json in Triage.",
            time: "14:04:12",
            ts: t(40),
            mentions: ["coordinator"],
            all: false,
          },
        ],
        frames: [],
      },
    },
    worktrees: [
      {
        id: "wt-main",
        root: "/workspace/fleet",
        name: "fleet",
        path: "/workspace/fleet",
        uri: "file:///workspace/fleet",
        isMain: true,
        exists: true,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        branch: "main",
        head: "8c54f0ec",
        clean: true,
        baseBranch: "main",
        ahead: 0,
        behind: 0,
        landStatus: "main",
        mergeability: "main",
        dirtyFiles: 0,
        untrackedFiles: 0,
        stagedFiles: 0,
        commits: [
          { sha: "8c54f0ec", subject: "feat(v1.0.0): Antigravity-native Fleet sidecar plugin", authorTime: "5m ago" },
        ],
        lastCommitSha: "8c54f0ec",
        lastCommitSubject: "feat(v1.0.0): Antigravity-native Fleet sidecar plugin",
        lastCommitAt: t(320),
      },
      {
        id: "wt-builder",
        root: "/workspace/fleet",
        name: "fleet-builder",
        path: "/workspace/scratch/fleet-builder",
        uri: "file:///workspace/scratch/fleet-builder",
        isMain: false,
        exists: true,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        branch: "lane/sidecar-backend",
        head: "9a31d4b0",
        clean: true,
        baseBranch: "main",
        ahead: 1,
        behind: 0,
        landStatus: "ready",
        mergeability: "clean",
        dirtyFiles: 0,
        untrackedFiles: 0,
        stagedFiles: 0,
        branchFiles: [
          "sidecars/fleet_pane/git_probe.mjs",
          "sidecars/fleet_pane/server_core.mjs",
          "frontend/src/sidecar.ts",
        ],
        commits: [
          { sha: "9a31d4b0", subject: "test: add CWE-22/59 frame confinement & 413 tests", authorTime: "2m ago" },
        ],
        lastCommitSha: "9a31d4b0",
        lastCommitSubject: "test: add CWE-22/59 frame confinement & 413 tests",
        lastCommitAt: t(95),
      },
      {
        id: "wt-ui",
        root: "/workspace/fleet",
        name: "fleet-ui",
        path: "/workspace/scratch/fleet-ui",
        uri: "file:///workspace/scratch/fleet-ui",
        isMain: false,
        exists: true,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        branch: "lane/sidebar-ui",
        head: "c42e81f2",
        clean: false,
        baseBranch: "main",
        ahead: 2,
        behind: 0,
        landStatus: "dirty",
        mergeability: "dirty",
        dirtyFiles: 3,
        untrackedFiles: 1,
        stagedFiles: 0,
        files: [
          {
            path: "frontend/src/components/WorktreesView.tsx",
            state: "M",
            uri: "file:///workspace/scratch/fleet-ui/frontend/src/components/WorktreesView.tsx",
          },
          {
            path: "frontend/src/sidecar.ts",
            state: "M",
            uri: "file:///workspace/scratch/fleet-ui/frontend/src/sidecar.ts",
          },
        ],
        branchFiles: [
          "frontend/src/types.ts",
          "frontend/src/sidecar.ts",
        ],
        commits: [
          { sha: "c42e81f2", subject: "ui: refine 380px Needs-You triage cards", authorTime: "1m ago" },
          { sha: "b102f8a1", subject: "ui: wire worktree operator controls", authorTime: "4m ago" },
        ],
        lastCommitSha: "c42e81f2",
        lastCommitSubject: "ui: refine 380px Needs-You triage cards",
        lastCommitAt: t(25),
      },
    ],
  };

  function computeWorktreeCollisions(worktrees) {
    var byFile = {};
    (worktrees || []).forEach(function (wt) {
      if (wt.isMain) return;
      (wt.files || []).forEach(function (f) {
        var fp = typeof f === "string" ? f : f.path;
        if (!fp) return;
        byFile[fp] = byFile[fp] || { working: {}, branch: {} };
        byFile[fp].working[wt.path] = wt.branch;
      });
      (wt.branchFiles || []).forEach(function (f) {
        var fp = typeof f === "string" ? f : f.path;
        if (!fp) return;
        byFile[fp] = byFile[fp] || { working: {}, branch: {} };
        byFile[fp].branch[wt.path] = wt.branch;
      });
    });
    var out = [];
    Object.keys(byFile).sort().forEach(function (file) {
      var entry = byFile[file];
      var allPaths = {};
      Object.keys(entry.working).forEach(function (p) { allPaths[p] = entry.working[p]; });
      Object.keys(entry.branch).forEach(function (p) { allPaths[p] = entry.branch[p]; });
      var paths = Object.keys(allPaths);
      if (paths.length < 2) return;
      var hasWorking = Object.keys(entry.working).length > 0;
      var hasBranch = Object.keys(entry.branch).length > 0;
      out.push({
        file: file,
        worktrees: paths,
        branches: paths.map(function (p) { return allPaths[p]; }),
        kind: hasWorking && hasBranch ? "mixed" : hasBranch ? "branch" : "working",
      });
    });
    return out;
  }

  function planEtagOf(sw) {
    return sw && sw.plan ? "plan-v" + (sw.planVersion || 1) : "";
  }

  function normalizePlanForSnapshot(raw, etag) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var goalTitle = typeof raw.goalTitle === "string" ? raw.goalTitle : undefined;
    var goalLine = typeof raw.goalLine === "string" ? raw.goalLine : undefined;
    var goal = "";
    if (typeof raw.goal === "string") {
      goal = raw.goal;
    } else if (raw.goal && typeof raw.goal === "object") {
      goalTitle = typeof raw.goal.title === "string" ? raw.goal.title : goalTitle;
      goalLine = typeof raw.goal.line === "string" ? raw.goal.line : goalLine;
      goal = goalLine || goalTitle || "";
    }
    var threads = Array.isArray(raw.threads) ? raw.threads.map(function (th, idx) {
      return {
        id: String((th && th.id) || ("thread-" + (idx + 1))),
        title: String((th && th.title) || ""),
        goal: String((th && th.goal) || ""),
        tasks: Array.isArray(th && th.tasks) ? th.tasks.map(String) : [],
      };
    }) : [];
    var tasks = {};
    if (raw.tasks && typeof raw.tasks === "object" && !Array.isArray(raw.tasks)) {
      Object.keys(raw.tasks).forEach(function (k) {
        if (raw.tasks[k]) tasks[k] = String(raw.tasks[k]);
      });
    }
    var workstreams = Array.isArray(raw.workstreams) ? raw.workstreams.map(function (ws, idx) {
      return {
        id: String((ws && ws.id) || ("ws-" + (idx + 1))),
        title: String((ws && ws.title) || ""),
        owner: String((ws && ws.owner) || ""),
        status: String((ws && ws.status) || "pending"),
      };
    }) : [];
    var milestones = Array.isArray(raw.milestones) ? raw.milestones.map(function (ms) {
      return { title: String((ms && ms.title) || ""), status: String((ms && ms.status) || "pending") };
    }) : [];
    var risks = Array.isArray(raw.risks) ? raw.risks.map(function (r) {
      return typeof r === "string" ? { title: r } : { title: String((r && r.title) || ""), severity: r && r.severity ? String(r.severity) : undefined };
    }) : [];
    var hasNative = Boolean(threads.length || Object.keys(tasks).length || goalTitle || goalLine);
    var hasFleet = Boolean(workstreams.length || milestones.length || raw.gate);
    var schema = hasNative && hasFleet ? "hybrid" : hasNative ? "native" : "fleet";
    return Object.assign(
      {
        schema: schema,
        etag: etag || "",
        title: String(raw.title || goalTitle || ""),
        goal: goal,
        gate: String(raw.gate || ""),
        threads: threads,
        tasks: tasks,
        workstreams: workstreams,
        milestones: milestones,
        risks: risks,
      },
      goalTitle ? { goalTitle: goalTitle } : {},
      goalLine ? { goalLine: goalLine } : {},
    );
  }

  function findSwarmByConvId(convId) {
    if (!convId) return null;
    if (state.swarms[convId]) return state.swarms[convId];
    var all = Object.values(state.swarms);
    for (var i = 0; i < all.length; i++) {
      if ((all[i].members || []).some(function (m) { return m.conversation_id === convId; })) {
        return all[i];
      }
    }
    return null;
  }

  function computeSnapshot(id) {
    var sw = state.swarms[id];
    if (!sw) return { conversationId: id || null, swarm: null, member: null, swarms: listSwarms(), capabilities: { canSendMessage: true, isSidecar: false } };
    var triage = [];
    for (var i = 0; i < sw.members.length; i++) {
      var m = sw.members[i];
      if (!m.killed && m.failure) {
        triage.push({
          id: "sys-" + m.name + "-" + m.failure.kind,
          kind: m.failure.kind,
          severity: "urgent",
          member: m.name,
          conversationId: m.conversation_id,
          seq: m.lastPostSeq || 0,
          title: m.name + ": last step failed (" + m.failure.kind + ")",
          detail: m.failure.text || "Inspect transcript and continue.",
          suggestedPrompt: "@" + m.name + " Recover and continue.",
          timestamp: m.transcriptMtime || now,
        });
      }
      if (!m.killed && m.replyAsk) {
        triage.push({
          id: "ask-" + m.name,
          kind: "question",
          severity: "attention",
          member: m.name,
          conversationId: m.conversation_id,
          seq: m.lastPostSeq,
          title: m.name + " asked a question",
          detail: m.replyAsk,
          suggestedPrompt: "@" + m.name + " Yes, keep Vary: Accept-Encoding on JSON responses.",
          timestamp: m.transcriptMtime,
        });
      }
    }
    var hasVerified = sw.messages.some(function (msg) {
      return msg.text.indexOf("[verified]") >= 0;
    });
    if (!hasVerified) {
      sw.messages.forEach(function (msg) {
        if (msg.text.indexOf("[done]") >= 0) {
          var sender = sw.members.find(function (m) { return m.name === msg.agent; });
          triage.push({
            id: "verify-" + msg.agent + "-" + msg.seq,
            kind: "verify",
            severity: "verify",
            member: msg.agent,
            conversationId: sender ? sender.conversation_id : "",
            seq: msg.seq,
            title: msg.agent + " awaits cold verification (#" + msg.seq + ")",
            detail: msg.text,
            suggestedPrompt: "@verifier Cold-verify #" + msg.seq + " and post [verified].",
            timestamp: msg.ts || now,
          });
        }
      });
    }
    var usage = sw.members.reduce(
      function (acc, m) {
        acc.inputTokens += m.usage.inputTokens;
        acc.cacheReadTokens += m.usage.cacheReadTokens;
        acc.outputTokens += m.usage.outputTokens;
        acc.totalTokens += m.usage.totalTokens;
        return acc;
      },
      { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 },
    );
    var burnRows = sw.members
      .filter(function (m) { return !m.roleWorker && m.usage.totalTokens > 0; })
      .map(function (m) {
        var tok = m.usage.totalTokens;
        var sharePct = usage.totalTokens > 0 ? Math.round((tok / usage.totalTokens) * 100) : 0;
        var level = tok >= 400000 || (usage.totalTokens >= 20000 && sharePct >= 65 && sw.members.length >= 2)
          ? "critical"
          : tok >= 150000 || (usage.totalTokens >= 10000 && sharePct >= 45 && sw.members.length >= 2)
            ? "warn"
            : "normal";
        return { name: m.name, totalTokens: tok, sharePct: sharePct, level: level, killed: Boolean(m.killed) };
      })
      .sort(function (a, b) { return b.totalTokens - a.totalTokens || a.name.localeCompare(b.name); });
    var burnSummary = {
      totalTokens: usage.totalTokens,
      topWorker: burnRows[0] || null,
      highBurnCount: burnRows.filter(function (r) { return r.level !== "normal"; }).length,
      workers: burnRows.slice(0, 6),
    };
    var dC = 0, dS = 0, vC = 0, vS = 0, sC = 0, sS = 0, bC = 0, bS = 0, bAgent = "", shC = 0, shS = 0, fTs = 0, lTs = 0;
    sw.messages.forEach(function (m) {
      if (!m || !m.text) return;
      var hasBrk = m.text.indexOf("[") >= 0;
      var hasShip = /\bshipped\b/i.test(m.text);
      if (!hasBrk && !hasShip) return;
      var hit = false;
      if (hasBrk) {
        if (/\[scale-verified\]/i.test(m.text)) { sC++; sS = Math.max(sS, m.seq); hit = true; }
        else if (/\[verified\]/i.test(m.text)) { vC++; vS = Math.max(vS, m.seq); hit = true; }
        else if (/\[done\]/i.test(m.text)) { dC++; dS = Math.max(dS, m.seq); hit = true; }
        if (/\[blocked\]/i.test(m.text)) { bC++; if (m.seq >= bS) { bS = m.seq; bAgent = m.agent || ""; } hit = true; }
      }
      if (hasShip) { shC++; shS = Math.max(shS, m.seq); hit = true; }
      if (hit && m.ts > 0) { if (!fTs || m.ts < fTs) fTs = m.ts; if (m.ts > lTs) lTs = m.ts; }
    });
    var activeBlk = triage.find(function (x) { return (x.kind === "blocked" || x.severity === "urgent") && x.seq > 0; });
    var maxSt = Math.max(dS, vS, sS);
    var gState = activeBlk || bS > maxSt ? "blocked" : sC > 0 && dS <= vS && vS <= sS ? "ready" : "verifying";
    var gSeq = activeBlk ? activeBlk.seq : dS > vS ? dS : vS > sS ? vS : bS > maxSt ? bS : sS || vS || dS || 0;
    var pickM = function (prefs, fb) {
      for (var pi = 0; pi < prefs.length; pi++) {
        var hit = sw.members.find(function (m) { return !m.killed && (m.name === prefs[pi] || m.name.indexOf(prefs[pi]) === 0); });
        if (hit) return hit;
      }
      return { name: prefs[0] || fb, conversation_id: "" };
    };
    var nextAction = null;
    if (dC || vC || sC || bC || shC || activeBlk) {
      if (gState === "blocked") {
        var bHit = pickM([activeBlk ? activeBlk.member : bAgent || "coordinator"], "coordinator");
        nextAction = { kind: "unblock", target: bHit.name, conversationId: (activeBlk && activeBlk.conversationId) || bHit.conversation_id || "", seq: gSeq, label: "Unblock @" + bHit.name, prompt: "@" + bHit.name + (gSeq ? " Re #" + gSeq + ":" : "") + " Resolve blocker on " + sw.title + " and post updated [done]." };
      } else if (dS > vS) {
        var vHit = pickM(["ux-verifier", "verifier"], "ux-verifier");
        nextAction = { kind: "verify", target: vHit.name, conversationId: vHit.conversation_id || "", seq: dS, label: "Nudge @" + vHit.name, prompt: "@" + vHit.name + " Re #" + dS + ": Cold-verify " + sw.title + " and post [verified]." };
      } else if (vS > sS) {
        var sHit = pickM(["scale-auditor", "auditor"], "scale-auditor");
        nextAction = { kind: "scale", target: sHit.name, conversationId: sHit.conversation_id || "", seq: vS, label: "Nudge @" + sHit.name, prompt: "@" + sHit.name + " Re #" + vS + ": Run cold scale/security audit on " + sw.title + " and post [scale-verified]." };
      } else {
        var rHit = pickM(["release-ops", "coordinator"], "release-ops");
        nextAction = { kind: "ship", target: rHit.name, conversationId: rHit.conversation_id || "", seq: sS || gSeq, label: "Nudge @" + rHit.name, prompt: "@" + rHit.name + " Re #" + (sS || gSeq) + ": " + sw.title + " is [scale-verified] and ready to ship." };
      }
    }
    var okC = dC + vC + sC;
    var totC = okC + bC;
    var passPct = totC > 0 ? Math.round((okC / totC) * 100) : 0;
    var wavesC = Math.max(shC, sC) || (vC > 0 ? vC : dC);
    var spanMs = fTs > 0 && lTs > fTs ? lTs - fTs : 0;
    var wPerHr = spanMs >= 60000 ? Number(((wavesC * 3600000) / spanMs).toFixed(1)) : 0;
    var gateReadiness = (dC || vC || sC || bC || shC || activeBlk) ? {
      state: gState,
      pendingSeq: gSeq,
      nextAction: nextAction,
      velocity: {
        passRatePct: passPct,
        waves: wavesC,
        wavesPerHr: wPerHr,
        shippedSeq: shS || sS || vS || dS || 0,
        exactShipped: Boolean(shS || sS),
        done: dC,
        verified: vC,
        scaleVerified: sC,
        blocked: bC,
      },
      stages: [
        { key: "done", label: "[done]", count: dC, seq: dS },
        { key: "verified", label: "[verified]", count: vC, seq: vS },
        { key: "scale", label: "[scale-verified]", count: sC, seq: sS },
        { key: "blocked", label: "[blocked]", count: bC, seq: bS },
      ],
    } : null;
    return {
      conversationId: sw.id,
      swarm: sw.id,
      member: sw.member,
      etag: "liveweb-" + sw.head + "-" + triage.length + "-" + (sw.planVersion || 1),
      id: sw.id,
      title: sw.title,
      head: sw.head,
      members: sw.members.map(function (m) {
        if (m.killed || m.activityPeek) return m;
        var label = (m.activity || (m.recentTools && m.recentTools[0] && m.recentTools[0].summary) || m.thinkingHeading || (m.status === "waiting" ? "Waiting on board" : ""))
          .replace(/\/(?:home|Users)\/[^/\s]+(\/|$)/g, function (_m, sep) { return "~" + sep; });
        return Object.assign({}, m, {
          activityPeek: label
            ? {
                status: m.status === "working" ? "working" : "waiting",
                label: label,
                tool: m.activityKind || (m.recentTools && m.recentTools[0] && m.recentTools[0].name) || "tool",
                ts: m.transcriptMtime || 0,
              }
            : null,
        });
      }),
      messages: sw.messages,
      edges: [],
      view: sw.view || null,
      plan: normalizePlanForSnapshot(sw.plan, planEtagOf(sw)),
      frames: sw.frames,
      triage: triage,
      burnSummary: burnSummary,
      gateReadiness: gateReadiness,
      usage: usage,
      capabilities: { canSendMessage: true, isSidecar: false, sseStream: false },
    };
  }

  function listSwarms() {
    return Object.values(state.swarms).map(function (sw) {
      var snap = computeSnapshot(sw.id);
      return {
        id: sw.id,
        title: sw.title,
        appData: "live-web",
        head: sw.head,
        memberCount: sw.members.length,
        activeCount: sw.members.filter(function (m) { return !m.killed && m.status === "working"; }).length,
        waitingCount: sw.members.filter(function (m) { return !m.killed && m.status === "waiting"; }).length,
        killedCount: sw.members.filter(function (m) { return m.killed; }).length,
        triageCount: snap.triage.length,
        totalTokens: snap.usage.totalTokens,
        hasPlan: Boolean(sw.plan),
        lastActivityTs: now,
      };
    });
  }

  window.sidecar = {
    conversationId: COORD_ID,
    standalone: true,
    getWorkspaceUris: async function () {
      return ["file:///workspace/fleet"];
    },
    onWorkspaceChange: function () {
      return function () {};
    },
    ui: {
      toggleConversation: function (convId) {
        console.info("[fleet live-web] toggleConversation:", convId);
      },
      toggleAuxPane: function (req) {
        console.info("[fleet live-web] toggleAuxPane:", req);
      },
    },
    agent: {
      sendMessage: async function (message, convId) {
        var sw = state.swarms[COORD_ID];
        var target = sw.members.find(function (m) { return m.conversation_id === convId; });
        sw.head += 1;
        sw.messages.push({
          seq: sw.head,
          agent: "coordinator",
          text: message,
          time: new Date().toTimeString().slice(0, 8),
          ts: Date.now(),
          mentions: target ? [target.name] : [],
          all: false,
        });
        if (target) {
          target.replyAsk = "";
          target.status = "working";
        }
        return { ok: true };
      },
    },
  };

  var origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    var urlStr = typeof input === "string" ? input : input.url;
    var url = new URL(urlStr, window.location.origin);
    var jsonResp = function (data, status) {
      return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    if (url.pathname === "/api/plan" && init && String(init.method || "").toUpperCase() === "POST") {
      var rawPlanBody = String(init.body || "{}");
      if (rawPlanBody.length > 65536) {
        return jsonResp({ error: "Payload too large" }, 413);
      }
      var planBody = {};
      try { planBody = JSON.parse(rawPlanBody); } catch { return jsonResp({ error: "Invalid JSON" }, 400); }
      if (!planBody.confirm || !planBody.patch || typeof planBody.patch !== "object") {
        return jsonResp({ error: "confirm and patch required" }, 400);
      }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(rawPlanBody)) {
        return jsonResp({ error: "Control characters not permitted" }, 400);
      }
      var targetSw = findSwarmByConvId(planBody.conversationId);
      if (!targetSw) {
        return jsonResp({ error: "Unknown swarm" }, 404);
      }
      var curPlanEtag = planEtagOf(targetSw);
      if (typeof planBody.ifMatch === "string" && targetSw.plan && planBody.ifMatch !== curPlanEtag) {
        return jsonResp({ error: "plan changed on disk", plan: normalizePlanForSnapshot(targetSw.plan, curPlanEtag) }, 409);
      }
      var basePlan = planBody.mode === "replace" || !targetSw.plan ? {} : Object.assign({}, targetSw.plan);
      var patch = planBody.patch;
      var isNativeObj = (basePlan.goal && typeof basePlan.goal === "object") || patch.goalTitle !== undefined || patch.goalLine !== undefined;
      if (isNativeObj) {
        var prevObj = basePlan.goal && typeof basePlan.goal === "object" ? basePlan.goal : {};
        basePlan.goal = {
          title: patch.goalTitle !== undefined ? String(patch.goalTitle) : String(prevObj.title || basePlan.title || ""),
          line: patch.goalLine !== undefined ? String(patch.goalLine) : patch.goal !== undefined ? String(patch.goal) : String(prevObj.line || ""),
        };
      } else if (patch.goal !== undefined) {
        basePlan.goal = String(patch.goal);
      }
      if (patch.title !== undefined) basePlan.title = String(patch.title);
      if (patch.gate !== undefined) basePlan.gate = String(patch.gate);
      if (patch.tasks !== undefined && patch.tasks && typeof patch.tasks === "object") basePlan.tasks = patch.tasks;
      if (Array.isArray(patch.threads)) basePlan.threads = patch.threads;
      if (Array.isArray(patch.workstreams)) basePlan.workstreams = patch.workstreams;
      if (Array.isArray(patch.milestones)) basePlan.milestones = patch.milestones;
      if (Array.isArray(patch.risks)) basePlan.risks = patch.risks;
      targetSw.plan = basePlan;
      targetSw.planVersion = (targetSw.planVersion || 1) + 1;
      var nextEtag = planEtagOf(targetSw);
      var notified = false;
      if (planBody.notifyCoordinator) {
        notified = true;
        targetSw.head += 1;
        targetSw.messages.push({
          seq: targetSw.head,
          agent: "coordinator",
          text: "@coordinator Plan updated: " + (typeof basePlan.goal === "object" ? basePlan.goal.line || basePlan.goal.title : basePlan.goal || basePlan.title || "updated"),
          time: new Date().toTimeString().slice(0, 8),
          ts: Date.now(),
          mentions: ["coordinator"],
          all: false,
        });
      }
      return jsonResp({ ok: true, plan: normalizePlanForSnapshot(targetSw.plan, nextEtag), etag: nextEtag, notified: notified });
    }
    if (url.pathname === "/api/nudge" && init && String(init.method || "").toUpperCase() === "POST") {
      var body = {};
      try { body = JSON.parse(String(init.body || "{}")); } catch {}
      var msg = typeof body.message === "string" ? body.message.trim() : "";
      if (!body.confirm || !msg || msg.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(String(body.message || ""))) {
        return jsonResp({ error: "Invalid nudge payload" }, 400);
      }
      var targets = Array.isArray(body.conversationIds) ? body.conversationIds : body.conversationId ? [body.conversationId] : [];
      if (!targets.length) return jsonResp({ error: "Target required" }, 400);
      var sw = state.swarms[COORD_ID];
      var hitNames = [];
      for (var ti = 0; ti < targets.length; ti++) {
        var m = sw.members.find(function (x) { return x.conversation_id === targets[ti]; });
        if (m) {
          m.replyAsk = "";
          m.status = "working";
          hitNames.push(m.name);
        }
      }
      sw.head += 1;
      sw.messages.push({
        seq: sw.head,
        agent: "coordinator",
        text: msg,
        time: new Date().toTimeString().slice(0, 8),
        ts: Date.now(),
        mentions: hitNames,
        all: /@all\b/i.test(msg),
      });
      return jsonResp({ ok: true, delivered: targets.length });
    }
    if (url.pathname === "/api/health") {
      return jsonResp({ ok: true, name: "fleet", version: "1.19.0", mode: "live-web", canSendMessage: true, sseStream: false, idleSleep: false, sseClients: 0 });
    }
    if (url.pathname === "/api/swarms") {
      return jsonResp({ swarms: listSwarms(), defaultConversationId: COORD_ID });
    }
    if (url.pathname === "/api/swarm") {
      var conv = url.searchParams.get("conversationId") || COORD_ID;
      var snap = computeSnapshot(conv);
      if (url.searchParams.get("etag") && url.searchParams.get("etag") === snap.etag) {
        return jsonResp({ conversationId: conv, swarm: snap.swarm, member: snap.member, unchanged: true, etag: snap.etag });
      }
      return jsonResp(snap);
    }
    if (url.pathname === "/api/worktrees") {
      return jsonResp({
        roots: [{ path: "/workspace/fleet", uri: "file:///workspace/fleet", isGit: true, count: state.worktrees.length, error: "" }],
        worktrees: state.worktrees,
        collisions: computeWorktreeCollisions(state.worktrees),
        rejected: [],
      });
    }
    if (url.pathname === "/api/worktrees/diff") {
      var wtPath = url.searchParams.get("worktree") || url.searchParams.get("path") || "/workspace/fleet";
      var relFile = url.searchParams.get("file") || "README.md";
      var diffMode = url.searchParams.get("mode") === "branch" ? "branch" : "working";
      var diffBody = diffMode === "branch"
        ? "@@ -1,3 +1,5 @@\n export interface WorktreeChange {}\n+export type WorktreeDiffMode = \"working\" | \"branch\";\n+// committed on branch"
        : "@@ -12,4 +12,6 @@\n-  const cached = probeCache.get(key);\n+  const realTarget = realpathSync(abs);\n+  if (!realTarget.startsWith(wtPrefix)) return { ok: false, status: 404 };\n   return capDiff(stdout, 8192);";
      return jsonResp({
        ok: true,
        worktree: wtPath,
        file: relFile,
        mode: diffMode,
        diff: diffBody,
        truncated: false,
        untracked: false,
        added: 2,
        removed: 1,
      });
    }
    if (url.pathname === "/api/worktrees/action" && init && String(init.method || "").toUpperCase() === "POST") {
      var actBody = {};
      try { actBody = JSON.parse(String(init.body || "{}")); } catch { return jsonResp({ error: "Invalid JSON" }, 400); }
      var actName = String(actBody.action || "");
      var targetPath = String(actBody.path || actBody.worktree || "");
      var targetWt = state.worktrees.find(function (w) { return w.path === targetPath; });
      if (!targetWt) return jsonResp({ error: "Unknown worktree" }, 404);
      var collisionsNow = computeWorktreeCollisions(state.worktrees);
      var collidingFiles = collisionsNow
        .filter(function (c) { return c.worktrees.indexOf(targetWt.path) >= 0; })
        .map(function (c) { return c.file; });

      if (actName === "dry_run_merge") {
        if (targetWt.branch === "lane/sidebar-ui" && collidingFiles.length > 0) {
          return jsonResp({
            ok: false,
            action: actName,
            status: "conflict",
            conflicts: collidingFiles,
            message: "Dry-run merge detected conflicting changes against main.",
          });
        }
        return jsonResp({
          ok: true,
          action: actName,
          status: "clean",
          conflicts: [],
          message: "Dry-run merge with " + (targetWt.baseBranch || "main") + " is clean.",
        });
      }
      if (actName === "rebase") {
        if (targetWt.isMain) return jsonResp({ error: "Cannot rebase primary worktree" }, 400);
        if (targetWt.branch === "lane/sidebar-ui" && collidingFiles.length > 0) {
          return jsonResp({
            ok: false,
            action: actName,
            status: "conflict",
            aborted: true,
            conflicts: collidingFiles,
            message: "Rebase hit conflict and was aborted cleanly.",
          }, 409);
        }
        targetWt.behind = 0;
        targetWt.mergeability = "clean";
        return jsonResp({
          ok: true,
          action: actName,
          status: "rebased",
          conflicts: [],
          message: "Rebased " + targetWt.branch + " onto " + (targetWt.baseBranch || "main") + ".",
        });
      }
      if (actName === "ff_merge") {
        if (targetWt.isMain) return jsonResp({ error: "Cannot FF merge primary worktree" }, 400);
        if (!targetWt.clean) {
          return jsonResp({ ok: false, action: actName, status: "dirty", message: "Worktree has uncommitted changes." }, 409);
        }
        targetWt.ahead = 0;
        targetWt.landStatus = "merged";
        targetWt.mergeability = "clean";
        return jsonResp({
          ok: true,
          action: actName,
          status: "merged",
          message: "Fast-forward merged " + targetWt.branch + " into " + (targetWt.baseBranch || "main") + ".",
        });
      }
      if (actName === "remove_worktree") {
        if (targetWt.isMain) return jsonResp({ error: "Cannot remove primary worktree" }, 400);
        if (!targetWt.clean || (targetWt.ahead || 0) > 0) {
          return jsonResp({
            ok: false,
            action: actName,
            status: "unmerged",
            message: "Worktree must be clean and merged before removal.",
          }, 409);
        }
        state.worktrees = state.worktrees.filter(function (w) { return w.path !== targetWt.path; });
        return jsonResp({
          ok: true,
          action: actName,
          status: "removed",
          message: "Removed clean worktree " + targetWt.branch + ".",
        });
      }
      return jsonResp({ error: "Unsupported action" }, 400);
    }
    return origFetch(input, init);
  };
})();
