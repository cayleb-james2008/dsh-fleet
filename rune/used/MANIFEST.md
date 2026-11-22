# rune/used: the library parts this app uses

Copied unchanged (apart from the house edits recorded in the starter's STACK.lock.md) from the owner's house-frontend starter by `frontend/scripts/sync-used.mjs`. Only parts the screens import are here; `npm run sync-used` refreshes this folder and this table. npm packages the parts need (react, motion, radix, vaul, sonner, recharts, lucide, ...) are in `frontend/package.json`.

| Part | Library | Licence | Imported by |
| --- | --- | --- | --- |
| `components/Tracker/Tracker.tsx` | Tremor Raw (tremor.so) | Apache-2.0 | src/App.tsx |
| `components/kibo-ui/avatar-stack/index.tsx` | Kibo UI (kibo-ui.com) | MIT | src/App.tsx |
| `components/kibo-ui/pill/index.tsx` | Kibo UI (kibo-ui.com) | MIT | src/App.tsx, src/board.tsx |
| `components/ui/animated-background.tsx` | Motion Primitives (motion-primitives.com) | MIT | src/detail.tsx |
| `components/ui/avatar.tsx` | COSS UI (coss.com/ui) | MIT | rune/used/components/kibo-ui/pill/index.tsx, src/App.tsx |
| `components/ui/badge.tsx` | COSS UI (coss.com/ui) | MIT | rune/used/components/kibo-ui/pill/index.tsx, src/App.tsx, src/board.tsx, src/detail.tsx |
| `components/ui/border-trail.tsx` | Motion Primitives (motion-primitives.com) | MIT | src/board.tsx |
| `components/ui/button.tsx` | COSS UI (coss.com/ui) | MIT | rune/used/components/kibo-ui/pill/index.tsx, src/App.tsx, src/board.tsx, src/detail.tsx, src/update.tsx |
| `components/ui/expandable.tsx` | Cult UI (cult-ui.com) | MIT | src/detail.tsx, src/update.tsx |
| `components/ui/input-group.tsx` | COSS UI (coss.com/ui) | MIT | src/App.tsx |
| `components/ui/input.tsx` | COSS UI (coss.com/ui) | MIT | rune/used/components/ui/input-group.tsx |
| `components/ui/kbd.tsx` | COSS UI (coss.com/ui) | MIT | src/App.tsx |
| `components/ui/morphing-dialog.tsx` | Motion Primitives (motion-primitives.com) | MIT | src/App.tsx |
| `components/ui/popover.tsx` | shadcn/ui on Radix UI primitives | MIT | src/App.tsx |
| `components/ui/segmented-control.tsx` | COSS UI (coss.com/ui) | MIT | src/App.tsx |
| `components/ui/sliding-number.tsx` | Motion Primitives (motion-primitives.com) | MIT | src/App.tsx |
| `components/ui/spinner.tsx` | COSS UI (coss.com/ui) | MIT | rune/used/components/ui/button.tsx |
| `components/ui/text-shimmer.tsx` | Motion Primitives (motion-primitives.com) | MIT | src/board.tsx |
| `components/ui/textarea.tsx` | COSS UI (coss.com/ui) | MIT | rune/used/components/ui/input-group.tsx, src/App.tsx, src/detail.tsx |
| `components/ui/tooltip.tsx` | COSS UI (coss.com/ui) | MIT | src/App.tsx |
| `hooks/useClickOutside.tsx` | House presets (house-frontend starter) | owner's | rune/used/components/ui/morphing-dialog.tsx |
| `lib/useMediaQuery.ts` | House presets (house-frontend starter) | owner's | src/App.tsx |
| `lib/utils.ts` | House presets (house-frontend starter) | owner's | rune/used/components/kibo-ui/avatar-stack/index.tsx, rune/used/components/kibo-ui/pill/index.tsx, rune/used/components/ui/animated-background.tsx, rune/used/components/ui/avatar.tsx, rune/used/components/ui/badge.tsx, rune/used/components/ui/border-trail.tsx, rune/used/components/ui/button.tsx, rune/used/components/ui/expandable.tsx, rune/used/components/ui/input-group.tsx, rune/used/components/ui/input.tsx, rune/used/components/ui/kbd.tsx, rune/used/components/ui/morphing-dialog.tsx, rune/used/components/ui/popover.tsx, rune/used/components/ui/segmented-control.tsx, rune/used/components/ui/spinner.tsx, rune/used/components/ui/text-shimmer.tsx, rune/used/components/ui/textarea.tsx, rune/used/components/ui/tooltip.tsx, src/App.tsx, src/board.tsx, src/detail.tsx |
| `utils/cx.ts` | House frontend starter | owner's | rune/used/components/Tracker/Tracker.tsx |
