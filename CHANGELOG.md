# Changelog

Each release is tagged `vMAJOR.MINOR.PATCH` and published on GitHub Releases with
binaries and a `SHA256SUMS` file. The running app shows its version and can update
itself from the newest release (see README, "Versions and updates").

## 0.2.0 - 2026-11-19

- Board redesign: Needs you, Working and Done groups; a detail panel with
  Transcript, Diff and Receipt tabs; an honest banner for a needs-you session
  whose check passed.
- Per-session record files (`logs/<id>.record.json`): a lost `sessions.json` is
  rebuilt from them, so done stays done and merged stays merged. Rebuilt sessions
  say so.
- Retry hands the agent the failure: the task, the failing check's command and the
  tail of its output. A worktree that lost its link to the repo is re-attached from
  its branch, and two retries at once run once.
- Dismiss: a needs-you session that cannot succeed can be archived off the board
  and the inbox; its log stays on disk.
- `merge_target` (where Merge lands) and `merge_error` (the last refused merge,
  with git's own text in `detail`) in the session JSON; refusals are plain sentences.
- Checks: a failed check's reason names its exit code and output; a blank check
  falls back to the policy default; `check_ran` and `check_exit` are reported.
- Host rule: only loopback names, plus `FLEET_ALLOWED_HOSTS`; header limits (100
  headers, 32 KiB); JSON-only POST.
- `fleet-rs --version`, `GET /api/version`, and self-update from GitHub releases
  (`FLEET_UPDATE_MODE`). Restart is refused while any session is queued, working or
  checking.

## 0.1.0 - 2026-11-17

- First build: sessions run in their own git worktrees, a check decides done,
  merge with safety checks, persistence and restart recovery, steering and stop,
  successor chains, and the board.
