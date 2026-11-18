# Ledger — fleet-rs

| row | first failing check + message | commit | outcome | cause |
|---|---|---|---|---|
| L0 | baseline: `bash .loop/verify baseline` → "verify[baseline]: pass=3 fail=0" (build, cargo test 3/3, proof.sh PROOF OK) | 98b56d4 (as found) | recorded | starting point for the scale-up run |
| B1 | persist.sh on baseline: "FAIL: after restart expected 2 sessions, got 0" | (see commit "B1: sessions persist…") | kept | sessions were memory-only; added sessions.json snapshot (atomic rename), per-session log files written per line and treated as the durable transcript, startup recovery marking working/checking as needs-you with reason, persisted counter (retires the run_tag same-second collision lead) |
| B2 | agents.sh on baseline: "FAIL: /api/policy has no agents array" (policy blindly named codex) | (see commit "B2: agent support detected…") | kept | agent_cmd fallback invented an agent; added detect_agents() probed via `which`, per-session agent field, resolve/validate at hand-out (bare name must be detected-found; path must be executable), honest 400 naming the problem before any worktree exists |
