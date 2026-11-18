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
