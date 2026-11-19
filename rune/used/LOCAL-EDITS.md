# rune/used: local edits

Parts copied from the house starter that this repo edits on purpose. `frontend/scripts/sync-used.mjs` does NOT overwrite the files listed here (it skips them), so a sync keeps these edits. Each line: part, what changed, why.

| Part | Change | Why |
|---|---|---|
| `components/ui/button.tsx` | `transition-shadow` to `transition-[background-color,border-color,color]` | focus ring is a box-shadow; a transitioned shadow makes the ring fade in (Hallmark 15) |
| `components/ui/input.tsx` | `transition-shadow` to `transition-[background-color,border-color,color]` | focus ring is a box-shadow; a transitioned shadow makes the ring fade in (Hallmark 15) |
| `components/ui/input-group.tsx` | `transition-shadow` to `transition-[background-color,border-color,color]` | focus ring is a box-shadow; a transitioned shadow makes the ring fade in (Hallmark 15) |
| `components/ui/textarea.tsx` | `transition-shadow` to `transition-[background-color,border-color,color]` | focus ring is a box-shadow; a transitioned shadow makes the ring fade in (Hallmark 15) |
| `components/ui/badge.tsx` | `transition-shadow` to `transition-[background-color,border-color,color]` | focus ring is a box-shadow; a transitioned shadow makes the ring fade in (Hallmark 15) |
| `components/ui/tooltip.tsx` | `transition-[top,left,right,bottom,transform]` to `transition-transform` | never transitions top/left (Hallmark 10a); the positioner moves by transform |
| `components/ui/expandable.tsx` | `transition-all duration-300` to `transition-[opacity,transform] duration-300` | transition: all is banned (Hallmark 10a); the two properties that change are listed |
| `components/kibo-ui/avatar-stack/index.tsx` | `[&>*]:transition-all` to `[&>*]:transition-transform` | transition: all is banned (Hallmark 10a); only the stacking offset moves |

## Round 3 (lint to 0 FAIL)

| Part | Change | Why |
|---|---|---|
| `components/ui/button.tsx` | `disabled:opacity-64` to `disabled:bg-track disabled:text-disabled disabled:cursor-not-allowed` | Hallmark 39a: three disabled channels (fill, ink, cursor) instead of opacity alone |
| `components/ui/input.tsx` | `disabled:opacity-64` to `disabled:bg-track disabled:text-disabled disabled:cursor-not-allowed` | Hallmark 39a: three disabled channels (fill, ink, cursor) instead of opacity alone |
| `components/ui/input-group.tsx` | `has-[input:focus-visible,textarea:focus-visible]:border-ring ` to ` ` | Hallmark 39a: focus is drawn by the ring, not a border |
| `components/ui/input-group.tsx` | `has-[input:focus-visible,textarea:focus-visible]:has-[input[aria-invalid],textarea[aria-invalid]]:border-destructive/64 ` to ` ` | Hallmark 39a: invalid state drawn by the ring, not a border |
| `components/ui/input-group.tsx` | `has-[input:disabled,textarea:disabled]:opacity-64` to `has-[input:disabled,textarea:disabled]:text-disabled has-[input:disabled,textarea:disabled]:cursor-not-allowed` | Hallmark 39a: disabled by ink and cursor, not opacity alone |
| `components/ui/textarea.tsx` | `disabled:opacity-64` to `disabled:bg-track disabled:text-disabled disabled:cursor-not-allowed` | Hallmark 39a: three disabled channels (fill, ink, cursor) instead of opacity alone |
| `components/ui/segmented-control.tsx` | `transition-[width,height,translate]` to `transition-transform` | Hallmark 10a: width and height do not transition |
| `components/ui/segmented-control.tsx` | `disabled:opacity-64` to `disabled:bg-track disabled:text-disabled disabled:cursor-not-allowed` | Hallmark 39a: three disabled channels (fill, ink, cursor) instead of opacity alone |
| `components/ui/tooltip.tsx` | `transition-[width,height,scale,opacity]` to `transition-[opacity,transform]` | Hallmark 10a: width and height do not transition; the part moves by transform and opacity |
| `components/ui/badge.tsx` | `disabled:opacity-64` to `disabled:bg-track disabled:text-disabled disabled:cursor-not-allowed` | Hallmark 39a: three disabled channels (fill, ink, cursor) instead of opacity alone |
| `components/Tracker/Tracker.tsx` | `px-[0.5px]` to `px-0` | Hallmark 24b: off the 4px scale; the sm breakpoint keeps the 1px inset |
| `components/kibo-ui/pill/index.tsx` | `white_100%` to `currentColor_100%` | Hallmark 48: the mask ignores colour (it reads alpha only); no literal white |
| `components/Tracker/Tracker.tsx` | `transition` to `transition-colors` | Hallmark 15: a plain transition includes box-shadow, so the focus ring fades in |
