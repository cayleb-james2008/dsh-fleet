<div align="center">

# Fleet

**Antigravity-native Swarm Sidebar Plugin** — turn native multi-agent swarms (`swarm`, `post_message`, `read_board`, `swarm_wait`, `plan.json`, and worker transcripts) into a keyboard-first auxiliary side pane inside Antigravity.

[![CI](https://img.shields.io/github/actions/workflow/status/cayleb-james2008/fleet/release.yml?branch=main&label=CI&style=flat-square)](https://github.com/cayleb-james2008/fleet/actions/workflows/release.yml)
[![Release](https://img.shields.io/github/v/release/cayleb-james2008/fleet?style=flat-square&color=blue)](https://github.com/cayleb-james2008/fleet/releases/latest)
[![Platform](https://img.shields.io/badge/Antigravity-Sidecar%20Plugin-111318?style=flat-square)](https://cayleb-james2008.github.io/projects/fleet.html)
[![Stack](https://img.shields.io/badge/Node%20ESM-React%2019%20%2B%20TS-3178c6?style=flat-square)](https://github.com/cayleb-james2008/fleet)
[![License](https://img.shields.io/github/license/cayleb-james2008/fleet?style=flat-square)](LICENSE)

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/triage-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/triage-light.png" />
  <img alt="Fleet Antigravity Swarm Sidebar — Needs-You Triage & Swarm Plan" src="docs/screenshots/triage-light.png" width="380" />
</picture>

</div>

---

## Sidebar Gallery

Fleet scales from `340px–380px` Antigravity auxiliary sidebars up to wide `1440px` panes with live host theme luminance sync (`theme-change` postMessage) and a Settings-only Light/Dark theme switch.

<table>
  <tr>
    <td align="center" width="25%">
      <strong>Triage &amp; Plan</strong><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/triage-dark.png" />
        <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/triage-light.png" />
        <img alt="Triage view" src="docs/screenshots/triage-light.png" width="220" />
      </picture>
    </td>
    <td align="center" width="25%">
      <strong>Board &amp; Pins</strong><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/board-dark.png" />
        <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/board-light.png" />
        <img alt="Board feed view" src="docs/screenshots/board-light.png" width="220" />
      </picture>
    </td>
    <td align="center" width="25%">
      <strong>Roster &amp; Telemetry</strong><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/roster-dark.png" />
        <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/roster-light.png" />
        <img alt="Roster telemetry view" src="docs/screenshots/roster-light.png" width="220" />
      </picture>
    </td>
    <td align="center" width="25%">
      <strong>Git Worktrees</strong><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/worktrees-dark.png" />
        <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/worktrees-light.png" />
        <img alt="Git worktrees view" src="docs/screenshots/worktrees-light.png" width="220" />
      </picture>
    </td>
  </tr>
</table>

---

## Capabilities

- **Swarm Bottleneck Heat Bar & 1-Click Copy Blocker:** Spot swarm saturation at a glance from a proportional `working` / `waiting` / `blocked` strip on Needs You, jump straight to the highest-impact thread via `Top #seq`, and copy a concise `~/`-masked Markdown escalation with 1-click **Copy blocker**.
- **Keyboard-First Sidebar Triage & `#seq` Quote-Reply:** Navigate Needs-You escalations with `j`/`k`, jump tabs with `1`–`5`, open worker chat with `o`/`Enter`, pin `#seq` with `p`, reply (`Re #<seq>:`) with `r` or Board `#seq` / **Reply** buttons, cycle Board quick filters (`All` / `Needs reply` / `[done]` / `[blocked]`) with `f`, and press `?` anytime for the keyboard cheatsheet.
- **1-Click Wave Digest, Unstick Presets & File Links:** Generate clean Markdown **Wave digest** summaries (pinned `#seq`s, active/waiting/stalled worker durations, and `~/`-masked dirty worktree files), expand worker **Activity Peek**, dispatch confirmation-gated **Unstick / Resume** nudges, inspect sanitized `Screenshot:` chips, and open files via `window.sidecar.ui.toggleAuxPane({ tabType: "fileView", uri })`.
- **Live SSE Push Stream & Polling Fallback:** Streams instant board/transcript fingerprint deltas over `GET /api/swarm/stream` (`text/event-stream`) with automatic interval fallback inside Antigravity's `SidecarApp` gateway.
- **Worker Roster, Context Saturation & `@mention` Graph:** Incrementally tails `transcript.jsonl` with bounded 16 KB tail rings to track real `input` / `cache_read` / `output` tokens, `% ctx` context saturation, shimmering active work, and replayable `@mention` topology.
- **Confined Workspace Git Worktrees & Inline Diff Peek:** Listens to `sidecar.getWorkspaceUris()` / `onWorkspaceChange()`, runs `git status --porcelain=v1 -z` and bounded (`<= 8 KB`) `GET /api/worktrees/diff` hunks with strict root + `realpathSync` CWE-22/CWE-59 symlink confinement, and exposes dirty/staged/untracked file rows with 1-click **Diff** peek drawers and **Open** actions.

---

## Architecture

```mermaid
flowchart LR
    Host["Antigravity Host<br/>(Aux Side Pane + /preload.js)"] <-->|"SidecarApp RPC + theme-change<br/>toggleConversation / toggleAuxPane"| Backend["Fleet Sidecar Backend<br/>(sidecars/fleet_pane/main.mjs)"]
    UI["Embedded Sidebar SPA<br/>(304.1 KiB raw / 91.9 KiB gz)"] <-->|"GET /api/swarm/stream (SSE)<br/>Pre-Gzipped ETag/304 JSON"| Backend
    Backend -->|"Zero-String Buffer Scan + 16 KB Ring"| Store["swarm_store.mjs"]
    Backend -->|"Debounced TTL + CWE-22/59 Diff Peek"| Git["git_probe.mjs"]
    Store -.->|"Read-Only"| Brain["~/.gemini/antigravity/brain/&lt;conv&gt;<br/>.system_generated/{swarm,logs}"]
    Git -.->|"git status + bounded diff"| WT["Workspace Git Worktrees"]
```

---

## Verified Benchmarks

Measured under `#154` CPU isolation (`taskset -c 24-31`, `16` concurrent polling workers) on a 16–20 worker / 2,000-board-post / 50,000-transcript-line stress fixture:

| Metric | v1.7.0 | v1.8.0 | **v1.9.0** |
| --- | --- | --- | --- |
| Embedded Sidecar UI (`/`) | `344,345 B` raw / `99,949 B` gz | `322,939 B` raw (`315.4 KiB`) / `95,371 B` gz (`93.1 KiB`) | **`311,446 B` raw (`304.1 KiB`) / `94,127 B` gz (`91.9 KiB`)** |
| Peak RSS (`VmHWM`, `--jitless` 16w) | `80.98 MB` | `80.49 MB` (`72.82 MB` sidecar `--jitless`) | **`73.16 MB` (`74,916 KB` sidecar `--jitless`, `99.86 MB` zero-flag under `taskset 24-31`)** |
| Throughput (`req/s`, 16w `taskset 24-31`) | `2,853.0 req/s` | `2,766.0 req/s` | **`1,351.7 req/s` (`--jitless`) / `1,088.0 req/s` (audit)** |
| Latency (`p50` / `p95`, `taskset 24-31`) | `5.54 ms` / `8.49 ms` | `5.64 ms` / `8.34 ms` (`15.38 ms` max) | **`14.38 ms` / `22.81 ms` (audit) · `15.66 ms` p95 (`--jitless`)** |
| Simultaneous SSE (`/api/swarm/stream` x5) | `5/5` (`0` drops) | `5/5` (`0` drops) | **`5/5` (`0` drops)** |
| E2E Gate + Replay + Sloplint | `35/35` + `8/8` + `0 FAIL / 0 WARN` | `36/36` + `8/8` + `0 FAIL / 0 WARN` | **`38/38` + `8/8` + `0 FAIL / 0 REFLEX / 0 WARN`** |

---

## Quick Start (Antigravity Plugin)

1. Install into `~/.gemini/config/plugins/fleet/` atomically:

```bash
./install.sh
```

2. Open Antigravity Customizations (**`customization://fleet`**) to enable **`fleet`**.
3. Open the auxiliary sidebar via **`sidecar://fleet/fleet_pane/`**, or invoke **`/fleet`** in chat to orchestrate a `plan.json`-tracked swarm with isolated worktrees.

> **Legacy v0.12.0:** Fleet pivoted cleanly to an Antigravity-native sidecar plugin in `v1.0.0`. The legacy standalone Rust binary remains preserved at git tag `v0.12.0`.

---

## Security Model

- Strictly loopback-bound (`127.0.0.1`) with `Host` loopback `403` validation and same-origin `Origin` checks on mutating `POST` routes (`403`).
- Prompt `413 Payload Too Large` abort before reading oversized request bodies.
- Strict CWE-22 / CWE-59 confinement on `GET /api/frame` (canonical `realpath` inside `<appData>/brain/` and listed on board/`view.json`) and `git_probe.mjs` worktree file URIs (escaping symlinks return empty `uri`).
- Confirmation-gated mutating nudges (`confirm: true`), zero external network calls, `frame-src 'none'`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.

---

## Development & Verification

```bash
cd sidecars/fleet_pane && npm test
cd ../../frontend && npm ci && npm run build:live-web
npm run check:ui -- --lints
node e2e/test-live-web.mjs
```
