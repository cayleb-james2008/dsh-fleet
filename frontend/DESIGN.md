# Fleet front end: design (round 1, first draft)

Status: round 1. Built and looked at, not yet signed off by the art director. Pictures: `/home/cayleb/Work/scratch/goal-20261118/_final/be/fleet-<empty|work|detail|dialog>-<size>-<theme>.png`. Their data is fixture data: tasks are prefixed `[example]`, the repo is the launch kit's fixture repo.

## The job

Hand out coding tasks to agents that work in parallel, each in its own git worktree. Every task comes back verified (its check passed) or lands in Needs you with the reason. Nothing is babysat, and nothing calls itself done without its receipt.

Questions the first screen answers (`data-answers` in the code):
1. What needs me now? (the Needs you lane, `data-answers="1"`, and its count in the scan strip)
2. What is running? (the Working lane, `data-answers="2"`)
3. What came back verified, and what did it change? (the hero receipt and the Done lane, `data-answers="3"`)
4. How do I hand out the next task? (New session, in the top bar and in the hero when empty, `data-answers-via="4"`)

## Region map

Top bar, sticky: wordmark, version chip (opens the release page), search with the `/` key, New session (the one primary key), engines and settings icon, theme switch. Why: the four actions a person takes every time sit in one row, and nothing else competes with them.

Update strip (only when an update is available or staged): one slim line under the top bar, plain words. Why: the owner said updates must read as a quiet strip, not a dev-tool box.

Scan strip: four readings (Sessions, Needs you, Working, Verified) with rolling numbers, and the last 32 sessions as a tracker. Why: the counts answer question 1 and 2 at a glance, and the tracker shows the rhythm of outcomes without a chart.

Hero receipt: the newest verified session drawn large (task in Geologica 300, the readings in mono, the line "verified by" with its check), or, empty, the sentence "No receipt yet" with the New session key. Why: it is the product's defining object (see the signature), drawn at the size the first screen can give it.

Three lanes on one hairline-divided surface: Needs you (widest, first), Working, Done. Each lane head has a count pill. Why: the three buckets are the job's three states, and the reading order puts the question that needs a person first.

Session detail: a right column at 1100 px and wider, a bottom drawer below it. Why: the detail is the second question's answer; on a phone it must not cover the lanes permanently.

Settings: a right-hand Vaul drawer from the engines icon (policy sentence, agents found on this machine, version, Check for updates). Why: engines are read rarely; a drawer keeps them one press away and out of the board.

New session: a MorphingDialog grown from its button, with the form (repo, project, agent, task, check, then). Why: the form is a single decision; the dialog keeps the board visible behind it.

## Signature: the receipt

A finished session is a measured scan card: four corner ticks (the Vantage frame), the task as the headline in Geologica 300, the readings in Geist Mono with their units (`1 file`, `+12`, `−3`, the branch), the check's last printed line, and "verified by: <check command>". A session that needs a person carries its reason at the same weight as the headline, in the red token. A running session carries a steel border trail and a shimmering "Agent running" line, and both stop when the work stops. The hero receipt is the same object at display size.

## Library rows

| Library | Need of this product | Part used | File |
| --- | --- | --- | --- |
| Motion Primitives | a tab-like switch that glides between Transcript, Diff and Receipt; a figure that rolls when a session finishes; a running card that shows it runs; the New session dialog that grows from its button | `AnimatedBackground` (detail views), `SlidingNumber` (scan readings), `BorderTrail` and `TextShimmer` (running cards), `MorphingDialog` (New session) | `rune/used/components/ui/animated-background.tsx`, `sliding-number.tsx`, `border-trail.tsx`, `text-shimmer.tsx`, `morphing-dialog.tsx` |
| COSS UI | compact hairline controls: buttons, the search field with its key hint, the theme switch with icons, badges for states, the avatar for an agent, a tooltip for the icon-only engines key, text areas and inputs in the form | `Button`, `InputGroup`/`InputGroupInput`/`InputGroupAddon`, `Kbd`, `SegmentedControl`/`SegmentedControlItem`, `Badge`, `Avatar`/`AvatarFallback`, `Tooltip`, `Textarea`, `Input` | `rune/used/components/ui/*.tsx` (listed in `rune/used/MANIFEST.md`) |
| Cult UI | every disclosure: the refused-merge Details, the check output Details on a verified receipt | `Expandable`, `ExpandableTrigger`, `ExpandableContent` | `rune/used/components/ui/expandable.tsx` |
| Kibo UI | lane count pills; a stack of the agents that are running | `Pill` (lane heads), `AvatarStack` (scan strip) | `rune/used/components/kibo-ui/pill/index.tsx`, `avatar-stack/index.tsx` |
| Tremor | the recent-sessions strip: one block per session, coloured by its outcome, with a tooltip | `Tracker` | `rune/used/components/Tracker/Tracker.tsx` (its relative import of `utils/cx` is copied too, see the sync fix below) |
| Vaul | the detail drawer on narrow screens (bottom sheet); the settings sheet on every size (right side) | `Drawer.Root` with bottom and right directions | `vaul` package |
| Sonner | the toast that says what happened: handed out, steering sent, merged, a refused action with the server's words | `Toaster`, `toast.success`, `toast.error` | `sonner` package |
| Motion | the lane move when a session changes state (`layoutId` plus `layout`, on the `layout` preset); every duration and spring comes from `src/motion.ts` | `motion/react` `motion.div` | `src/motion.ts` (copied from the house starter, unchanged) |

Cult UI: used for disclosures (round 2). The native `<details>` is gone.

## Parity inventory (old page `git show HEAD:assets/index.html`)

Status key: K kept, C changed (reason), G gap (not built in round 1), D dropped (reason).

Top bar and popovers
- Needs you inbox button with count, popover with View session and Retry, inbox error line: G. The count is in the scan strip and the Needs you lane is the list; the View and Retry actions are in the lane card and detail. The popover is for round 2.
- New session button, opening the form: K (New session is a MorphingDialog, C).
- Engines popover (policy sentence, agents found, theme switch, version, Check for updates): C to a Vaul settings sheet; the theme switch moved to the top bar as a segmented control (COMMON.md names it as the toggle).
- Version chip: K (shown from 768 px, was 1100 px, C).
- Theme choice persisted in `localStorage` `fleet-theme`, default dark: K.
- Search by task, project, branch, `/` key: added (the house rule for list screens).

Board
- Polls `/api/policy` and `/api/sessions` every 2 s: K. `/api/inbox` is not polled while the inbox popover is a gap: G.
- Last good list kept with "Cannot reach Fleet. Showing the last list from <time>. Retrying.": K.
- "The board cannot reach Fleet" empty block with reconnect text: C (lanes stay; the note line says it).
- Loading skeletons: C, text only ("Loading the board.") so the four loading states are not complete (G on the skeleton shape).
- "No sessions yet" empty block: C (hero empty state with its one action, and three lanes with their own sentences).
- Lane empty sentences ("Nothing needs you. Failed checks and stopped runs land here with the reason.", "No agent is running right now.", "Work appears here once its check passes, with the check line as its receipt."): K verbatim.
- Card: keyboard activation (Enter and Space), `aria-current`, accessible name: K (a native button gives Enter and Space). The card's `aria-label` built from task, status and reason: D (the visible text is the name).
- Card reason clipped to 110 characters: C (two-line clamp).
- "Check passed — but this session needs you" on needs-you cards: K (exact wording, the verify2 pin).
- "The agent finished. Running your check.", "N steering messages waiting", test mode chip with its explanation as a title: K (the title attribute on the chip is D: the chip's text says "test mode" and the Agent line in the detail says the rest).
- Diff stat on done cards (files, +, −): K.
- Live pulse on working cards: C to BorderTrail and TextShimmer, with the same stop-when-done rule.
- Re-render discipline (list and detail keys, no focus loss): C. React reconciles the DOM, so focus and scroll survive a poll without the key logic; the check `ui.sh` greps for the old key names and now fails (see pins).

Detail
- Opens on click or Enter, focus moves to its heading; Close button and Escape return focus to the row: C. Focus moves to the row on Close (K); focus to the heading on open is G.
- Status pill, Close with its aria-label "Close this session": K.
- Honest banner (`role="status"`) with the reason: K.
- Facts: Project, Agent (test-mode wording), Branch, Queue: K.
- Chain notes (handed out automatically, its finish handed out, Then): K.
- Receipt card for verified sessions ("Check passed: verified done", the check line, "Check: <command>"): K.
- Reason box for needs-you sessions: K.
- Confirm group for Merge, Stop and Dismiss with the old wording and the buttons "Merge now", "Stop now", "Dismiss now", "Keep it": K.
- Action buttons: Merge this work, Retry this session, Dismiss, Stop this session: K. Steer jump button: D (the steer box is always on screen in the detail).
- merge_error: message and Details disclosure with the raw text: K (a native details element; the house has no disclosure part, see the gaps).
- "Merged <branch> into <target>." success line: K.
- Action error line (`role="alert"`): K (C: it is a live alert rather than a role-less paragraph).
- Tabs Transcript, Diff, Receipt: K, with the glide (C). Arrow, Home and End roving keys: G.
- Transcript: "N lines so far", "No output yet.", the last-2000-lines note with the log path: K.
- Diff: the "N files changed, +a −b lines, against the branch this session started from." line and "No changes on this branch yet.": K.
- Receipt tab: "No check has run yet.", "Passed.", "Failed with exit code N.", command and output: K.
- Steer: textarea with the draft kept per session in `sessionStorage` (`fleet-steer:<id>`), Send, "Write the message first.", the three hints: K.
- Steer box shown on any session that is not merged: K.

New session dialog
- Title, lead sentence, field labels and hints: K verbatim.
- Repo path required, with its message and focus on refusal; project default `fixture`; agent select listing only found agents with the test-mode default label: K.
- Task required; Ctrl+Enter or Cmd+Enter hands it out: K.
- Check command optional; Then (optional) with its hint: K.
- Refused repo path shown under the field (`role="alert"`) and focus returned to it: K. Other refusals in a form-level alert: K.
- Network failure text ("Could not reach the server. Your text is still here; try again when Fleet is running."): K.
- Double submit ignored while in flight: K. Success closes the dialog, opens the new session and shows a toast: K (C: toast added).

Update banner and version (COMMON.md, items 1 to 8)
- 1 Update now only on localhost, 127.0.0.1 or [::1]; elsewhere one plain line and no manual check on that page: K for the strip; the manual check in settings is shown but its result is plain text.
- 2 Dismiss per version, "Show update" kept in the header after a dismiss; a manual check un-dismisses: K for "Show update"; un-dismiss on a manual check: G (the Check button does not clear the dismissal yet).
- 3 plainUpdateError mapping for the six substrings, raw text in Details only: K.
- 4 Focus: the status line takes focus while busy (tabindex -1) and the live region is polite: K. Focus to "Show update" after Dismiss: G. Restart focus: G.
- 5 "Update now downloads it, checks it, and replaces this app. Restart to start using it.": G (not yet written under the button).
- 6 "<version> installed. Restart to use it." once; no "Not checked yet" after a restart (the page reloads): K.
- 7 Developer copy sentence: K.
- 8 Version always visible, link to the release page: K.
- Restart: the "N sessions are still running" refusal, the 60-second wait and the reload: K.

Sonner toasts: handed out, steering sent, merged, refused actions, installed update: K. Stopped and dismissed: K.

## Pinned hooks (tests and the check kit)

- `tests/cli.rs` and the 43 unit tests: pass (`cargo test` 43 and 3 passed on this build).
- `.loop/checks/verify2.sh` pins the exact text "Check passed — but this session needs you": present in the page, passes.
- `.loop/checks/ui.sh` pins JavaScript names in the old page: `lastDetailKey`, `scrollTop = prevScroll`, `detailError`, `tabindex`, `onkeydown`, `lastListKey`, `lastInboxKey`, `inboxError`, `slice(-80)`. It FAILS on this build because React has no such text. The behaviour it guards (no focus loss on a poll, errors kept, rows keyboard-operable) holds by construction in React; the pin needs replacing with a browser assertion. Decision for the lead, not changed here.
- `.loop/checks/theme.sh` pins served-page text: `[data-theme="light"]` (the light theme is in the bundle as `:root[data-theme="light"]`), `id="settings"` (the settings sheet is rendered when open, so it is not in the static page), `id="themeBtn"` (kept, on the top-bar switch, not inside settings), `<symbol id="i-check">` and `<symbol id="i-alert">` (icons are lucide now, no SVG sprite), no `letter-spacing` anywhere (the Vantage display heads use a tracked −0.035em, which the check forbids). FAILS for these reasons. Decision for the lead: keep the no-emoji and reduced-motion rules and drop the sprite and tracking pins.
- Ids kept on purpose: `themeBtn`, `settings`, `data-theme` on `<html>`, `localStorage` key `fleet-theme`, `fleet-steer:<id>`, `fleet-update-dismissed`.

## Shared-tool fix (recorded here, one line in the commit)

`frontend/scripts/sync-used.mjs` now also follows relative imports inside a copied part (Tracker imports `../../utils/cx`), so `rune/used` builds without a hand edit. Parts in `rune/used` are unedited copies.

## What was not checked

- Round 1 is not a finished screen: the Needs you inbox popover, the arrow-key tab roving, the update copy under the button, the focus rules after Dismiss and Restart are open (see the parity list).
- No `ALIVE.md`, `ROLE-COVERAGE.md` or `JOB.md` were written, and `scripts/role-coverage.mjs` and the starter's render check were not run. The hand-written disclosure (the native details element for merge errors) would fail the coverage rule, since the house has no disclosure part in the eight libraries.
- Hallmark sloplint (`--scope app --render`): 35 FAIL and 4 WARN remain. Most come from the library parts' own utilities (literal white, black and shadow values in `button`, `input-group`, `dialog` and the Tailwind defaults; `focus-within` borders and `opacity-64` disabled states in COSS). Two are mine and open: the New session dialog's width uses `min(560px, 100vw − 24px)`, and input fields sit at 1.28:1 against the canvas (the Vantage hairline is quiet by design). Not fixed in round 1.
- No screenshot at 768 or 320 px, no probe run for console errors, overflow or tap targets, and no contrast measurement of every token pair.
- Both themes were looked at at 1440 by 900 and 390 by 844 (empty and working states, the detail and the dialog). The light theme's lime is a fill and a rule only, because lime text fails 4.5:1 on the light surface.


## Round 2 (lead review, 2026-11-19)

- Hero: the top Needs-you session (its reason in the red at headline weight, keys Retry, Dismiss, Open); else the newest verified receipt. Capped: desktop max 260 px, headline two lines; phone one receipt row. Its lane card becomes a "shown above" row.
- Scan strip: the avatar stack only with two or more agents running; one agent shows `running <engine>`. No elapsed time: the API returns no start time for a session.
- Test mode: one chip in the top bar; cards no longer repeat it. The explanation sits in the chip's title and in the detail.
- New session: the native select is replaced by a SegmentedControl for up to three agents (a popover list above that). Fields use InputGroup. The check field shows a Kbd example. Dialog width no longer uses 100vw.
- Inbox: the "Needs you N" header key opens a Popover with each session's reason, View, Retry, and a "Go to Needs you" key. Focus returns to the Needs you lane after Dismiss and after a detail close.
- Detail: arrow keys, Home and End move between Transcript, Diff and Receipt (roving focus). The highlight is a solid ink pill. A restored session (transcript line from the server) shows a note.
- Updates: the copy under Update now is in place; focus goes to the "Show update" control after Dismiss and to the status line on Restart.
- Skeletons: lane-shaped while the board loads.
- Input edge: `--input` and `--edge` are 3:1 in both themes (theme.css).
- Lint: the Hallmark render lint is down from 38 FAIL to 16 FAIL. The parts' edits are in `rune/used/LOCAL-EDITS.md`; `sync-used.mjs` keeps those files. The remaining FAILs are the COSS focus-within borders and disabled states, a mask-image literal in the avatar stack, one `transition` in the Tracker, and the stamp that the minifier strips.
- Not done: the Needs-you inbox does not poll `/api/inbox` (it reads the same sessions list); the arrow-key roving is not tested in a browser run; the elapsed time for a running agent; the tablet 768 picture is taken but not re-reviewed after the last edit.
