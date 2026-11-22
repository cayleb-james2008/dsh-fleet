// build-demo.mjs: Produces a standalone, zero-network static fixture demo bundle (demo-dist/index.html)
// from the freshly built single-file ../assets/index.html by injecting an interactive client-side /api/* mock.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const srcHtml = path.join(root, "assets/index.html");
const outDir = process.env.DEMO_OUT_DIR || path.join(root, "demo-dist");
const outFile = path.join(outDir, "index.html");

if (!fs.existsSync(srcHtml)) {
  console.error(`Missing ${srcHtml} — run npm run build first.`);
  process.exit(1);
}

const MOCK_SCRIPT = `<script>
(() => {
  window.__FLEET_DEMO__ = true;
  const nowSec = Math.floor(Date.now() / 1000) - 240;

  let sessions = [
    {
      id: "s-041",
      project: "dsh-fleet",
      branch: "fleet/s-041-setsid-sweep",
      engine: "claude",
      agent: "claude",
      test_mode: false,
      status: "done",
      bucket: "done",
      merge_target: "main",
      task: "Sweep detached setsid child processes when a worktree session settles",
      check_cmd: "cargo test --test cli && bash .loop/checks/verify2.sh",
      check_ran: true,
      check_passed: true,
      check_exit: 0,
      check_output: [
        "running 9 tests",
        "test version_is_answered_in_any_argument_position ... ok",
        "test with_no_env_the_data_lives_in_the_platform_data_folder ... ok",
        "VERIFY2 OK: pristine-tree checks, delta gates with -z parsing, index bits committed, setsid sweep",
        "52 passed, 0 failed in 2.14s"
      ].join("\\n"),
      transcript: [
        "worktree ready on branch fleet/s-041-setsid-sweep",
        "claude -p: scanning /proc/<pid>/cwd for processes holding worktree after process-group kill",
        "claude -p: added sweep_worktree_holders() before pristine-checkout verification",
        "agent exited 0 — committing worktree delta and running policy check",
        "check passed — verified done (52 passed, 0 failed in 2.14s)"
      ],
      diff: [
        "diff --git a/src/main.rs b/src/main.rs",
        "index 84c12a1..c92e410 100644",
        "--- a/src/main.rs",
        "+++ b/src/main.rs",
        "@@ -1418,7 +1418,16 @@ fn settle_worktree(wt: &Path, log: &mut Vec<String>) {",
        "-    kill_process_group(pgid);",
        "+    kill_process_group(pgid);",
        "+    let swept = sweep_detached_holders(wt);",
        "+    if swept > 0 {",
        "+        log.push(format!(\\"swept {swept} detached process(es) holding worktree\\"));",
        "+    }",
        "     verify_clean_index(wt);",
        " }",
        "diff --git a/.loop/checks/verify2.sh b/.loop/checks/verify2.sh",
        "index 22019ab..7781c04 100755",
        "--- a/.loop/checks/verify2.sh",
        "+++ b/.loop/checks/verify2.sh",
        "@@ -129,5 +129,9 @@ sleep 5",
        "-grep -q GHOST \\"$wt6/output.txt\\" && exit 1",
        "+if grep -q GHOST \\"$wt6/output.txt\\"; then",
        "+  echo \\"FAIL [ghost]: detached setsid writer survived settle\\"; exit 1",
        "+fi"
      ].join("\\n"),
      steer: [],
      next_queue: []
    },
    {
      id: "s-039",
      project: "dsh-fleet",
      branch: "fleet/s-039-checksum-manifest",
      engine: "opencode",
      agent: "opencode",
      test_mode: false,
      status: "needs-you",
      bucket: "needs-you",
      merge_target: "main",
      task: "Write SHA-256 release artifact manifest to output.txt before publish",
      reason: "Check failed (exit 1): test -s output.txt. Agent claimed completion (exit 0), but output.txt was empty (0 bytes).",
      check_cmd: "test -s output.txt",
      check_ran: true,
      check_passed: false,
      check_exit: 1,
      check_output: "test -s output.txt -> exit code 1 (output.txt is 0 bytes in pristine checkout)",
      transcript: [
        "worktree ready on branch fleet/s-039-checksum-manifest",
        "opencode run --model opencode-go/deepseek-v4.1-flash: drafting scripts/checksums.sh",
        "agent: Done! Generated SHA-256 release manifest in output.txt.",
        "fleet: agent exited 0 — running verification check in pristine checkout: test -s output.txt",
        "fleet: check failed (exit 1): output.txt was never written (false completion claim refused)"
      ],
      diff: [
        "diff --git a/scripts/checksums.sh b/scripts/checksums.sh",
        "new file mode 100755",
        "index 0000000..3091fa2",
        "--- /dev/null",
        "+++ b/scripts/checksums.sh",
        "@@ -0,0 +1,6 @@",
        "+#!/usr/bin/env bash",
        "+set -euo pipefail",
        "+# Bug: wrote to stdout instead of redirecting into output.txt",
        "+sha256sum dist/fleet-rs-*"
      ].join("\\n"),
      steer: [],
      next_queue: []
    },
    {
      id: "s-042",
      project: "ergon",
      branch: "fleet/s-042-graph-columns",
      engine: "codex",
      agent: "codex",
      test_mode: false,
      status: "working",
      bucket: "working",
      merge_target: "main",
      task: "Keep Work Graph SVG column labels >= 12px across 768px and 1440px widths",
      check_cmd: "cargo test && npm run check:ui",
      check_ran: false,
      check_passed: null,
      check_exit: null,
      check_output: "",
      transcript: [
        "worktree ready on branch fleet/s-042-graph-columns",
        "codex exec --sandbox workspace-write: measuring SVG getScreenCTM scale at 768px",
        "codex: replacing fixed viewBox shrink with measured container width + opaque label pills"
      ],
      diff: [
        "diff --git a/frontend/src/Graph.tsx b/frontend/src/Graph.tsx",
        "index 119a02e..54f910b 100644",
        "--- a/frontend/src/Graph.tsx",
        "+++ b/frontend/src/Graph.tsx",
        "@@ -44,4 +44,7 @@ export function WorkGraph({ width }: { width: number }) {",
        "-  const scale = width / 1280;",
        "+  const fontSize = 13;",
        "+  const colWidth = Math.floor((width - 48) / 4);"
      ].join("\\n"),
      steer: [],
      next_queue: []
    },
    {
      id: "s-040",
      project: "dsh-fleet",
      branch: "fleet/s-040-rune-clamp",
      engine: "opencode",
      agent: "opencode",
      test_mode: false,
      status: "done",
      bucket: "done",
      merge_target: "main",
      task: "Clamp policy timeout_secs to 7 days so Instant::checked_add never overflows",
      check_cmd: "cargo test policy_timeout",
      check_ran: true,
      check_passed: true,
      check_exit: 0,
      check_output: "running 1 test\\ntest tests::policy_timeout_clamps_i64_max ... ok\\n1 passed; 0 failed in 0.29s",
      transcript: [
        "worktree ready on branch fleet/s-040-rune-clamp",
        "opencode: clamping policy.timeout_secs to MAX_TIMEOUT_SECS (604_800s)",
        "check passed — verified done (1 passed; 0 failed in 0.29s)"
      ],
      diff: [
        "diff --git a/src/main.rs b/src/main.rs",
        "index 510bc12..84c12a1 100644",
        "--- a/src/main.rs",
        "+++ b/src/main.rs",
        "@@ -121,4 +121,5 @@ impl Policy {",
        "-    policy.timeout_secs = secs as u64;",
        "+    const MAX_TIMEOUT_SECS: u64 = 604_800;",
        "+    policy.timeout_secs = (secs as u64).min(MAX_TIMEOUT_SECS);"
      ].join("\\n"),
      steer: [],
      next_queue: []
    }
  ];

  const policy = {
    agents: [
      { name: "claude", found: true },
      { name: "codex", found: true },
      { name: "opencode", found: true }
    ],
    max_parallel: 4,
    timeout_secs: 1800,
    source: "policies.rn",
    default_agent: "claude",
    default_agent_engine: "claude",
    model: "opencode-go/deepseek-v4.1-flash"
  };

  let updateState = {
    current: "0.3.0",
    latest: "0.3.0",
    available: false,
    mode: "notify",
    can_apply: false,
    dev_build: false,
    staged: null,
    checked_at: nowSec
  };

  let stepTick = 1;
  const streamLines = [
    "codex: running Playwright SVG label bounding-box check at 768px and 1440px",
    "codex: all 14 labels >= 13px, 0 overlaps — preparing check suite",
    "codex: verifying keyboard structured-list fallback below 720px"
  ];
  setInterval(() => {
    const running = sessions.find((s) => s.id === "s-042" && s.bucket === "working");
    if (running && stepTick <= streamLines.length) {
      running.transcript = [...running.transcript, streamLines[stepTick - 1]];
      stepTick++;
    }
  }, 3500);

  let seq = 43;
  const jsonResp = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" }
    });

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(rawUrl, window.location.origin);
    if (!u.pathname.startsWith("/api/")) {
      return realFetch(input, init);
    }
    const method = (init.method || "GET").toUpperCase();
    const bodyText = typeof init.body === "string" ? init.body : "";
    let body = {};
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch {}

    if (method === "GET" && u.pathname === "/api/sessions") {
      return jsonResp(sessions.filter((s) => s.bucket !== "archived"));
    }
    if (method === "GET" && u.pathname === "/api/inbox") {
      return jsonResp(sessions.filter((s) => s.bucket === "needs-you"));
    }
    if (method === "GET" && u.pathname === "/api/policy") {
      return jsonResp(policy);
    }
    if (method === "GET" && u.pathname === "/api/version") {
      return jsonResp({ version: "0.3.0" });
    }
    if (method === "GET" && u.pathname === "/api/update") {
      return jsonResp(updateState);
    }
    if (method === "POST" && u.pathname === "/api/update/check") {
      updateState = { ...updateState, checked_at: Math.floor(Date.now() / 1000) };
      return jsonResp(updateState);
    }
    if (method === "POST" && u.pathname === "/api/sessions") {
      const task = String(body.task || "").trim();
      const repo = String(body.repo || "").trim();
      if (!repo) return jsonResp({ error: "Give the repo path: the folder of the git repository the agent works in." }, 400);
      if (!task) return jsonResp({ error: "Write the task: say what the agent should do." }, 400);
      const id = "s-0" + (seq++);
      const proj = String(body.project || "dsh-fleet").trim() || "dsh-fleet";
      const eng = String(body.agent || policy.default_agent || "claude");
      const checkCmd = String(body.check || "").trim() || "cargo test";
      const created = {
        id,
        project: proj,
        branch: "fleet/" + id + "-" + task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 22),
        engine: eng,
        agent: eng,
        test_mode: false,
        status: "working",
        bucket: "working",
        merge_target: "main",
        task,
        check_cmd: checkCmd,
        check_ran: false,
        check_passed: null,
        check_exit: null,
        check_output: "",
        transcript: [
          "worktree ready on branch fleet/" + id,
          eng + ": inspecting repository and applying requested change"
        ],
        diff: "",
        steer: [],
        next_queue: body.next ? [String(body.next)] : []
      };
      sessions = [created, ...sessions];
      setTimeout(() => {
        const target = sessions.find((x) => x.id === id);
        if (!target || target.status !== "working") return;
        target.status = "done";
        target.bucket = "done";
        target.check_ran = true;
        target.check_passed = true;
        target.check_exit = 0;
        target.check_output = "running check: " + checkCmd + "\\nall assertions passed in 0.64s";
        target.transcript = [
          ...target.transcript,
          "fleet: agent exited 0 — running check in pristine checkout: " + checkCmd,
          "check passed — verified done (all assertions passed in 0.64s)"
        ];
        target.diff = [
          "diff --git a/src/task_" + id.replace("-", "_") + ".rs b/src/task_" + id.replace("-", "_") + ".rs",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/task_" + id.replace("-", "_") + ".rs",
          "@@ -0,0 +1,5 @@",
          "+// Verified task: " + task,
          "+pub fn verified_change() -> bool {",
          "+    true",
          "+}"
        ].join("\\n");
      }, 1400);
      return jsonResp(created, 201);
    }

    const m = /^\\/api\\/sessions\\/([^/]+)\\/(retry|merge|steer|stop|dismiss)$/.exec(u.pathname);
    if (method === "POST" && m) {
      const [, id, action] = m;
      const s = sessions.find((x) => x.id === id);
      if (!s) return jsonResp({ error: "Session not found." }, 404);
      if (action === "retry") {
        s.status = "working";
        s.bucket = "working";
        s.reason = null;
        s.transcript = [
          ...s.transcript,
          "fleet: retrying in existing worktree with failure context (" + (s.check_cmd || "test -s output.txt") + ")",
          (s.engine || "agent") + ": redirecting sha256sum manifest into output.txt"
        ];
        setTimeout(() => {
          if (s.status !== "working") return;
          s.status = "done";
          s.bucket = "done";
          s.check_ran = true;
          s.check_passed = true;
          s.check_exit = 0;
          s.check_output = "test -s output.txt && wc -l output.txt -> 4 lines (verified non-empty)";
          s.diff = [
            "diff --git a/scripts/checksums.sh b/scripts/checksums.sh",
            "index 3091fa2..8f44d19 100755",
            "--- a/scripts/checksums.sh",
            "+++ b/scripts/checksums.sh",
            "@@ -1,6 +1,6 @@",
            " #!/usr/bin/env bash",
            " set -euo pipefail",
            "-sha256sum dist/fleet-rs-*",
            "+sha256sum dist/fleet-rs-* > output.txt",
            "+test -s output.txt"
          ].join("\\n");
          s.transcript = [...s.transcript, "check passed — verified done (output.txt verified non-empty)"];
        }, 1800);
        return jsonResp({ ok: true });
      }
      if (action === "merge") {
        if (s.status !== "done") return jsonResp({ error: "Only verified done sessions can be merged." }, 409);
        s.status = "merged";
        s.bucket = "done";
        s.transcript = [...s.transcript, "merged " + s.branch + " into " + (s.merge_target || "main")];
        return jsonResp({ merged: true, branch: s.merge_target || "main" });
      }
      if (action === "steer") {
        const msg = String(body.message || "").trim();
        if (!msg) return jsonResp({ error: "Write the message first." }, 400);
        s.steer = [...(s.steer || []), msg];
        s.transcript = [...s.transcript, "operator steer queued: " + msg];
        if (s.status === "needs-you" || s.status === "done") {
          s.status = "working";
          s.bucket = "working";
          setTimeout(() => {
            s.steer = [];
            s.status = "done";
            s.bucket = "done";
            s.check_ran = true;
            s.check_passed = true;
            s.check_exit = 0;
            s.check_output = "steered run verified: check passed in 0.51s";
            s.transcript = [...s.transcript, "steered continuation finished — check passed"];
          }, 1600);
        }
        return jsonResp({ ok: true });
      }
      if (action === "stop") {
        s.status = "needs-you";
        s.bucket = "needs-you";
        s.reason = "Stopped by you.";
        s.transcript = [...s.transcript, "session stopped by operator"];
        return jsonResp({ ok: true });
      }
      if (action === "dismiss") {
        s.status = "archived";
        s.bucket = "archived";
        return jsonResp({ ok: true });
      }
    }
    return jsonResp({ error: "Unhandled demo route: " + u.pathname }, 404);
  };
})();
</script>`;

let html = fs.readFileSync(srcHtml, "utf8");
html = html.replace("<head>", `<head>\n    ${MOCK_SCRIPT}`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`demo bundle: ${outFile} (${(html.length / 1024).toFixed(0)} kB)`);
