# Backlog — fleet-rs

| id | what is wrong / unmet | reproduce | severity | status |
|---|---|---|---|---|
| B1 | Sessions live only in memory; a server restart loses the session list, counter and transcripts (baseline's known weakest point). Bars C2, C3. | Start server, hand out a task, restart server: session list is empty. | high | kept |
| B2 | Agent support is assumed, not detected: binary falls back to "codex" when nothing is installed, so hand-outs fail late and opaquely. Bar C4. | Run with an empty PATH and no FLEET_AGENT: policy still names codex; a hand-out spawns a missing binary. | medium | kept |
| B3 | Queueing exists but is invisible: queued sessions show no position and no order. Bar C5. | Test policy max_parallel=1, hand out 3 tasks: API shows three "queued" with no position. | medium | kept |
| B4 | No needs-you inbox: sessions that need the operator are scattered in the list with no aggregated view and no stated reason. Bar C6. | Fail a check: the session is marked needs-you in the list only; no inbox endpoint exists. | medium | kept |
| B5 | Merge is unsafe: it runs against whatever state the repo is in; a dirty tree or a conflict can leave the repo mid-merge. Bar C7. | Dirty the repo, merge a done session: git merge proceeds/fails uncontrolled; conflict leaves MERGE_HEAD behind. | high | kept |
| B6 | UI is dark-only, uses uppercase micro-labels and letter-free but unpolished chrome; no settings, no theme toggle, no drawn status icons. Bars C8, C9, C10. | Serve the page: single dark theme, no settings area. | medium | kept |

## Leads

- run_tag is epoch-seconds: two server starts inside one second could still collide on worktree paths (noted by the baseline checker). B1's persisted counter should retire this; confirm during B1.
| B7 | THERMONUCLEAR D1 (High): a session can be "verified done" and merge with {"merged":true} while landing nothing — agent output that the repo gitignores is never committed (git add -A skips it, commit result discarded), so the branch merges empty. | Fixture repo with output.txt in .gitignore; agent writes output.txt; check passes in the worktree; merge returns 200; repo has no output.txt. | high | kept |
| B8 | THERMONUCLEAR D3+D8+D10: a directory passes as an "executable file" agent (worktree created before the failure); /api/policy's source is a hardcoded display string, not the loaded file; some error bodies are built by unescaped string interpolation. | POST agent=/tmp → 201 + worktree; run with a different policy path → source still says policies.rn; merge error containing a quote → malformed JSON. | medium | kept |
| B9 | THERMONUCLEAR D4: retry is permanently broken once a session's worktree directory is deleted — `worktree add -b` refuses because the branch exists, stranding the session's committed work. | Fail a check, delete data/worktrees/<id>, retry → needs-you "worktree creation failed" forever. | medium | kept |
| B10 | THERMONUCLEAR D2: no timeout on agent or check execution — a hung agent or check holds its parallel slot and its session forever. | Hand out check `sleep 30` (or a sleeping agent): session sits in checking/working indefinitely. | medium | kept |
| B11 | THERMONUCLEAR D6: transcript, check output and diff are unbounded; every 25 transcript lines re-serializes all sessions (quadratic). A flooding agent grows memory, disk and every API response without limit. | Agent prints 20,000 lines: all stored and served; settle time ~7s vs <1s. | medium | open |
| B12 | THERMONUCLEAR D5+D7: the detail view re-renders every 2s, destroying scroll position, keyboard focus and just-shown error messages; session rows are clickable divs, not keyboard-operable. | Open a long transcript, scroll, wait for refresh: back at top. Merge error in detail view vanishes within one refresh. Tab through the list: rows unreachable. | medium | open |
