# Fleet front end: design (v0.8.0 Mission Control Board)

Status: v0.8.0 complete. Built on the House Frontend system (`JOB.md`, `ROLE-COVERAGE.md`, `ALIVE.md`), self-hosted **Geist** and **Geist Mono** (`frontend/src/fonts/*.woff2`), light default + full dark parity (`frontend/src/theme.css`).

## What v0.8.0 adds

- **Full `Fleet` Rebrand**: clean `Fleet` branding across all UI headers, modals, release URLs (`cayleb-james2008/fleet`), local Fleet connector copy, and standalone live web bundle (`shared-live-web/fleet/index.html`), with zero legacy names or internal jargon (`#155`, `#67` Settings-only Light/Dark preserved).

## What v0.7.0 added

- **Interactive Multi-Wave DAG Dependency Visualizer** (`frontend/src/dag-graph.tsx`): `Board` / `DAG Graph` `SegmentedControl` toggle (+ `g` shortcut & `Cmd+K` command), topological wave columns, status rails, SVG directed cubic Bezier dependency arrows, and click-node -> Session Inspector navigation.
- **PR Preview & Confirmation-Gated Create PR Modal** (`frontend/src/pr-modal.tsx`): structured PR title & copyable Markdown body (`GET /api/sessions/:id/pr-preview`), draft toggle, explicit confirmation checkbox gating `POST /api/sessions/:id/pr` (`confirm: true`), mounted outside Vaul `<Drawer.Content>` for reliable `390x844` mobile taps.
- **Worktrees Inspector & Budget Guardrails** (`frontend/src/settings-policy.tsx`, `frontend/src/board.tsx`): live `Daily budget` chip in `BoardMetricsStrip`, `Budget guardrails` panel with GPU-composited `scaleX` progress bar inside Settings, and per-worktree `Worktrees inspector` (`GET/DELETE /api/repos/worktrees`) showing main/active/orphan/dirty status with inline-confirmed targeted pruning.
- **Standalone Browser Bundle** (`shared-live-web/fleet/index.html`): full browser-only parity for DAG Graph, PR Preview + dry-run confirmation, Worktrees Inspector with orphan prune, and Budget Guardrails with zero external requests.

## What v0.6.0 added

- **Board Telemetry Strip** (`GET /api/metrics`): compact live strip showing First-pass %, Auto-healed count + effective pass rate, Median check duration, Active/Max parallel slots (+ queued/blocked), and an interactive `By repo (N)` popover breakdown.
- **Autonomous Auto-Heal Badges & Timeline** (`auto_heal_attempt` SSE): live `Healed N/M` / `Auto-healing N/M` badges across session cards, hero verified receipt, and inspector header, plus an expandable `Auto-heal timeline` inside the Receipt tab showing each attempt's failing step, stderr tail, elapsed time, and diagnostic steer prompt (zero native `<details>`).
- **Reusable Playbooks & Auto-Heal Budget** (`GET/POST/DELETE /api/templates`): Playbook selector bar with inline `Save as playbook` and custom delete inside the Composer, `auto_steer_budget` input, and a `Playbooks` section in the `Cmd+K` Command Palette.
- **Standalone Browser Bundle v0.6.0** (`shared-live-web/fleet/index.html`): full browser-only parity including in-browser autonomous Auto-Heal loop with identical-error guard, live metrics, and IndexedDB-backed Playbook Templates CRUD.

## What v0.5.0 added

- Live SSE stream (`EventSource('/api/events/stream')`) with automatic backoff polling fallback and header status indicator.
- Virtualized searchable transcript viewer (`frontend/src/transcript.tsx`) smoothly handling 50,000+ lines (<150 mounted DOM rows), match navigation, and 1-click **Jump to first error**.
- Unified & Side-by-Side Split Diff viewer (`frontend/src/diff.tsx`) with non-destructive pre-merge dry-run conflict badge (`GET /api/sessions/:id/merge-check`), merge strategy selector (`Merge commit` · `Squash` · `Fast-forward`), and **Download `.patch`** (`GET /api/sessions/:id/patch`).
- Ordered multi-step timed receipt timeline (`check_steps`) and file-scope guardrail badges (`allowed_globs` / `forbidden_globs` / `guardrail_violations`).
- Single, Batch, and Multi-Repo Matrix DAG Composer (`frontend/src/composer.tsx`) with `depends_on`, multi-step checks, and file-scope rules.
- Multi-select bulk controls on the board (Bulk Retry, Bulk Merge, Bulk Stop/Dismiss), live concurrency slot capacity display, and global `Cmd+K` / `Ctrl+K` Command Palette (`frontend/src/palette.tsx`).
- Policy Tester (`POST /api/policies/test`), concurrency cap slider (`max_parallel_agents`), and **Prune stale worktrees** inside the `Engines and settings` Vaul drawer (`#settings`), keeping Light/Dark Appearance strictly inside Settings.

## The job

Hand out coding tasks to CLI agents (`opencode`, `claude`, `codex`) that work in parallel, each in its own git worktree. Every task comes back verified (its check command passed in a pristine checkout) or lands in **Needs you** with the exact failure reason. Nothing is babysat, and nothing calls itself done without its receipt.

Questions the first screen answers (`data-answers` / `data-answers-via` in the DOM, verified at `1440x900` and `390x844`):
1. **What needs me now, and why did it stop?** — Needs you counter (`data-answers="1"`) and the `Needs you` lane (`data-answers="1"`).
2. **What agents are running or verifying checks right now?** — Working counter + running `AvatarStack` (`data-answers="2"`) and the `Working` lane (`data-answers="2"`).
3. **What came back verified done, and what receipt and diff did it produce?** — `Latest verified receipt` hero card (`data-answers="3"`) and the `Done` lane (`data-answers="3"`).
4. **How do I hand out the next task in its own git worktree?** — `New session` `MorphingDialog` trigger in the Top Command Bar (`>=768px`) and mobile action bar (`<768px`, `data-answers-via="4"`).

## Region map

- **Top Command Bar** (sticky): `Fleet` wordmark, version chip (`v0.8.0`), desktop `Check for updates` icon button (loopback-only), `Show update` button when an available update is dismissed, `/` search field (`InputGroup` + `Kbd` `/`) filtering by task/project/branch, `Needs you` Inbox `Popover` (live `/api/inbox` count, `View session`, `Retry`, `Go to Needs you`), `New session` `MorphingDialog` (`GET /api/repos` repository picker, Playbooks bar, auto-derived project basename, `Cmd/Ctrl+Enter` dispatch), and `Engines and settings` Vaul right-sheet trigger (`#settings-open`).
- **Engines and Settings Sheet (`#settings`)**: Light/Dark `SegmentedControl` (`id="themeBtn"`, `aria-label="Light"` / `"Dark"`) under **Appearance** (kept out of the top bar), policy rules summary, detected CLI engines on PATH, live default-engine and per-engine model routing (`GET/POST /api/config`), and updates controls (plus Browser Worktree Engine / Local `Fleet` / optional `sessionStorage` BYOK controls in the standalone web bundle).
- **Update Strip** (shown when an update is available, staged, or a manual check fails): loopback-only `Update now` with `"Update now downloads it, checks it, and replaces this app. Restart to start using it."`, developer-copy / non-loopback plain explanation, Cult UI `Expandable` release notes and raw failure diagnostics (zero native `<details>`), and deterministic focus transitions (`busy` -> status line, `staged` -> `Restart now`, `Dismiss` -> `Show update`).
- **Scan Strip**: four `SlidingNumber` counters (`Sessions`, `Needs you`, `Working`, `Verified` — skeleton placeholders before initial fetch so unreachable never flashes fake zeros), Kibo UI `AvatarStack` for concurrent running agents, and Tremor 32-session outcome `Tracker`.
- **Latest Verified Receipt Hero**: Fleet's defining signature object — measured corner ticks, sage `Latest verified receipt` `Pill`, project & branch chips, task headline in Geist 500, check output receipt line, Geist Mono diff stats (`files`, `+added`, `−removed`), `verified by: <check command>`, and 1-click `Inspect receipt`, `View diff`, and `Merge` (with inline safety confirmation).
- **Three-Lane Board (`Needs you` · `Working` · `Done`)**: hairline-separated columns with Kibo UI `Pill` counts, lane-shaped loading skeletons on initial load, Motion FLIP `layoutId` transitions between lanes when session state changes, and `BorderTrail` + `TextShimmer` + live 2-line transcript tail strictly on running sessions.
- **Split-Pane Session Inspector**: right column (`>=1100px`, `460px–500px`) and Vaul bottom sheet (`<1100px`). Moves focus to the session heading on open and restores focus to the card opener on close/Escape. Features Cult UI `Expandable` disclosures for check output and refused-merge diagnostics, roving `ArrowLeft`/`ArrowRight`/`Home`/`End` tabs with Motion Primitives `AnimatedBackground` glide across `Transcript` · `Diff` (syntax-tinted `+/-` unified diff lines in Geist Mono) · `Receipt`, confirmation gates on Merge/Stop/Dismiss, and per-session `sessionStorage` `Steer` composer.

## Comparison gate (House Frontend step 4)

Matches none of: Square UI preview (no left icon rail + project sidebar + user card), starter bench (`src/bench/`), Open-Ro (left chat rail + studio stage + right Explorer shelf), Ergon (left rail + Chat/Today/Work Graph tabs + field-book paper), or OpenBell (financial report card + slot table). Derived strictly from Fleet's worktree-and-receipt supervision job.

## Library coverage (8 / 8 House Frontend libraries)

Full mapping in `../ROLE-COVERAGE.md` and motion preset table in `../ALIVE.md`:
- **Motion Primitives**: `SlidingNumber`, `AnimatedBackground`, `MorphingDialog`, `BorderTrail`, `TextShimmer`
- **COSS UI**: `Button`, `InputGroup`, `Kbd`, `SegmentedControl`, `Badge`, `Avatar`, `Tooltip`, `Textarea`
- **Cult UI**: `Expandable`
- **Kibo UI**: `Pill`, `AvatarStack`
- **Tremor**: `Tracker`
- **Vaul**: `Drawer` (right sheet + mobile bottom inspector)
- **Sonner**: `Toaster`, `toast`
- **Motion**: `motion.article` FLIP `layoutId` lane transitions + `<MotionConfig reducedMotion="user">`

## Verification gates

- `cargo clippy --all-targets -- -D warnings`: 0 warnings
- `cargo test`: 113 passed (23 lib + 63 bin + 9 CLI + 11 v0.5.0 engine + 4 v0.6.0 engine + 3 v0.7.0 engine)
- `bash .loop/verify`: 23/23 passed (including `verify2.sh`, `engines.sh`, `ui.sh`, `theme.sh`, `inbox.sh`, `proof.sh`)
- `cd frontend && npm run check:ui -- --lints`: `gate` 56/56, `replay` 6/6, Hallmark `sloplint` 0 FAIL / 0 REFLEX
- `cd frontend && node e2e/test-live-web.mjs`: 28/28 passed (DAG Graph, PR Preview modal, Worktrees Inspector orphan prune, Budget Guardrails, Auto-Heal timeline, Playbooks CRUD, Batch DAG, 0 external requests, 0 console errors)
- Real live-agent E2E (real `opencode` CLI, zero `FLEET_AGENT` shim, local bare git remotes): multi-wave DAG Graph visualization, PR preview Markdown + confirmation-gated `dry_run` without touching GitHub, Worktree Inspector orphan cleanup + main/traversal 403 refusals, and atomic HTTP `429` daily budget enforcement
