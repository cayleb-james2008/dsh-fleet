# Fleet

**Antigravity-native Swarm Command Center sidecar plugin.**

Fleet lives directly in Antigravity's auxiliary side pane (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) and turns native multi-agent swarms (`swarm`, `post_message`, `read_board`, `swarm_wait`, `plan.json`, and conversation transcripts) into a crisp command center.

> Looking for the legacy standalone Rust server (`v0.12.0`)? It remains preserved in git history at tag `v0.12.0`.

## What It Gives You

- **Needs-You Triage Inbox, Unstick Presets & File Actions:** Surfaces stalled workers, model/quota errors, open worker questions, `[blocked]` escalations, unverified `[done]` deliverables, confirmation-gated 1-click **Unstick / Resume** presets, `plan.json` workstreams/milestones/gates, worker-flagged `Screenshot:` captures with 1-click **Open file** (`toggleAuxPane`), and 1-click **Copy swarm digest** Markdown summaries.
- **Worker Activity Peek & Context Pressure Telemetry:** Incrementally tails each member's `transcript.jsonl` to display live shimmering tool/thinking activity, expandable **Activity Peek** (last 5 tool calls + thinking heading), step counts, active context saturation (`% ctx` / `High ctx` / `Quota paused`), and real `input` / `cache_read` / `output` token totals.
- **Live SSE Push & Graceful Polling:** Streams instant board/transcript deltas over `GET /api/swarm/stream` (`text/event-stream`) in standalone mode and falls back seamlessly to interval polling inside Antigravity's `SidecarApp` gateway.
- **Board Feed, Pinned Posts & `@mention` Graph:** Filterable, `#seq`-clickable board stream with persistent **Pin `#seq`** highlights (surfaced in both Board and Triage), unread `New` dividers, and an interactive `@mention` topology graph with timeline replay.
- **Workspace Git Worktrees:** Subscribes to `sidecar.getWorkspaceUris()` / `onWorkspaceChange()` and probes git worktree branches, dirty/staged/untracked counts, and latest commit metadata with debounced caching.
- **Multi-Swarm Switcher & Empty-State Presets:** Switch across active or recent swarms in `<appData>/brain/` or launch `/fleet` swarm presets (`Feature + Verifier`, `Audit & Harden`, `Multi-Lane Ship`).

## Install Into Antigravity

```bash
./install.sh
```

By default, `./install.sh` installs atomically into `~/.gemini/config/plugins/fleet/` (override with `--dest <dir>`).

Once installed:
1. Open Antigravity Customizations to manage **`fleet`** (`customization://fleet`).
2. Toggle the side pane with **`[Fleet](sidecar://fleet/fleet_pane/)`**, or run **`/fleet`** in chat to coordinate a swarm with `plan.json` tracking and isolated worktrees.

## Standalone Local Preview & Development

You can also run Fleet's sidecar backend standalone against local `<appData>/brain/` state (default `127.0.0.1:18430`):

```bash
cd frontend && npm ci && npm run build:live-web
cd ../sidecars/fleet_pane && npm test
node main.mjs --port 18430
```

Flags:
- `--port <n>`: Bind standalone HTTP server on `127.0.0.1:<n>` (default `18430`).
- `--app-data-dir <path>`: Point to a custom Antigravity `<appData>` directory containing `brain/`.

## Security Model

- Strictly binds `127.0.0.1` loopback; validates loopback `Host` (`403`) and same-origin `Origin` on `POST` (`403`).
- Prompt `413 Payload Too Large` on oversized request bodies before consuming payload bytes.
- Strict CWE-22 / CWE-59 confinement on `GET /api/frame` (real path must lie inside `<appData>/brain/` and be explicitly listed on the board or `view.json`) and path validation on `GET /api/worktrees`.
- Confirmation-gated mutating nudge API (`confirm: true`).
- Zero external network calls; strict `Content-Security-Policy` (`frame-src 'none'; child-src 'none'`), `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.

## Verification

```bash
cd sidecars/fleet_pane && npm test
cd ../../frontend && npm run build:live-web
npm run check:ui -- --lints
node e2e/test-live-web.mjs
```
