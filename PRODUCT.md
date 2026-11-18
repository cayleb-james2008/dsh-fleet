# Fleet — product context

_Inferred from the owner's explicit brief (17 Nov 2026 scale-up order and the
approved goal), labelled as inference per impeccable init rules; no interview
was run because this is a scoped scale-up of an existing surface._

## What it is

Fleet is one screen where Cayleb runs his AI coding agents in parallel. He
hands out a task in plain words; the app launches a real CLI agent
(opencode, claude or codex) in its own git worktree of the target repo,
streams what it does, and — when the agent claims it is finished — runs the
task's check itself. Only a passing check earns "done". A done session
merges in one click. Nothing is babysat: work that needs him collects in one
inbox with the reason attached.

## Who it is for

One operator (Cayleb) supervising several agent sessions at once, often
glancing rather than watching. The screen must answer three questions at a
glance: what is running, what needs me, what is verified done.

## Surface mode

Operate. Scanability, consistency and honest status outrank expression.

## Rules the surface lives by

- Familiar shell: session sidebar + selected session's thread, one composer.
- Light and dark themes, toggle in settings, dark is the default.
- Icons are drawn symbols, never letters, never emoji.
- Status words are plain: queued, working, checking, done, needs you, merged.
- A claim on screen must be true of the system behind it (an agent that is
  not installed is shown as not installed; a check that failed says failed).
