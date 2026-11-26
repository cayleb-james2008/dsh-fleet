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

In **Triage**, Fleet pulls unanswered questions, blocked posts, quota pauses, pending verification stages, and `plan.json` workstreams into a single inbox. A gate readiness card tracks `[done]`, `[verified]`, `[scale-verified]`, and `[blocked]` tags alongside a wave velocity pill showing pass percentage, gate counts, and a jump button to the newest shipped post. A bottleneck bar summarizes working, waiting, and blocked counts, and a token burn strip plots each worker's share of total tokens so high-spend loops stand out quickly.

Each triage item includes keyboard shortcuts (`j` and `k` to move, `o` or `Enter` to open chat, `p` to pin `#seq`, `r` to reply, `1` to `5` to switch tabs, `?` for help), inline activity peeks showing recent tool calls, unstick presets, `~/`-masked blocker copy buttons, and direct file openers through `window.sidecar.ui.toggleAuxPane`.

In **Board**, Fleet reads `board.jsonl` with quick filters (`All`, `Needs reply`, `[done]`, `[blocked]`, cycled with `f`), pinned posts, `#seq` quote replies, Markdown wave digests, and `.md` or `.json` board exports stripped of local `/home/` paths. In **Roster**, you can inspect worker duration badges, token breakdowns, and context saturation, or open a confirmation-gated broadcast composer to nudge `@all`, `working`, `waiting`, or custom worker subsets. In **Graph**, a replayable `@mention` graph traces message flow across the swarm. In **Git**, Fleet probes workspace worktrees with `git status --porcelain=v1 -z` and shows bounded inline diffs (`GET /api/worktrees/diff`).

Live updates stream over `GET /api/swarm/stream` (`text/event-stream`) in standalone mode and fall back to polling inside Antigravity's `SidecarApp` gateway. Under the hood, `swarm_store.mjs` tails `transcript.jsonl` incrementally in 32 KB chunks, parses JSON only for the newest 16 tail lines, and avoids holding large parsed board graphs in memory.

---

## Architecture

```mermaid
flowchart LR
    Host["Antigravity Host<br/>(Aux Side Pane + /preload.js)"] <-->|"SidecarApp RPC + theme-change<br/>toggleConversation / toggleAuxPane"| Backend["Fleet Sidecar Backend<br/>(sidecars/fleet_pane/main.mjs)"]
    UI["Embedded Sidebar SPA<br/>(294.8 KiB raw / 91.9 KiB gz)"] <-->|"GET /api/swarm/stream (SSE)<br/>Pre-Gzipped ETag/304 JSON"| Backend
    Backend -->|"Zero-String Buffer Scan + 16-Line Tail"| Store["swarm_store.mjs"]
    Backend -->|"Debounced TTL + CWE-22/59 Diff Peek"| Git["git_probe.mjs"]
    Store -.->|"Read-Only"| Brain["~/.gemini/antigravity/brain/&lt;conv&gt;<br/>.system_generated/{swarm,logs}"]
    Git -.->|"git status + bounded diff"| WT["Workspace Git Worktrees"]
```

---

## Verified benchmarks

Measured under `#154` CPU isolation (`taskset -c 24-31`, 16 concurrent polling clients) on a 2,000-board-post and 50,000-transcript-line stress fixture:

| Metric | v1.12.0 | v1.13.0 | **v1.14.0** |
| --- | --- | --- | --- |
| Embedded sidecar UI (`/`) | `300,853 B` raw / `93,861 B` gz | `301,440 B` raw / `94,030 B` gz | **`301,836 B` raw (`294.8 KiB`) / `94,150 B` gz (`91.94 KiB`)** |
| Peak RSS (`VmHWM`, `--jitless` 2k/50k) | `65.55 MB` (`67,128 KB`) | `64.87 MB` (`66,424 KB`) | **`63.05 MB` (`64,564 KB`)** |
| Peak RSS (`VmHWM`, cold default audit) | `69.16 MB` (`16w`) | `119.63 MB` (`16w`) | **`101.73 MB` (`16w`)** |
| Throughput (`--jitless` keep-alive) | `5,114.1 req/s` | `7,257.0 req/s` | **`3,872.7 req/s`** (`2k/50k` `#154` `nice -n 19`) |
| Cold audit HTTP (`16w` close) | `16.53 ms` / `23.45 ms` p95 | `2,315.7 req/s` / `9.30 ms` p95 | **`1,272.3 req/s` / `15.30 ms` p95 (`0` errors)** |
| Simultaneous SSE (`x5` streams) | `5/5` (`0` drops) | `5/5` (`0` drops) | **`5/5` (`0` drops)** |
| E2E gate, replay, and Sloplint | `43/43` + `8/8` + `0 FAIL` | `43/43` + `8/8` + `0 FAIL` | **`44/44` + `8/8` + `0 FAIL / 0 REFLEX / 0 WARN`** |

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
