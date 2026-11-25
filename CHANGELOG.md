# Changelog

Each release is tagged `vMAJOR.MINOR.PATCH` and published on GitHub Releases as a
ready-to-install Antigravity plugin bundle (`tar.gz` + `zip`) with `SHA256SUMS`.

## 1.8.0 - 2026-11-25

- **Inline Worktree Diff Peek & CWE-22/CWE-59 Confinement (`WorktreesView.tsx`, `sidecars/fleet_pane/{git_probe.mjs,main.mjs}`, `web-engine.js`):** Added `GET /api/worktrees/diff?root=...&worktree=...&file=...` returning bounded (`<= 8 KB`) `git diff HEAD` hunks and untracked text previews strictly confined to validated repository worktrees via `realpathSync` (rejecting `..` traversal, out-of-repo worktrees, and escaping symlinks), wired to an expandable **Diff peek** toggle beside **Open file** inside the `380px` sidebar.
- **Low-RSS Runtime & `<94 KiB` Gzip Diet (`frontend/src/{icons.tsx,ui.tsx,theme.css}`, `vite.config.ts`, `sidecars/fleet_pane/{main.mjs,swarm_store.mjs,sidecar.json}`):** Consolidated icons onto lightweight shared SVG path primitives (`322,939 B` raw / `93.1 KiB` gz), extracted shared `InlineComposer`, `MediaPathChips`, `ActivityPeek`, and `copyText` UI helpers, replaced `node:crypto` OpenSSL ETags with native `zlib.crc32`, fixed quadratic `buf.indexOf` chunk scans in `swarm_store.mjs` with bounded `buf.subarray(start, end)` (`max_ms` `15.38 ms`, `44.3 ms` boot, `2,766 req/s`), and tuned `sidecar.json` (`72.82 MB` `VmHWM`).

## 1.7.0 - 2026-11-25

- **Board Quick-Filter Chips & 1-Click Wave Digest (`frontend/src/components/BoardView.tsx`, `ui.tsx`, `App.tsx`):** Added compact Board quick-filter pills (`All` / `Needs reply` / `[done]` / `[blocked]`, cycled via `f` hotkey), a 1-click **Wave digest** button generating clean Markdown summaries of pinned `#seq`s, active/waiting/stalled worker durations, and `~/`-masked dirty worktree files, and `~/` sanitization on pinned board post previews.
- **Pre-Gzipped Sidecar Asset & Sub-`75 MB` V8 Peak RSS (`frontend/vite.config.ts`, `sidecars/fleet_pane/{main.mjs,swarm_store.mjs,sidecar.json}`):** Replaced `cmdk` with a zero-dependency accessible React palette (`dist/index.html` `<345 KB` raw / `<100 KB` gzip), emitted build-time `dist/index.html.gz` read directly by `main.mjs` (`0` startup deflate overhead while preserving `ETag`/`304` + `Vary: Accept-Encoding`), tightened transcript tail retention to `16 KB`, and applied V8 tier/heap bounds (`--jitless` + `--max-old-space-size=32` in `sidecar.json` / runtime tier guards in `main.mjs`) dropping 2k/50k Peak `VmHWM` below `75 MB`.

## 1.6.0 - 2026-11-25

- **Peak V8 RSS (`<90 MB`) & Wire Diet (`<365 KB` raw / `<108 KB` gzip):** Added zero-string-allocation `Buffer` transcript scanning in `swarm_store.mjs`, eliminated duplicate cold-boot snapshot generation between `listSwarms` and `/api/swarm`, enabled V8 `--optimize-for-size` in `main.mjs` & `sidecar.json`, and aliased unused `@radix-ui/react-dialog` out of `cmdk` to shrink `dist/index.html` to `~350 KB` raw / `~104 KB` gzip.
- **1-Click `#seq` Quote-Reply, `?` Cheatsheet & Clean Screenshot Chips (`frontend/src/`):** Added clickable `#seq` / **Reply** inline quote-reply (`Re #<seq>:`) on Board posts, `r` reply shortcut on Triage, `?` keyboard shortcut cheatsheet modal, and pretty `Screenshot:` media caption chips + `~/` worktree paths (never rendering raw `/home/...` paths in card excerpts).

## 1.5.0 - 2026-11-25

- **Worker Duration Pills & Inline Quick-Action Nudge Bar (`frontend/src/components/{TriageView,RosterView}.tsx`, `ui.tsx`, `sidecars/fleet_pane/main.mjs`)**: added live elapsed state badges (`Working 1m`, `Waiting 3m`, `stalled` escalation) and 1-click **Ask status / Wrap up** quick-action chips populating confirmation-gated inline nudge composers, alongside control-character validation on `POST /api/nudge`.
- **Windowed Board Feed & Bundle/RSS Diet (`frontend/src/components/BoardView.tsx`, `ui.tsx`, `theme.css`, `sidecars/fleet_pane/swarm_store.mjs`)**: windowed long Board feeds to the newest 80 posts with automatic expansion on `#seq` jumps and **Show older posts**, replaced `sonner` with a lightweight theme-synced `FleetToaster` + trimmed unused CSS tokens to drop sidecar `dist/index.html` below `380 KB` raw (`~112 KB` gzip), and moved `swarm_store.mjs` to in-place board transformation + zero-retention compact `tailSteps` rings (`<95 MB` Peak `VmHWM`).

## 1.4.0 - 2026-11-25

- **Keyboard-First Sidebar Triage (`frontend/src/App.tsx`, `frontend/src/components/TriageView.tsx`)**: added keyboard navigation across Needs-You items (`j`/`k` move focus, `o`/`Enter` open worker chat, `p` pin/unpin `#seq`, `1`–`5` jump tabs) while preserving input focus safety and compact shortcut hints.
- **Worktree Changed-File Links (`sidecars/fleet_pane/git_probe.mjs`, `frontend/src/components/WorktreesView.tsx`)**: expanded `git status --porcelain=v1 -z` inspection with strict path/symlink confinement inside each worktree root and 1-click **Open file** (`toggleAuxPane`) rows per modified/untracked/staged file.
- **Bundle & Peak RSS Diet (`frontend/src/`, `sidecars/fleet_pane/{swarm_store.mjs,main.mjs}`)**: removed `@radix-ui/react-dialog` overhead around `cmdk` and replaced `motion/react` runtime with zero-dep GPU `Element.animate` (`src/motion.ts`) to trim the sidecar bundle below `410 KB` raw (`~120 KB` gzip), plus bounded LRU caches and fixed 32-slot ring buffering in `swarm_store.mjs` for lower V8 Peak `VmHWM`.

## 1.3.0 - 2026-11-25

- **Live SSE Push Stream (`/api/swarm/stream`, `sidecars/fleet_pane/main.mjs`, `frontend/src/App.tsx`)**: added bounded `text/event-stream` endpoint pushing instant `etag` deltas via `computeSwarmFingerprint` (64-client cap, shared 150ms watcher active only while subscribers are connected, 15s keepalive, clean disconnect teardown) with automatic `EventSource` subscription in standalone mode and graceful polling fallback inside `SidecarApp`, verified under 5/5 concurrent SSE client survival.
- **Pinned Board Posts (`Pin #seq`) & `380px` Sidebar Micro-Polish (`frontend/src/components/{BoardView,TriageView}.tsx`, `App.tsx`, `install.sh`)**: added per-swarm persistent `Pin #seq` toggles surfacing pinned decisions/blockers at the top of both Board and Triage views, aligned `#seq` jump pills cleanly on Triage cards, balanced horizontal padding on the `380px` sidebar `tok` pill, and ensured `chmod 755` on the atomic install staging root in `install.sh`.

## 1.2.0 - 2026-11-25

- **Zero-Friction Triage Presets, Aux-Pane File Actions & Context Pressure (`frontend/src/`, `skills/fleet/SKILL.md`)**: added confirmation-gated 1-click **Unstick / Resume / Ask status** presets on `[blocked]` / `quota` / `error` / stalled Triage cards with exact `#seq` context, 1-click **Open file** (`window.sidecar.ui.toggleAuxPane({ tabType: "fileView", uri })`) across `Screenshot:` reel items and board/triage file paths, and per-worker **Context & Token Pressure** saturation badges/bars (`% ctx`, `High ctx`, `Quota paused`, `Stalled`) in `RosterView`.
- **Zero-Alloc Transcript Tail & Low-RSS Store (`sidecars/fleet_pane/{swarm_store.mjs,main.mjs,sidecar.json}`)**: replaced 50k-line full `JSON.parse` allocation with direct scalar extraction across transcript history (parsing JSON objects only for the newest 32-line tail window), stopped retaining parsed 2,000-message JS graphs in heap caches once `etag`-keyed serialized/gzipped `Buffer`s are built (computing `raw` lazily only on `?raw=1`), added 250ms stat-guarded payload caching + fast query slicing in `main.mjs`, and bounded V8 old-space to `64 MB` in `sidecar.json`.
- **Typography & Sloplint Cleanliness (`frontend/src/index.css`)**: added `text-wrap: pretty` on prose paragraphs and verified `0 FAIL / 0 REFLEX / 0 WARN` (`sloplint --scope app --render`), `30/30` Playwright gate, `6/6` replay, and `11/11` offline `live-web` checks.

## 1.1.0 - 2026-11-25

- **340px–380px Sidebar Tab & House-Frontend Craft (`frontend/src/`)**: sized and spaced all 5 tabs (`Triage`, `Board`, `Roster`, `Graph`, `Git`) to fit `340px` and `380px` sidebars with zero text clipping or horizontal scroll; switched section headings (`Needs you`, `Swarm plan`, `Roster`, `@Mention graph`, `Git worktrees`) to crisp sentence-case; replaced middle-dot metadata separators with spaced pills/badges; removed nested card-in-card borders inside Swarm plan and empty-state presets; and humanized workflow statuses (`In progress`, `Done`, `Running`).
- **Worker Activity Peek & Swarm Digest (`sidecars/fleet_pane/swarm_store.mjs`, `frontend/src/components/{TriageView,RosterView}.tsx`, `ui.tsx`, `App.tsx`, `CommandPalette.tsx`)**: added inline **Activity Peek** drawers revealing each worker's newest thinking heading, last 5 tool calls, and `input` / `cache` / `output` token breakdown before opening chat, plus 1-click **Copy swarm digest** (`CommandPalette` + header action) generating a clean Markdown swarm summary.
- **Incremental Byte-Offset JSONL Tailing (`sidecars/fleet_pane/swarm_store.mjs`)**: replaced full-file reads on `board.jsonl` and `transcript.jsonl` with 128 KB chunked incremental byte-offset tailing (`openSync` / `readSync`) and inode/truncation reset, reducing Peak RSS (`VmHWM`) and boosting concurrent poll throughput.

## 1.0.0 - 2026-11-25

- **Antigravity-Native Sidecar Plugin (`plugin.json`, `sidecars/fleet_pane/`, `skills/fleet/SKILL.md`, `rules/AGENTS.md`, `install.sh`)**: pivoted Fleet from an external-CLI standalone Rust server to a first-class Antigravity `SIDECAR_UI_ENTRYPOINT_AUX_PANE` plugin integrating `SidecarApp` + `/preload.js` host theme/workspace/conversation bridges, `/fleet` coordinator skill, standing swarm rules, and atomic `./install.sh` (`~/.gemini/config/plugins/fleet/`).
- **Swarm Store, Transcript Telemetry & Hardened Loopback Server (`sidecars/fleet_pane/`)**: added zero-external-dep Node ESM sidecar backend reading `<appData>/brain/<conv>/.system_generated/{swarm,logs}/` read-only with real per-worker token/cache/step aggregation, `plan.json` workstreams & verification gates, `Needs-You` triage computation, cached `git worktree` inspection (`GET /api/worktrees`), Multi-Swarm Switcher (`GET /api/swarms`), CWE-22/CWE-59 confined screenshot serving (`GET /api/frame`), pre-compressed gzip + strong SHA-256 `ETag`/`304` + `Vary` + CSP headers, loopback `Host`/`Origin` `403` guards, prompt `413` payload limits, and confirmation-gated `POST /api/nudge`.
- **Sidebar-First Aux Pane Command Center (`frontend/`, `dist-live-web/index.html`)**: rebuilt UI for `340px–520px` Antigravity sidebar width (scaling smoothly to `1440px`) in House Frontend v2.0 (`data-world="codex"`, Geist + Geist Mono, live host `theme-change` luminance sync + Settings-only Light/Dark toggle `#67`), delivering Needs-You Triage + `plan.json` + Screenshot Reel, `#seq`-linked Board feed, shimmering Roster + token telemetry, interactive `@mention` Graph + replay scrubber, Workspace Git Worktrees, `cmdk` Command Palette, empty-state `/fleet` presets, `<500 KB` raw / `<160 KB` gzip sidecar bundle, and `0`-network-call offline `dist-live-web/index.html` simulator.

## 0.12.0 - 2026-11-25

- **Dynamic Huffman Gzip & Peak RSS Diet (`src/http_assets.rs`, `src/main.rs`)**: upgraded pure-Rust DEFLATE in `src/http_assets.rs` from fixed Huffman to Package-Merge length-limited Dynamic Huffman (`BTYPE=10`), compressing embedded HTML down to `<360 KB` gzip; replaced 2,000-session `Value` DOM batch allocation with streamed per-session `serde_json::to_writer` into single `Arc<Vec<u8>>` HTTP buffers and dropped duplicate `String` caches.
- **Smart Cross-CLI Router & Failure Memory (`src/router.rs`, `src/autoheal.rs`, `src/main.rs`, `frontend/src/board.tsx`)**: extracted cohesive `src/router.rs` scoring installed CLIs from live persisted pass rates, first-pass rate, and median wall time (`GET /api/router/recommend` + Goal-to-DAG auto-routing) alongside atomic `<data_dir>/lessons.json` (`LessonStore`, `GET /api/lessons`) injecting verified past repo repairs into attempt-1 auto-heal prompts.
- **Large Diff Windowing, Wave Telemetry & Bundle Diet (`frontend/src/diff.tsx`, `frontend/src/dag-graph.tsx`, `frontend/src/main.tsx`, `frontend/scripts/web-engine.js`)**: added windowed file/line rendering in `DiffViewer` (auto-collapsing 12+ file diffs, 250-line file windows with instant expand), live wave pass-rate & average-duration telemetry in DAG Graph, `domAnimation` bundle trimming, and `0.12.0` parity in `web-engine.js`.

## 0.11.0 - 2026-11-25

- **Cold Boot Latency (`src/main.rs`)**: replaced 3 sequential `which`/`where` child spawns in `detect_agents` with pure-Rust `$PATH` resolution, replaced intermediate `serde_json::Value` AST double-parsing in `load_persisted_core` with single-pass `PersistedStore` deserialization, and moved settled `.log` hydration + update checks off the pre-bind boot path (`<30 ms` cold boot at 2k sessions while preserving `6,250+ req/s`).
- **Wave Preflight & Batch Wave PR (`src/main.rs`, `frontend/src/pr-modal.tsx`, `frontend/src/App.tsx`, `frontend/src/api.ts`)**: added `WaveShipModal` featuring non-destructive `git merge-tree` per-session conflict/clean preview, strategy switching (`merge` / `squash` / `ff`), 1-click **Merge clean**, and confirmation-gated `POST /api/sessions/batch-pr` (`confirm: true` enforcement + `dry_run` preview) with full parity in `frontend/scripts/web-engine.js`.
- **Smart Auto-Heal Failure Classifier (`src/autoheal.rs`, `src/main.rs`, `frontend/src/detail.tsx`)**: added deterministic `classify_failure` / `classify_heal_attempt` (`CompileError`, `TestAssertion`, `LintOrFormat`, `ScopeGuardrail`, `Timeout`, `TransientFlake`), injected failure category + repair strategy into autonomous retry prompts, and surfaced live failure-class badges in the Auto-Heal timeline and Needs You banner.

## 0.10.0 - 2026-11-25

- **Runtime Speed & Asset Compression (`Cargo.toml`, `src/http_assets.rs`, `src/main.rs`)**: added `[profile.release]` (`lto = "thin"`, `codegen-units = 1`, `strip = "symbols"`, `opt-level = 3`), pure-Rust RFC 1952 Gzip + strong SHA-256 `ETag` / `304 Not Modified` / `Vary: Accept-Encoding` + security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`), persistent 64-worker HTTP pool with `TCP_NODELAY`, buffered line parsing without per-byte `setsockopt` or `try_clone()`, zero-copy `Arc<Vec<u8>>` cached JSON responses, `.git/HEAD` fast-path for `merge_target`, single-flight repo discovery lock, and allocation-free transcript/session search.
- **Zero-Friction Shipping & Smart Auto-Heal (`src/autoheal.rs`, `src/main.rs`, `frontend/src/`)**: enriched auto-heal steering prompts with modified worktree files, bounded diff excerpts, and prior failed attempt summaries; added `POST /api/sessions/batch-merge` with non-destructive `git merge-tree` conflict preflight + 1-click **Merge verified wave** controls in the top toolbar, DAG Graph, and Command Palette; added instant keyboard triage shortcuts (`y` retry, `x` dismiss, `m` merge, `s` focus steer, `[` / `]` cycle Needs you, `1`–`4` status filters); surfaced live per-session run duration, timeout cap headroom, heal budget remaining, and daily budget headroom in the inspector and status bar.
- **Security & Web Engine Parity (`src/main.rs`, `src/worktrees.rs`, `frontend/scripts/web-engine.js`)**: added session ID path validation, `..` / NUL repository validation, CWE-59 symlink checks before worktree directory removal, strict ASCII-digit `Content-Length` parsing with prompt `413` while keeping the client write half open, and full v0.10.0 parity in `frontend/scripts/web-engine.js`.

## 0.9.0 - 2026-11-25

- Desktop-Workbench UI Overhaul (`frontend/src/App.tsx`, `board.tsx`, `detail.tsx`, `ui.tsx`, `theme.css`): replaced multi-band stacked header chrome and card-in-card Kanban layout with a slim 44px top bar, collapsible left Session Inbox rail, central workspace switching between streaming Transcript (50k+ virtualized), Unified/Split Diff review, Check Pipeline Receipt, Interactive DAG Graph, and a 1-click Goal-to-DAG launchpad, plus a collapsible right Worktree/Checks/PR Inspector and quiet bottom telemetry bar.
- Lean Zero-Bloat Frontend Bundle (`frontend/src/ui.tsx`, `frontend/package.json`): replaced external `motion`, `vaul`, `cmdk`, `@radix-ui/*`, `@base-ui/react`, and `sonner` wrappers with lean accessible primitives using Geist, Geist Mono, and `lucide-react` 1.5px stroke icons, cutting `assets/index.html` by >42% (~1.23 MB -> ~708 kB) under a crisp Neutral Slate + Electric Blue Light/Dark theme (`#67` Settings-only theme switch, `#155` zero `"Rune"` jargon).
- Goal-to-DAG Planner Endpoint & Browser Engine (`POST /api/plan` in `src/main.rs` and `frontend/scripts/web-engine.js`): decomposes plain goals into parallel or sequential DAG tasks with policy routing and file-scope guardrails.
- Backend Security & Memory Hardening (`src/main.rs`, `src/events.rs`, `src/checks.rs`): bounded HTTP worker pool (128 threads), bounded SSE subscriber slots (64), 256 KiB SSE replay-frame cap, bounded `run_bounded` / `run_shell_bounded` output buffers, strict IPv6/scheme `Host`/`Origin` checks, malformed `Content-Length` rejection, loopback enforcement on `/api/update/check`, and streaming `App::persist()` serialization.

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
