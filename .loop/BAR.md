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

## Completion pass conditions (18 Nov 2026 — see COMPLETION.md)

- C12 (cmd): Real engines are driven through an adapter, not a bare
  name. With a recording stand-in binary named `opencode` on PATH, a
  hand-out naming agent "opencode" invokes it as
  `run --model opencode-go/deepseek-v4.1-flash <task>` (the model from
  policies.rn `agent_model()`, exposed by /api/policy) and the session
  reaches verified done through the normal gate. With the real codex
  binary present but not logged in, a hand-out naming "codex" spawns
  the real process, streams its output, and lands needs-you naming the
  failure — never done, never hung. Sessions record their engine kind;
  a path agent is labelled custom/test mode in the API and the page.
  (`.loop/checks/engines.sh`)
- C13 (cmd): Steer and stop are real. A steer posted while a session
  works is delivered as a continuation run before commit+check (the
  fixture records both invocations; the final tree reflects the steer;
  the session still reaches verified done, and the transcript shows the
  operator's message). A stop posted while a session works kills the
  run within seconds — long before the agent's own sleep would end —
  and lands the session needs-you with "stopped by you" as the reason.
  Steer on a merged session and stop on a settled session are refused.
  (`.loop/checks/steer_stop.sh`)
- C14 (cmd): Successor work self-claims. A hand-out with `next` fires
  the successor automatically when — and only when — the session
  reaches verified done: the successor session exists with its origin
  recorded, runs, and reaches done itself; a chain of two fires in
  order. A session that lands needs-you fires nothing.
  (`.loop/checks/successor.sh`)
- C15 (cmd): The elevated front end (Hallmark-Rune pass) holds at 8
  viewport widths in both themes: no horizontal overflow, the three
  status groups and the detail view render, the theme toggle persists.
  (`.loop/checks/widths.sh`)
- C16 (cmd): Elevation breaks no flow: after the front-end pass, the
  full kit (`bash .loop/verify final`) is green end to end, including
  C12–C14.

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
- C17 (cmd): The settle boundary holds (thermonuclear fix wave): a
  successor fired at a verified-done settle joins the queue in
  hand-out order and never jumps a session queued earlier; steering
  leaves the persisted queue only after the run that carries it, so
  a kill -9 mid-delivery loses nothing and the retry re-delivers;
  a verified-done session whose chain never fired has it fired by
  startup recovery. (`.loop/checks/settle_races.sh`)
