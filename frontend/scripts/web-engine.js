// Pure client-side Antigravity Swarm Sidecar simulator for `dist-live-web/index.html`.
// Zero external calls; provides stateful /api/swarms, /api/swarm, /api/worktrees, /api/nudge, /api/frame.
(function () {
  window.__FLEET_LIVE_WEB__ = true;

  var COORD_ID = "demo-coord-0001";
  var BUILDER_ID = "demo-builder-0002";
  var VERIFIER_ID = "demo-verifier-0003";
  var UI_ID = "demo-ui-0004";
  var AUDIT_COORD_ID = "demo-audit-0009";

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
            usage: { inputTokens: 24200, cacheReadTokens: 19400, outputTokens: 2850, totalTokens: 46450 },
            workspace_mode: "share",
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
            activity: "",
            activityKind: "",
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
        dirtyFiles: 0,
        untrackedFiles: 0,
        stagedFiles: 0,
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
        dirtyFiles: 0,
        untrackedFiles: 0,
        stagedFiles: 0,
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
        dirtyFiles: 3,
        untrackedFiles: 1,
        stagedFiles: 0,
        lastCommitSha: "c42e81f2",
        lastCommitSubject: "ui: refine 380px Needs-You triage cards",
        lastCommitAt: t(25),
      },
    ],
  };

  function computeSnapshot(id) {
    var sw = state.swarms[id];
    if (!sw) return { conversationId: id || null, swarm: null, member: null, swarms: listSwarms(), capabilities: { canSendMessage: true, isSidecar: false } };
    var triage = [];
    for (var i = 0; i < sw.members.length; i++) {
      var m = sw.members[i];
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
    return {
      conversationId: sw.id,
      swarm: sw.id,
      member: sw.member,
      etag: "liveweb-" + sw.head + "-" + triage.length,
      id: sw.id,
      title: sw.title,
      head: sw.head,
      members: sw.members,
      messages: sw.messages,
      edges: [],
      plan: sw.plan,
      frames: sw.frames,
      triage: triage,
      usage: usage,
      capabilities: { canSendMessage: true, isSidecar: false },
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

    if (url.pathname === "/api/health") {
      return jsonResp({ ok: true, name: "fleet", version: "1.0.0", mode: "live-web", canSendMessage: true });
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
      return jsonResp({ roots: [{ path: "/workspace/fleet", uri: "file:///workspace/fleet", isGit: true, count: state.worktrees.length, error: "" }], worktrees: state.worktrees, rejected: [] });
    }
    return origFetch(input, init);
  };
})();
