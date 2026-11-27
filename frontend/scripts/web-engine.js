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
  var opCounter = 100;

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
            channel: "backend",
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
            channel: "ui",
            text: "@coordinator Adapting Needs-You triage cards and @mention graph for 380px aux pane.",
            time: "13:45:01",
            ts: t(12),
            mentions: ["coordinator"],
            all: false,
          },
        ],
        channels: [
          { name: "backend", topic: "Sidecar store, git probe, and security checks", created_by: "coordinator", archived: false },
          { name: "ui", topic: "Sidebar layout and live-web parity", created_by: "coordinator", archived: false },
        ],
        frames: [],
        ops: [],
        repo: "/workspace/fleet",
        archived: false,
        pinnedSeqs: [],
        triageAcks: {},
        checkpoints: [
          {
            id: "cp-seed-1",
            conversationId: COORD_ID,
            label: "Initial sidecar baseline",
            createdAt: t(200),
            head: 3,
            planEtag: "plan-v1",
            planGoal: "Deliver native aux-pane Swarm Command Center with live telemetry and worktrees.",
            planSnapshot: {
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
            worktrees: [
              { path: "/workspace/scratch/fleet-ui", branch: "lane/sidebar-ui", head: "b102f8a1", clean: true, dirtyFiles: 0 },
            ],
          },
        ],
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
          {
            name: "scanner",
            conversation_id: "demo-scanner-0013",
            model: "gemini-3-pro",
            role: "worker",
            wake_mode: "mentions",
            wait_since: 2,
            last_read_seq: 2,
            unread: 0,
            killed: false,
            status: "waiting",
            steps: 4,
            activity: "Waiting after quota limit",
            activityKind: "tool",
            replied: false,
            replyAsk: "",
            narrator: false,
            roleWorker: false,
            failure: { kind: "quota", text: "429 RESOURCE_EXHAUSTED: model quota exceeded" },
            transcriptMtime: t(200),
            startedAt: new Date(t(600)).toISOString(),
            lastStepAt: new Date(t(200)).toISOString(),
            usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 },
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
        ops: [
          {
            opId: "op-seed-timeout-1",
            op: "switch_model",
            target: "scanner",
            status: "timed_out",
            createdAt: t(180),
            updatedAt: t(150),
            coordinatorId: AUDIT_COORD_ID,
            error: "Coordinator ack timed out after 30s",
          },
        ],
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
            model: "claude-sonnet-4-6",
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
            lastContextTokens: 160000,
            usage: { inputTokens: 100000, cacheReadTokens: 60000, outputTokens: 1800, totalTokens: 161800 },
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
            lastContextTokens: 300000,
            usage: { inputTokens: 180000, cacheReadTokens: 120000, outputTokens: 4200, totalTokens: 304200 },
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
        ops: [],
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
      {
        id: "wt-landing",
        root: "/workspace/fleet",
        name: "fleet-landing",
        path: "/workspace/scratch/fleet-landing",
        uri: "file:///workspace/scratch/fleet-landing",
        isMain: false,
        exists: true,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        branch: "lane/non-ff-land",
        head: "d81e40b3",
        clean: true,
        baseBranch: "main",
        ahead: 2,
        behind: 1,
        landStatus: "rebase",
        mergeability: "clean_merge",
        swarmOwner: { member: "verifier", status: "waiting", workspaceMode: "branch" },
        dirtyFiles: 0,
        untrackedFiles: 0,
        stagedFiles: 0,
        branchFiles: ["docs/landing-notes.md"],
        commits: [
          { sha: "d81e40b3", subject: "docs: add non-FF landing checklist", authorTime: "3m ago" },
        ],
        lastCommitSha: "d81e40b3",
        lastCommitSubject: "docs: add non-FF landing checklist",
        lastCommitAt: t(140),
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

  function safePlanText(val, depth) {
    var d = depth || 0;
    if (d > 6 || val === null || val === undefined) return "";
    if (typeof val === "string") return val;
    if (typeof val === "number") return Number.isFinite(val) ? String(val) : "";
    if (typeof val === "boolean") return String(val);
    if (Array.isArray(val)) {
      return val.slice(0, 8).map(function (x) { return safePlanText(x, d + 1).trim(); }).filter(Boolean).join(", ");
    }
    if (typeof val === "object") {
      var keys = ["line", "title", "summary", "text", "detail", "description", "label", "name", "message", "note", "status", "value"];
      for (var i = 0; i < keys.length; i++) {
        if (Object.prototype.hasOwnProperty.call(val, keys[i])) {
          var hit = safePlanText(val[keys[i]], d + 1).trim();
          if (hit) return hit;
        }
      }
      var fallback = [];
      Object.keys(val).forEach(function (k) {
        if (fallback.length >= 3) return;
        var rendered = safePlanText(val[k], d + 1).trim();
        if (rendered) fallback.push(k + ": " + rendered);
      });
      return fallback.join(" · ");
    }
    return "";
  }

  function normalizePlanForSnapshot(raw, etag) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var goalTitle = safePlanText(raw.goalTitle).trim() || undefined;
    var goalLine = safePlanText(raw.goalLine).trim() || undefined;
    var goal = "";
    if (typeof raw.goal === "string") {
      goal = raw.goal;
    } else if (raw.goal && typeof raw.goal === "object" && !Array.isArray(raw.goal)) {
      goalTitle = safePlanText(raw.goal.title).trim() || goalTitle;
      goalLine = safePlanText(raw.goal.line).trim() || goalLine;
      goal = goalLine || goalTitle || safePlanText(raw.goal).trim();
    } else {
      goal = safePlanText(raw.goal).trim() || goalLine || goalTitle || "";
    }
    var threads = Array.isArray(raw.threads) ? raw.threads.filter(function (th) { return th && typeof th === "object"; }).map(function (th, idx) {
      return {
        id: safePlanText(th.id).trim() || ("thread-" + (idx + 1)),
        title: safePlanText(th.title),
        goal: safePlanText(th.goal),
        tasks: Array.isArray(th.tasks) ? th.tasks.map(function (x) { return safePlanText(x); }).filter(Boolean) : [],
      };
    }) : [];
    var tasks = {};
    if (raw.tasks && typeof raw.tasks === "object" && !Array.isArray(raw.tasks)) {
      Object.keys(raw.tasks).forEach(function (k) {
        var desc = safePlanText(raw.tasks[k]).trim();
        if (k && desc) tasks[k] = desc;
      });
    }
    var workstreams = Array.isArray(raw.workstreams) ? raw.workstreams.filter(function (ws) { return ws && typeof ws === "object"; }).map(function (ws, idx) {
      return {
        id: safePlanText(ws.id).trim() || ("ws-" + (idx + 1)),
        title: safePlanText(ws.title),
        owner: safePlanText(ws.owner),
        status: safePlanText(ws.status).trim() || "pending",
      };
    }) : [];
    var milestones = Array.isArray(raw.milestones) ? raw.milestones.filter(function (ms) { return ms && typeof ms === "object"; }).map(function (ms) {
      return { title: safePlanText(ms.title), status: safePlanText(ms.status).trim() || "pending" };
    }) : [];
    var risks = Array.isArray(raw.risks) ? raw.risks.map(function (r) {
      if (typeof r === "string") return { title: r };
      if (r && typeof r === "object") {
        var sev = safePlanText(r.severity).trim();
        return { title: safePlanText(r.title), severity: sev || undefined };
      }
      return null;
    }).filter(function (r) { return Boolean(r && r.title); }) : [];
    var hasNative = Boolean(threads.length || Object.keys(tasks).length || goalTitle || goalLine);
    var hasFleet = Boolean(workstreams.length || milestones.length || raw.gate);
    var schema = hasNative && hasFleet ? "hybrid" : hasNative ? "native" : "fleet";
    return Object.assign(
      {
        schema: schema,
        etag: etag || "",
        title: safePlanText(raw.title) || goalTitle || "",
        goal: goal,
        gate: safePlanText(raw.gate),
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

  function getModelSpec(modelId) {
    var id = String(modelId || "").trim().toLowerCase();
    if (!id) {
      return { family: "unknown", contextLimit: 200000, inPer1M: 0, cacheReadPer1M: 0, outPer1M: 0, pricingKnown: false };
    }
    if (id.indexOf("gemini") >= 0) {
      var isFlash = id.indexOf("flash") >= 0;
      return isFlash
        ? { family: "gemini-flash", contextLimit: 1000000, inPer1M: 0.30, cacheReadPer1M: 0.075, outPer1M: 2.50, pricingKnown: true }
        : { family: "gemini-pro", contextLimit: 1000000, inPer1M: 1.25, cacheReadPer1M: 0.3125, outPer1M: 10.0, pricingKnown: true };
    }
    if (id.indexOf("claude") >= 0 || id.indexOf("opus") >= 0 || id.indexOf("sonnet") >= 0 || id.indexOf("haiku") >= 0) {
      var is1m = /(?:^|[^a-z0-9])1m(?:[^a-z0-9]|$)|\[1m\]|-1m\b/.test(id);
      var ctx = is1m ? 1000000 : 200000;
      if (id.indexOf("opus") >= 0) {
        return { family: "claude-opus", contextLimit: ctx, inPer1M: 15.0, cacheReadPer1M: 1.5, outPer1M: 75.0, pricingKnown: true };
      }
      if (id.indexOf("haiku") >= 0) {
        return { family: "claude-haiku", contextLimit: ctx, inPer1M: 1.0, cacheReadPer1M: 0.10, outPer1M: 5.0, pricingKnown: true };
      }
      return { family: "claude-sonnet", contextLimit: ctx, inPer1M: 3.0, cacheReadPer1M: 0.3, outPer1M: 15.0, pricingKnown: true };
    }
    if (id.indexOf("gpt-") >= 0 || /^o[134](?:-|$)/.test(id)) {
      if (id.indexOf("gpt-4.1") >= 0) {
        return { family: "openai-gpt", contextLimit: 1000000, inPer1M: 2.0, cacheReadPer1M: 0.5, outPer1M: 8.0, pricingKnown: true };
      }
      if (id.indexOf("gpt-4o") >= 0) {
        return { family: "openai-gpt", contextLimit: 128000, inPer1M: 2.5, cacheReadPer1M: 1.25, outPer1M: 10.0, pricingKnown: true };
      }
      if (id.indexOf("gpt-5") >= 0) {
        return { family: "openai-gpt", contextLimit: 400000, inPer1M: 1.25, cacheReadPer1M: 0.125, outPer1M: 10.0, pricingKnown: true };
      }
      return { family: "openai-o", contextLimit: 200000, inPer1M: 2.0, cacheReadPer1M: 0.5, outPer1M: 8.0, pricingKnown: true };
    }
    return { family: "unknown", contextLimit: 200000, inPer1M: 0, cacheReadPer1M: 0, outPer1M: 0, pricingKnown: false };
  }

  function safeNonNeg(v) {
    var n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function memberByModel(m) {
    if (m.byModel && Object.keys(m.byModel).length > 0) return m.byModel;
    var mdl = m.model || "unknown";
    var u = m.usage || {};
    var res = {};
    res[mdl] = {
      inputTokens: safeNonNeg(u.inputTokens),
      cacheReadTokens: safeNonNeg(u.cacheReadTokens),
      outputTokens: safeNonNeg(u.outputTokens),
      steps: safeNonNeg(m.steps),
    };
    return res;
  }

  function computeCostFromByModel(byModel, activeModel) {
    var inputUsd = 0;
    var cacheReadUsd = 0;
    var outputUsd = 0;
    var cacheSavingsUsd = 0;
    var totalIn = 0;
    var totalCache = 0;
    var anyKnown = false;
    var keys = Object.keys(byModel || {});
    for (var i = 0; i < keys.length; i++) {
      var mdl = keys[i];
      var e = byModel[mdl];
      if (!e) continue;
      var inp = safeNonNeg(e.inputTokens);
      var cac = safeNonNeg(e.cacheReadTokens);
      var out = safeNonNeg(e.outputTokens);
      totalIn += inp;
      totalCache += cac;
      var spec = getModelSpec(mdl);
      if (spec.pricingKnown) {
        anyKnown = true;
        inputUsd += (inp * spec.inPer1M) / 1e6;
        cacheReadUsd += (cac * spec.cacheReadPer1M) / 1e6;
        outputUsd += (out * spec.outPer1M) / 1e6;
        cacheSavingsUsd += (cac * Math.max(0, spec.inPer1M - spec.cacheReadPer1M)) / 1e6;
      }
    }
    if (!anyKnown && activeModel) {
      anyKnown = getModelSpec(activeModel).pricingKnown;
    }
    var totalUsd = Math.max(0, inputUsd + cacheReadUsd + outputUsd);
    var denom = totalIn + totalCache;
    var cacheHitPct = denom > 0 ? Math.min(100, Math.max(0, Math.round((totalCache / denom) * 1000) / 10)) : 0;
    return {
      totalUsd: totalUsd,
      inputUsd: Math.max(0, inputUsd),
      cacheReadUsd: Math.max(0, cacheReadUsd),
      outputUsd: Math.max(0, outputUsd),
      cacheSavingsUsd: Math.max(0, cacheSavingsUsd),
      cacheHitPct: cacheHitPct,
      pricingKnown: anyKnown,
    };
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
    sw.messages.forEach(function (msg) {
      if (/\[blocked\]/i.test(msg.text || "")) {
        var resolved = sw.messages.some(function (later) {
          return later.seq > msg.seq && later.agent === msg.agent && /\[(done|verified|scale-verified)\]/i.test(later.text || "");
        });
        if (!resolved) {
          var bSender = sw.members.find(function (m) { return m.name === msg.agent; });
          triage.push({
            id: "blocked-" + msg.agent + "-" + msg.seq,
            kind: "blocked",
            severity: "urgent",
            member: msg.agent,
            conversationId: bSender ? bSender.conversation_id : "",
            seq: msg.seq,
            title: msg.agent + " posted [blocked] (#" + msg.seq + ")",
            detail: msg.text,
            suggestedPrompt: "@" + msg.agent + " Re #" + msg.seq + ": Resolve blocker and post updated [done].",
            timestamp: msg.ts || now,
          });
        }
      }
    });
    var ackMap = sw.triageAcks || {};
    triage = triage.map(function (it) {
      var rec = ackMap[it.id];
      var activeAck = Boolean(
        rec &&
          rec.action !== "unack" &&
          !(rec.action === "snooze" && typeof rec.untilSeq === "number" && sw.head > rec.untilSeq),
      );
      if (!activeAck) return it;
      return Object.assign({}, it, {
        acked: true,
        snoozed: rec.action === "snooze",
        ackAction: rec.action,
        ackState: rec.action,
        ackedAt: rec.ackedAt || null,
        untilSeq: rec.untilSeq || null,
        ackNote: rec.note || null,
      });
    });
    var usage = sw.members.reduce(
      function (acc, m) {
        var u = m.usage || {};
        acc.inputTokens += safeNonNeg(u.inputTokens);
        acc.cacheReadTokens += safeNonNeg(u.cacheReadTokens);
        acc.outputTokens += safeNonNeg(u.outputTokens);
        acc.totalTokens += safeNonNeg(u.totalTokens);
        return acc;
      },
      { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 },
    );
    var swarmByModel = {};
    var maxContextLimit = 200000;
    var maxContextPct = 0;
    var enrichedMembers = sw.members.map(function (m) {
      var u = m.usage || {};
      var bm = memberByModel(m);
      Object.keys(bm).forEach(function (mdl) {
        var e = bm[mdl];
        if (!swarmByModel[mdl]) swarmByModel[mdl] = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, steps: 0 };
        swarmByModel[mdl].inputTokens += safeNonNeg(e.inputTokens);
        swarmByModel[mdl].cacheReadTokens += safeNonNeg(e.cacheReadTokens);
        swarmByModel[mdl].outputTokens += safeNonNeg(e.outputTokens);
        swarmByModel[mdl].steps += safeNonNeg(e.steps);
      });
      var spec = getModelSpec(m.model);
      var contextLimit = Number.isFinite(spec.contextLimit) && spec.contextLimit > 0 ? spec.contextLimit : 0;
      var ctxTok = safeNonNeg(m.lastContextTokens) || (safeNonNeg(u.inputTokens) + safeNonNeg(u.cacheReadTokens));
      var contextPct = contextLimit > 0 ? Math.min(100, Math.max(0, Math.round((ctxTok / contextLimit) * 100))) : 0;
      var cost = computeCostFromByModel(bm, m.model);
      if (contextLimit > maxContextLimit) maxContextLimit = contextLimit;
      if (!m.killed && contextPct > maxContextPct) maxContextPct = contextPct;
      var label = !m.killed && !m.activityPeek
        ? (m.activity || (m.recentTools && m.recentTools[0] && m.recentTools[0].summary) || m.thinkingHeading || (m.status === "waiting" ? "Waiting on board" : ""))
            .replace(/\/(?:home|Users)\/[^/\s]+(\/|$)/g, function (_m, sep) { return "~" + sep; })
        : "";
      return Object.assign({}, m, {
        contextLimit: contextLimit,
        contextPct: contextPct,
        cost: cost,
        byModel: bm,
      }, !m.killed && !m.activityPeek ? {
        activityPeek: label
          ? {
              status: m.status === "working" ? "working" : "waiting",
              label: label,
              tool: m.activityKind || (m.recentTools && m.recentTools[0] && m.recentTools[0].name) || "tool",
              ts: m.transcriptMtime || 0,
            }
          : null,
      } : {});
    });
    var swarmCost = computeCostFromByModel(swarmByModel, "");
    var burnRows = enrichedMembers
      .filter(function (m) { return !m.roleWorker && m.usage.totalTokens > 0; })
      .map(function (m) {
        var tok = m.usage.totalTokens;
        var mCost = m.cost || { totalUsd: 0, cacheHitPct: 0, cacheSavingsUsd: 0, pricingKnown: false };
        var sharePct = swarmCost.pricingKnown && swarmCost.totalUsd > 0 && mCost.pricingKnown
          ? Math.round((mCost.totalUsd / swarmCost.totalUsd) * 100)
          : (usage.totalTokens > 0 ? Math.round((tok / usage.totalTokens) * 100) : 0);
        var level = mCost.pricingKnown
          ? (mCost.totalUsd >= 5.0 || (swarmCost.totalUsd >= 0.05 && sharePct >= 65 && enrichedMembers.length >= 2)
            ? "critical"
            : mCost.totalUsd >= 1.5 || (swarmCost.totalUsd >= 0.02 && sharePct >= 45 && enrichedMembers.length >= 2)
              ? "warn"
              : "normal")
          : (tok >= 400000 || (usage.totalTokens >= 20000 && sharePct >= 65 && enrichedMembers.length >= 2)
            ? "critical"
            : tok >= 150000 || (usage.totalTokens >= 10000 && sharePct >= 45 && enrichedMembers.length >= 2)
              ? "warn"
              : "normal");
        return {
          name: m.name,
          totalTokens: tok,
          sharePct: sharePct,
          level: level,
          killed: Boolean(m.killed),
          costUsd: mCost.totalUsd,
          cacheHitPct: mCost.cacheHitPct,
          cacheSavingsUsd: mCost.cacheSavingsUsd,
          pricingKnown: mCost.pricingKnown,
        };
      })
      .sort(function (a, b) {
        if (swarmCost.pricingKnown) {
          var diff = (b.costUsd || 0) - (a.costUsd || 0);
          if (Math.abs(diff) > 1e-9) return diff;
        }
        return b.totalTokens - a.totalTokens || a.name.localeCompare(b.name);
      });
    var burnSummary = {
      totalTokens: usage.totalTokens,
      topWorker: burnRows[0] || null,
      highBurnCount: burnRows.filter(function (r) { return r.level !== "normal"; }).length,
      workers: burnRows.slice(0, 6),
      costUsd: swarmCost.totalUsd,
      cacheHitPct: swarmCost.cacheHitPct,
      cacheSavingsUsd: swarmCost.cacheSavingsUsd,
      pricingKnown: swarmCost.pricingKnown,
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
    var replyRefs = {};
    var seqSet = {};
    sw.messages.forEach(function (m) {
      if (m && m.seq && !m.control) seqSet[m.seq] = true;
    });
    sw.messages.forEach(function (m) {
      if (!m || m.control || !m.text) return;
      var seenRef = {};
      var reRef = /#(\d+)\b/g;
      var refMatch;
      while ((refMatch = reRef.exec(m.text)) !== null) {
        var refSeq = Number(refMatch[1]);
        if (refSeq > 0 && refSeq !== m.seq && seqSet[refSeq] && !seenRef[refSeq]) {
          seenRef[refSeq] = true;
          if (!replyRefs[refSeq]) replyRefs[refSeq] = [];
          replyRefs[refSeq].push(m.seq);
        }
      }
    });
    return {
      conversationId: sw.id,
      swarm: sw.id,
      member: sw.member,
      etag: "liveweb-" + sw.head + "-" + triage.length + "-" + (sw.planVersion || 1) + "-" + (sw.controlVersion || 0) + "-" + (sw.opsVersion || 0) + "-" + (sw.pinsVersion || 0) + "-" + (sw.ackVersion || 0) + "-" + (sw.checkpointVersion || 0) + "-" + (sw.archived ? 1 : 0),
      id: sw.id,
      title: sw.title,
      head: sw.head,
      members: enrichedMembers,
      messages: sw.messages,
      replyRefs: replyRefs,
      channels: sw.channels || [],
      edges: computeEdgesForMessages(enrichedMembers, sw.messages),
      view: sw.view || null,
      plan: normalizePlanForSnapshot(sw.plan, planEtagOf(sw)),
      frames: sw.frames,
      triage: triage,
      pinnedSeqs: (sw.pinnedSeqs || []).slice(),
      triageAcks: Object.assign({}, sw.triageAcks || {}),
      archived: Boolean(sw.archived),
      checkpoints: (sw.checkpoints || []).map(sanitizeCheckpoint),
      burnSummary: burnSummary,
      gateReadiness: gateReadiness,
      usage: usage,
      contextLimit: maxContextLimit,
      contextPct: maxContextPct,
      cost: swarmCost,
      byModel: swarmByModel,
      ops: (sw.ops || []).slice(),
      capabilities: { canSendMessage: true, isSidecar: false, sseStream: false, deltaStream: true },
    };
  }

  function computeEdgesForMessages(members, msgs) {
    var byKey = {};
    var names = (members || []).filter(function (m) { return !m.roleWorker; }).map(function (m) { return m.name; });
    var nameSet = {};
    names.forEach(function (n) { nameSet[n] = true; });
    (msgs || []).forEach(function (m) {
      if (!m || m.control) return;
      var from = m.agent;
      if (!nameSet[from]) return;
      var seen = {};
      var mentions = Array.isArray(m.mentions) ? m.mentions : [];
      if (m.all) {
        names.forEach(function (to) {
          if (to === from || seen[to]) return;
          seen[to] = true;
          var key = from + "\0" + to;
          var e = byKey[key] || (byKey[key] = { from: from, to: to, count: 0, direct: 0, viaAll: 0 });
          e.count += 1;
          if (mentions.indexOf(to) >= 0) e.direct += 1;
          else e.viaAll += 1;
        });
      } else {
        mentions.forEach(function (to) {
          if (to === from || !nameSet[to] || seen[to]) return;
          seen[to] = true;
          var key = from + "\0" + to;
          var e = byKey[key] || (byKey[key] = { from: from, to: to, count: 0, direct: 0, viaAll: 0 });
          e.count += 1;
          e.direct += 1;
        });
      }
    });
    return Object.values(byKey);
  }

  function computeDelta(conv, since, etag) {
    var sw = findSwarmByConvId(conv) || state.swarms[conv];
    if (!sw) {
      return { status: 404, body: { ok: false, error: "Swarm not found" } };
    }
    var full = computeSnapshot(sw.id);
    if (etag && etag === full.etag && (since === 0 || since <= full.head)) {
      return {
        status: 200,
        body: {
          ok: true,
          unchanged: true,
          conversationId: conv,
          swarm: full.swarm,
          member: full.member,
          etag: full.etag,
          head: full.head,
        },
      };
    }
    if (since > 0 && since <= full.head) {
      var messagesDelta = (full.messages || []).filter(function (m) { return m.seq > since; });
      var replyRefsDelta = {};
      Object.keys(full.replyRefs || {}).forEach(function (k) {
        var added = (full.replyRefs[k] || []).filter(function (s) { return s > since; });
        if (added.length) replyRefsDelta[k] = added;
      });
      return {
        status: 200,
        body: {
          ok: true,
          mode: "delta",
          unchanged: false,
          conversationId: conv,
          swarm: full.swarm,
          member: full.member,
          etag: full.etag,
          since: since,
          head: full.head,
          messagesDelta: messagesDelta,
          replyRefsDelta: replyRefsDelta,
          edgesDelta: computeEdgesForMessages(full.members, messagesDelta),
          members: full.members,
          channels: full.channels,
          plan: full.plan,
          view: full.view,
          frames: full.frames,
          triage: full.triage,
          pinnedSeqs: full.pinnedSeqs,
          triageAcks: full.triageAcks,
          archived: full.archived,
          checkpoints: full.checkpoints,
          burnSummary: full.burnSummary,
          gateReadiness: full.gateReadiness,
          usage: full.usage,
          contextLimit: full.contextLimit,
          contextPct: full.contextPct,
          cost: full.cost,
          byModel: full.byModel,
          ops: full.ops,
          capabilities: full.capabilities,
        },
      };
    }
    return {
      status: 200,
      body: Object.assign({ ok: true, mode: "full", unchanged: false }, full, { conversationId: conv }),
    };
  }

  var deltaWaiters = [];
  function notifyDeltaWaiters(swarmId) {
    if (!deltaWaiters.length) return;
    var active = deltaWaiters.slice();
    deltaWaiters = [];
    active.forEach(function (w) {
      if (!swarmId || !w.swarmId || w.swarmId === swarmId) {
        w.wake();
      } else {
        deltaWaiters.push(w);
      }
    });
  }

  function coordinatorStateOf(sw) {
    var coord = (sw.members || []).find(function (m) { return m.role === "coordinator"; });
    if (!coord) return { status: "missing", failure: null };
    return { status: coord.killed ? "killed" : coord.status, failure: coord.failure || null };
  }

  function scheduleOpReconcile(sw, opRec, resolvedSeq) {
    setTimeout(function () {
      if (opRec.status !== "dispatched") return;
      var cState = coordinatorStateOf(sw);
      if (cState.failure || cState.status === "killed" || cState.status === "missing") {
        opRec.status = "failed";
        opRec.error = (cState.failure && cState.failure.text) || ("Coordinator is " + cState.status);
      } else {
        opRec.status = "verified";
        if (resolvedSeq && resolvedSeq > 0) opRec.resolvedSeq = resolvedSeq;
        opRec.error = undefined;
      }
      opRec.updatedAt = Date.now();
      sw.opsVersion = (sw.opsVersion || 0) + 1;
      notifyDeltaWaiters(sw.id);
    }, 90);
  }

  function dispatchOpRecord(sw, opName, target, payload, resolvedSeq) {
    var coord = (sw.members || []).find(function (m) { return m.role === "coordinator"; });
    var ts = Date.now();
    var opRec = {
      opId: "op-" + (++opCounter),
      op: opName,
      target: target || undefined,
      payload: payload,
      status: "dispatched",
      createdAt: ts,
      updatedAt: ts,
      coordinatorId: coord ? coord.conversation_id : undefined,
    };
    sw.ops = [opRec].concat(sw.ops || []).slice(0, 50);
    sw.opsVersion = (sw.opsVersion || 0) + 1;
    scheduleOpReconcile(sw, opRec, resolvedSeq);
    return opRec;
  }

  function sanitizeCheckpoint(cp) {
    if (!cp) return null;
    return {
      id: cp.id,
      conversationId: cp.conversationId,
      label: cp.label,
      createdAt: cp.createdAt,
      head: cp.head,
      planEtag: cp.planEtag || "",
      planGoal: cp.planGoal || "",
      memberCount: cp.memberCount,
      activeCount: cp.activeCount,
      triageCount: cp.triageCount,
      worktrees: (cp.worktrees || []).slice(),
      diff: cp.diff || null,
    };
  }

  function computeCheckpointDiffObj(sw, cp) {
    var curPlan = normalizePlanForSnapshot(sw.plan, planEtagOf(sw));
    var curGoal = (curPlan && (curPlan.goalLine || curPlan.goal)) || "";
    var planChanged = Boolean((cp.planEtag && curPlan && cp.planEtag !== curPlan.etag) || (cp.planGoal && curGoal && cp.planGoal !== curGoal));
    var changedWorktrees = [];
    (cp.worktrees || []).forEach(function (cwt) {
      var lwt = state.worktrees.find(function (w) { return w.path === cwt.path || w.branch === cwt.branch; });
      if (!lwt) {
        changedWorktrees.push({ path: cwt.path, branch: cwt.branch, prevHead: cwt.head, head: "removed", changed: true, status: "removed" });
        return;
      }
      var liveDirty = (lwt.dirtyFiles || 0) + (lwt.untrackedFiles || 0);
      if (lwt.head !== cwt.head || liveDirty !== (cwt.dirtyFiles || 0)) {
        changedWorktrees.push({
          path: cwt.path,
          branch: cwt.branch,
          prevHead: cwt.head,
          head: lwt.head,
          dirtyFiles: liveDirty,
          changed: true,
          status: lwt.head !== cwt.head ? "head_moved" : "dirty_changed",
        });
      }
    });
    return {
      headDelta: (sw.head || 0) - (cp.head || 0),
      newMessages: Math.max(0, (sw.head || 0) - (cp.head || 0)),
      planChanged: planChanged,
      worktreeChanges: changedWorktrees.length,
      changedWorktrees: changedWorktrees,
    };
  }

  function listSwarms() {
    return Object.values(state.swarms).map(function (sw) {
      var snap = computeSnapshot(sw.id);
      var unackedTriage = (snap.triage || []).filter(function (it) { return !it.acked; });
      var blockedCount = unackedTriage.filter(function (it) { return it.kind === "blocked" || it.severity === "urgent"; }).length;
      var failureCount = sw.members.filter(function (m) { return !m.killed && Boolean(m.failure); }).length;
      var topUrgent = unackedTriage.find(function (it) { return it.severity === "urgent"; }) || unackedTriage[0] || null;
      return {
        id: sw.id,
        title: sw.title,
        appData: "live-web",
        head: sw.head,
        memberCount: sw.members.length,
        activeCount: sw.members.filter(function (m) { return !m.killed && m.status === "working"; }).length,
        waitingCount: sw.members.filter(function (m) { return !m.killed && m.status === "waiting"; }).length,
        killedCount: sw.members.filter(function (m) { return m.killed; }).length,
        triageCount: unackedTriage.length,
        totalTokens: snap.usage.totalTokens,
        hasPlan: Boolean(sw.plan),
        lastActivityTs: now,
        costUsd: snap.cost ? snap.cost.totalUsd : 0,
        gateState: snap.gateReadiness ? snap.gateReadiness.state : null,
        blockedCount: blockedCount,
        failureCount: failureCount,
        repo: sw.repo || "/workspace/fleet",
        archived: Boolean(sw.archived),
        topUrgent: topUrgent,
      };
    });
  }

  function buildPortfolioPayload() {
    var summaries = listSwarms();
    var active = summaries.filter(function (s) { return !s.archived; });
    var urgentTriage = [];
    active.forEach(function (swSummary) {
      var snap = computeSnapshot(swSummary.id);
      (snap.triage || []).forEach(function (it) {
        if (!it.acked && (it.severity === "urgent" || it.kind === "blocked" || it.kind === "quota" || it.kind === "error" || it.kind === "stuck")) {
          urgentTriage.push(Object.assign({}, it, { swarmId: swSummary.id, swarmTitle: swSummary.title }));
        }
      });
    });
    return {
      ok: true,
      totalCostUsd: active.reduce(function (sum, s) { return sum + (s.costUsd || 0); }, 0),
      totalTokens: active.reduce(function (sum, s) { return sum + (s.totalTokens || 0); }, 0),
      activeSwarms: active.length,
      urgentCount: urgentTriage.length,
      urgentTriage: urgentTriage,
      swarms: summaries,
    };
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
      addArtifactComment: function (comment) {
        console.info("[fleet live-web] addArtifactComment:", comment);
      },
    },
    agent: {
      sendMessage: async function (message, convId) {
        var sw = findSwarmByConvId(convId) || state.swarms[COORD_ID];
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
        var opRec = dispatchOpRecord(sw, "nudge", target ? target.name : undefined, { conversationId: convId }, sw.head);
        notifyDeltaWaiters(sw.id);
        return {
          ok: true,
          opId: opRec.opId,
          status: "dispatched",
          coordinatorState: coordinatorStateOf(sw),
        };
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

    if (url.pathname === "/api/control" && init && String(init.method || "").toUpperCase() === "POST") {
      var rawCtrlBody = String(init.body || "{}");
      if (rawCtrlBody.length > 65536) {
        return jsonResp({ error: "Payload too large" }, 413);
      }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(rawCtrlBody)) {
        return jsonResp({ error: "Control characters not permitted" }, 400);
      }
      var ctrl = {};
      try { ctrl = JSON.parse(rawCtrlBody); } catch { return jsonResp({ error: "Invalid JSON" }, 400); }
      if (!ctrl || ctrl.confirm !== true || typeof ctrl.op !== "string") {
        return jsonResp({ error: "Confirmation (confirm: true) and op required" }, 400);
      }
      var cSw = findSwarmByConvId(ctrl.conversationId);
      if (!cSw) return jsonResp({ error: "Swarm not found" }, 404);
      var coordMember = cSw.members.find(function (m) { return m.role === "coordinator"; });
      if (!coordMember) return jsonResp({ error: "Coordinator not found" }, 404);

      var WORKER_RE = /^[a-z][a-z0-9-]{0,31}$/;
      var CHAN_RE = /^[a-z][a-z0-9-]{0,23}$/;
      var nowIso = new Date().toISOString();
      var nowClk = new Date().toTimeString().slice(0, 8);
      var preview = "";

      function extractMentions(txt) {
        var names = cSw.members.map(function (m) { return m.name; });
        var lo = String(txt || "").toLowerCase();
        var hit = names.filter(function (n) { return lo.indexOf("@" + n.toLowerCase()) >= 0; });
        return { mentions: hit, all: /@all\b/i.test(lo) };
      }

      if (ctrl.op === "board_post") {
        var postText = typeof ctrl.text === "string" ? ctrl.text.trim() : "";
        if (!postText || postText.length > 4000) return jsonResp({ error: "Valid text required" }, 400);
        var postCh = typeof ctrl.channel === "string" ? ctrl.channel.trim() : "";
        if (postCh && postCh !== "main" && !CHAN_RE.test(postCh)) return jsonResp({ error: "Invalid channel name" }, 400);
        var replySeq = Number(ctrl.replyToSeq) || 0;
        var finalText = replySeq > 0 && postText.indexOf("#" + replySeq) < 0 ? "Re #" + replySeq + ": " + postText : postText;
        var mInfo = extractMentions(finalText);
        cSw.head += 1;
        cSw.messages.push(Object.assign(
          {
            seq: cSw.head,
            agent: "coordinator",
            text: finalText,
            time: nowClk,
            ts: Date.now(),
            mentions: mInfo.mentions,
            all: mInfo.all,
          },
          postCh && postCh !== "main" ? { channel: postCh } : {},
        ));
        cSw.controlVersion = (cSw.controlVersion || 0) + 1;
        preview = "[fleet-operator:board_post] " + (postCh || "main") + ": " + finalText.slice(0, 120);
      } else if (ctrl.op === "spawn_worker") {
        var wName = typeof ctrl.name === "string" ? ctrl.name.trim() : "";
        var wBrief = typeof ctrl.brief === "string" ? ctrl.brief.trim() : "";
        var wMode = ctrl.workspaceMode || "inherit";
        var wCh = typeof ctrl.channel === "string" ? ctrl.channel.trim() : "";
        if (!WORKER_RE.test(wName) || wName === "all" || wName === "coordinator") {
          return jsonResp({ error: "Invalid worker name" }, 400);
        }
        if (!wBrief || wBrief.length > 4000) return jsonResp({ error: "Valid brief required" }, 400);
        if (["inherit", "share", "branch"].indexOf(wMode) < 0) return jsonResp({ error: "Invalid workspaceMode" }, 400);
        if (wCh && wCh !== "main" && !CHAN_RE.test(wCh)) return jsonResp({ error: "Invalid channel" }, 400);
        if (cSw.members.some(function (m) { return !m.killed && m.name === wName; })) {
          return jsonResp({ error: "Worker already exists" }, 409);
        }
        var newConvId = "demo-" + wName + "-" + String(Date.now()).slice(-4);
        cSw.members.push({
          name: wName,
          conversation_id: newConvId,
          model: ctrl.model || "gemini-3-pro",
          role: "worker",
          wake_mode: "mentions",
          wait_since: cSw.head,
          last_read_seq: cSw.head,
          unread: 0,
          killed: false,
          status: "working",
          steps: 0,
          activity: "Starting assigned task",
          activityKind: "thinking",
          replied: false,
          replyAsk: "",
          narrator: false,
          roleWorker: false,
          failure: null,
          transcriptMtime: Date.now(),
          startedAt: nowIso,
          lastStepAt: nowIso,
          usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 },
          workspace_mode: wMode,
          ...(wCh && wCh !== "main" ? { channels: [wCh] } : {}),
          posts: 0,
          lastPostSeq: 0,
          lastPostTime: "",
          lastPostTs: null,
        });
        cSw.head += 1;
        cSw.messages.push(Object.assign(
          {
            seq: cSw.head,
            agent: "coordinator",
            text: "@" + wName + " " + wBrief,
            time: nowClk,
            ts: Date.now(),
            mentions: [wName],
            all: false,
          },
          wCh && wCh !== "main" ? { channel: wCh } : {},
        ));
        cSw.controlVersion = (cSw.controlVersion || 0) + 1;
        preview = "[fleet-operator:spawn_worker] @" + wName + " (" + wMode + ")";
      } else if (ctrl.op === "switch_model") {
        var smTarget = typeof ctrl.member === "string" ? ctrl.member.trim() : "";
        var smModel = typeof ctrl.model === "string" ? ctrl.model.trim() : "";
        if (!smTarget || !smModel || smModel.length > 120) return jsonResp({ error: "member and model required" }, 400);
        var smMember = cSw.members.find(function (m) { return !m.killed && m.name === smTarget; });
        if (!smMember) return jsonResp({ error: "Member not found" }, 404);
        if (smMember.status === "working" && !ctrl.allowWorking) {
          return jsonResp({ error: "worker_not_waiting", status: smMember.status }, 409);
        }
        smMember.byModel = memberByModel(smMember);
        if (!smMember.byModel[smModel]) {
          smMember.byModel[smModel] = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, steps: 0 };
        }
        smMember.model = smModel;
        smMember.failure = null;
        smMember.status = "working";
        smMember.activity = "Resumed on " + smModel;
        smMember.activityPeek = { status: "working", label: "Resumed on " + smModel, tool: "thinking", ts: Date.now() };
        smMember.transcriptMtime = Date.now();
        cSw.controlVersion = (cSw.controlVersion || 0) + 1;
        preview = "[fleet-operator:switch_model] @" + smTarget + " -> " + smModel;
      } else if (ctrl.op === "kill_worker") {
        var kwTarget = typeof ctrl.member === "string" ? ctrl.member.trim() : "";
        if (!kwTarget) return jsonResp({ error: "member required" }, 400);
        if (kwTarget === "coordinator" || kwTarget === "narrator" || kwTarget === "monitor") {
          return jsonResp({ error: "Refusing to kill protected role " + kwTarget }, 403);
        }
        var kwMember = cSw.members.find(function (m) { return !m.killed && m.name === kwTarget; });
        if (!kwMember) return jsonResp({ error: "Member not found" }, 404);
        var kwWt = kwMember.workspace ? state.worktrees.find(function (w) { return w.path === kwMember.workspace; }) : null;
        if (kwWt && !ctrl.forceUnmerged && (!kwWt.clean || (kwWt.ahead || 0) > 0)) {
          return jsonResp({
            error: "unmerged worktree",
            dirtyFiles: (kwWt.dirtyFiles || 0) + (kwWt.untrackedFiles || 0),
            ahead: kwWt.ahead || 0,
          }, 409);
        }
        kwMember.killed = true;
        kwMember.status = "killed";
        kwMember.activity = "";
        kwMember.activityPeek = null;
        cSw.controlVersion = (cSw.controlVersion || 0) + 1;
        preview = "[fleet-operator:kill_worker] @" + kwTarget;
      } else if (ctrl.op === "channel_op") {
        var chAction = ctrl.action;
        var chName = typeof ctrl.channel === "string" ? ctrl.channel.trim() : "";
        if (["create", "archive", "subscribe", "unsubscribe"].indexOf(chAction) < 0) {
          return jsonResp({ error: "Invalid channel action" }, 400);
        }
        if (!CHAN_RE.test(chName) || ["main", "all", "here"].indexOf(chName) >= 0) {
          return jsonResp({ error: "Invalid channel name" }, 400);
        }
        cSw.channels = cSw.channels || [];
        if (chAction === "create") {
          if (!cSw.channels.some(function (c) { return c.name === chName; })) {
            cSw.channels.push({ name: chName, topic: String(ctrl.topic || "").trim(), created_by: "coordinator", archived: false });
          }
        } else if (chAction === "archive") {
          var ar = cSw.channels.find(function (c) { return c.name === chName; });
          if (ar) ar.archived = true;
        } else {
          var subTarget = typeof ctrl.member === "string" ? ctrl.member.trim() : "";
          var subMember = cSw.members.find(function (m) { return !m.killed && m.name === subTarget; });
          if (!subMember) return jsonResp({ error: "Member not found" }, 404);
          var curChs = Array.isArray(subMember.channels) ? subMember.channels.slice() : [];
          if (chAction === "subscribe" && curChs.indexOf(chName) < 0) curChs.push(chName);
          if (chAction === "unsubscribe") curChs = curChs.filter(function (c) { return c !== chName; });
          subMember.channels = curChs;
        }
        cSw.head += 1;
        cSw.messages.push({
          seq: cSw.head,
          agent: "coordinator",
          text: "[channel:" + chAction + "] #" + chName,
          time: nowClk,
          ts: Date.now(),
          mentions: [],
          all: false,
          control: { op: chAction, channel: chName, topic: ctrl.topic || "" },
        });
        cSw.controlVersion = (cSw.controlVersion || 0) + 1;
        preview = "[fleet-operator:channel_op] " + chAction + " #" + chName;
      } else if (ctrl.op === "gate_verdict") {
        var gVerdict = ctrl.verdict;
        var gSeq = Number(ctrl.seq) || 0;
        var gNote = typeof ctrl.note === "string" ? ctrl.note.trim() : "";
        if (["verified", "blocked", "ship"].indexOf(gVerdict) < 0 || gSeq <= 0 || !gNote || gNote.length > 4000) {
          return jsonResp({ error: "Valid verdict, seq, and note required" }, 400);
        }
        var tag = gVerdict === "verified" ? "[verified]" : gVerdict === "blocked" ? "[blocked]" : "shipped";
        var targetTag = ctrl.targetMember ? "@" + ctrl.targetMember + " " : "";
        var vText = targetTag + tag + " Re #" + gSeq + ": " + gNote;
        var vMentions = extractMentions(vText);
        cSw.head += 1;
        cSw.messages.push({
          seq: cSw.head,
          agent: "coordinator",
          text: vText,
          time: nowClk,
          ts: Date.now(),
          mentions: vMentions.mentions,
          all: vMentions.all,
        });
        cSw.controlVersion = (cSw.controlVersion || 0) + 1;
        preview = "[fleet-operator:gate_verdict] " + gVerdict + " #" + gSeq;
      } else {
        return jsonResp({ error: "Unsupported op" }, 400);
      }

      var opTarget = ctrl.member || ctrl.targetMember || ctrl.name || ctrl.channel || undefined;
      var ctrlOpRec = dispatchOpRecord(cSw, ctrl.op, opTarget, ctrl, cSw.head);
      notifyDeltaWaiters(cSw.id);
      return jsonResp({
        ok: true,
        op: ctrl.op,
        opId: ctrlOpRec.opId,
        status: "dispatched",
        coordinatorState: coordinatorStateOf(cSw),
        coordinatorId: coordMember.conversation_id,
        directivePreview: preview,
        deliveredAt: nowIso,
      });
    }
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
      notifyDeltaWaiters(targetSw.id);
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
      var nudgeOpRec = dispatchOpRecord(sw, "nudge", hitNames.join(", ") || undefined, { conversationIds: targets }, sw.head);
      notifyDeltaWaiters(sw.id);
      return jsonResp({
        ok: true,
        opId: nudgeOpRec.opId,
        status: "dispatched",
        coordinatorState: coordinatorStateOf(sw),
        delivered: targets.length,
      });
    }
    if (url.pathname === "/api/ops" && (!init || !init.method || String(init.method).toUpperCase() === "GET")) {
      var opsConv = url.searchParams.get("conversationId") || COORD_ID;
      var opsSw = findSwarmByConvId(opsConv) || state.swarms[opsConv];
      if (!opsSw) return jsonResp({ error: "Swarm not found" }, 404);
      return jsonResp({
        ok: true,
        conversationId: opsSw.id,
        ops: (opsSw.ops || []).slice(),
      });
    }
    if (url.pathname === "/api/ops/action" && init && String(init.method || "").toUpperCase() === "POST") {
      var actOpBody = {};
      try { actOpBody = JSON.parse(String(init.body || "{}")); } catch { return jsonResp({ error: "Invalid JSON" }, 400); }
      if (!actOpBody || actOpBody.confirm !== true || typeof actOpBody.opId !== "string") {
        return jsonResp({ error: "confirm and opId required" }, 400);
      }
      var actAction = String(actOpBody.action || "");
      if (["retry", "dismiss", "mark_verified"].indexOf(actAction) < 0) {
        return jsonResp({ error: "Invalid ops action" }, 400);
      }
      var actSw = findSwarmByConvId(actOpBody.conversationId) || state.swarms[actOpBody.conversationId];
      if (!actSw) return jsonResp({ error: "Swarm not found" }, 404);
      actSw.ops = actSw.ops || [];
      var targetOp = actSw.ops.find(function (o) { return o.opId === actOpBody.opId; });
      if (!targetOp) return jsonResp({ error: "Operation not found" }, 404);

      if (actAction === "dismiss") {
        targetOp.status = "dismissed";
        targetOp.updatedAt = Date.now();
      } else if (actAction === "mark_verified") {
        targetOp.status = "verified";
        targetOp.error = undefined;
        if (!targetOp.resolvedSeq && actSw.head > 0) targetOp.resolvedSeq = actSw.head;
        targetOp.updatedAt = Date.now();
      } else if (actAction === "retry") {
        targetOp.status = "dispatched";
        targetOp.error = undefined;
        targetOp.updatedAt = Date.now();
        scheduleOpReconcile(actSw, targetOp, actSw.head);
      }
      actSw.opsVersion = (actSw.opsVersion || 0) + 1;
      notifyDeltaWaiters(actSw.id);
      return jsonResp({
        ok: true,
        opId: targetOp.opId,
        action: actAction,
        op: Object.assign({}, targetOp),
        ops: actSw.ops.slice(),
      });
    }
    if (url.pathname === "/api/portfolio") {
      return jsonResp(buildPortfolioPayload());
    }
    if (url.pathname === "/api/triage/ack" && init && String(init.method || "").toUpperCase() === "POST") {
      var ackBody = {};
      try { ackBody = JSON.parse(String(init.body || "{}")); } catch { return jsonResp({ error: "Invalid JSON" }, 400); }
      if (!ackBody || ackBody.confirm !== true || typeof ackBody.triageId !== "string") {
        return jsonResp({ error: "confirm and triageId required" }, 400);
      }
      var ackAction = String(ackBody.action || "");
      if (["ack", "snooze", "unack"].indexOf(ackAction) < 0) {
        return jsonResp({ error: "Invalid ack action" }, 400);
      }
      var ackSw = findSwarmByConvId(ackBody.conversationId) || state.swarms[ackBody.conversationId];
      if (!ackSw) return jsonResp({ error: "Swarm not found" }, 404);
      ackSw.triageAcks = ackSw.triageAcks || {};
      if (ackAction === "unack") {
        delete ackSw.triageAcks[ackBody.triageId];
      } else {
        ackSw.triageAcks[ackBody.triageId] = {
          triageId: ackBody.triageId,
          action: ackAction,
          untilSeq: typeof ackBody.untilSeq === "number" ? ackBody.untilSeq : (ackSw.head || 0) + 5,
          note: typeof ackBody.note === "string" ? ackBody.note.slice(0, 400) : undefined,
          ackedAt: Date.now(),
        };
      }
      ackSw.ackVersion = (ackSw.ackVersion || 0) + 1;
      notifyDeltaWaiters(ackSw.id);
      return jsonResp({
        ok: true,
        conversationId: ackSw.id,
        triageId: ackBody.triageId,
        action: ackAction,
        acks: Object.assign({}, ackSw.triageAcks),
        triage: computeSnapshot(ackSw.id).triage,
      });
    }
    if (url.pathname === "/api/pins" && init && String(init.method || "").toUpperCase() === "POST") {
      var pinBody = {};
      try { pinBody = JSON.parse(String(init.body || "{}")); } catch { return jsonResp({ error: "Invalid JSON" }, 400); }
      if (!pinBody || pinBody.confirm !== true || typeof pinBody.seq !== "number" || pinBody.seq <= 0) {
        return jsonResp({ error: "confirm and valid seq required" }, 400);
      }
      var pinSw = findSwarmByConvId(pinBody.conversationId) || state.swarms[pinBody.conversationId];
      if (!pinSw) return jsonResp({ error: "Swarm not found" }, 404);
      var curPins = Array.isArray(pinSw.pinnedSeqs) ? pinSw.pinnedSeqs.slice() : [];
      var wantPinned = Boolean(pinBody.pinned);
      if (wantPinned && curPins.indexOf(pinBody.seq) < 0) curPins.push(pinBody.seq);
      if (!wantPinned) curPins = curPins.filter(function (x) { return x !== pinBody.seq; });
      curPins.sort(function (a, b) { return a - b; });
      pinSw.pinnedSeqs = curPins;
      pinSw.pinsVersion = (pinSw.pinsVersion || 0) + 1;
      notifyDeltaWaiters(pinSw.id);
      return jsonResp({
        ok: true,
        conversationId: pinSw.id,
        seq: pinBody.seq,
        pinned: wantPinned,
        pinnedSeqs: curPins.slice(),
      });
    }
    if (url.pathname === "/api/swarm/archive" && init && String(init.method || "").toUpperCase() === "POST") {
      var archBody = {};
      try { archBody = JSON.parse(String(init.body || "{}")); } catch { return jsonResp({ error: "Invalid JSON" }, 400); }
      if (!archBody || archBody.confirm !== true || typeof archBody.archived !== "boolean") {
        return jsonResp({ error: "confirm and archived boolean required" }, 400);
      }
      var archSw = findSwarmByConvId(archBody.conversationId) || state.swarms[archBody.conversationId];
      if (!archSw) return jsonResp({ error: "Swarm not found" }, 404);
      archSw.archived = Boolean(archBody.archived);
      notifyDeltaWaiters(archSw.id);
      return jsonResp({ ok: true, conversationId: archSw.id, archived: archSw.archived });
    }
    if (url.pathname === "/api/checkpoints" && (!init || !init.method || String(init.method).toUpperCase() === "GET")) {
      var cpConv = url.searchParams.get("conversationId") || COORD_ID;
      var cpSw = findSwarmByConvId(cpConv) || state.swarms[cpConv];
      if (!cpSw) return jsonResp({ error: "Swarm not found" }, 404);
      var cpList = (cpSw.checkpoints || []).map(function (cp) {
        return Object.assign({}, sanitizeCheckpoint(cp), { diff: computeCheckpointDiffObj(cpSw, cp) });
      });
      return jsonResp({ ok: true, conversationId: cpSw.id, checkpoints: cpList });
    }
    if (url.pathname === "/api/checkpoints" && init && String(init.method || "").toUpperCase() === "POST") {
      var rawCpBody = String(init.body || "{}");
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(rawCpBody)) {
        return jsonResp({ error: "Control characters not permitted" }, 400);
      }
      var cpBody = {};
      try { cpBody = JSON.parse(rawCpBody); } catch { return jsonResp({ error: "Invalid JSON" }, 400); }
      var cpLabel = typeof cpBody.label === "string" ? cpBody.label.trim() : "";
      if (!cpBody || cpBody.confirm !== true || !cpLabel || cpLabel.length > 120) {
        return jsonResp({ error: "confirm and valid label required" }, 400);
      }
      var targetCpSw = findSwarmByConvId(cpBody.conversationId) || state.swarms[cpBody.conversationId];
      if (!targetCpSw) return jsonResp({ error: "Swarm not found" }, 404);
      var normPlan = normalizePlanForSnapshot(targetCpSw.plan, planEtagOf(targetCpSw));
      var newCp = {
        id: "cp-" + (++opCounter),
        conversationId: targetCpSw.id,
        label: cpLabel,
        createdAt: Date.now(),
        head: targetCpSw.head || 0,
        planEtag: planEtagOf(targetCpSw),
        planGoal: (normPlan && (normPlan.goalLine || normPlan.goal)) || "",
        planSnapshot: targetCpSw.plan ? JSON.parse(JSON.stringify(targetCpSw.plan)) : null,
        memberCount: targetCpSw.members.length,
        activeCount: targetCpSw.members.filter(function (m) { return !m.killed && m.status === "working"; }).length,
        triageCount: computeSnapshot(targetCpSw.id).triage.length,
        worktrees: state.worktrees.map(function (w) {
          return { path: w.path, branch: w.branch, head: w.head, clean: w.clean, dirtyFiles: (w.dirtyFiles || 0) + (w.untrackedFiles || 0) };
        }),
      };
      targetCpSw.checkpoints = [newCp].concat(targetCpSw.checkpoints || []);
      targetCpSw.checkpointVersion = (targetCpSw.checkpointVersion || 0) + 1;
      notifyDeltaWaiters(targetCpSw.id);
      var enrichedList = targetCpSw.checkpoints.map(function (cp) {
        return Object.assign({}, sanitizeCheckpoint(cp), { diff: computeCheckpointDiffObj(targetCpSw, cp) });
      });
      return jsonResp({ ok: true, checkpoint: enrichedList[0], checkpoints: enrichedList });
    }
    if (url.pathname === "/api/checkpoints/restore" && init && String(init.method || "").toUpperCase() === "POST") {
      var rstBody = {};
      try { rstBody = JSON.parse(String(init.body || "{}")); } catch { return jsonResp({ error: "Invalid JSON" }, 400); }
      if (!rstBody || rstBody.confirm !== true || typeof rstBody.checkpointId !== "string") {
        return jsonResp({ error: "confirm and checkpointId required" }, 400);
      }
      var rstMode = String(rstBody.mode || "");
      if (rstMode !== "plan" && rstMode !== "resume_prompt") {
        return jsonResp({ error: "Invalid restore mode" }, 400);
      }
      var rstSw = findSwarmByConvId(rstBody.conversationId) || state.swarms[rstBody.conversationId];
      if (!rstSw) return jsonResp({ error: "Swarm not found" }, 404);
      var hitCp = (rstSw.checkpoints || []).find(function (c) { return c.id === rstBody.checkpointId; });
      if (!hitCp) return jsonResp({ error: "Checkpoint not found" }, 404);
      if (rstMode === "plan") {
        if (hitCp.planSnapshot) {
          rstSw.plan = JSON.parse(JSON.stringify(hitCp.planSnapshot));
          rstSw.planVersion = (rstSw.planVersion || 1) + 1;
        }
        notifyDeltaWaiters(rstSw.id);
        var nextPlEtag = planEtagOf(rstSw);
        return jsonResp({
          ok: true,
          mode: "plan",
          checkpointId: hitCp.id,
          plan: normalizePlanForSnapshot(rstSw.plan, nextPlEtag),
          etag: nextPlEtag,
        });
      }
      var resumePrompt = "@coordinator Resume from checkpoint \"" + hitCp.label + "\" (#" + hitCp.head + "): " +
        (hitCp.planGoal || rstSw.title) + ". Verify live worktrees and post updated [done].";
      return jsonResp({
        ok: true,
        mode: "resume_prompt",
        checkpointId: hitCp.id,
        resumePrompt: resumePrompt,
      });
    }
    if (url.pathname === "/api/health") {
      return jsonResp({ ok: true, name: "fleet", version: "1.30.0", mode: "live-web", canSendMessage: true, sseStream: false, deltaStream: true, transcriptInspector: true, idleSleep: false, sseClients: 0 });
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
    if (url.pathname === "/api/swarm/delta") {
      var signal = init && init.signal;
      if (signal && signal.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      var dConv = url.searchParams.get("conversationId") || COORD_ID;
      var rawSince = url.searchParams.get("since");
      var sinceNum = 0;
      if (rawSince !== null && rawSince !== "") {
        sinceNum = Number(rawSince);
        if (!Number.isInteger(sinceNum) || sinceNum < 0) {
          return jsonResp({ ok: false, error: "Invalid since parameter" }, 400);
        }
      }
      var dEtag = url.searchParams.get("etag") || "";
      var rawWait = Number(url.searchParams.get("waitMs") || 0);
      var waitMs = Number.isFinite(rawWait) ? Math.max(0, Math.min(25000, Math.floor(rawWait))) : 0;
      var firstRes = computeDelta(dConv, sinceNum, dEtag);
      if (firstRes.status !== 200 || !firstRes.body.unchanged || waitMs <= 0) {
        return jsonResp(firstRes.body, firstRes.status);
      }
      await new Promise(function (resolve, reject) {
        var settled = false;
        var timer = null;
        var waiter = {
          swarmId: firstRes.body.swarm,
          wake: function () {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (signal) signal.removeEventListener("abort", onAbort);
            resolve();
          },
        };
        function onAbort() {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          deltaWaiters = deltaWaiters.filter(function (w) { return w !== waiter; });
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        deltaWaiters.push(waiter);
        timer = setTimeout(function () {
          deltaWaiters = deltaWaiters.filter(function (w) { return w !== waiter; });
          waiter.wake();
        }, waitMs);
      });
      var nextRes = computeDelta(dConv, sinceNum, dEtag);
      return jsonResp(nextRes.body, nextRes.status);
    }
    if (url.pathname === "/api/worktrees") {
      var wtConvId = url.searchParams.get("conversationId") || COORD_ID;
      var wtSw = findSwarmByConvId(wtConvId) || state.swarms[COORD_ID];
      var enrichedWorktrees = state.worktrees.map(function (wt) {
        var matchedMember = wtSw && (wtSw.members || []).find(function (m) {
          return !m.killed && ((m.workspace && m.workspace === wt.path) || (wt.swarmOwner && wt.swarmOwner.member === m.name));
        });
        if (!matchedMember) return wt;
        return Object.assign({}, wt, {
          swarmOwner: {
            member: matchedMember.name,
            status: matchedMember.status || "waiting",
            workspaceMode: (wt.swarmOwner && wt.swarmOwner.workspaceMode) || matchedMember.workspace_mode || "inherit",
          },
        });
      });
      return jsonResp({
        roots: [{ path: "/workspace/fleet", uri: "file:///workspace/fleet", isGit: true, count: enrichedWorktrees.length, error: "" }],
        worktrees: enrichedWorktrees,
        collisions: computeWorktreeCollisions(enrichedWorktrees),
        rejected: [],
      });
    }
    if (url.pathname === "/api/worktrees/diff") {
      var wtPath = url.searchParams.get("worktree") || url.searchParams.get("path") || "/workspace/fleet";
      var relFile = url.searchParams.get("file") || "README.md";
      var rawMode = url.searchParams.get("mode") || "working";
      var diffMode = rawMode === "branch" || rawMode === "conflict" ? rawMode : "working";
      var targetBr = url.searchParams.get("targetBranch") || "main";
      var reqOffset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") || 0) || 0));
      if (diffMode === "conflict") {
        var conflictChunk1 =
          "@@ -42,7 +42,13 @@\n" +
          " export async function fetchWorktrees(roots) {\n" +
          "+<<<<<<< HEAD (" + targetBr + ")\n" +
          "+  return apiJson(qs(\"/api/worktrees\", { roots: roots.join(\",\") }), \"Worktrees failed\");\n" +
          "+=======\n" +
          "+  return apiJson(qs(\"/api/worktrees\", { roots: roots.join(\",\"), conversationId }), \"Worktrees failed\");\n" +
          "+>>>>>>> lane/sidebar-ui";
        var conflictChunk2 =
          "@@ -180,4 +186,6 @@\n" +
          "+// second 32 KiB conflict chunk from offset " + reqOffset + "\n" +
          "+export const conflictMergedChunk = true;";
        var isSecondChunk = reqOffset >= 32768;
        var cBody = isSecondChunk ? conflictChunk2 : conflictChunk1;
        return jsonResp({
          ok: true,
          worktree: wtPath,
          file: relFile,
          mode: diffMode,
          targetBranch: targetBr,
          diff: cBody,
          offset: reqOffset,
          nextOffset: isSecondChunk ? null : 32768,
          hasMore: !isSecondChunk,
          totalBytes: 49152,
          truncated: !isSecondChunk,
          untracked: false,
          added: isSecondChunk ? 2 : 5,
          removed: 0,
        });
      }
      var diffBody = diffMode === "branch"
        ? "@@ -1,3 +1,5 @@\n export interface WorktreeChange {}\n+export type WorktreeDiffMode = \"working\" | \"branch\" | \"conflict\";\n+// committed on branch"
        : "@@ -12,4 +12,6 @@\n-  const cached = probeCache.get(key);\n+  const realTarget = realpathSync(abs);\n+  if (!realTarget.startsWith(wtPrefix)) return { ok: false, status: 404 };\n   return capDiff(stdout, 8192);";
      return jsonResp({
        ok: true,
        worktree: wtPath,
        file: relFile,
        mode: diffMode,
        diff: diffBody,
        offset: reqOffset,
        nextOffset: null,
        hasMore: false,
        totalBytes: diffBody.length,
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
            conflictFiles: collidingFiles,
            message: "Dry-run merge detected conflicting changes against main.",
          });
        }
        return jsonResp({
          ok: true,
          action: actName,
          status: "clean",
          conflicts: [],
          conflictFiles: [],
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
            conflictFiles: collidingFiles,
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
      if (actName === "squash_merge" || actName === "merge_commit") {
        if (targetWt.isMain) return jsonResp({ error: "Cannot merge primary worktree" }, 400);
        if (!targetWt.clean) {
          return jsonResp({ ok: false, action: actName, status: "dirty", message: "Worktree has uncommitted changes." }, 409);
        }
        if (collidingFiles.length > 0 || (targetWt.conflictFiles && targetWt.conflictFiles.length > 0)) {
          var mergeConflicts = collidingFiles.length > 0 ? collidingFiles : targetWt.conflictFiles;
          return jsonResp({
            ok: false,
            action: actName,
            status: "conflict",
            aborted: true,
            conflicts: mergeConflicts,
            conflictFiles: mergeConflicts,
            message: (actName === "squash_merge" ? "Squash merge" : "Merge commit") + " hit conflicts and was aborted cleanly.",
          }, 409);
        }
        var customMsg = typeof actBody.commitMessage === "string" ? actBody.commitMessage.trim() : "";
        targetWt.ahead = 0;
        targetWt.behind = 0;
        targetWt.landStatus = "merged";
        targetWt.mergeability = "up_to_date";
        return jsonResp({
          ok: true,
          action: actName,
          status: "merged",
          message: (actName === "squash_merge" ? "Squash-merged " : "Merged ") +
            targetWt.branch + " into " + (targetWt.baseBranch || "main") +
            (customMsg ? " (" + customMsg + ")" : "") + ".",
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
    if (url.pathname === "/api/transcript") {
      var tConv = url.searchParams.get("conversationId") || COORD_ID;
      var tMember = String(url.searchParams.get("member") || "").trim();
      var tFilter = String(url.searchParams.get("filter") || "all").toLowerCase();
      if (tFilter !== "errors" && tFilter !== "tools") tFilter = "all";
      var rawLimit = Number(url.searchParams.get("limit") || 20);
      var tLimit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, Math.floor(rawLimit))) : 20;
      var rawBefore = url.searchParams.get("before");
      var hasBefore = rawBefore !== null && rawBefore !== "";
      var beforeNum = hasBefore ? Number(rawBefore) : null;
      if (hasBefore && (!Number.isInteger(beforeNum) || beforeNum < 0)) {
        return jsonResp({ ok: false, error: "Invalid before parameter" }, 400);
      }
      var tSw = state.swarms[tConv] || Object.values(state.swarms).find(function (s) {
        return (s.members || []).some(function (m) { return m.conversation_id === tConv; });
      });
      if (!tSw) return jsonResp({ ok: false, error: "Unknown swarm" }, 404);
      var tMemObj = (tSw.members || []).find(function (m) {
        return tMember ? m.name === tMember : m.conversation_id === tConv;
      }) || (tSw.members || [])[0];
      if (!tMemObj) return jsonResp({ ok: false, error: "Unknown member" }, 404);

      var mName = tMemObj.name;
      if (tMemObj.steps === 0) {
        return jsonResp({
          ok: true,
          member: mName,
          conversationId: tMemObj.conversation_id || tSw.id,
          totalSteps: 0,
          nextBefore: null,
          hasMore: false,
          steps: [],
        });
      }
      var mModel = tMemObj.model || "gemini-3-pro";
      var stepsAll = [];
      for (var si = 0; si < 24; si++) {
        var stepTs = t(900 - si * 35);
        var isBoot = si === 0;
        var isErrStep = si === 21 || (mName === "scanner" && si === 22);
        var isToolStep = si % 2 === 0 || isErrStep || si === 3;
        var toolCalls = [];
        if (isBoot) {
          toolCalls.push({
            name: "read_file",
            summary: "Inspect ~/workspace/fleet-ui/package.json",
            args: { Path: "~/workspace/fleet-ui/package.json", StartLine: 1, EndLine: 40 },
            status: "DONE",
            outputPreview: "{\"name\": \"fleet-frontend\", \"version\": \"1.26.0\"}",
          });
        } else if (isErrStep) {
          toolCalls.push({
            name: "run_command",
            summary: mName === "scanner" ? "Probe model endpoint capacity" : "Run Host-403 and CWE-59 security suite",
            args: {
              CommandLine: mName === "scanner" ? "node scripts/scan-endpoints.mjs --strict" : "node --test test/security.test.mjs",
              WaitMsBeforeAsync: 5000,
            },
            status: "ERROR",
            outputPreview: mName === "scanner"
              ? "stdout: scanning 12 routes...\nstderr: 429 RESOURCE_EXHAUSTED: model quota exceeded on endpoint"
              : "stdout: running 7 security tests...\nstderr: FAIL test/security.test.mjs:48 expected 403 for non-loopback Host, got 200 (exit 1)",
          });
        } else if (isToolStep) {
          toolCalls.push({
            name: si % 4 === 0 ? "run_command" : "edit_file",
            summary: si === 2
              ? "Verify initial test harness baseline"
              : si % 4 === 0
                ? "Run unit and frame confinement tests"
                : "Update ~/workspace/fleet-ui/swarm_store.mjs",
            args: si % 4 === 0
              ? { CommandLine: "node --test test/store.test.mjs", WaitMsBeforeAsync: 5000 }
              : { Path: "~/workspace/fleet-ui/swarm_store.mjs", StartLine: 120, EndLine: 165 },
            status: "DONE",
            outputPreview: si % 4 === 0
              ? "stdout: 7/7 tests passed (142ms)"
              : "Updated 1 block in ~/workspace/fleet-ui/swarm_store.mjs",
          });
        }
        stepsAll.push({
          stepIndex: si,
          type: "PLANNER_RESPONSE",
          status: isErrStep ? "ERROR" : "DONE",
          ts: stepTs,
          durationMs: isErrStep ? 1840 : 420 + (si % 5) * 190,
          model: mModel,
          thinking: isErrStep
            ? "Investigating failure in " + mName + " execution trace"
            : isBoot
              ? "Bootstrapping workspace context for @" + mName
              : "Step #" + si + " verification for @" + mName,
          content: isBoot
            ? "Initial workspace bootstrap complete (#0)."
            : si === 23
              ? "All checks pass after remediation."
              : "",
          error: isErrStep
            ? (mName === "scanner"
              ? "QuotaError: 429 RESOURCE_EXHAUSTED: model quota exceeded\n  at callModel (~/sidecars/fleet_pane/runtime.mjs:112:9)"
              : "AssertionError: Expected 403 for non-loopback Host header\n  at Object.<anonymous> (~/sidecars/fleet_pane/test/security.test.mjs:48:12)")
            : null,
          toolCalls: toolCalls,
          usage: {
            inputTokens: 1100 + si * 90,
            cacheReadTokens: 450 + si * 40,
            outputTokens: 120 + (si % 4) * 45,
          },
        });
      }

      var filteredSteps = stepsAll.filter(function (st) {
        if (tFilter === "errors") {
          return Boolean(st.error) || st.status === "ERROR" || st.toolCalls.some(function (tc) { return tc.status === "ERROR"; });
        }
        if (tFilter === "tools") {
          return st.toolCalls && st.toolCalls.length > 0;
        }
        return true;
      });
      var beforeFiltered = hasBefore
        ? filteredSteps.filter(function (st) { return st.stepIndex < beforeNum; })
        : filteredSteps;
      var pageSlice = beforeFiltered.slice(-tLimit).reverse();
      var nextBefore = pageSlice.length > 0 ? pageSlice[pageSlice.length - 1].stepIndex : null;
      var hasMore = pageSlice.length > 0 && beforeFiltered.some(function (st) { return st.stepIndex < nextBefore; });
      return jsonResp({
        ok: true,
        member: mName,
        conversationId: tMemObj.conversation_id || tSw.id,
        totalSteps: stepsAll.length,
        nextBefore: nextBefore,
        hasMore: hasMore,
        steps: pageSlice,
      });
    }
    return origFetch(input, init);
  };
})();
