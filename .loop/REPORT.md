# Fleet — scale-up run report

**Goal:** your agents working in parallel under one screen — you hand out
the work, it comes back verified done, nothing babysat.

**Bar:** `.loop/BAR.md` C1–C11 (C10 judge, C11 owner-only). Baseline kit
at loop-baseline (98b56d4): pass=3 fail=0. Final: **verify[final]:
pass=19 fail=0** (build, cargo test, 16 check scripts, proof.sh).

## What the improve pass + loop built (B1–B6)
- Sessions persist atomically and survive kill -9; interrupted sessions
  return as needs-you with the reason, never silently resumed.
- Agent support is detected, never assumed (executable files only);
  unknown agents are refused before any worktree exists.
- Queue positions are derived at serialization; a needs-you inbox
  aggregates every waiting session with its reason; retry re-runs in
  the same worktree with the failure attached.
- Merge safety: dirty/mid-merge/detached targets refused, conflicts
  abort clean, the landing is verified by ancestry.
- The board rebuilt: three groups, the check line as each done
  session's identity, light + dark themes (dark default, toggle in
  Settings), symbol icons only.

## Thermonuclear review — three rounds, fresh reviewers each time
- **Round 1** (standard + adversarial + checks-finder): the headline
  was D1 — merge reported success while landing nothing when agent
  output was gitignored. Fixed B7–B15 (ignored-content enumeration,
  cumulative diff, classified merge errors, bounded HTTP reads,
  policy timeouts, transcript caps).
- **Round 2**: both reviewers independently found the root class —
  "Fleet verifies a moment and merges a mutable branch." Fixed
  B16–B19: commit-then-check with a verified-commit pin the merge
  consumes; per-run ignored baselines; process-group-bounded runner
  (libc killpg); caps that survive restarts; store-loss recovery
  from logs; whole-request header deadline; POST content-type/origin
  discipline.
- **Round 3** (final round under the cap): kit re-ran 18/18 solo by
  the standard reviewer; C1–C10 graded MET. The adversarial reviewer
  found the deeper structural truth — the check still ran in the
  mutable worktree, not on the pinned tree — plus a family of
  siblings (index bits, quoted-path gate evasion, setsid ghosts,
  body drip, restore byte-cap, timeout overflow, banner honesty).
  **B20** answers them structurally: the check runs in a pristine
  checkout of the pinned commit; gates read the session's delta with
  NUL-separated git output; a /proc sweep kills detached processes
  holding the worktree at settle; the rest are fixed at their lines.
  verify2.sh proves all ten shapes; a mutation spot-check (disabling
  the index-bit clearing) makes it fail, as it should. One check
  assertion was corrected to the bar (merge_safety recorded a
  worktree "pass"; the bar judges the committed tree).

## Weakest remaining point
The restore path's trust in on-disk state: sessions.json is taken at
face value (a hand-edited store could mint a "done" session pointing
at any commit — inside the local trust boundary, no API path exists),
and the setsid sweep cannot reach a process that leaves the worktree
and closes its files (it also can no longer write the worktree
without reopening it by path). Both are named in the ledger.

## Replacement staging
~/workspace/restart-20261117/replacement/fleet/ — README.md (facts
re-verified against the final source), fleet.html (site page),
CLAIMS.md (every claim tied to its proof).

---

# Fleet — completion run report (18 Nov 2026)

**Goal (canonical):** agents working in parallel under one screen; work
handed out comes back verified done, nothing babysat. The v1 build
proved the shape with script agents; this run closed the gaps between
that shape and the full objective (`.loop/COMPLETION.md` G1–G6).

## Gaps closed
- **G1 real engines (C12).** An adapter drives each engine's real
  headless form with the model pinned from one config point —
  opencode `run --model`, claude `-p`, codex `exec` — with
  session-resume continuations. The model is `agent_model()` in
  policies.rn: `opencode-go/deepseek-v4.1-flash`, exposed at
  /api/policy. Path-spelled agents stay possible and are labelled
  engine=custom + test mode in the API and on the board.
- **G2 steer (C13).** A message posted mid-run is delivered as a
  continuation of the same session BEFORE commit+check; steering a
  settled session reopens it (pin cleared) and re-verifies.
- **G3 stop (C13).** Stop kills the run's process group within
  seconds and lands the session needs-you, "stopped by you"; a queued
  session is cancelled before it starts; a settled one refuses.
- **G4 successor chains (C14).** A hand-out's `next` fires only on a
  verified-done settle, in hand-out order, origins recorded both
  ways; needs-you cascades nothing.
- **G5 front end.** Hallmark-Rune elevation (ledger C3/C4 waves).
- **G6 public surfaces.** README and the site page state
  checker-proven facts only, including the honest engine limit
  below; the repo's main carries the whole completion.

## Verify numbers
Kit grew 19 → 23 checks across the run (engines, steer_stop,
successor, settle_races added). Final state: **verify pass=23
fail=0**, confirmed independently by three fresh checkers on their
own runs (22/22 at the G5 stage, 23/23 twice after).

## Checker verdicts
- Functionality waves: kit-first (checks authored before the fixes
  were trusted); C2-wave records the one real bug they caught
  (run_bounded never nulled stdin — the real codex blocked on it).
- G5 elevation: fresh checker FAIL (an unknown count rendered as 0;
  one middle-dot join survived) → fixed → fresh re-grade PASS.
- Thermonuclear review over the completion diff: the
  pristine-check/pin core survived every attack; four should-fix
  findings at the settle boundary (successor queue-jump and
  steer-loss both REPRODUCED). Fix wave + three micro-fixes for the
  narrower windows the fix-wave checker named: two further fresh
  checkers, both PASS with their own re-probes (ledger C5-wave).

## Public surfaces updated
- github.com/cayleb-james2008/dsh-fleet — main fast-forwarded to the
  completion (Cayleb's 18 Nov rule change: checker-passed work lands
  without waiting for his tap).
- Site page projects/dsh-fleet.html — completion facts, the
  credential-wall limit stated, and the walkthrough flagged as
  predating the completion build and the elevation. The site card
  captures and the walkthrough video predate both and are flagged
  for re-shoot; nothing was re-recorded in this run.

## Weakest remaining point
The settle boundary still has no atomic settle token: status
transitions are unconditional writes, so a stop landing between the
final flag read and the status store (instructions wide) is lost —
named in ledger C5-wave with its closure shape. Behind it: a real
engine CLI invoked by full path is labelled test mode and loses its
--model/--continue semantics (honest label, cannot fabricate done;
basename-match is the recorded follow-up).

## Impossibles, plainly
- **A live model run from this VM.** opencode and claude are not
  installed here; codex is installed but signed out (retired by
  Cayleb); the OpenCode Go key lives in secure storage and is not
  exportable. The engine path is proven by exact invocation shape
  against a recording stand-in and, for codex, up to its sign-in
  wall. A live run needs a host where an engine is signed in —
  Cayleb's desktop.
- **Re-shot captures/video** were out of scope by the brief: flagged
  on the page, not re-recorded.
