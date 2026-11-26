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

- **1-Click Gate Readiness & Context-Aware Next-Gate Action:** Automatically tracks `[done]` -> `[verified]` -> `[scale-verified]` / `[blocked]` board gates into a compact **Gate readiness** strip in **Triage** with 1-click `#seq` stage jumps plus a **Nudge / Unblock Next Gate** button pre-filling `Re #<seq>:` + branch/commit context into a confirmation-gated composer.
- **Per-Worker Token & Burn-Rate Guard Strip:** Inspect proportional per-worker token consumption right in **Triage** and **Roster** with a live stacked segment bar, top-3 consumer share percentages, and automatic `High burn` alerts flagging runaway workers at a glance.
- **Swarm Bottleneck Heat Bar & 1-Click Copy Blocker:** Spot swarm saturation at a glance from a proportional `working` / `waiting` / `blocked` strip on Needs You, jump straight to the highest-impact thread via `Top #seq`, and copy a concise `~/`-masked Markdown escalation with 1-click **Copy blocker**.
- **Multi-Worker Broadcast & Filtered Board Export:** Select `@all`, `working`, `waiting`, or custom worker subsets inside **Roster -> Broadcast** to dispatch confirmation-gated multi-worker nudges (`conversationIds`), and export active **Board** filters in 1 click as sanitized `.md` or `.json` reports (`~/`-masked paths, zero `/home/` leaks).
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
    UI["Embedded Sidebar SPA<br/>(294.4 KiB raw / 91.8 KiB gz)"] <-->|"GET /api/swarm/stream (SSE)<br/>Pre-Gzipped ETag/304 JSON"| Backend
    Backend -->|"Zero-String Buffer Scan + 16 KB Ring"| Store["swarm_store.mjs"]
    Backend -->|"Debounced TTL + CWE-22/59 Diff Peek"| Git["git_probe.mjs"]
    Store -.->|"Read-Only"| Brain["~/.gemini/antigravity/brain/&lt;conv&gt;<br/>.system_generated/{swarm,logs}"]
    Git -.->|"git status + bounded diff"| WT["Workspace Git Worktrees"]
```

---

## Verified Benchmarks

Measured under `#154` CPU isolation (`taskset -c 24-31`, `16` concurrent polling workers) on a 16–20 worker / 2,000-board-post / 50,000-transcript-line stress fixture:

| Metric | v1.11.0 | v1.12.0 | **v1.13.0** |
| --- | --- | --- | --- |
| Embedded Sidecar UI (`/`) | `301,090 B` raw (`294.0 KiB`) / `93,839 B` gz (`91.64 KiB`) | `300,853 B` raw (`293.8 KiB`) / `93,861 B` gz (`91.66 KiB`) | **`301,440 B` raw (`294.4 KiB`) / `94,030 B` gz (`91.83 KiB`)** |
| Peak RSS (`VmHWM`, `--jitless` 16w) | `64.79 MB` (`66,340 KB` `--jitless` 2k/50k, `95.49 MB` default) | `65.55 MB` (`67,128 KB` `--jitless` 2k/50k, `69.16 MB` audit) | **`64.87 MB` (`66,424 KB` `--jitless` 2k/50k, `95.47 MB` default)** |
| Throughput (`req/s`, 16w `taskset 24-31`) | `8,257.6 req/s` (`--jitless` keep-alive) · `28,821.2 req/s` (keep-alive) | `5,114.1 req/s` (`--jitless` keep-alive) · `21,926.4 req/s` (keep-alive) | **`7,257.0 req/s` (`--jitless` keep-alive) · `23,130.6 req/s` (keep-alive) · `1,211.0 req/s` (cold audit)** |
| Latency (`p50` / `p95`, `taskset 24-31`) | `1.67 ms` / `2.67 ms` (`--jitless`) · `9.22 ms` / `13.97 ms` (audit) | `2.52 ms` / `4.24 ms` (`--jitless`) · `16.53 ms` / `23.45 ms` (audit) | **`1.85 ms` / `3.10 ms` (`--jitless`) · `11.35 ms` / `14.71 ms` (cold audit)** |
| Simultaneous SSE (`/api/swarm/stream` x5) | `5/5` (`0` drops) | `5/5` (`0` drops) | **`5/5` (`0` drops)** |
| E2E Gate + Replay + Sloplint | `42/42` + `8/8` + `0 FAIL / 0 REFLEX / 0 WARN` | `43/43` + `8/8` + `0 FAIL / 0 REFLEX / 0 WARN` | **`43/43` + `8/8` + `0 FAIL / 0 REFLEX / 0 WARN`** |

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
