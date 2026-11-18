# Backlog — fleet-rs

| id | what is wrong / unmet | reproduce | severity | status |
|---|---|---|---|---|
| B1 | Sessions live only in memory; a server restart loses the session list, counter and transcripts (baseline's known weakest point). Bars C2, C3. | Start server, hand out a task, restart server: session list is empty. | high | kept |
| B2 | Agent support is assumed, not detected: binary falls back to "codex" when nothing is installed, so hand-outs fail late and opaquely. Bar C4. | Run with an empty PATH and no FLEET_AGENT: policy still names codex; a hand-out spawns a missing binary. | medium | open |
| B3 | Queueing exists but is invisible: queued sessions show no position and no order. Bar C5. | Test policy max_parallel=1, hand out 3 tasks: API shows three "queued" with no position. | medium | open |
| B4 | No needs-you inbox: sessions that need the operator are scattered in the list with no aggregated view and no stated reason. Bar C6. | Fail a check: the session is marked needs-you in the list only; no inbox endpoint exists. | medium | open |
| B5 | Merge is unsafe: it runs against whatever state the repo is in; a dirty tree or a conflict can leave the repo mid-merge. Bar C7. | Dirty the repo, merge a done session: git merge proceeds/fails uncontrolled; conflict leaves MERGE_HEAD behind. | high | open |
| B6 | UI is dark-only, uses uppercase micro-labels and letter-free but unpolished chrome; no settings, no theme toggle, no drawn status icons. Bars C8, C9, C10. | Serve the page: single dark theme, no settings area. | medium | open |

## Leads

- run_tag is epoch-seconds: two server starts inside one second could still collide on worktree paths (noted by the baseline checker). B1's persisted counter should retire this; confirm during B1.
