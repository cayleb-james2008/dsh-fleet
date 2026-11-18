# Bar — fleet-rs scale-up

Kind: code + interface (a local web app: Rust binary serving one screen).
Delivered means: commits on `loop/work` in this repo; nothing pushed.
Facts never invented: agent availability (only what detection actually
finds), check results (only what the app ran), session states (only what
the state machine produced).

## Conditions

- C1 (cmd): `bash .loop/verify final` passes end to end — cargo build,
  cargo test, every `.loop/checks/*.sh`, and `proof.sh` printing PROOF OK.
- C2 (cmd): Sessions survive a server restart. Script: hand out a fixture
  task, let it reach done, kill the server, restart it on the same
  FLEET_DATA; the session is still listed with its status, transcript,
  check result and diff intact, and a session that was mid-work at the
  kill is honestly marked needs-you with the reason in its transcript.
  (`.loop/checks/persist.sh`)
- C3 (cmd): Every session has a log file on disk under the data dir that
  survives restart and contains its transcript lines.
  (`.loop/checks/persist.sh`, same run as C2)
- C4 (cmd): Agent support is detected, not assumed. `/api/policy` reports
  each of opencode/claude/codex as found or not found from the actual
  PATH; handing out work that names an agent which is not available is
  refused with an error that names the problem, before any worktree is
  created. (`.loop/checks/agents.sh`)
- C5 (cmd): Queueing is visible. With max_parallel forced to 1 by a test
  policy, three handed-out sessions show queue positions in the API while
  waiting and all reach a terminal state in hand-out order.
  (`.loop/checks/queue.sh`)
- C6 (cmd): The needs-you inbox aggregates. `/api/inbox` lists every
  needs-you session across the board, each with a reason (failed check,
  agent exit, worktree failure, restart interruption); a session whose
  check fails appears there naming the failed check.
  (`.loop/checks/inbox.sh`)
- C7 (cmd): Merge is safe. Merging a done session into a repo with
  uncommitted changes is refused with a clear error and leaves the repo
  untouched; a merge that conflicts aborts cleanly — repo not left
  mid-merge, session stays done and unmerged, error names the conflict.
  (`.loop/checks/merge_safety.sh`)
- C8 (cmd): The served page carries light and dark themes: both theme
  variable sets present, dark is the default, a theme toggle lives in a
  settings area, and the choice persists (localStorage).
  (`.loop/checks/theme.sh`)
- C9 (cmd): No emoji anywhere in the served page; status is carried by
  text plus drawn markers (inline SVG or CSS shapes), never by letters
  standing in for icons. (`.loop/checks/theme.sh`, same run as C8)
- C10 (judge): "Would this screen still fit another product's name?"
  Pass example: the Fleet screen, whose words and signature detail (the
  verified-done check line) belong to agent supervision. Fail example: the
  same layout with the product renamed to a generic chat app and nothing
  on it that only Fleet would say.
- C11 (owner): The look and feel of the finished screen. The loop never
  marks this passed.

## DIRECTION v1 (interface)

- Product: one screen where Cayleb supervises several AI coding agents
  working in parallel git worktrees, and only sees work that a check has
  verified.
- Character: exact, calm, a little dry. Status you can trust at a glance.
- World: a night-shift control board — instruments, not decoration. The
  neutrals are tinted toward slate blue; the one accent is the
  verified-done green, spent only where a check actually passed.
- Moments: the check result line in a session's detail (pass/fail with the
  real output) and the needs-you inbox — the two places the eye must land.
- Signature: every done session carries its check line — the command that
  was run and its verdict — as part of its identity in the list, not
  buried in detail. No other product on his screen shows that.
