# Fleet front end: design (v0.3.0 Mission Control Board)

Status: v0.3.0 complete. Built on the House Frontend system (`JOB.md`, `ROLE-COVERAGE.md`, `ALIVE.md`), self-hosted **Geist** and **Geist Mono** (`frontend/src/fonts/*.woff2`), light default + full dark parity (`frontend/src/theme.css`).

## The job

Hand out coding tasks to CLI agents (`opencode`, `claude`, `codex`) that work in parallel, each in its own git worktree. Every task comes back verified (its check command passed in a pristine checkout) or lands in **Needs you** with the exact failure reason. Nothing is babysat, and nothing calls itself done without its receipt.

Questions the first screen answers (`data-answers` / `data-answers-via` in the DOM, verified at `1440x900` and `390x844`):
1. **What needs me now, and why did it stop?** — Needs you counter (`data-answers="1"`) and the `Needs you` lane (`data-answers="1"`).
2. **What agents are running or verifying checks right now?** — Working counter + running `AvatarStack` (`data-answers="2"`) and the `Working` lane (`data-answers="2"`).
3. **What came back verified done, and what receipt and diff did it produce?** — `Latest verified receipt` hero card (`data-answers="3"`) and the `Done` lane (`data-answers="3"`).
4. **How do I hand out the next task in its own git worktree?** — `New session` `MorphingDialog` trigger in the Top Command Bar (`>=768px`) and mobile action bar (`<768px`, `data-answers-via="4"`).

## Region map

- **Top Command Bar** (sticky): `Fleet` wordmark, version chip (`v0.3.0`), desktop `Check for updates` icon button (loopback-only), `fixture demo` / `fixture · test mode` honesty badge, `Show update` button when an available update is dismissed, `/` search field (`InputGroup` + `Kbd` `/`) filtering by task/project/branch, `Needs you` Inbox `Popover` (live `/api/inbox` count, `View session`, `Retry`, `Go to Needs you`), `New session` `MorphingDialog` (`Cmd/Ctrl+Enter` dispatch), `Engines and settings` Vaul right-sheet trigger, and Light/Dark `SegmentedControl` (`id="themeBtn"`, `aria-label="Light"` / `"Dark"`).
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
- `cargo test`: 52 passed (43 unit + 9 CLI)
- `bash .loop/verify`: 23/23 passed (including `verify2.sh`, `ui.sh`, `theme.sh`, `inbox.sh`, `proof.sh`)
- `cd frontend && npm run check:ui`: `gate` 34/34, `replay` 6/6
- `hallmark/scripts/sloplint.mjs --scope app --render`: 0 FAIL, 0 REFLEX
- `ultra-design/kit/probe.mjs`: PASS across `1440, 1100, 900, 768` Light & Dark
- `ultra-design/kit/replay.mjs`: PASS across malformed 200 + unreachable sweep + 6 worst-case scenarios at `1440` and `390`
