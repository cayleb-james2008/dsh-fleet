# UI Architecture & Role Coverage (Fleet v0.9.0)

Fleet v0.9.0 implements the **Codex Desktop + Linear (`data-world="codex"`)** Material World with monochrome ink primary actions (`#111318` light / `#F3F4F6` dark), restrained architectural indigo accents (`#4F46E5` / `#818CF8`), Geist + Geist Mono (`tabular-nums`), and role-driven libraries strictly where the workbench earns them.

| Library / Layer | Need of Fleet v0.9.0 | Part Used & Source File |
| --- | --- | --- |
| **Motion** (`motion/react`) | Interruptible spring indicators (`stiffness: 450, damping: 35, mass: 0.7`), collapsible inspector `AnimatePresence` (`220ms`, `[0.23, 1, 0.32, 1]`), and global `<MotionConfig reducedMotion="user">` | `MotionConfig` (`src/main.tsx`), `layoutId` spring indicators (`App.tsx`, `board.tsx`, `detail.tsx`, `ui.tsx`), `src/motion.ts` |
| **Sonner** (`sonner`) | Theme-synced non-blocking notifications for merge, retry, dismiss, patch export, and Goal-to-DAG dispatch | `<Toaster theme={theme} />` & `toast` (`src/ui.tsx`, `src/App.tsx`) |
| **cmdk** (`cmdk`) | `Cmd/Ctrl+K` global command palette filtering sessions, playbooks, views, and actions with native keyboard navigation | `Command`, `Command.Input`, `Command.List`, `Command.Group`, `Command.Item` (`src/palette.tsx`) |
| **COSS / Base-style ARIA Kit** | Hairline-bordered buttons, monochrome ink primary CTAs (`active:scale-[0.97]`), dialogs, drawers, popovers, inputs, expandables without `<details>`, and segmented controls | `Button`, `Badge`, `Input`, `Textarea`, `SegmentedControl`, `Dialog`, `Drawer`, `PopoverPanel`, `Expandable` (`src/ui.tsx`) |
| **Iconography** (`lucide-react`) | 1.5px stroke technical icons across inbox, inspector, diffs, DAG, PR preview, and composer (zero emojis) | `lucide-react` across `src/*.tsx` |
| **Typography & Tokens** | Light default + full Dark parity, `#67` Settings-only theme switch, `#155` zero `"Rune"` jargon, themed scrollbars, `::selection`, `caret-color`, `:focus-visible` | `Geist` + `Geist Mono`, `src/theme.css`, `src/index.css` |
