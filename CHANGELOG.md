# Changelog

Each release is tagged `vMAJOR.MINOR.PATCH` and published on GitHub Releases with
binaries and a `SHA256SUMS` file. The running app shows its version and can update
itself from the newest release (see README, "Versions and updates").

## 0.8.0 - 2026-11-22

- Full **Fleet** Rebrand (`Cargo.toml`, `src/`, `frontend/`, `assets/index.html`,
  `README.md`, `PRODUCT.md`, `.github/workflows/release.yml`, standalone web
  bundle `shared-live-web/fleet/index.html`): renamed crate, binary (`fleet`),
  self-updater repository (`cayleb-james2008/fleet`), release links, and every
  user-facing title, badge, and Settings label cleanly to **Fleet** with zero
  legacy `dsh-fleet` / `fleet-rs` / `DeepSeek Harness` branding or internal
  engine jargon.
- First-Class Native Windows (`x86_64-pc-windows-msvc`) Support: moved `libc`
  under `[target.'cfg(unix)'.dependencies]`, gated Unix-only process-group /
  `/proc` calls with `#[cfg(unix)]`, added native Windows `taskkill /PID <pid> /T`
  and `/T /F` process-tree teardown, `cmd /C` check execution, `where` agent
  probing, `core.hooksPath=NUL`, `%LOCALAPPDATA%\fleet` default data folder,
  and `;`-separated `FLEET_REPOS_DIR`, and restored `windows-latest`
  (`fleet-x86_64-pc-windows-msvc.exe`) to `.github/workflows/release.yml`
  (4-platform release matrix: Linux x86_64/arm64, macOS arm64, Windows x86_64).
- Standalone Chromeless Desktop App Launcher (`src/main.rs`): automatically
  opens Fleet in a dedicated chromeless desktop window (`chromium`/`google-chrome`/
  `brave`/`microsoft-edge --app=<url> --class=fleet` on Linux, `msedge.exe`/
  `chrome.exe --app=<url>` on Windows, fallback `xdg-open` / `cmd /C start` /
  `open`), embeds the default `policies.rn` for zero-config launch from `.desktop`
  shortcuts or double-clicked Windows `.exe` builds outside a repo checkout,
  supports `--app` to open the app window even under systemd/UWSM desktop
  launchers (`INVOCATION_ID`), and strictly honors `--no-open`, `FLEET_NO_OPEN=1`,
  `FLEET_APP_WINDOW=0`, background `INVOCATION_ID`, and headless display checks.

## 0.7.0 - 2026-11-22

- Interactive Multi-Wave DAG Dependency Visualizer (`frontend/src/dag-graph.tsx`,
  `Board` / `DAG Graph` toggle + `g` shortcut + `Cmd+K` command): topological
  longest-path wave layering with cycle protection, color-coded status rails,
  directed SVG cubic Bezier dependency arrows with hover path highlighting, and
  1-click node jump into the Session Inspector.
- PR Preview & Confirmation-Gated GitHub PR Creator (`src/pr.rs`,
  `GET /api/sessions/:id/pr-preview`, loopback+CSRF-guarded `POST /api/sessions/:id/pr`,
  `frontend/src/pr-modal.tsx`): generates structured titles and copy-ready
  Markdown PR bodies (task summary, per-step verification receipt table,
  auto-heal timeline, hardened `--no-ext-diff --no-textconv` diff stats,
  base/head branch, `gh` availability), refuses pushing unless `confirm: true`,
  supports non-destructive `dry_run: true` validation via `git push --dry-run`,
  and passes PR bodies over stdin (`--body-file -`).
- Git Worktree Inspector & Safe Non-Main Removal (`src/worktrees.rs`,
  loopback-guarded `GET /api/repos/worktrees`, `DELETE /api/repos/worktrees`,
  `frontend/src/settings-policy.tsx`): parses `git worktree list --porcelain`
  with linked session status, branch, dirty flag, `is_orphan`, and `removable`;
  strictly enforces an authoritative registered non-main worktree allowlist
  blocking main repo deletion (`403`), `..` path traversal (`403`), relative
  paths (`400`), symlink/unregistered escapes (`403`), locked worktrees (`409`),
  and active running sessions (`409`).
- Daily Dispatch & Session Budget Guardrails (`src/budget.rs`,
  `GET/POST /api/budget`, `POST /api/config` patch, `GET /api/metrics` `budget`
  object, `frontend/src/settings-policy.tsx` & `board.tsx`): atomic UTC-day
  `<data_dir>/budget.json` tracker enforcing `daily_session_limit` with atomic
  HTTP `429` refusals on single and batch dispatch (never charging invalid `400`
  or `dry_run: true` requests), clamping session timeouts by `max_session_mins`,
  and capping autonomous repair passes by `max_heal_attempts`.
- Standalone Browser-Only Live Web Bundle v0.7.0
  (`shared-live-web/dsh-fleet/index.html`): full browser parity for DAG Graph,
  PR Preview + confirmation-gated dry-run, Worktrees Inspector with orphan
  pruning, and Budget Guardrails with zero external requests and zero user-facing
  internal jargon.

## 0.6.0 - 2026-11-22

- Autonomous Auto-Heal / Auto-Steer Feedback Loop (`src/autoheal.rs`,
  `run_agent_and_check`): when a healable verification step fails under a
  session's `auto_steer_budget`, Fleet generates a deterministic diagnostic
  steering prompt containing the failing step command, exit status, and
  ANSI-stripped stderr tail, re-invokes the agent via `--continue`, records
  each `HealAttempt` (`trigger_step`, `exit_code`, `stderr_tail`, `prompt_sent`,
  `elapsed_ms`, `healed`), emits live SSE `auto_heal_attempt` events, enforces
  an identical-error SHA-256 fingerprint loop guard so repeated failures halt
  early instead of burning budget, and never bypasses file-scope guardrails or
  gitignored/commit/stop refusals.
- Reusable Engineering Playbook Templates (`src/templates.rs`,
  `GET /api/templates`, `POST /api/templates`, `DELETE /api/templates/:id`):
  ships 4 clean built-in engineering playbooks (`rust-lint-test`,
  `web-typecheck-build`, `python-pytest-guard`, `docs-safe-update`), atomic
  `<data_dir>/templates.json` persistence with corruption quarantine, live
  `templates_updated` SSE broadcasts, and same-origin CSRF enforcement across
  `POST`/`DELETE`/`PUT`/`PATCH`.
- Live Board Telemetry (`src/metrics.rs`, `GET /api/metrics`): single-pass
  $O(N)$ `state_rev`-cached board telemetry reporting `first_pass_count`,
  `auto_healed_count`, `needs_you_count`, honest `first_pass_rate_pct` vs
  `effective_pass_rate_pct`, `median_check_ms`, `active_slots`/`max_slots`,
  `queued_count`/`blocked_count`, and per-repository breakdowns.
- Mission Control UI v0.6.0: compact Board Telemetry Strip with `By repo (N)`
  popover breakdown, `Healed N/M` & `Auto-healing N/M` badges across session
  cards, hero receipt, and inspector, expandable Auto-Heal Timeline inside the
  Receipt tab (zero native `<details>`), Playbook selector + inline Save/Delete
  and `auto_steer_budget` control in the Composer, `Playbooks` group in `Cmd+K`
  Command Palette, and full v0.6.0 parity in the standalone browser bundle
  (`shared-live-web/dsh-fleet/index.html`).

## 0.5.0 - 2026-11-22

- Real-time Server-Sent Events stream (`GET /api/events/stream`, `src/events.rs`):
  lock-minimal bounded subscriber bus with 64-frame `Last-Event-ID` / `?since=`
  replay, 15s keepalive heartbeats, and live `session_created`, `session_status`,
  `transcript_line`, `check_progress`, `queue_depth`, `config_updated`, and
  `worktrees_pruned` events, wired into the frontend `EventSource` stream with
  graceful 2s polling fallback.
- DAG Dependency Scheduler & Batch / Multi-Repo Matrix Dispatch (`src/dag.rs`,
  `POST /api/sessions/batch`, `depends_on` on `POST /api/sessions`): iterative
  Kahn's topological sort + 3-color cycle detection tested to 2,000+ nodes,
  atomic cycle/unknown-dependency rejection, `blocked` session state with
  `blocked_by` tracking, automatic downstream launch on upstream `done`/`merged`,
  and transitive `Needs you: upstream failed (...)` cascading on upstream failure
  or dismissal.
- Multi-Step Check Pipelines & File-Scope Guardrails (`src/checks.rs`): ordered
  `check_steps` execution in pristine checkouts with live per-step SSE receipts,
  per-step timing/exit/tail output, and polynomial-time glob guardrails
  (`allowed_globs` / `forbidden_globs` merged with `policies.rn` defaults) that
  block out-of-scope or forbidden-file edits cleanly in `Needs you` before any
  session can reach `done`.
- Non-Destructive Pre-Merge Dry-Run, `.patch` Export & Merge Strategies
  (`src/merge_check.rs`): `GET /api/sessions/:id/merge-check` via `git merge-tree`
  (zero mutation to working tree, index, or `HEAD`), `GET /api/sessions/:id/patch`
  (`format-patch` or `unified-diff`), and `POST /api/sessions/:id/merge` strategy
  support (`merge-commit`, `squash`, `fast-forward-only`) preserving every merge
  safety guarantee.
- Policy Rules Engine & Live Dry-Run Tester (`src/policy.rs`, `policies.rn`,
  `POST /api/policies/test`): repo/task engine routing (`route_engine`), model
  routing (`route_model`), per-task timeouts (`timeout_for`), retry/steer budgets
  (`auto_retry_budget`, `auto_steer_budget`), default globs & check steps, and
  fuzz-hardened live dry-run evaluation with full decision traces.
- Scale & Operational Controls: configurable live concurrency cap
  (`max_parallel_agents`, `FLEET_MAX_PARALLEL`, `1..=64`), graceful
  `SIGTERM -> SIGKILL` process-group cancellation on stop/timeout, loopback-only
  `POST /api/repos/prune-worktrees`, dirty-tracked `.record.json` persistence,
  5s TTL merge-target & `state_rev`-keyed session caches, and fast indexed/paginated
  `GET /api/sessions` & `GET /api/sessions/:id/transcript` tested to 2,000 sessions
  and 50,000+ transcript lines (<200ms).
- Mission Control UI v0.5.0: virtualized searchable 50,000+ line transcript viewer
  with Jump to first error, Unified & Side-by-Side Split Diff viewer with pre-merge
  conflict badge and `.patch` export, per-step timed receipt timeline, Batch &
  Matrix DAG composer with guardrail inputs, multi-select bulk actions, global
  `Cmd+K` command palette, Policy Tester & concurrency slider inside
  `Engines and settings` (Light/Dark switch exclusively in Settings), and upgraded
  standalone v0.5.0 Browser Worktree Engine (`shared-live-web/dsh-fleet/index.html`).

## 0.4.0 - 2026-11-21

- Real repository discovery (`GET /api/repos`, loopback-only): discovers local
  git repositories under `FLEET_REPOS_DIR`, `$HOME/Work/projects`, `$HOME/projects`,
  `$HOME/Code`, cwd, and active sessions, wired into a live repo picker in the
  `New session` dialog. Default project name is derived automatically from the
  selected repository folder basename instead of `"fixture"`.
- Live engine and model routing (`GET /api/config`, `POST /api/config`, loopback-only,
  persisted in `data_dir/config.json`) plus `FLEET_MODEL` / `FLEET_CLAUDE_MODEL` /
  `FLEET_CODEX_MODEL` environment overrides. Default `policies.rn` OpenCode model
  updated to `opencode/deepseek-v4.1-flash-free`, with per-engine model routing
  in `Engines and settings`.
- Worktree isolation & cleanup fixes: sets `PWD` to the isolated worktree/check
  directory on spawned agents and checks so CLIs reading `$PWD` (such as
  `opencode`) never write outside the worktree; automatically removes and prunes
  a session's worktree directory under `data_dir/worktrees` once its verified
  commit merges onto the target branch.
- Settings-only Appearance switch: moved the Light/Dark `SegmentedControl`
  (`id="themeBtn"`) out of the top command bar and into the `Engines and settings`
  Vaul right sheet while preserving `Light`/`Dark` accessible labels and
  `localStorage('fleet-theme')` persistence.
- Board polish & real-time reliability: optimistic session insertion on
  `New session` dispatch so the Split-Pane Inspector opens immediately without a
  poll race, `sm:h-auto` fix preventing multi-line task buttons from clipping at
  desktop widths, and zero fixture/demo pills in live operation.
- Standalone functional browser bundle (`frontend/scripts/build-live-web.mjs` +
  `frontend/scripts/web-engine.js`): in-browser git worktree store persisted in
  IndexedDB, real LCS unified diff generator, real sandboxed Web Worker check
  evaluator, in-inspector branch file editor, optional BYOK OpenAI-compatible
  agent (`sessionStorage` only), and local `fleet-rs` connector.

## 0.3.0 - 2026-11-21

- Parallel Coding-Agent Mission Control Board built on the House Frontend system
  (Square UI hairline surfaces, warm light default + full dark parity, self-hosted
  Geist and Geist Mono fonts, and full coverage across all eight House libraries
  documented in `JOB.md`, `ROLE-COVERAGE.md`, and `ALIVE.md`).
- Top Command Bar: `Fleet` wordmark and version chip, `/` search filter with `Kbd`
  hint across tasks/projects/branches, `Needs you` Inbox popover with live count
  and 1-click session jump/Retry, `New session` `MorphingDialog` (`Cmd/Ctrl+Enter`
  dispatch), `Engines and settings` Vaul right sheet, and Light/Dark
  `SegmentedControl` (`id="themeBtn"`).
- Scan Strip & Latest Verified Receipt hero: four `SlidingNumber` counters
  (`Sessions`, `Needs you`, `Working`, `Verified`), Kibo UI running `AvatarStack`,
  Tremor 32-session outcome `Tracker`, and a measured Latest Verified Receipt hero
  card (`+added` / `-removed` diff stats in Geist Mono, `verified by: <check>`,
  and 1-click `Inspect receipt`, `View diff`, and `Merge`).
- Three-Lane Board (`Needs you` · `Working` · `Done`) & Split-Pane Session
  Inspector: Motion `layoutId` transitions between lanes, `BorderTrail` and
  `TextShimmer` strictly on running sessions with live streaming transcript tails,
  Cult UI `Expandable` disclosures for check and merge diagnostics (zero native
  `<details>`), roving `ArrowLeft`/`ArrowRight`/`Home`/`End` tabs across
  `Transcript` · `Diff` (syntax-tinted `+/-` lines in Geist Mono) · `Receipt`,
  focus restoration on open/close, and live per-session `Steer` composer.
- Desktop launch UX and Update strip hardening: platform data-folder default
  (`XDG_DATA_HOME`/macOS Application Support), automatic port fallback when the
  default port is busy, loopback-only `Update now` and manual update checks,
  plain-language update error mapping, and deterministic focus handoff across
  `Update now`, `Restart now`, `Dismiss`, and `Show update`.
- Release workflow (`release.yml`): targets Unix platforms (`x86_64-unknown-linux-gnu`,
  `aarch64-unknown-linux-gnu`, `aarch64-apple-darwin`) matching Fleet's Unix
  process-group supervision model.

## 0.2.0 - 2026-11-19

- Board redesign: Needs you, Working and Done groups; a detail panel with
  Transcript, Diff and Receipt tabs; an honest banner for a needs-you session
  whose check passed.
- Per-session record files (`logs/<id>.record.json`): a lost `sessions.json` is
  rebuilt from them, so done stays done and merged stays merged. Rebuilt sessions
  say so.
- Retry hands the agent the failure: the task, the failing check's command and the
  tail of its output. A worktree that lost its link to the repo is re-attached from
  its branch, and two retries at once run once.
- Dismiss: a needs-you session that cannot succeed can be archived off the board
  and the inbox; its log stays on disk.
- `merge_target` (where Merge lands) and `merge_error` (the last refused merge,
  with git's own text in `detail`) in the session JSON; refusals are plain sentences.
- Checks: a failed check's reason names its exit code and output; a blank check
  falls back to the policy default; `check_ran` and `check_exit` are reported.
- Host rule: only loopback names, plus `FLEET_ALLOWED_HOSTS`; header limits (100
  headers, 32 KiB); JSON-only POST.
- `fleet-rs --version`, `GET /api/version`, and self-update from GitHub releases
  (`FLEET_UPDATE_MODE`). Restart is refused while any session is queued, working or
  checking.

## 0.1.0 - 2026-11-17

- First build: sessions run in their own git worktrees, a check decides done,
  merge with safety checks, persistence and restart recovery, steering and stop,
  successor chains, and the board.
