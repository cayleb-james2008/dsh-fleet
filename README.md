<div align="center">

# Fleet

An Antigravity sidecar plugin for multi-agent swarms. It reads native swarm boards, worker transcripts, `plan.json` milestones, and workspace git worktrees into a compact sidebar inside Antigravity.

[![CI](https://img.shields.io/github/actions/workflow/status/cayleb-james2008/fleet/release.yml?branch=main&label=CI&style=flat-square)](https://github.com/cayleb-james2008/fleet/actions/workflows/release.yml)
[![Release](https://img.shields.io/github/v/release/cayleb-james2008/fleet?style=flat-square&color=blue)](https://github.com/cayleb-james2008/fleet/releases/latest)
[![Platform](https://img.shields.io/badge/Antigravity-Sidecar%20Plugin-111318?style=flat-square)](https://cayleb-james2008.github.io/projects/fleet.html)
[![Stack](https://img.shields.io/badge/Node%20ESM-React%2019%20%2B%20TS-3178c6?style=flat-square)](https://github.com/cayleb-james2008/fleet)
[![License](https://img.shields.io/github/license/cayleb-james2008/fleet?style=flat-square)](LICENSE)

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/triage-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/triage-light.png" />
  <img alt="Fleet sidebar showing Triage inbox, gate readiness, and swarm plan" src="docs/screenshots/triage-light.png" width="380" />
</picture>

</div>

---

## Sidebar gallery

Fleet lays out cleanly from a `340px` to `380px` auxiliary sidebar up to `1440px` desktop views. It listens for Antigravity `theme-change` luminance updates and keeps the manual Light and Dark switch inside Settings.

<table>
  <tr>
    <td align="center" width="25%">
      <strong>Triage and plan</strong><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/triage-dark.png" />
        <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/triage-light.png" />
        <img alt="Triage view" src="docs/screenshots/triage-light.png" width="220" />
      </picture>
    </td>
    <td align="center" width="25%">
      <strong>Board and pins</strong><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/board-dark.png" />
        <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/board-light.png" />
        <img alt="Board feed view" src="docs/screenshots/board-light.png" width="220" />
      </picture>
    </td>
    <td align="center" width="25%">
      <strong>Roster and telemetry</strong><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/roster-dark.png" />
        <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/roster-light.png" />
        <img alt="Roster telemetry view" src="docs/screenshots/roster-light.png" width="220" />
      </picture>
    </td>
    <td align="center" width="25%">
      <strong>Git worktrees</strong><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/worktrees-dark.png" />
        <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/worktrees-light.png" />
        <img alt="Git worktrees view" src="docs/screenshots/worktrees-light.png" width="220" />
      </picture>
    </td>
  </tr>
</table>

---

## What it does

In **Triage**, Fleet pulls unanswered questions, blocked posts, quota pauses, stalled worker alerts, narrator `view.json` status, and normalized native or custom `plan.json` threads, tasks, and workstreams into a single inbox. Operators can edit goals, gates, tasks, and workstream statuses inline via atomic CAS `POST /api/plan` updates (with `409 Conflict` reload protection and optional coordinator notifications). Three 1-click actions sit right in the Triage header: **Copy Handoff Digest** exports a sanitized Markdown summary (active goal, gate readiness, worker state, verified commits, blockers, and worktree readiness), while **Archive .md** and **Archive .json** download a sanitized Full Swarm Archive (`fleet.swarm-archive.v1` JSON or full Markdown transcript) with zero `/home/` path leaks. A worker attention strip surfaces idle, unread, and stalled workers with 1-click recovery prompts, direct board jumps filtered to that member, and a compact 1-line `activityPeek` showing live transcript tail status, tool or command summary, and age, while an inline SSE reconnect banner offers a 1-click **Resync** recovery when live streams stall or polling is paused. A gate readiness card tracks `[done]`, `[verified]`, `[scale-verified]`, and `[blocked]` tags alongside a wave velocity pill, next-gate action button, and direct target jump. A bottleneck bar summarizes working, waiting, and blocked counts, and a token burn strip plots each worker's share of total tokens.

Each triage item includes keyboard shortcuts (`j` and `k` to move, `o` or `Enter` to open chat, `p` to pin `#seq`, `r` to reply, `1` to `5` to switch tabs, `?` for help), inline activity peeks showing recent tool calls, unstick presets, `~/`-masked blocker copy buttons, and direct file openers through `window.sidecar.ui.toggleAuxPane`. Press `Ctrl+K` or `Cmd+K` anywhere to search across tabs, `@worker` board filters, worker chats, triage items, recent board posts, worktrees, and active swarms.

In **Board**, Fleet reads `board.jsonl` with quick filters (`All`, `Needs reply`, `[done]`, `[blocked]`, cycled with `f`), pinned posts, `#seq` quote replies, Markdown wave digests, and `.md` or `.json` board exports stripped of local `/home/` paths. In **Roster**, each worker card pairs duration badges, token breakdowns, context saturation, and a 1-line mtime-cached transcript tail `activityPeek` (active tool or command, `~/`-masked paths, and age) with 1-click worker recovery, filtered board jumps, and a confirmation-gated broadcast composer to nudge `@all`, `working`, `waiting`, or custom worker subsets. In **Graph**, a replayable `@mention` graph traces message flow across the swarm. In **Git**, Fleet probes workspace worktrees with `git status --porcelain=v1 -z`, computes ahead/behind divergence against `main` (`Ready to land`, `Needs rebase`, `Uncommitted edits`, or `Landed / clean`) with 1-click copyable merge/rebase/cleanup commands, and shows bounded inline diffs (`GET /api/worktrees/diff`).

Live updates stream over `GET /api/swarm/stream` (`text/event-stream`) with live ping heartbeats in standalone mode and fall back to polling inside Antigravity's `SidecarApp` gateway. On startup, `main.mjs` binds the HTTP listener and answers `/api/health` immediately before lazily loading `server_core.mjs` (`swarm_store.mjs`, `git_probe.mjs`, and gzip caches) and `--jitless` V8 tuning flags after socket bind. When zero SSE clients are connected, `server_core.mjs` enters `idleSleep` and clears background polling timers until the next request or stream connection, serves cached `/api/worktrees` responses synchronously on cache hit, and reads only the trailing 8 KB of each `transcript.jsonl` into a shared buffer for `activityPeek` while tailing full history incrementally in 32 KB chunks without retaining parsed board graphs in memory.

---

## Architecture

```mermaid
flowchart LR
    Host["Antigravity Host<br/>(Aux Side Pane + /preload.js)"] <-->|"SidecarApp RPC + theme-change<br/>toggleConversation / toggleAuxPane"| Backend["Fleet Sidecar Bootstrap<br/>(sidecars/fleet_pane/main.mjs)"]
    UI["Embedded Sidebar SPA<br/>(304.2 KiB raw / 94.7 KiB gz)"] <-->|"GET /api/swarm/stream (SSE)<br/>Zero-Client Idle Sleep + 304 JSON"| Backend
    Backend -->|"Lazy Route + Store Load"| Core["server_core.mjs + swarm_store.mjs"]
    Core -->|"Safe-Land Checks + CWE-22/59 Diff Peek"| Git["git_probe.mjs"]
    Core -.->|"Read-Only 8 KB Tail + Scan"| Brain["~/.gemini/antigravity/brain/&lt;conv&gt;<br/>.system_generated/{swarm,logs}"]
    Git -.->|"git status + rev-list + bounded diff"| WT["Workspace Git Worktrees"]
```

---

## Verified benchmarks

Measured under `#154` CPU isolation (`taskset -c 24-31`, 16 concurrent polling clients) on a 2,000-board-post and 50,000-transcript-line stress fixture:

| Metric | v1.17.0 | v1.18.0 | **v1.19.0** |
| --- | --- | --- | --- |
| Embedded sidecar UI (`/`) | `308,802 B` raw / `96,193 B` gz | `309,310 B` raw / `96,345 B` gz | **`311,474 B` raw (`304.2 KiB`) / `97,019 B` gz (`94.7 KiB`)** |
| Peak RSS (`VmHWM`, `--jitless` 2k/50k) | `64.56 MB` (`66,108 KB`) | `63.61 MB` (`65,136 KB`) | **`63.74 MB` (`65,268 KB`)** |
| Throughput (`--jitless` keep-alive) | `3,456.5 req/s` | `4,764.6 req/s` | **`4,584.3 req/s` (`2k/50k`, `taskset`)** |
| Cold audit HTTP (`16w` close) | `1,487.4 req/s` / `13.83 ms` p95 | `1,839.4 req/s` / `11.90 ms` p95 | **`1,833.4 req/s` / `14.11 ms` p95 (`0` errors)** |
| Simultaneous SSE (`x5` streams) | `5/5` (`0` drops) | `5/5` (`0` drops) | **`5/5` (`0` drops)** |
| E2E gate, replay, and Sloplint | `50/50` + `8/8` + `0 FAIL` | `51/51` + `8/8` + `0 FAIL` | **`52/52` + `8/8` + `0 FAIL / 0 REFLEX / 0 WARN`** |

---

## Quick start

Install the plugin into `~/.gemini/config/plugins/fleet/`:

```bash
./install.sh
```

Open Antigravity Customizations (`customization://fleet`) to enable `fleet`, then open the side pane (`sidecar://fleet/fleet_pane/`) or run `/fleet` in chat to start a tracked swarm.

> Note: Fleet became an Antigravity sidecar plugin in `v1.0.0`. The older standalone Rust binary remains at git tag `v0.12.0`.

---

## Security model

The sidecar binds strictly to `127.0.0.1`, validates loopback `Host` headers (`403` otherwise), and checks `Origin` headers on mutating `POST` requests (`403`). Oversized request bodies fail early with `413 Payload Too Large`. `GET /api/frame` resolves paths with `realpath` inside `<appData>/brain/` and checks that each image appears on the board or `view.json`, while `git_probe.mjs` clears `uri` for escaping symlinks inside worktrees. All nudges and broadcasts require explicit user confirmation (`confirm: true`), external network requests are blocked by CSP, and every response carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

---

## Development and verification

```bash
cd sidecars/fleet_pane && npm test
cd ../../frontend && npm ci && npm run build:live-web
npm run check:ui -- --lints
node e2e/test-live-web.mjs
```
