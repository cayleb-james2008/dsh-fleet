# UI Architecture & Role Coverage (Fleet v0.9.0)

Fleet v0.9.0 replaces bloated wrapper abstractions (`motion`, `vaul`, `cmdk`, `@radix-ui/*`, `@base-ui/react`, `sonner`) with a lean, self-contained Desktop-Workbench kit in `frontend/src/ui.tsx` built directly on React 19, Tailwind CSS v4, Geist / Geist Mono, and `lucide-react` (1.5px stroke).

| Need of Fleet v0.9.0 | Implementation | Source File |
| --- | --- | --- |
| Accessible dialogs, Settings drawer, popovers, segmented switches, inline toasts, expandable check logs without `<details>` | Lean bespoke ARIA primitives with `prefers-reduced-motion` support and >= 44px mobile touch targets | `frontend/src/ui.tsx` |
| Desktop-Workbench 3-pane layout (collapsible Session Inbox, Transcript/Diff/Receipt/DAG/Goal-to-DAG workspace, collapsible Worktree/PR Inspector) | `SessionInboxRail`, `GoalLaunchpad`, `RightInspectorRail`, `BoardMetricsStrip`, `DetailBody` | `frontend/src/board.tsx`, `frontend/src/detail.tsx`, `frontend/src/App.tsx` |
| High-scale log & diff inspection, DAG graph, Goal-to-DAG planning, confirmation-gated PR workflow | `VirtualizedTranscript` (50k+ lines), `RichDiffViewer` (Unified & Split), `DagWaveGraph`, `PrPreviewModal` | `frontend/src/transcript.tsx`, `frontend/src/diff.tsx`, `frontend/src/dag-graph.tsx`, `frontend/src/pr-modal.tsx` |
| Icons | Consistent 1.5px stroke technical iconography (zero emojis) | `lucide-react` |
