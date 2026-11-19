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
