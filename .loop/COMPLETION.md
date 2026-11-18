# Fleet — completion gap list (18 Nov 2026)

Canonical objective (Cayleb, approved 17 Nov): **your agents working in
parallel under one screen; work handed out comes back verified done,
nothing babysat.** Cayleb's completion order (18 Nov): complete the app
to that objective in FULL — simplification governs showcase wording,
never the app's scope.

State at the start of this pass: verify[final] pass=19 fail=0 (B1–B20).
Sessions persist, the check runs in a pristine checkout of the pinned
commit, merges consume the pin, needs-you inbox aggregates reasons,
queue positions are derived. What follows is what stands between that
build and the full objective.

## Environment facts (established firsthand, 18 Nov)

- `opencode` is NOT installed on this VM (it lives on Cayleb's desktop,
  logged into OpenCode Go). `claude` is NOT installed here.
- `codex` CLI 0.164.0-alpha.9 IS installed (`/opt/hatch-image/bin/codex`)
  but `codex login status` reports **Not logged in** — Cayleb's ChatGPT
  lapsed and he retired Codex (1 Nov). It can be spawned and will fail
  on auth; it cannot complete a run from this VM.
- The OpenCode Go API is reachable only through Muse's connector
  helper, which by design cannot export its key into an app's
  environment (connector doc, "Limits"). Fleet therefore gets the model
  as a config point (policies.rn `agent_model()`), and the live-model
  run happens where a real credential lives — Cayleb's desktop. On this
  VM the real-engine path is proven to the credential wall with the
  real codex binary, and the full positive path is proven through the
  adapter's exact invocation shape with a recording stand-in binary
  plus the fixture engine (explicitly labelled test mode).

## Gaps

### G1 — REAL ENGINES (headline gap)
Sessions invoke the agent as `<agent> <task>`: one bare argument. That
contract works only for fixture scripts written to it. The real CLIs
are interactive TUIs under that invocation — `opencode <task>` and
`codex <task>` open a terminal UI that never returns in a pipe.
- Build an engine adapter: per-engine non-interactive invocation —
  opencode `run`, claude `-p`, codex `exec --sandbox workspace-write`
  — with the task as the prompt, cwd = the session worktree, output
  streaming into the transcript through the existing bounded runner.
- One model config point: policies.rn `agent_model()` →
  `opencode-go/deepseek-v4.1-flash` (Cayleb's standing route: DeepSeek
  V4.1 Flash via OpenCode Go), passed to the engine that speaks that
  provider namespace (opencode `--model`). /api/policy exposes it.
- Every session records its engine kind (opencode / claude / codex /
  custom). A path agent stays possible (it is how fixtures run) and is
  labelled **custom command — test mode** in the API and the UI.
  Fixtures never wear a real engine's name.

### G2 — STEER
No way to talk to a session after hand-out. The operator can only
watch, retry blind, or merge.
- `POST /api/sessions/:id/steer {message}`: the message joins a
  per-session pending queue (persisted). The runner drains it between
  agent runs: after a run exits cleanly, pending messages are delivered
  as ONE continuation run using the engine's own resume mechanism
  (opencode `run --continue`, claude `-p --continue`,
  codex `exec resume --last`; custom agents get the message under the
  same contract as the task) — before commit and check, so "done"
  always describes a tree the operator has not since steered away from.
- Steer on a needs-you session = steer + retry (the message waits for
  the new run, which drains it after its first pass). Steer on a done
  session reopens it (pin cleared, work re-verified before any merge).
  Steer on a merged session is refused — the work already landed.
- The detail view gets a steer composer; the transcript shows every
  message as the operator's own lines.

### G3 — STOP
No way to stop a runaway session short of its policy timeout (up to
30 min) or killing the server.
- `POST /api/sessions/:id/stop`: while working/checking, sets the
  session's stop flag; the bounded runner polls it and kills the whole
  process group, landing the session in needs-you with "stopped by
  you" as the reason. While queued, stop cancels the hand-out before
  it starts. On a settled session it is refused with the status named.
- The detail view gets a Stop button on live sessions.

### G4 — SELF-CLAIMING QUEUE (successor work)
The parallel queue exists (cap + positions), but a finished session's
lane goes idle: nothing pulls the next item unless the operator hands
it out. Cayleb's standing rule: every order names its successor; a
finished session pulls it instead of idling.
- Hand-out accepts `next` (a task string, or an array for a chain).
  When a session reaches **verified done**, Fleet automatically hands
  out the next item — same repo, project, agent and resolved check —
  and the rest of the chain rides along. Both sessions' transcripts
  record the hand-off; the successor records what spawned it.
- A successor fires ONLY on verified done: not on needs-you (failed
  work must not cascade), not on merge (done is the finish line).
- The composer gains a "Then" field; session rows/detail show the
  chain link.

### G5 — FRONT END (ordered 18 Nov, sequenced LAST) — DONE 18 Nov: elevation landed under Hallmark-Rune, checker FAIL on two findings (F1/F2), fixed, fresh re-grade PASS; kit 22/22, lint 0/0 (ledger C3/C4 waves)
Cayleb graded the current front ends "very underwhelming". After the
functionality above lands and is checker-proven, the whole UI gets an
elevation pass under the Hallmark-Rune skill
(~/workspace/custom-skills/hallmark-rune/) — Fleet's vernacular is the
ops board: dense, scannable, status legible at a glance. The elevation
must keep every proven flow working: checker rounds grade BOTH
directions — the new look at 8 widths in both themes, and the full
verify kit still green.

### G6 — PUBLIC SURFACES — DONE 18 Nov: README updated to the completion facts, loop/work landed to main on github.com/cayleb-james2008/dsh-fleet per Cayleb's 07:48 rule change, site page updated to checker-proven facts only; captures/video flagged stale for re-shoot, not re-recorded. Thermonuclear fix wave (C17) landed with it — ledger C5-wave.
README + the public repo (github.com/cayleb-james2008/dsh-fleet) and
the site page (landing-work/site, projects/dsh-fleet.html) are updated
to checker-proven facts only — including the honest engine limit:
real-engine invocation is built and proven to the credential wall on
this VM; a full live-model run needs a machine with a real agent
credential (Cayleb's desktop). Stale site captures/video are FLAGGED
for re-shoot, not re-recorded in this pass.

## Non-gaps (already at the objective — do not rebuild)
Persistence + restart honesty, pristine-checkout checks on the pinned
commit, merge pinning and safety, needs-you inbox with reasons, queue
positions under the parallel cap, bounded runs with timeouts,
transcript caps, HTTP discipline. The completion work plugs into this
machinery; it does not replace it.
