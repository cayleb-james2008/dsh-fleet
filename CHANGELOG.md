# Changelog

Each release is tagged `vMAJOR.MINOR.PATCH` and published on GitHub Releases with
binaries and a `SHA256SUMS` file. The running app shows its version and can update
itself from the newest release (see README, "Versions and updates").

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
  dispatch), `Engines and Rune policy` Vaul right sheet, and Light/Dark
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
