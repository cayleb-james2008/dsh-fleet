# Fleet

[![latest release](https://img.shields.io/github/v/release/cayleb-james2008/dsh-fleet)](https://github.com/cayleb-james2008/dsh-fleet/releases)


Your agents, working in parallel, under one screen. You hand out the work; it
comes back verified done — or it lands in a **Needs you** inbox with the reason
attached. Nothing is babysat, and nothing calls itself done without the
receipt.

Fleet is a small Rust server with a single-page board. Each session is a task
handed to a coding agent — [opencode](https://opencode.ai),
[Claude Code](https://claude.com/product/claude-code), or
[Codex](https://openai.com/codex) — running in its own git worktree of your
repo. When the agent stops, Fleet runs **your check command** itself. The
session is done only when that check passes; the check's own output is the
receipt, and it travels with the session everywhere it is listed.

## The board

Sessions live in three groups:

- **Needs you** — the check failed, the agent exited non-zero, a merge was
  refused, the run timed out or was stopped. Each one says why. This group is
  also an inbox: one list of everything waiting on a human, across every
  session. A needs-you session you have decided not to pursue can be
  **dismissed**: it leaves the board and the inbox, and its log stays on disk.
- **Working** — the agent is running, or Fleet is running the check.
- **Done** — the check passed. The row carries the check's last printed line
  ("3 passed in 4.12s"), or "Check passed (no output)" when it printed nothing.

A session's detail panel has three tabs: **Transcript**, **Diff** and
**Receipt**. The diff is the whole branch against the branch it diverged from.
From a finished session you can merge into the target branch. From a failed
session you can **retry**: the agent runs again in the same worktree, and its
prompt is the original task plus a note with the failing check's command and
the last 4000 characters of its output (or the previous reason, when the check
printed nothing).

While a session works, you can **steer** it — your message runs as a
continuation of the same session before Fleet runs the check — and **stop**
it, which kills the run and lands it in Needs you with "stopped by you" as the
reason. A steering message still waiting on a needs-you session is named in
its reason. Steering is durable: a message leaves the queue only after the run
that carries it, so a server crash mid-delivery loses nothing. A hand-out can
also name what runs **next**: when the session reaches verified done, the
follow-up work is handed out on its own branch, in hand-out order. A session
that lands in Needs you fires nothing.

## What "verified" means here

- **The check is the product's own command**, named per project in a policy
  rules file (`policies.rn`) — the same command a developer would run. A
  check given with a hand-out replaces the default; a blank one counts as no
  check given. Whoever grades the work, it is never the agent.
- **A failed check says what it printed.** Its reason reads
  `Check failed (exit N): <command>. Output: <first 200 characters>`, or
  `Check failed (exit N): <command>. The check printed nothing.` A check that
  never started reads `the check did not run: <command>`.
- **Merging is defensive.** Fleet refuses to merge into a dirty or
  mid-merge target, aborts its own failed merge cleanly, and leaves the
  session in Done when it cannot land. A refusal is a plain sentence:
  a content conflict names its files ("Merge conflict in <files>. Nothing was
  merged."), a missing git identity names `git config user.name` and
  `git config user.email`. Git's own text is kept in the response's `detail`.
  The refusal is also kept on the session as `merge_error`, until a merge
  lands or the session is retried. A merge is only reported once the
  session's branch is verifiably an ancestor of the target, and Fleet then
  removes and prunes the merged session's isolated worktree cleanly.
- **Nothing is silently dropped.** If an agent writes files your repo's
  gitignore excludes, they can never be committed — so the session goes to
  Needs you, naming the files, instead of reporting a "done" whose work is
  not in the diff.
- **Runs are bounded.** Agent and check runs take their timeout from the
  policies file; a run that exceeds it is killed and the session says so.
  Transcripts are capped on the board (2000 lines, 512 KB); the full log is
  kept on disk, per session, and the cap marker names the file.

## Hand-outs

A hand-out is a JSON `POST /api/sessions` with `task` and `repo`, and
optionally `project`, `check`, `agent` and `next`.

- `task` and `repo` are trimmed. Either empty is a 400. A task containing a
  NUL byte, or longer than 100000 bytes, is a 400.
- A `repo` that is not a folder is a 400 `There is no folder at <path>.`; a
  folder that is not a git repository is a 400 that names the `.git` folder
  to point at.
- An agent that is not installed is refused before any worktree is created.

## Persistence

Sessions survive restarts. State is written atomically (a temp file renamed
over the old one) after every change. Each session has two files in
`logs/`: its transcript (`<id>.log`) and its record (`<id>.record.json`),
which holds its repo, branch, check, agent, status, check result, merge
refusal and queued steering. If `sessions.json` is lost, sessions are rebuilt
from their records, so a done session stays done and a merged one stays
merged; a session with no record comes back in Needs you.

A session that was mid-run when the server stopped comes back in **Needs
you**, with "the server restarted while this session was …" attached.

If a session's worktree has lost its link to the repo (its `.git` file is gone
or the repo no longer knows the worktree), a retry moves the directory aside
(`<id>.detached-<seconds>`, files kept, path logged) and re-attaches the work
from the session's branch. Two retries at once run the session once; the second
is refused with "already running".

## Session JSON

`GET /api/sessions` and `GET /api/sessions/<id>` return the sessions. Besides
the task, status, bucket and transcript, each carries:

- `check_cmd`, `check_output` (empty string when none), `check_passed` (null
  until a check ran), `check_ran` (true once the check command started) and
  `check_exit` (its exit code when it exited).
- `merge_target` — the repo's checked-out branch, where Merge lands; null when
  the repo is unknown or its HEAD is detached.
- `merge_error` — `{message, detail, ts}` of the last refused merge, or null.
- `engine`, `test_mode` (true for a custom command), `queue_position`,
  `reason`, `successor` and `spawned_from`.

## HTTP

- `POST /api/sessions` — hand out (201), accepting optional `depends_on`,
  `check_steps`, `allowed_globs`, `forbidden_globs`, `auto_steer_budget`,
  `model`, and `next`.
- `POST /api/sessions/batch` — atomic multi-task / multi-repo DAG batch dispatch
  (201; supports symbolic task keys, `depends_on`, `auto_steer_budget`,
  `dry_run: true`, and rejects cycles or unknown dependencies with 400 before
  creating any session).
- `GET /api/metrics` — live cached board telemetry (`first_pass_count`,
  `auto_healed_count`, `needs_you_count`, `first_pass_rate_pct`,
  `effective_pass_rate_pct`, `median_check_ms`, `active_slots`, `max_slots`,
  `queued_count`, `blocked_count`, and `per_repo_breakdown`).
- `GET /api/templates`, `POST /api/templates`, `DELETE /api/templates/<id>` —
  reusable engineering playbook templates persisted atomically to
  `<data_dir>/templates.json` (ships 4 built-in playbooks and supports custom
  save/delete with live `templates_updated` SSE updates).
- `GET /api/sessions` — list sessions with optional filtering and pagination
  (`q`, `status`, `bucket`, `project`, `repo`, `engine`, `limit`, `offset`,
  `compact=1`, `paginated=1`).
- `GET /api/sessions/<id>/transcript` — paginated, searchable transcript view
  (`offset`, `limit`, `q`, `errors_only=1`, returning `first_error_index`).
- `GET /api/sessions/<id>/merge-check` — non-destructive `git merge-tree` dry-run
  conflict check (`clean`, `conflicting_files`, `commits_ahead`, `commits_behind`,
  `can_fast_forward`).
- `GET /api/sessions/<id>/pr-preview` — generates a structured PR title,
  copy-ready Markdown body (task summary, verification receipt table, auto-heal
  timeline, diff stats), base/head branch metadata, and `gh` availability check.
- `POST /api/sessions/<id>/pr` (loopback-only + CSRF + `confirm: true`) —
  confirmation-gated GitHub PR creation via `gh pr create --body-file -`
  (supports `dry_run: true` for non-destructive `git push --dry-run` validation;
  refuses `confirm: false` with 400 before pushing).
- `GET /api/sessions/<id>/patch` — exports the session's verified work as a
  downloadable `.patch` (`?format=format-patch|unified-diff`, or `?json=1`).
- `POST /api/sessions/<id>/merge` (optional `{"strategy": "merge-commit"|"squash"|"fast-forward-only"}`),
  `/retry`, `/steer` (`{"message": ...}`), `/stop`, and `/dismiss`. Actions on a
  session in the wrong state answer 409 with a plain sentence; an unknown session
  answers 404.
- `GET /api/events/stream` — real-time Server-Sent Events stream with
  `Last-Event-ID` / `?since=` replay and 15s keepalive heartbeats.
- `GET /api/inbox` lists the needs-you sessions. `GET /api/policy` shows the
  parallel cap, detected agents, default agent, active per-engine models,
  budgets, feature flags, and `version`.
- `POST /api/policies/test` — live dry-run policy rules evaluation (`repo`, `task`,
  optional `engine` or candidate `script`), returning the routed engine, model,
  check steps, timeout, budgets, file-scope globs, and trace.
- `GET /api/repos` (loopback-only) discovers local git repositories and their
  checked-out branches; `GET /api/repos/worktrees` and `DELETE /api/repos/worktrees`
  (loopback-only) inspect every registered git worktree (linked session status,
  dirty flag, `is_orphan`, `removable`) and safely remove targeted non-main
  worktrees (refusing main repos, path traversal, unregistered paths, locked
  worktrees, and active sessions); `POST /api/repos/prune-worktrees`
  (loopback-only) prunes inactive worktrees strictly inside Fleet's worktrees
  directory.
- `GET /api/config`, `POST /api/config`, `GET /api/budget`, and `POST /api/budget`
  (loopback-only) read and persist live default-engine, per-engine model,
  `max_parallel_agents` (`1..=64`), and daily budget guardrails
  (`max_session_mins`, `daily_session_limit`, `max_heal_attempts`, enforcing
  HTTP 429 on daily dispatch exhaustion and exposed inside `GET /api/metrics`)
  without restarting Fleet.
- `GET /api/version`, `GET /api/update`, `POST /api/update/check`,
  `POST /api/update/apply`, `POST /api/update/restart` — see "Versions and
  updates".
- Only loopback Host names are answered: `localhost`, `127.0.0.1` and `[::1]`,
  plus any names in `FLEET_ALLOWED_HOSTS` (comma-separated). Any other Host is
  a 403. A request with more than 100 header lines, or more than 32 KiB of
  headers, is a 431. A request body over 1 MiB is a 413.
- A POST must be `Content-Type: application/json` (415 otherwise), and any
  mutating request (`POST`, `DELETE`, `PUT`, `PATCH`) with an `Origin` that is
  not this machine is refused (403).

## Agents, honestly

Fleet detects the agents it can actually run: a name counts only when it
resolves to an executable file on the PATH — a directory named `claude` does
not make Claude available. Asking for an agent that is not there is refused
up front, before any worktree is created, and the board says which agents
this machine really has. When a session names no agent, it runs the
project's policy default.

## Engines, driven as headless CLIs

A bare name gets the engine's non-interactive form:

- **opencode** — `opencode run --model <model> <task>`; a continuation adds
  `--continue`.
- **claude** — `claude -p [--model <model>] <task>`; a continuation adds
  `--continue`. OpenCode-namespaced model IDs are never passed to claude.
- **codex** — `codex exec --sandbox workspace-write --color never [--model <model>] <task>`;
  a continuation is `codex exec resume --last <task>`, which keeps the first
  run's sandbox.

The default OpenCode model comes from `policies.rn` (`agent_model()`, set to
`opencode/deepseek-v4.1-flash-free`), overridable via `FLEET_MODEL` (plus
`FLEET_CLAUDE_MODEL` / `FLEET_CODEX_MODEL`) or live from the **Engines and
settings** sheet (`POST /api/config`, persisted in `config.json`). Every agent
and check process is spawned with both `cwd` and `PWD` set to the isolated
worktree path. Any executable path named as the agent runs as a custom script
and receives the prompt as its single argument.

## Running it

```sh
cargo run -- policies.rn               # serves the board on $PORT (default 8471)
```

Environment: `PORT` (default 8471; a busy default falls back to the next free
port and the banner says which), `FLEET_DATA` (default the platform data folder
— `$XDG_DATA_HOME/fleet`, else `~/.local/share/fleet` on Linux,
`~/Library/Application Support/fleet` on macOS), `FLEET_AGENT` (the default
agent, otherwise the first detected one), `FLEET_MODEL` / `FLEET_CLAUDE_MODEL` /
`FLEET_CODEX_MODEL` (startup model overrides), `FLEET_REPOS_DIR` (optional
colon-separated git repo discovery roots for `GET /api/repos`),
`FLEET_ALLOWED_HOSTS` (extra Host names, see HTTP), `FLEET_NO_OPEN` (do not
open the browser on launch), and the `FLEET_UPDATE_*` variables under
"Versions and updates".

The board opens in the operator's browser on launch, unless there is no display
(a headless service), `FLEET_NO_OPEN` is set, `--no-open` is passed, or
`INVOCATION_ID` is set (a systemd service). The browser open is silent if it
fails — the board is still reachable at the URL on the banner.

State lands in the platform data folder (override with `FLEET_DATA`): the session
store, `logs/`, and the worktrees — one per session, each on its own branch of
the session's repo.

## Versions and updates

**Releasing:** bump `version` in `Cargo.toml`, add a `## X.Y.Z - date` entry to `CHANGELOG.md`, and merge to `main`. `.github/workflows/release.yml` sees the new version, builds every platform and publishes the GitHub Release `vX.Y.Z` with the binaries and `SHA256SUMS`; a push that does not change the version publishes nothing, and a new version without a changelog entry fails the workflow. Pushing a `vX.Y.Z` tag by hand does the same.

The running version is `fleet-rs --version` (or `-V`), `GET /api/version`, and
`version` in `GET /api/policy`. Every release is tagged `vX.Y.Z` on GitHub, with a
`CHANGELOG.md` entry, one binary per platform and a `SHA256SUMS` file. Merging a new version to `main` (or pushing a
tag) runs `.github/workflows/release.yml`, which refuses a tag that does not match
the version in `Cargo.toml`.

Self-update (`src/update.rs`): the app asks the newest GitHub release of its
repository whether a newer version exists (shortly after start and every 6 hours
in `notify` and `auto` modes). `POST /api/update/apply` downloads the binary for
this platform (`fleet-rs-<target>`), checks its SHA-256 against the release's
`SHA256SUMS`, runs it with `--version` to confirm the build, and only then swaps
it in. `POST /api/update/restart` starts the new build. A failed step leaves the
installed program untouched. Downloads use `curl`, which must be installed.

Restart is refused while any session is queued, working or checking, because it
would send those sessions to Needs you; wait for them to settle or stop them.
Apply and restart answer only to a loopback Host name: a name from
`FLEET_ALLOWED_HOSTS` is not enough. Updating is also refused for a cargo-built
binary (one under a `target` folder) unless `FLEET_UPDATE_DEV=1`.

| Var | Default |
| --- | --- |
| `FLEET_UPDATE_MODE` | `notify` (check and tell); `auto` also downloads and installs (a restart is still yours to press); `off` never contacts GitHub |
| `FLEET_UPDATE_REPO` | `cayleb-james2008/dsh-fleet` |
| `FLEET_UPDATE_API` | `https://api.github.com` (plain http only for a loopback address) |
| `FLEET_UPDATE_DEV` | unset; `1` allows replacing a cargo-built binary (tests) |

## Tests and checks

`cargo test` runs the full Rust test suite (library unit tests, server unit
tests, CLI integration tests, and v0.5.0 engine integration tests), covering the
session store and recovery, DAG batch scheduling & 2,000-node cycle rejection,
multi-step check pipelines, file-scope guardrails, non-destructive `merge-tree`
checks, `.patch` export, merge strategies (`merge-commit`/`squash`/`ff-only`),
policy rules dry-run routing & fuzz resilience, SSE event streaming, 2,000-session
and 50,000-line transcript scale benchmarks, graceful `SIGTERM -> SIGKILL`
cancellation, worktree pruning, and desktop launch/self-update verification.

`bash .loop/verify` builds the binary, runs `cargo test`, runs all 20 hermetic
HTTP/process checks in `.loop/checks/`, and runs `proof.sh` (23/23 checks
passing). `cd frontend && npm run check:ui` runs the Playwright E2E gate and
worst-case data replay across desktop and mobile viewports in both themes.

## Layout

- `src/main.rs`, `src/lib.rs`, `src/events.rs`, `src/dag.rs`, `src/checks.rs`,
  `src/merge_check.rs`, `src/policy.rs`, `src/update.rs` — the single-binary
  Rust server and engine library: SSE event bus, DAG/batch scheduler, multi-step
  check pipelines & file-scope guardrails, non-destructive merge checker &
  patch exporter, policy rules engine, worktree runner, persistence, and
  self-updater.
- `frontend/` — the React + Tailwind 4 Mission Control Board, compiled into a
  single self-contained `assets/index.html` with self-hosted Geist and Geist
  Mono fonts embedded directly into the Rust binary. Light default + full dark
  theme parity.
- `policies.rn` — the routing and policy rules file: parallel session cap, repo/task engine
  and model routing, per-task timeouts, retry/steer budgets, file-scope globs,
  and default check commands/steps.
