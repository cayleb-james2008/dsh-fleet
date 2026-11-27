# Changelog

Each release is tagged `vMAJOR.MINOR.PATCH` and published on GitHub Releases as an
Antigravity plugin archive (`tar.gz` and `zip`) with `SHA256SUMS`.

## 1.31.0 - 2026-11-26

- Hardened JSON recovery, portfolio caching, git probing, and HTTP confinement in `sidecars/fleet_pane/{swarm_store,git_probe,server_core,main}.mjs`: stripped BOMs on `fleet_ops.json` and `fleet_state.json`, bounded fd reads with `O_NOFOLLOW` and `fstatSync` size caps, preserved valid sibling ops and checkpoints when skipping corrupt entries, serialized writes with unique temporary files and 64-entry retention caps, added signature-checked `portfolioCache` and `lstatSync` symlink exclusion in `scanSwarmIds` and `streamLinesIncremental`, bounded concurrent git probes (`GIT_CONCURRENCY = 4`), returned `504` on `SIGKILL` git timeouts, handled unborn repositories, detached HEADs, missing branches, and Unicode paths (`core.quotepath=false`, `GIT_OPTIONAL_LOCKS=0`), rejected symlinked `.git` directories, and enforced strict loopback `Host`, `Origin`, and path-traversal `400`/`403` checks.
- Hardened button borders, RPC timeouts, and error recovery in `frontend/src/{index.css,ui.tsx,sidecar.ts,App.tsx}`, `frontend/src/components/{WorktreesView,TriageView}.tsx`, `frontend/vite.config.ts`, and `frontend/e2e/gate.mjs`: moved base component rules into `@layer components` with explicit variant borders so `Rebase` and worktree action buttons keep 1px borders across Light and Dark themes, added `fetchWithTimeout` and `AbortSignal` support across RPCs, added `Abort` and `Retry` controls on stalled or failed worktree actions and `Retry next 32 KiB` diff pagination, added inline `Retry` recovery for worktree, portfolio, and checkpoint errors, added same-tick locks on triage ack and checkpoint actions, and surfaced elapsed wait indicators on pending `OperatorOpsStrip` entries.
- Captured light and dark `docs/screenshots/hardening-c4h1-{light,dark}.png` (`380x844` sidebar) and `docs/screenshots/hardening-c4h1-1440-{light,dark}.png` (`1440x900`), bumped all manifests and runtime endpoints to `1.31.0`, and verified post-final-edit: `52/52` backend unit tests, `74/74` gate, `8/8` replay, `30/30` `test-live-web.mjs`, `SLOP 0/0/0` (`frontend/src` across 13 files and built `dist`, render tier ran), `446,260 B` raw (`435.8 KiB`) / `131,034 B` gz (`128.0 KiB`), `37.64 ms` boot, `118.38 MB` RSS, `1,765.1 req/s` (`17.3 ms` p95, `0/4,423` errors), `5/5` SSE, and `30/30` fuzz.

## 1.30.0 - 2026-11-26

- Added swarm worktree discovery, conflict hunk inspection, paginated diffs, and non-fast-forward landing in `sidecars/fleet_pane/{git_probe,server_core}.mjs`: extended `GET /api/worktrees?roots=...&conversationId=...` to resolve and deduplicate explicit and swarm-discovered repo roots via `resolveGitRepoRoot` (preventing duplicate cards when multiple member worktrees in the same repo are passed in `roots=`) and tag each unique worktree with `swarmOwner` (`member`, `status`, `workspaceMode`), extended `GET /api/worktrees/diff` with `mode=conflict` (`git merge-tree --write-tree` conflict hunks against `targetBranch`) and `<= 32 KiB` byte-offset pagination (`offset`, `nextOffset`, `hasMore`, `totalBytes`), and added confirmation-gated `squash_merge` and `merge_commit` actions (with optional sanitized `commitMessage`, automatic `409` conflict abort/reset returning `conflictFiles`, and cache invalidation) to `POST /api/worktrees/action`.
- Upgraded the Git worktrees UI and offline parity in `frontend/src/{types.ts,sidecar.ts,App.tsx}`, `frontend/src/components/WorktreesView.tsx`, and `frontend/scripts/web-engine.js`: added `swarmOwner` badges, `Squash Merge` and `Merge Commit` confirmation drawers with optional commit message input, `Conflict diff` expandable `mode=conflict` hunks with `Load next 32 KiB` pagination, automatic `diffByKey` cache clearing across refreshes, actions, and swarm switches, `Send conflict to @owner` recovery routing via `POST /api/control`, responsive `basis-60` badge wrapping at `380px`, and full E3 coverage in `frontend/e2e/{gate,test-live-web}.mjs`.
- Captured light and dark `docs/screenshots/worktree-conflicts-c4e3-{light,dark}.png` (`380x844` sidebar) and `docs/screenshots/worktree-conflicts-c4e3-1440-{light,dark}.png` (`1440x900`), bumped all manifests and runtime endpoints to `1.30.0`, and verified post-final-edit: `49/49` backend unit tests, `72/72` gate, `8/8` replay, `30/30` `test-live-web.mjs`, `SLOP 0/0/0` (`frontend/src` across 13 files and built `dist`, render tier ran), `435,483 B` raw (`425.3 KiB`) / `128,851 B` gz (`125.8 KiB`), `49.11 ms` boot, `115.29 MB` RSS, `1,776.7 req/s` (`12.95 ms` p95, `0/4,449` errors), `5/5` SSE, and `30/30` fuzz.

## 1.29.0 - 2026-11-26

- Added the multi-swarm portfolio index, persistent triage state, and swarm checkpoints in `sidecars/fleet_pane/{swarm_store,server_core,git_probe}.mjs`: introduced an `LRU=64` lightweight summary index and extended `SwarmSummary` (`costUsd`, `gateState`, `blockedCount`, `failureCount`, `repo`, `archived`, `topUrgent`), persisted `pinnedSeqs`, `ackedTriage`, `archived`, and `checkpoints` atomically in `brain/`-confined `fleet_state.json`, and exposed `GET /api/portfolio`, `POST /api/triage/ack`, `POST /api/pins`, `POST /api/swarm/archive`, `GET /api/checkpoints`, `POST /api/checkpoints` (capturing git worktree HEADs and clean flags), and `POST /api/checkpoints/restore` (`plan` CAS restore and `resume_prompt`) across both the standalone HTTP router and `runSidecarApp`.
- Added the Portfolio Command Drawer, persistent triage ack/snooze and server-synced pins, and Swarm Checkpoints UI in `frontend/src/{types.ts,sidecar.ts,ui.tsx,App.tsx}`, `frontend/src/components/{TriageView,CommandPalette}.tsx`, and `frontend/scripts/web-engine.js`: added the header Portfolio status pill and `PortfolioDrawer` (aggregated USD spend, urgent cross-swarm triage queue with `Jump to swarm`, gate state badges, and `Show archived` / `Archive` controls), wired `Ack`, `Snooze`, `Unack`, and `Show acked` across Triage and Command Palette, aligned `ackedTriage`, `ackUntilSeq`, and `cp.plan` diff/goal resolution with Zone A, added `SwarmCheckpointsSection` (`Create checkpoint`, `Compare vs live`, `Restore plan`, and `Resume prompt`), and synced `/api/pins` with local fallback.
- Captured light and dark `docs/screenshots/portfolio-checkpoints-c4e2-{light,dark}.png` (`380x844` sidebar) and `docs/screenshots/portfolio-checkpoints-c4e2-1440-{light,dark}.png` (`1440x900`), bumped all manifests and runtime endpoints to `1.29.0`, and verified post-final-edit: `47/47` backend unit tests, `72/72` gate, `8/8` replay, `30/30` `test-live-web.mjs`, `SLOP 0/0/0` (`frontend/src` across 13 files and built `dist`, render tier ran), `429,110 B` raw (`419.1 KiB`) / `127,122 B` gz (`124.1 KiB`), `52.36 ms` boot, `109.61 MB` RSS, `1,584.9 req/s` (`14.81 ms` p95, `0/3,975` errors), `5/5` SSE, and `30/30` fuzz.

## 1.28.0 - 2026-11-26

- Added the closed-loop operator command ledger and non-blocking async sidecar RPC dispatch in `sidecars/fleet_pane/{swarm_store,server_core}.mjs`, `rules/AGENTS.md`, and `skills/fleet/SKILL.md`: persisted a 64-entry atomic ring in `fleet_ops.json` (with CWE-22/CWE-59 symlink confinement, `[opId=...]` tagging across coordinator directives and nudges, automatic reconciliation against `board.jsonl`, `members.json`, `plan.json`, coordinator `ERROR_MESSAGE` steps, and 45s timeouts), exposed `ops` on `SwarmSnapshot` and `GET /api/swarm/delta`, added `GET /api/ops` and `POST /api/ops/action` (`retry`, `dismiss`, `mark_verified`) across both the standalone router and `runSidecarApp`, switched `POST /api/control` and `POST /api/nudge` to return `200` immediately with `opId`, `status: "dispatched"`, and `coordinatorState`, and guarded `switch_model` with HTTP `409 worker_not_waiting` unless `allowWorking: true` is confirmed.
- Added the Operator Command Queue UI, honest dispatch notifications, and working-worker Switch Model guard in `frontend/src/{types.ts,sidecar.ts,ui.tsx,App.tsx}`, `frontend/src/components/{BoardView,RosterView,TriageView}.tsx`, and `frontend/scripts/web-engine.js`: built `OperatorOpsStrip` in both Roster and Board (displaying pending spinners, verified `#seq` links, failure and timeout alerts, and `Retry`, `Mark Verified`, and `Dismiss` actions), unified `createdAt`/`updatedAt` timestamp parsing and string/object `coordinatorState` handling across live sidecar and `web-engine.js`, replaced optimistic "Switched" / "Sent" toasts with coordinator-aware `Dispatched <opId> (awaiting coordinator)` notices, and added the `allowWorking` confirmation checkbox plus `409 worker_not_waiting` recovery inside the Roster Switch Model drawer.
- Captured light and dark `docs/screenshots/ops-control-{light,dark}.png` (`380x844` sidebar) and `docs/screenshots/ops-control-1440-{light,dark}.png` (`1440x900`), bumped all manifests and runtime endpoints to `1.28.0`, and verified post-final-edit: `43/43` backend unit tests, `69/69` gate, `8/8` replay, `28/28` `test-live-web.mjs`, `SLOP 0/0/0` (`frontend/src` across 13 files and built `dist`, render tier ran), `404,506 B` raw (`395.0 KiB`) / `120,652 B` gz (`117.8 KiB`), `51.07 ms` boot, `115.6 MB` RSS, `1,767.1 req/s` (`12.94 ms` p95, `0/4,425` errors), `5/5` SSE, and `30/30` fuzz.

## 1.27.0 - 2026-11-26

- Hardened backend delta, transcript, and cost boundary paths in `sidecars/fleet_pane/{server_core,swarm_store}.mjs`: cleaned up aborted `GET /api/swarm/delta` waiters without hitting the waiter cap, rejected prototype-polluting query keys in `parseQueryFast`, handled corrupt partial tails, same-size rewrites, and truncate-then-grow resets in `buildSwarmDelta`, added intermediate symlink CWE-59 checks, tuned Bearer/token scrubbing, and UTF-8-safe byte slicing in `readTranscriptSteps`, and clamped negative, `NaN`, and `Infinity` token/cost values while resetting `byModel` on transcript shrink or rotation.
- Hardened Cycle 3 frontend sync, trace inspection, and cost bounds in `frontend/src/{App.tsx,sidecar.ts,ui.tsx}`, `frontend/src/components/{RosterView,TriageView}.tsx`, and `frontend/scripts/web-engine.js`: deduplicated out-of-order and replayed `seq` frames and capped 5xx backoff with abort cleanup on swarm switch, added epoch and `AbortController` guards for overlapping `ForensicTranscriptDrawer` loads plus Escape close and empty-trace states, and guarded 0-token, `NaN`/`Infinity`, negative savings, and unknown `contextLimit` states across `TokenBurnStrip`, `RosterView`, digests, and archives.
- Captured light and dark `docs/screenshots/hardening-c3-{light,dark}.png`, bumped all manifests and runtime endpoints to `1.27.0`, and verified post-final-edit: `40/40` backend unit tests, `67/67` gate, `8/8` replay, `26/26` `test-live-web.mjs`, `SLOP 0/0/0` (`frontend/src` and built `dist`), `394,513 B` raw (`385.3 KiB`) / `118,034 B` gz (`115.3 KiB`), `51.48 ms` boot, `105.63 MB` RSS, `1,240.8 req/s` (`22.24 ms` p95, `0/3,113` errors), `5/5` SSE, and `30/30` fuzz.

## 1.26.0 - 2026-11-26

- Added `getModelSpec` (covering Gemini 1M, Claude 200k and `[1m]`, OpenAI 128k/200k/400k, and safe unknown fallbacks) and incremental per-model `byModel` spend tracking across `switch_model` in `sidecars/fleet_pane/swarm_store.mjs`. Each `SwarmMember`, `SwarmSnapshot`, `SwarmSummary`, and `buildSwarmDelta` payload now carries `contextLimit`, `contextPct`, `cost` (`totalUsd`, `inputUsd`, `cacheReadUsd`, `outputUsd`, `cacheSavingsUsd`, `cacheHitPct`, `pricingKnown`), and `byModel`, while `computeBurnSummary` ranks workers by USD spend when pricing is known and weights cache-read savings.
- Updated `frontend/src/{types.ts,sidecar.ts,ui.tsx}`, `frontend/src/components/RosterView.tsx`, and `frontend/scripts/web-engine.js` with `mergeSwarmDelta` cost and context propagation, `fmtUsd` and `fmtContextCap` helpers, dynamic context saturation meters (`cap 1M` vs `cap 200k`), per-worker USD spend (`Unpriced` fallback) and cache-hit badges, and USD spend plus cache-savings summaries in `TokenBurnStrip`, `formatSwarmDigest`, and `formatSwarmArchive`.
- Captured light and dark `docs/screenshots/cost-economics-{light,dark}.png`, bumped all manifests and runtime endpoints to `1.26.0`, and verified post-final-edit: `36/36` backend unit tests, `64/64` gate, `8/8` replay, `25/25` `test-live-web.mjs`, `SLOP 0/0/0` (`frontend/src` and built `dist`), `389,954 B` raw (`380.8 KiB`) / `116,886 B` gz (`114.1 KiB`), `39.7 ms` boot, `108.97 MB` RSS, `1,739.0 req/s` (`12.93 ms` p95, `0/4,364` errors), `5/5` SSE, and `30/30` fuzz.

## 1.25.0 - 2026-11-26

- Added `readTranscriptSteps` in `sidecars/fleet_pane/swarm_store.mjs` and `GET /api/transcript` in `sidecars/fleet_pane/server_core.mjs` (both the standalone router and `runSidecarApp`, with `capabilities.transcriptInspector: true` on `/api/health`). The endpoint reads `transcript.jsonl` backwards in bounded `<= 512 KiB` scans, confines paths through `members.json` and `realpathSync` under `<appData>/brain/<memberConv>/.system_generated/logs/transcript.jsonl`, correlates `PLANNER_RESPONSE` tool calls with `GENERIC` tool outputs and errors (inferring missing planner timestamps from paired `GENERIC` steps), masks `/home/` paths and common API tokens (`Bearer`, `sk-`, `ghp_`, `gho_`, `AIza`, `xoxb-`, `AKIA`, PEM private keys, and env secrets), truncates text at `1200` chars and payloads at `2048` bytes, and paginates with `before`, `limit` (`1..50`), and `filter` (`all`, `errors`, `tools`).
- Added `ForensicTranscriptDrawer` and `StepInspector` in `frontend/src/ui.tsx`, `fetchMemberTranscript` in `frontend/src/sidecar.ts`, transcript types in `frontend/src/types.ts`, `Inspect trace` actions in `RosterView.tsx` and `TriageView.tsx`, and offline `/api/transcript` parity in `frontend/scripts/web-engine.js`. Operators can filter by `All`, `Errors`, or `Tools`, expand tool arguments and stderr tracebacks, copy masked errors, and paginate older steps down to `380px` sidebar width in both Light and Dark themes.
- Captured light and dark `docs/screenshots/forensic-trace-{light,dark}.png`, bumped all manifests and runtime endpoints to `1.25.0`, and verified post-final-edit: `33/33` backend unit tests, `64/64` gate, `8/8` replay, `24/24` `test-live-web.mjs`, `SLOP 0/0/0` (`frontend/src` and built `dist`), `385,808 B` raw (`376.8 KiB`) / `115,758 B` gz (`113.0 KiB`), `51.54 ms` boot, `105.93 MB` RSS, `1,373.1 req/s` (`16.91 ms` p95, `0/3,439` errors), `5/5` SSE, and `30/30` fuzz.

## 1.24.0 - 2026-11-26

- Added an incremental `board.jsonl` byte-offset tail cache (`LRU=8`) and `buildSwarmDelta` in `sidecars/fleet_pane/swarm_store.mjs`, paired with `GET /api/swarm/delta` (`fs.watch` coalesced wakeup, `125ms` fallback poll, `<=64` waiters, and `capabilities.deltaStream: true`) in both `createStandaloneRouter` and `runSidecarApp` inside `sidecars/fleet_pane/server_core.mjs`.
- Added sub-200ms delta sync (`fetchSwarmDelta` and `mergeSwarmDelta`) in `frontend/src/{types.ts,sidecar.ts,App.tsx}`, replacing 2s full-board polling with abort-safe `GET /api/swarm/delta?waitMs=20000` long-polling when `!canSse && canDelta`, routing SSE `ping` and `swarm` refreshes through `/api/swarm/delta`, and matching offline behavior in `frontend/scripts/web-engine.js`.
- Fixed release packaging in `.github/workflows/release.yml` by copying `sidecars/fleet_pane/server_core.mjs` into `$stage/sidecars/fleet_pane/` and running a staged `--standalone --port 0` `/api/health` and `/api/swarms` smoke check before archiving.
- Resolved `sloplint` checks across `frontend/src/{fonts.css,ui.tsx}` and `frontend/src/components/{TriageView,BoardView,WorktreesView}.tsx` to maintain zero fails and zero warnings on both source and built bundles.
- Captured light and dark `docs/screenshots/delta-{light,dark}.png`, bumped all manifests and runtime endpoints to `1.24.0`, and verified post-final-edit: `31/31` backend unit tests, `63/63` gate, `8/8` replay, `23/23` `test-live-web.mjs`, `SLOP 0/0/0` (`frontend/src` and built `dist`), `373,794 B` raw (`365.0 KiB`) / `113,137 B` gz (`110.5 KiB`), `55.13 ms` boot, `110.22 MB` RSS, `1,387.7 req/s` (`15.49 ms` p95, `0/3,480` errors), `5/5` SSE, and `30/30` fuzz.

## 1.23.0 - 2026-11-26

- Hardened the Node sidecar in `sidecars/fleet_pane/{swarm_store,channels,git_probe,server_core}.mjs`: added primitive type guards (`safeStr`, `safeSeq`) against non-primitive JSON payloads, bounded 2 MiB line buffering in `streamLinesIncremental`, last-good `view.json` fallback on transient parse errors, content-hash `plan.json` ETags for same-size CAS conflict detection, bounded LRU caches, CWE-59 symlink and escaping-root guards in `git_probe.mjs`, streaming bounded git diff execution, custom default branch fallbacks, and strict `/api/plan` and `/api/control` input validation (including coordinator kill protection, 404/409 target checks, and control-character rejection).
- Hardened the React sidebar UI in `frontend/src/{App,ui,sidecar,icons}.tsx` and `frontend/src/components/{TriageView,WorktreesView,BoardView,RosterView}.tsx`: added 3-way `Reload & merge` recovery on `409 Conflict` in the Live Plan Editor, depth-guarded `safePlanText` and `view.json` error cards, HTTP 200 `dry_run_merge` conflict classification with inline recovery hints and dismiss controls, 340px collision pill wrapping, synchronous ref double-submit locks on `/api/control` actions, missing-coordinator warnings, empty-channel fallback states, and `#seq` backlink filter recovery.
- Removed obsolete legacy UI component copies, `frontend/scripts/sync-used.mjs`, and `frontend/e2e/fixtures/agent.sh`, cleaned `frontend/tsconfig.json`, and updated `frontend/e2e/README.md` for the Node sidecar E2E suite.
- Captured light and dark `docs/screenshots/hardening-{light,dark}.png`, bumped all manifests and runtime endpoints to `1.23.0`, and verified post-final-edit: `29/29` backend unit tests (`753.9 ms`), `61/61` gate, `8/8` replay, `22/22` `test-live-web.mjs`, `SLOP 0/0/0`, `367,693 B` raw (`359.1 KiB`) / `111,231 B` gz (`108.6 KiB`), `52.47 ms` boot, `122.0 MB` RSS, `2,189.3 req/s` (`9.77 ms` p95, `0/5,487` errors), `5/5` SSE, and `30/30` fuzz.

## 1.22.0 - 2026-11-26

- Added `POST /api/control` in `sidecars/fleet_pane/server_core.mjs` (both the standalone router and `runSidecarApp`) supporting `board_post`, `spawn_worker`, `switch_model`, `kill_worker`, `channel_op`, and `gate_verdict`, with Host-403, Origin-403, 64 KB `413` checks, `confirm: true` validation, `404` coordinator resolution, `501` non-sidecar guard, `409` unmerged worktree protection via `probeMemberWorktree` in `sidecars/fleet_pane/git_probe.mjs`, and `[fleet-operator:<op>]` directive formatting documented in `skills/fleet/SKILL.md` and `rules/AGENTS.md`.
- Added `replyRefs` thread backlink indexing and `findCoordinatorConvId` in `sidecars/fleet_pane/swarm_store.mjs`.
- Upgraded `frontend/src/{types.ts,sidecar.ts,App.tsx,ui.tsx}` and `frontend/src/components/{BoardView,RosterView,CommandPalette}.tsx` with the New Swarm launcher modal, Command Palette Spawn Worker and Board Post actions, Board channel filter tabs, Channel Manager drawer, sticky confirmation-gated Board/Channel Composer, clickable `#seq` `replyRefs` backlink chips, Roster Spawn Worker and Switch Model drawers, confirmation-gated Kill Worker `409` warning and Force kill flow, Gate Readiness verdict controls, `addArtifactComment` host bridge, and matching offline parity in `frontend/scripts/web-engine.js`.
- Fixed header swarm selector flex width in `frontend/src/App.tsx` so the `<select>` shrinks cleanly beside the 5 header icon buttons at 380px, and imported `memberView` from `sidecars/fleet_pane/channels.mjs` into `sidecars/fleet_pane/swarm_store.mjs` for `unseenBy` channel visibility.
- Captured light and dark `docs/screenshots/control-{light,dark}.png`, updated version parity to `1.22.0`, and verified post-final-edit: `22/22` backend unit tests (`622.41 ms`), `57/57` gate, `8/8` replay, `21/21` `test-live-web.mjs`, `SLOP 0/0/0`, `357,566 B` raw (`349.2 KiB`) / `108,730 B` gz (`106.2 KiB`), `39.65 ms` boot, `113.73 MB` RSS, `2,300.7 req/s` (`12.66 ms` p95, `0/5,770` errors), `5/5` SSE, and `30/30` fuzz.

## 1.21.0 - 2026-11-26

- Added cross-worktree file collision detection (`collisions` across working changes and committed `branchFiles`), `git merge-tree --write-tree` mergeability and `conflictFiles` checks, recent branch commit summaries, and `mode=working|branch` bounded diffs in `sidecars/fleet_pane/git_probe.mjs`.
- Added `POST /api/worktrees/action` in `sidecars/fleet_pane/server_core.mjs` (`dry_run_merge`, `ff_merge`, `rebase` with automatic `--abort` on conflict, and safe non-force `remove_worktree` restricted to clean merged branches) using `execFile`, `realpath` worktree confinement, Host-403, Origin-403, and a `16 KiB` body limit.
- Upgraded `frontend/src/components/WorktreesView.tsx`, `frontend/src/sidecar.ts`, `frontend/src/types.ts`, and offline `web-engine.js` with the File collisions banner, mergeability badges, recent commit list, Working Changes vs Branch Diff toggle, and confirmation-gated merge, rebase, and cleanup controls with inline conflict file lists.
- Refreshed light and dark `docs/screenshots/worktrees-{light,dark}.png`, updated version parity to `1.21.0`, and verified post-final-edit: `18/18` backend unit tests, `52/52` gate, `8/8` replay, `18/18` `test-live-web.mjs`, `SLOP 0/0/0`, `336,001 B` raw (`328.1 KiB`) / `103,435 B` gz (`101.0 KiB`), `91.09 ms` boot, `100.22 MB` RSS, `828.5 req/s` (`22.29 ms` p95, `0/2,080` errors), `5/5` SSE, and `30/30` fuzz.

## 1.20.0 - 2026-11-26

- Fixed the React 19 white-screen crash on native Antigravity `plan.json` files (`goal.{title,line}`, `tasks`, `threads`) by implementing `normalizePlan` in `sidecars/fleet_pane/swarm_store.mjs` and defensive plan rendering across `frontend/src/{types.ts,ui.tsx,components/TriageView.tsx}` plus narrator `view.json` surfacing (`headline`, `phase`, `running_summary`, `now`, `attention`).
- Added atomic two-way plan editing via `POST /api/plan` in `sidecars/fleet_pane/server_core.mjs` (registered in both the standalone router and `runSidecarApp`, with Host-403, Origin-403, 64 KB body cap, `ifMatch` CAS `409 Conflict` detection, native schema preservation, and optional coordinator notification) paired with an inline confirmation-gated Live Plan Editor in `TriageView.tsx` and offline `web-engine.js` parity.

## 1.19.0 - 2026-11-25

- Added zero-client idle sleep mode in `sidecars/fleet_pane/server_core.mjs` (`idleSleep` + `sseClients` state exposed on `/api/health` and `getSleepState()`): servers boot idle with zero polling timers, clear `sseTimer` and re-enter `idleSleep` immediately when the last SSE client disconnects, and wake immediately on the next API or stream request.
- Added 1-click sanitized Full Swarm Archive Export (`formatSwarmArchive` in `frontend/src/ui.tsx`, `[data-testid="export-archive-md"]` and `[data-testid="export-archive-json"]` in `frontend/src/components/TriageView.tsx` and `App.tsx`) producing `fleet.swarm-archive.v1` JSON and Markdown archives covering plan, gate readiness, worker state, triage, full board transcript, and worktree readiness with zero `/home/` path leaks, plus hidden-tab timer pause in `App.tsx` and offline `web-engine.js` parity.
- Verified post-final-edit: `13/13` backend unit tests (`458.7 ms`), `52/52` gate, `8/8` replay, `14/14` `test-live-web.mjs`, `SLOP 0/0/0`, `63.74 MB` (`65,268 KB`) `--jitless` `VmHWM` on `2k/50k` (`4,584.3 req/s`), `1,833.4 req/s` (`14.11 ms` p95, `0` errors, `30/30` fuzz, `5/5` SSE) on `audit_runner.py` under `#154` isolation, `311,474 B` raw / `97,019 B` gz (`94.7 KiB`), and refreshed Light and Dark `docs/screenshots/*.png`.

## 1.18.0 - 2026-11-25

- Added a bounded, strictly read-only, mtime-cached 8 KB tail reader (`readTranscriptActivityTail`) in `sidecars/fleet_pane/swarm_store.mjs` reusing the shared 32 KB chunk buffer and masking `/home/` and `/Users/` paths as `~/`, attaching `activityPeek` (`status`, `label`, `tool`, `ts`) to non-killed members in `buildSwarmSnapshot`, `frontend/src/types.ts`, and `frontend/scripts/web-engine.js`.
- Added shared `<MemberActivityLine />` in `frontend/src/ui.tsx` rendered across Roster worker cards (`[data-testid="roster-activity-peek-*"]` in `RosterView.tsx`) and Triage attention rows (`[data-testid="triage-activity-peek-*"]` in `TriageView.tsx`) for both working and waiting workers.
- Deferred background `server_core.mjs` warmup and `--jitless` `node:v8` tuning by 25 ms after standalone HTTP socket bind in `sidecars/fleet_pane/main.mjs` and set `--max-old-space-size=16` in `sidecars/fleet_pane/sidecar.json` (`39.59 ms` cold boot on `audit_runner.py`, `102.05 ms` `--jitless` boot, `63.61 MB` `--jitless` `VmHWM` on `2k/50k`, `4,764.6 req/s` keep-alive, `1,839.4 req/s` / `11.90 ms` p95 / `99.84 MB` default RSS / `0` errors / `30/30` fuzz / `5/5` SSE on `audit_runner.py` under `#154` isolation), refreshed all 8 `docs/screenshots/*.png`, and verified `12/12` backend unit tests, `51/51` gate, `8/8` replay, `13/13` live-web, and `SLOP 0/0/0`.

## 1.17.0 - 2026-11-25

- Added a 1-click **Copy Handoff Digest** control (`[data-testid="copy-handoff-digest"]`) inside the Triage header in `frontend/src/components/TriageView.tsx` and upgraded `formatSwarmDigest` in `frontend/src/ui.tsx` to export plain-prose Markdown covering active goal, verification gate, gate readiness and wave velocity, worker states, verified deliverables, recent commit refs, blockers, and worktree safe-land readiness with zero local `/home/` path leaks.
- Added a non-intrusive SSE reconnect and sync-staleness banner (`[data-testid="sse-resync-banner"]` and `[data-testid="sse-resync-btn"]`) in `frontend/src/App.tsx`, paired with explicit `event: ping` SSE keepalive frames in `sidecars/fleet_pane/server_core.mjs` so stalled or paused connections surface cleanly and resync in one click.
- Split standalone HTTP startup into a lean bootstrapper in `sidecars/fleet_pane/main.mjs` (`server_core.mjs` plus lazy `node:zlib` loading copied by `install.sh`) reaching as low as `52.32 ms` unpinned default-V8 cold boot, refreshed all 8 Light and Dark screenshots (`docs/screenshots/*.png`), and verified `11/11` backend tests, `50/50` gate, `8/8` replay, `12/12` live-web, `0` Sloplint issues, `64.56 MB` (`66,108 KB`) `--jitless` `VmHWM` on `2k/50k`, `1,487.4 req/s` (`13.83 ms` p95, `0` errors, `30/30` fuzz, `5/5` SSE) on `audit_runner.py` under `#154` isolation, and `308,802 B` raw / `96,193 B` gz (`93.9 KiB`).

## 1.16.0 - 2026-11-25

- Added worktree safe-land readiness (`baseBranch`, `ahead`, `behind`, and `landStatus` across `ready`, `rebase`, `dirty`, `merged`, and `main`) in `sidecars/fleet_pane/git_probe.mjs`, `frontend/src/{types.ts,components/WorktreesView.tsx}`, and `frontend/scripts/web-engine.js`, with 1-click copyable safe-merge, rebase, status, and cleanup commands (`[data-testid="wt-land-status-*"]`, `[data-testid="wt-land-cmd-*"]`) masking local home paths with `~/`.
- Expanded `CommandPalette` (`Cmd/Ctrl+K` in `frontend/src/components/CommandPalette.tsx` and `App.tsx`) into a cross-swarm action index covering workers (`Filter Board: @worker`, `Roster: @worker`, `Open chat: @worker`), triage items and next-gate actions, the 20 newest board posts, workspace worktrees, and all active swarms.
- Deferred `node:v8` `--jitless` tuning (`--max-semi-space-size=1 --optimize-for-size --memory-reducer`) and store loading until after standalone HTTP socket binding in `sidecars/fleet_pane/main.mjs`, widened `swarmPayloadCache` stat checks to 1s (`swarmsListCache` to 1.5s), refreshed all 8 Light and Dark screenshots (`docs/screenshots/*.png`), and verified `11/11` backend tests, `48/48` gate, `8/8` replay, `11/11` live-web, `0` Sloplint issues, `62.39 MB` (`63,888 KB`) `--jitless` `VmHWM` on `2k/50k` (`6,921.0 req/s`), `1,364.4 req/s` (`14.60 ms` p95, `64.64 ms` boot, `100.86 MB` default RSS, `30/30` fuzz, `5/5` SSE) on `audit_runner.py`, and `306,653 B` raw / `95,549 B` gz (`93.3 KiB`).

## 1.15.0 - 2026-11-25

- Added 1-click stalled and idle worker recovery and direct member-filtered Board jumps across `[data-testid="worker-recovery-strip"]` in `TriageView.tsx`, `[data-testid="gate-target-jump"]` in `ui.tsx` (`GateReadinessCard`), `[data-testid="roster-recover-*"]` and `[data-testid="roster-board-*"]` in `RosterView.tsx`, lifted `boardAgentFilter` in `App.tsx` and `BoardView.tsx`, `buildRecoverPrompt` in `ui.tsx`, and `lastPostSeq` triage attachment in `swarm_store.mjs` and `web-engine.js`.
- Bound standalone TCP listening before lazily importing `./swarm_store.mjs` in `sidecars/fleet_pane/main.mjs`, answered `/api/health` immediately on boot, added a synchronous `getWorktreesPackedSync` cache hit path, widened `swarmPayloadCache` stat checks to 500ms with a 1-entry cap, and tuned `--max-old-space-size=20` in `sidecar.json` (`63.01 MB` `--jitless` `VmHWM` on `2k/50k`, `7,068.5 req/s` `--jitless` keep-alive, `99.27 MB` cold default audit RSS, `1,005.8 req/s` / `17.89 ms` p95 / `30/30` fuzz / `5/5` SSE under `#154` isolation).
- Rebuilt `dist/index.html` (`304,263 B` raw / `94,884 B` gz, `491,855 B` offline `dist-live-web/index.html`), refreshed all 8 Light and Dark screenshots in `docs/screenshots/`, and verified `11/11` backend tests, `46/46` Playwright gate, `8/8` replay, `11/11` live-web, and `0 FAIL / 0 REFLEX / 0 WARN` Sloplint.

## 1.14.0 - 2026-11-25

- Added a wave velocity and pass-rate summary pill (`[data-testid="wave-velocity-pill"]`) to `GateReadinessCard` via `computeGateReadiness` in `sidecars/fleet_pane/swarm_store.mjs`, `frontend/src/{types.ts,ui.tsx}`, and `frontend/scripts/web-engine.js`. It reports pass percentage, waves per hour across timestamps, `[done]` / `[verified]` / `[scale-verified]` / `[blocked]` counts, and a 1-click `[data-testid="gate-shipped-jump"]` button targeting the newest shipped or verified `#seq`.
- Deferred `/preload.js` buffer creation in `sidecars/fleet_pane/main.mjs` and replaced repeated flex utility strings with `.row` in `frontend/src/` (`301,836 B` raw / `94,150 B` gz, `488,715 B` offline `dist-live-web/index.html`, `63.05 MB` `--jitless` `VmHWM` on `2k/50k`, `3,872.7 req/s` `--jitless` keep-alive, `1,272.3 req/s` / `15.30 ms` p95 / `101.73 MB` cold default audit, `30/30` fuzz, and `5/5` SSE streams under `#154` isolation).
- Rewrote `README.md`, `CHANGELOG.md`, `plugin.json`, and visible UI labels in plain prose (`humanizer v4.0.0`), refreshed all 8 Light and Dark screenshots in `docs/screenshots/`, and verified `11/11` backend tests, `44/44` Playwright gate, `8/8` replay, `11/11` live-web, and `0 FAIL / 0 REFLEX / 0 WARN` Sloplint.

## 1.13.0 - 2026-11-25

- Extended `computeGateReadiness` in `sidecars/fleet_pane/swarm_store.mjs`, `frontend/src/{types.ts,ui.tsx}`, `TriageView.tsx`, and `frontend/scripts/web-engine.js` to compute `nextAction` (`unblock`, `verify`, `scale`, or `ship`) with `Re #<seq>:` and branch/commit context, wired to `[data-testid="gate-next-action"]` and `#gate-next-nudge` inside `GateReadinessCard`.
- Deferred `loadDistAssets` file and CRC reads until the first `/` request in `sidecars/fleet_pane/main.mjs`, guarded `/fonts/` prefix lookups, added a loopback `Host` fast path, folded gate tag scanning into the single `buildSwarmSnapshot` loop, and set `--max-old-space-size=28` in `sidecar.json` (`64.87 MB` `--jitless` `VmHWM` on `2k/50k`, `7,257.0 req/s` `--jitless` keep-alive, `2,315.7 req/s` / `9.30 ms` p95 / `50.37 ms` cold audit).
- Rebuilt `dist/index.html` (`301,440 B` raw / `94,030 B` gz), refreshed `docs/screenshots/*.png`, and verified `11/11` backend tests, `43/43` gate, `8/8` replay, `11/11` live-web, `0 FAIL / 0 REFLEX / 0 WARN` Sloplint, `30/30` fuzz, and `5/5` SSE streams.

## 1.12.0 - 2026-11-25

- Added `computeGateReadiness` and `<GateReadinessCard />` across `swarm_store.mjs`, `frontend/src/ui.tsx`, and `web-engine.js` to track `[done]`, `[verified]`, `[scale-verified]`, and `[blocked]` progression with 32px stage jump buttons.
- Removed `2,000` `Buffer.subarray` wrapper allocations on `board.jsonl` reads, trimmed `worktreesPayloadCache` to 1 entry, bounded V8 old space (`--max-old-space-size=24`), and added `info` and `danger` `Button` variants plus `.h2`, `.f1`, and `.t3` classes (`65.55 MB` `--jitless` `VmHWM`, `69.16 MB` cold audit, `300,853 B` raw / `93,861 B` gz).
- Refreshed `docs/screenshots/*.png` and verified `11/11` backend tests, `43/43` gate, `8/8` replay, `11/11` live-web, `0` Sloplint issues, `30/30` fuzz, and `5/5` SSE streams.

## 1.11.0 - 2026-11-25

- Added `computeBurnSummary` and `<TokenBurnStrip />` to Triage and Roster (`swarm_store.mjs`, `ui.tsx`, `TriageView.tsx`, `RosterView.tsx`, `web-engine.js`) with a stacked worker share bar, top-3 legend, and `High burn` warning badges.
- Replaced per-line `buf.subarray()` allocations in `extractIntSpan` and `extractStrSpan`, removed duplicate `indexOf` tail scans, tightened `rawTail` to `12 KB`, and bounded old space (`--max-old-space-size=32`), reaching `64.79 MB` `--jitless` `VmHWM` and `8,257.6 req/s` `--jitless` keep-alive.
- Verified `301,090 B` raw / `93,839 B` gz, refreshed screenshots, `10/10` backend tests, `42/42` gate, `8/8` replay, `11/11` live-web, `0` Sloplint issues, `30/30` fuzz, and `5/5` SSE streams.

## 1.10.0 - 2026-11-25

- Added a confirmation-gated Broadcast composer in `RosterView.tsx` (`@all`, `working`, `waiting`, or custom subsets via `POST /api/nudge` with `conversationIds`) and filtered `.md` and `.json` Board exports beside Wave digest in `BoardView.tsx` (all paths masked with `~/`).
- Kept serialized snapshot buffers to drop per-request decompression on `/api/swarm`, lazy-loaded `git_probe.mjs`, `node:v8`, and `/fonts` directory scans, cached `findAppDataDirs` for 1s, restored cog `Settings` and `Wrench` SVGs, and fixed default `ic()` sizing (`64.90 MB` `--jitless` `VmHWM`, `299,493 B` raw / `93,290 B` gz).
- Refreshed all 8 screenshots and verified `9/9` backend tests, `40/40` gate, `8/8` replay, `11/11` live-web, `0` Sloplint issues, `28/28` fuzz, and `5/5` SSE streams.

## 1.9.0 - 2026-11-25

- Added a proportional `working`, `waiting`, and `blocked` bottleneck heat bar to Needs you with a `Top #seq` jump button and a **Copy blocker** button that copies a `~/`-masked Markdown escalation.
- Consolidated SVG icon paths, shared `maskHome`, `submitNudge`, `openOrCopyPath`, and `PinnedList` helpers (`311,446 B` raw / `94,127 B` gz), and added `createMentionsMatcher`, `SHARED_CHUNK_BUF` carry handling, `TAIL_CAP = 16`, and single-param `parseQueryFast` (`73.16 MB` `--jitless` `VmHWM`, `8/8` backend tests, `28/28` fuzz, `5/5` SSE).
- Refreshed all 8 screenshots and verified `38/38` gate, `8/8` replay, `11/11` live-web, and `0` Sloplint issues.

## 1.8.0 - 2026-11-25

- Added `GET /api/worktrees/diff` in `git_probe.mjs` and `main.mjs` returning bounded (`<= 8 KB`) `git diff HEAD` hunks and untracked previews confined with `realpathSync`, wired to **Diff peek** toggles in `WorktreesView.tsx`.
- Consolidated icons onto shared SVG path primitives (`322,939 B` raw / `93.1 KiB` gz), extracted `InlineComposer`, `MediaPathChips`, `ActivityPeek`, and `copyText` helpers, switched ETags to `zlib.crc32`, fixed quadratic chunk scanning in `swarm_store.mjs`, and tuned `sidecar.json` (`72.82 MB` `VmHWM`).

## 1.7.0 - 2026-11-25

- Added Board quick filters (`All`, `Needs reply`, `[done]`, `[blocked]`, cycled with `f`), a **Wave digest** Markdown copy button, and `~/` sanitization on pinned post previews.
- Replaced `cmdk` with a dependency-free React command palette (`<345 KB` raw / `<100 KB` gzip), emitted build-time `dist/index.html.gz` read directly by `main.mjs`, cut tail retention to `16 KB`, and set V8 bounds in `sidecar.json` to keep `2k/50k` Peak `VmHWM` below `75 MB`.

## 1.6.0 - 2026-11-25

- Added scalar transcript scanning in `swarm_store.mjs` without per-line string allocations, removed duplicate cold-boot snapshot generation, enabled `--optimize-for-size`, and trimmed `@radix-ui/react-dialog` out of `cmdk` (`~350 KB` raw / `~104 KB` gzip).
- Added clickable `#seq` and **Reply** quote replies on Board posts, `r` reply shortcut on Triage, `?` shortcut modal, `Screenshot:` chips, and `~/` path masking.

## 1.5.0 - 2026-11-25

- Added worker duration badges (`Working 1m`, `Waiting 3m`, `stalled`) and **Ask status / Wrap up** preset buttons in Triage and Roster alongside control-character validation on `POST /api/nudge`.
- Windowed Board feeds to the newest 80 posts with expansion on `#seq` jumps, replaced `sonner` with `FleetToaster` (`<380 KB` raw / `~112 KB` gzip), and moved `swarm_store.mjs` to in-place board normalization with 32-line `tailSteps` rings (`<95 MB` `VmHWM`).

## 1.4.0 - 2026-11-25

- Added Triage keyboard navigation (`j` and `k` to move focus, `o` or `Enter` to open chat, `p` to pin `#seq`, `1` to `5` to switch tabs).
- Expanded `git status --porcelain=v1 -z` inspection with path and symlink confinement in `git_probe.mjs` plus **Open file** rows in `WorktreesView.tsx`.
- Replaced `motion/react` with `Element.animate` (`src/motion.ts`) to cut bundle size below `410 KB` raw, and added bounded LRU caches in `swarm_store.mjs`.

## 1.3.0 - 2026-11-25

- Added `GET /api/swarm/stream` (`text/event-stream`) pushing `etag` updates via `computeSwarmFingerprint` (64-client cap, shared 150ms watcher, 15s heartbeat) with polling fallback inside `SidecarApp`, tested across 5 concurrent SSE clients.
- Added persistent `Pin #seq` toggles, aligned `#seq` jump pills at `380px` sidebar width, and set `chmod 755` on the install staging directory in `install.sh`.

## 1.2.0 - 2026-11-25

- Added confirmation-gated **Unstick / Resume / Ask status** presets on blocked, quota, error, and stalled Triage items, **Open file** buttons via `toggleAuxPane`, and context saturation badges (`% ctx`) in `RosterView`.
- Switched transcript history scanning to scalar extraction (parsing JSON only for the newest 32-line tail), stopped keeping parsed 2,000-message graphs once serialized buffers exist, added 250ms stat-guarded caches, and capped old space at `64 MB`.
- Enabled `text-wrap: pretty` on paragraphs and verified `0` Sloplint issues, `30/30` Playwright gate, `6/6` replay, and `11/11` `live-web` checks.

## 1.1.0 - 2026-11-25

- Sized all 5 tabs (`Triage`, `Board`, `Roster`, `Graph`, `Git`) for `340px` to `380px` sidebars without horizontal overflow, updated headings to sentence case, flattened nested card borders, and humanized workstream statuses.
- Added **Activity Peek** drawers for worker thinking headings and last 5 tool calls, plus a **Copy swarm digest** Markdown action.
- Moved `board.jsonl` and `transcript.jsonl` reading to 128 KB chunked incremental byte-offset tailing with inode and truncation resets.

## 1.0.0 - 2026-11-25

- Converted Fleet from a standalone Rust binary to an Antigravity `SIDECAR_UI_ENTRYPOINT_AUX_PANE` plugin with `SidecarApp` and `/preload.js` bridges, `/fleet` skill, standing swarm rules, and atomic `./install.sh`.
- Built the dependency-free Node ESM backend (`sidecars/fleet_pane/`) reading `.system_generated/{swarm,logs}/` read-only with token/step telemetry, `plan.json` workstreams, triage items, `git worktree` inspection, multi-swarm switching, confined `/api/frame` images, pre-compressed gzip + `ETag`/`304`, loopback `Host`/`Origin` `403` guards, `413` limits, and confirmation-gated `POST /api/nudge`.
- Built the React 19 + TypeScript sidebar SPA with live host `theme-change` sync, Settings-only Light/Dark switch, `Geist` and `Geist Mono` fonts, and offline `dist-live-web/index.html` simulation.

## 0.12.0 - 2026-11-25

- Upgraded `src/http_assets.rs` DEFLATE to Package-Merge dynamic Huffman (`<360 KB` gzip) and streamed `serde_json::to_writer` into `Arc<Vec<u8>>` HTTP buffers.
- Added `src/router.rs` scoring installed CLIs from persisted pass rates and `<data_dir>/lessons.json` repair memory (`src/autoheal.rs`), plus windowed `DiffViewer`, DAG wave telemetry, and `web-engine.js` parity.

## 0.11.0 - 2026-11-25

- Replaced sequential `which` / `where` subprocesses with `$PATH` lookup and single-pass `PersistedStore` loading (`<30 ms` cold boot at 2k sessions).
- Added `WaveShipModal` (`git merge-tree` preflight and batch `POST /api/sessions/batch-pr`), deterministic auto-heal failure classification (`src/autoheal.rs`), and `web-engine.js` parity.

## 0.10.0 - 2026-11-25

- Enabled release LTO, pure-Rust gzip + SHA-256 `ETag`/`304`, a 64-worker HTTP pool with `TCP_NODELAY`, `.git/HEAD` fast paths, and allocation-free transcript search.
- Enriched auto-heal prompts with modified files and diff excerpts, added `POST /api/sessions/batch-merge`, keyboard triage shortcuts, CWE-59 worktree deletion checks, and `web-engine.js` parity.

## 0.9.0 - 2026-11-25

- Rebuilt the desktop UI around a 44px top bar, collapsible Session Inbox, central Transcript/Diff/Receipt/DAG/Goal workspace, and right Inspector.
- Removed heavy UI wrapper dependencies to shrink `assets/index.html` below `708 kB`, added `POST /api/plan`, bounded HTTP/SSE pools, and tightened IPv6 `Host`/`Origin` checks.

## 0.8.0 - 2026-11-22

- Renamed crate, binary (`fleet`), and user-facing strings to Fleet, added native `x86_64-pc-windows-msvc` process/check/path support across the 4-platform release matrix, and added the chromeless `--app` desktop launcher.

## 0.7.0 - 2026-11-22

- Added the interactive DAG visualizer, PR preview and confirmation-gated GitHub PR creator (`src/pr.rs`), `git worktree` inspector and allowlisted removal (`src/worktrees.rs`), UTC daily dispatch and heal budget limits (`src/budget.rs`), and standalone browser bundle parity.

## 0.6.0 - 2026-11-22

- Added the auto-heal steering loop (`src/autoheal.rs`) with identical-error fingerprint halting, reusable playbook templates (`src/templates.rs`), `state_rev`-cached board metrics (`src/metrics.rs`), and matching UI badges.

## 0.5.0 - 2026-11-22

- Added `/api/events/stream` SSE broadcasting, Kahn topological DAG scheduler (`src/dag.rs`), multi-step check pipelines with glob guardrails (`src/checks.rs`), `git merge-tree` dry-run merge checks (`src/merge_check.rs`), policy dry-run tester (`src/policy.rs`), concurrency caps, and virtualized 50k-line transcripts.

## 0.4.0 - 2026-11-21

- Added local git repository discovery (`GET /api/repos`), live engine/model config (`GET`/`POST /api/config`), isolated worktree `$PWD` execution and post-merge cleanup, Settings-only theme switch, and the IndexedDB standalone browser bundle.

## 0.3.0 - 2026-11-21

- Built the three-lane Kanban board (`Needs you`, `Working`, `Done`) and split-pane session inspector with self-hosted `Geist` fonts, automated check/merge disclosures, and Unix release builds.

## 0.2.0 - 2026-11-19

- Added per-session `logs/<id>.record.json` recovery, retry failure injection, orphaned worktree re-attachment, session dismiss archiving, merge refusal messages, loopback `Host` rules, and self-update support.

## 0.1.0 - 2026-11-17

- Initial release with isolated git worktrees, automated verification checks, safe merges, persistence across restarts, steering, and successor chains.
