# fleet-rs

**Goal: your agents working in parallel under one screen — you hand out the work, it comes back verified done, nothing babysat.**

A fresh Rust + Rune rebuild, apart from the original Fleet app. One screen:
a session sidebar (working / needs you / done) beside the selected session's
chat. You hand out a task; the app launches a real CLI agent (`opencode`,
`claude`, or `codex` — whichever is installed; `FLEET_AGENT` overrides) in
its **own git worktree** of your repo and streams its output. When the agent
claims completion, the app runs the check attached to the task itself —
**status only becomes "done" on a passing check** — and shows the check
output and the diff. A done session merges in one click.

Session policies live in [`policies.rn`](policies.rn), a Rune script the app
executes: the parallel-session cap and the per-project default check
commands are behaviour defined there, not constants in the binary.

## Run

```sh
cargo run -- policies.rn        # http://127.0.0.1:8471
PORT=8471 FLEET_AGENT=opencode cargo run
```

## Proof

```sh
cargo test
./proof.sh   # two parallel fixture sessions -> verified done -> one merged
```
