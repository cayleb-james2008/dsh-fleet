# Fleet

Your agents, working in parallel, under one screen. You hand out the work; it
comes back verified done — or it lands in a **Needs you** inbox with the reason
attached. Nothing is babysat, and nothing calls itself done without the
receipt.

Fleet is a small Rust server with a single-page board. Each session is a task
handed to a coding agent — [opencode](https://opencode.ai),
[Claude Code](https://claude.com/product/claude-code), or
[Codex](https://openai.com/codex) — running in its own git worktree of your
repo. When the agent stops, Fleet runs **your check command** itself. The
session is done only when that check passes; the check's own output is the
receipt, and it travels with the session everywhere it is listed.

## The board

Sessions live in three groups:

- **Needs you** — the check failed, the agent errored, a merge was refused,
  the run timed out. Each one says why, in the session's own words and the
  check's own output. This group is also an inbox: one list of everything
  waiting on a human, across every session.
- **Working** — the agent is running, or Fleet is running the check.
- **Done** — the check passed. The session's row carries the check line
  itself ("3 passed in 4.12s", "PROOF DONE"), not just a green badge.

From a finished session you can read the full diff Fleet computed against the
branch it diverged from, and merge it into the target branch — or retry a
failed session, which re-runs the agent in the same worktree with the failure
attached.

## What "verified" means here

- **The check is the product's own command**, named per project in a policies
  file (`policies.rn`, Rune) — the same command a developer would run.
  Whoever grades the work, it is never the agent.
- **Merging is defensive.** Fleet refuses to merge into a dirty or
  mid-merge target, aborts its own failed merge cleanly, and leaves the
  session in Done with the refusal attached when it cannot land. A merge is
  only reported once the session's branch is verifiably an ancestor of the
  target.
- **Nothing is silently dropped.** If an agent writes files your repo's
  gitignore excludes, they can never be committed — so the session goes to
  Needs you, naming the files, instead of reporting a "done" whose work is
  not in the diff. The diff a session shows is the whole branch, across
  every attempt, so what you review is what a merge would land.
- **Runs are bounded.** Agent and check runs take their timeout from the
  policies file; a run that exceeds it is killed and the session says so.
  Transcripts are capped on the board; the full log is kept on disk, per
  session, and the cap marker names the file.

## Persistence

Sessions survive restarts. State is written atomically (a temp file renamed
over the old one) after every change; each session's full transcript is its
own log file. A session that was mid-run when the server stopped comes back
in **Needs you**, with "the server restarted while this session was …"
attached — never silently resumed, never lost.

## Agents, honestly

Fleet detects the agents it can actually run: a name counts only when it
resolves to an executable file on the PATH — a directory named `claude` does
not make Claude available. Asking for an agent that is not there is refused
up front, before any worktree is created, and the board says which agents
this machine really has. When a session names no agent, it runs the
project's policy default.

## Running it

```sh
cargo run -- policies.rn               # serves the board on $PORT (default 8471)
```

State lands in `./fleet-data/` (override with `FLEET_DATA`): the session
store, one log file per session, and the worktrees — one per session, each
on its own branch of the session's repo.

## Checks

`bash .loop/verify` builds the binary, runs the Rust tests, and runs the
check kit: persistence across a `kill -9`, agent detection and refusal,
merge safety against dirty and mid-merge targets, gitignored-output
detection, retry after a deleted worktree, the timeout path, the inbox,
the HTTP body's size and read limits, and both themes. The kit is the bar:
it passes end to end, and it is re-run after every change.

## Layout

- `src/main.rs` — the whole server: sessions, the runner, the checker, the
  merger, persistence, and the HTTP API.
- `assets/index.html` — the board: the three groups, the session detail with
  its transcript, diff and check receipt, the Needs-you inbox, and Settings.
  Light and dark themes, dark by default, the switch in the settings footer;
  icons are drawn symbols, never letters.
- `policies.rn` — the Rune policies file: per-project check command, default
  agent, and run timeout.
