// Fixture harness for Fleet v1.0 Antigravity Sidecar UI verification.
// Starts sidecars/fleet_pane/main.mjs against a realistic temporary <appData>/brain
// plus a real temporary git repo + worktree (off /tmp, inside frontend/e2e/.out).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const E2E = import.meta.dirname;
export const ROOT = path.resolve(E2E, "../..");
export const OUT = path.join(E2E, ".out");
export const CHROME =
  process.env.E2E_CHROME ||
  `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;

export let BASE = "";
export let REPO_DIR = "";
export const results = [];

let serverProc = null;
let appDataDir = "";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

export function build() {
  execFileSync("npm", ["run", "build"], {
    cwd: path.join(ROOT, "frontend"),
    stdio: "inherit",
  });
}

function makePngBytes() {
  // Valid 1x1 PNG buffer
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
}

export function seed({ fresh = true } = {}) {
  const scratch = path.join(OUT, "fixture-data");
  if (fresh) fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });

  appDataDir = path.join(scratch, "appdata");
  const coordA = "11111111-1111-1111-1111-111111111111";
  const builderA = "22222222-2222-2222-2222-222222222222";
  const verifierA = "33333333-3333-3333-3333-333333333333";
  const killedA = "44444444-4444-4444-4444-444444444444";
  const coordB = "55555555-5555-5555-5555-555555555555";

  const swDirA = path.join(appDataDir, "brain", coordA, ".system_generated", "swarm");
  const swDirB = path.join(appDataDir, "brain", coordB, ".system_generated", "swarm");
  fs.mkdirSync(swDirA, { recursive: true });
  fs.mkdirSync(swDirB, { recursive: true });

  for (const id of [coordA, builderA, verifierA, killedA, coordB]) {
    fs.mkdirSync(path.join(appDataDir, "brain", id, ".system_generated", "logs"), { recursive: true });
  }

  const shotPath = path.join(appDataDir, "brain", builderA, "triage-shot.png");
  fs.writeFileSync(shotPath, makePngBytes());

  fs.writeFileSync(
    path.join(swDirA, "members.json"),
    JSON.stringify({
      title: "Release 1.0 Sidebar",
      members: {
        coordinator: { conversation_id: coordA, role: "coordinator", model: "gemini-3-pro", wake_mode: "mentions", last_read_seq: 3 },
        builder: { conversation_id: builderA, role: "worker", model: "gemini-3-pro", wake_mode: "mentions", last_read_seq: 4, workspace_mode: "share" },
        verifier: { conversation_id: verifierA, role: "worker", model: "gemini-3-flash", wake_mode: "working", last_read_seq: 2 },
        "old-helper": { conversation_id: killedA, role: "worker", model: "gemini-3-flash", killed: true, last_read_seq: 1 },
      },
    }),
  );

  fs.writeFileSync(
    path.join(swDirA, "plan.json"),
    JSON.stringify({
      title: "Fleet v1.0",
      goal: "Verify Antigravity-native sidebar UX at 380px and 1440px",
      gate: "node --test && npm run check:ui",
      workstreams: [
        { id: "ws-1", title: "Sidecar Node store & routes", owner: "builder", status: "done" },
        { id: "ws-2", title: "Cold Playwright gate", owner: "verifier", status: "running" },
      ],
      milestones: [
        { title: "Backend Tests", status: "done" },
        { title: "UI Verification", status: "in_progress" },
      ],
    }),
  );

  fs.writeFileSync(
    path.join(swDirA, "board.jsonl"),
    [
      JSON.stringify({ seq: 1, agent: "coordinator", text: "@all Ship Fleet v1.0 sidecar plugin cleanly.", time: "2026-11-25 13:10:00" }),
      JSON.stringify({ seq: 2, agent: "builder", text: "@coordinator Built sidecar backend + CWE-22/59 frame confinement.", time: "2026-11-25 13:14:00" }),
      JSON.stringify({ seq: 3, agent: "coordinator", text: "@builder Confirm #2 gzip ETag behavior and hand off to @verifier.", time: "2026-11-25 13:16:00" }),
      JSON.stringify({
        seq: 4,
        agent: "builder",
        text: `@verifier [done] Sidecar ready for cold check.\nScreenshot: ${shotPath} | Aux pane shot`,
        time: "2026-11-25 13:19:00",
      }),
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(appDataDir, "brain", builderA, ".system_generated", "logs", "transcript.jsonl"),
    [
      JSON.stringify({
        step_index: 0,
        type: "PLANNER_RESPONSE",
        model: "gemini-3-pro",
        input_tokens: 12000,
        cache_read_tokens: 4500,
        output_tokens: 680,
        tool_calls: [{ name: "run_command", args: { toolSummary: '"Run sidecar security tests"' } }],
        created_at: "2026-11-25T13:15:00Z",
      }),
      JSON.stringify({ type: "GENERIC", status: "DONE", step_index: 1 }),
      JSON.stringify({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        model: "gemini-3-pro",
        input_tokens: 4000,
        cache_read_tokens: 2000,
        output_tokens: 220,
        content: "All 7 backend checks pass. Should I tag release/1.0.0 now?",
        tool_calls: [],
        created_at: "2026-11-25T13:19:05Z",
      }),
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(appDataDir, "brain", verifierA, ".system_generated", "logs", "transcript.jsonl"),
    JSON.stringify({
      step_index: 0,
      type: "PLANNER_RESPONSE",
      model: "gemini-3-flash",
      input_tokens: 3200,
      cache_read_tokens: 800,
      output_tokens: 190,
      thinking: "**Auditing Host-403 and CWE-59 frame guard**",
      tool_calls: [{ name: "read_file", args: { AbsolutePath: "/home/demo/main.mjs" } }],
      created_at: "2026-11-25T13:20:00Z",
    }),
  );

  // Secondary swarm for switcher checks
  fs.writeFileSync(
    path.join(swDirB, "members.json"),
    JSON.stringify({
      title: "Docs & Changelog Polish",
      members: {
        coordinator: { conversation_id: coordB, role: "coordinator", wake_mode: "mentions", last_read_seq: 1 },
      },
    }),
  );
  fs.writeFileSync(
    path.join(swDirB, "board.jsonl"),
    JSON.stringify({ seq: 1, agent: "coordinator", text: "Updated README for v1.0.0 plugin.", time: "2026-11-25 12:00:00" }) + "\n",
  );

  // Real temporary git repo + 1 worktree for Worktrees tab verification
  REPO_DIR = path.join(scratch, "git-repo");
  const wtDir = path.join(scratch, "git-repo-wt");
  fs.mkdirSync(REPO_DIR, { recursive: true });
  execFileSync("git", ["init", "-b", "main", REPO_DIR], { stdio: "ignore" });
  execFileSync("git", ["-C", REPO_DIR, "config", "user.email", "test@fleet.local"], { stdio: "ignore" });
  execFileSync("git", ["-C", REPO_DIR, "config", "user.name", "Fleet Test"], { stdio: "ignore" });
  fs.writeFileSync(path.join(REPO_DIR, "README.md"), "# Fleet Repo\n");
  execFileSync("git", ["-C", REPO_DIR, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", REPO_DIR, "commit", "-m", "Initial fixture commit"], { stdio: "ignore" });
  execFileSync("git", ["-C", REPO_DIR, "worktree", "add", "-b", "lane/verify", wtDir], { stdio: "ignore" });
  fs.writeFileSync(path.join(wtDir, "untracked.txt"), "dirty\n");
}

export async function start({ fresh = true } = {}) {
  await stop();
  seed({ fresh });
  const port = await freePort();
  serverProc = spawn(
    "node",
    [path.join(ROOT, "sidecars/fleet_pane/main.mjs"), "--port", String(port), "--app-data-dir", appDataDir],
    {
      cwd: path.join(ROOT, "sidecars/fleet_pane"),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  BASE = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return BASE;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting for fleet_pane sidecar server");
}

export async function stop() {
  if (!serverProc) return;
  const proc = serverProc;
  serverProc = null;
  if (proc.exitCode === null) {
    proc.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
        resolve();
      }, 1500);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

export async function runChecks(name, fn) {
  let pass = 0;
  let total = 0;
  const check = async (label, pred) => {
    total++;
    try {
      const ok = typeof pred === "function" ? await pred() : pred;
      if (ok) {
        pass++;
        console.log(`  ok  ${label}`);
      } else {
        console.error(`  FAIL ${label}`);
      }
    } catch (err) {
      console.error(`  FAIL ${label}: ${err?.message || err}`);
    }
  };
  await fn(check);
  results.push({ name, pass, total });
  return { pass, total };
}
