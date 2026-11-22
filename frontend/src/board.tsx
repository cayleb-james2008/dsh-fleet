// Fleet Mission Control: Latest Verified Receipt hero + Filter/Bulk Action Strip + Three-Lane Board.
// Motion layoutId glides sessions across lanes when state changes; BorderTrail + TextShimmer appear strictly on running sessions.
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  Check,
  CheckCircle2,
  CheckSquare,
  Cpu,
  FileDiff,
  FolderGit2,
  Gauge,
  GitBranch,
  GitMerge,
  LayoutGrid,
  Network,
  RotateCcw,
  ShieldAlert,
  Square,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { BorderTrail } from "@/components/ui/border-trail";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Pill, PillIndicator } from "@/components/kibo-ui/pill";
import { layout } from "@/motion";
import { cn } from "@/lib/utils";
import {
  diffStat,
  formatDurationMs,
  healBadgeInfo,
  HONEST,
  isActivelyRunning,
  isFailed,
  isHonest,
  isQueuedOrBlocked,
  isVerified,
  receiptLine,
  statusText,
  type BoardMetrics,
  type Session,
  type StatusFilter,
  type TabId,
  type ViewMode,
} from "./api";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function Corners({ size = 8 }: { size?: number }) {
  const s = `${size}px`;
  const c = "pointer-events-none absolute border-ink-3/45";
  return (
    <>
      <span aria-hidden className={cn(c, "left-2 top-2 border-l border-t")} style={{ width: s, height: s }} />
      <span aria-hidden className={cn(c, "right-2 top-2 border-r border-t")} style={{ width: s, height: s }} />
      <span aria-hidden className={cn(c, "bottom-2 left-2 border-b border-l")} style={{ width: s, height: s }} />
      <span aria-hidden className={cn(c, "bottom-2 right-2 border-b border-r")} style={{ width: s, height: s }} />
    </>
  );
}

const TAG_SKINS = [
  "bg-tag-ops-bg text-tag-ops-fg",
  "bg-tag-mint-bg text-tag-mint-fg",
  "bg-tag-research-bg text-tag-research-fg",
  "bg-tag-dev-bg text-tag-dev-fg",
  "bg-tag-plan-bg text-tag-plan-fg",
];

function projectSkin(project: string): string {
  let h = 0;
  for (let i = 0; i < project.length; i++) h = (h * 31 + project.charCodeAt(i)) >>> 0;
  return TAG_SKINS[h % TAG_SKINS.length];
}

export function BoardMetricsStrip({ metrics }: { metrics: BoardMetrics }) {
  const settled = metrics.first_pass_count + metrics.auto_healed_count + metrics.needs_you_count;
  const firstPassLabel = settled > 0 ? `${Math.round(metrics.first_pass_rate_pct)}%` : "—";
  const effectiveLabel = settled > 0 ? `${Math.round(metrics.effective_pass_rate_pct)}% effective` : "awaiting runs";
  const medianLabel = metrics.median_check_ms !== null ? formatDurationMs(metrics.median_check_ms) : "—";

  return (
    <section
      aria-label="Board metrics"
      data-testid="board-metrics-strip"
      className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-hairline bg-canvas/70 px-4 py-2 text-xs md:px-6"
    >
      <span className="order-1 inline-flex items-center gap-1.5 font-medium text-ink-2">
        <Activity className="size-3.5 text-icon" strokeWidth={1.5} aria-hidden />
        <span>Telemetry</span>
      </span>

      <div className="order-3 flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 font-mono tabular-nums md:order-2 md:w-auto">
        <span className="inline-flex items-center gap-1.5 text-ink-2">
          <span className="font-sans text-ink-3">First-pass</span>
          <span className="font-medium text-ink" data-testid="metric-first-pass">{firstPassLabel}</span>
          {settled > 0 && <span className="text-ink-3">({metrics.first_pass_count}/{settled})</span>}
        </span>

        <span className="inline-flex items-center gap-1.5 text-ink-2">
          <Wrench className="size-3.5 text-icon" strokeWidth={1.5} aria-hidden />
          <span className="font-sans text-ink-3">Auto-healed</span>
          <span
            data-testid="metric-auto-healed"
            className={cn(
              "rounded-chip px-1.5 py-0.5 font-medium",
              metrics.auto_healed_count > 0 ? "bg-pill-active-bg text-pill-active-fg" : "bg-track text-ink",
            )}
          >
            {metrics.auto_healed_count}
          </span>
          <span className="hidden text-ink-3 sm:inline">{effectiveLabel}</span>
        </span>

        <span className="inline-flex items-center gap-1.5 text-ink-2">
          <span className="font-sans text-ink-3">Median check</span>
          <span className="font-medium text-ink" data-testid="metric-median-check">{medianLabel}</span>
        </span>

        <span className="inline-flex items-center gap-1.5 text-ink-2">
          <span className="font-sans text-ink-3">Active / Max</span>
          <span className="rounded-chip bg-track px-1.5 py-0.5 font-medium text-ink" data-testid="metric-slots">
            {metrics.active_slots} / {metrics.max_parallel}
          </span>
          {metrics.queued_count > 0 && <span className="text-ink-3">· {metrics.queued_count} queued</span>}
        </span>

        {metrics.budget && (
          <span className="inline-flex items-center gap-1.5 text-ink-2" data-testid="metric-budget">
            <Gauge className="size-3.5 text-icon" strokeWidth={1.5} aria-hidden />
            <span className="font-sans text-ink-3">Daily budget</span>
            <span
              className={cn(
                "rounded-chip px-1.5 py-0.5 font-medium",
                metrics.budget.limit_reached
                  ? "bg-pill-pro-bg text-destructive-foreground"
                  : "bg-track text-ink",
              )}
            >
              {metrics.budget.sessions_today} / {metrics.budget.daily_session_limit}
            </span>
          </span>
        )}
      </div>

      {metrics.per_repo_breakdown.length > 0 && (
        <div className="order-2 ml-auto md:order-3">
          <Popover>
            <PopoverTrigger className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-control border border-hairline bg-surface px-2.5 text-xs font-medium text-ink-2 outline-none transition-colors duration-(--dur-press) ease-(--ease-house) hover:bg-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 max-md:px-3">
              <FolderGit2 className="size-3.5 text-icon" strokeWidth={1.5} aria-hidden />
              <span>By repo ({metrics.per_repo_breakdown.length})</span>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="z-30 w-80 max-w-[calc(100%-24px)] rounded-card border border-hairline bg-surface p-3 text-ink shadow-lift"
            >
              <p className="mb-2 text-xs font-medium text-ink">Per-repository telemetry</p>
              <ul className="divide-y divide-hairline font-mono text-xs tabular-nums">
                {metrics.per_repo_breakdown.map((row) => (
                  <li key={row.repo} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="min-w-0 truncate text-ink">{row.repo}</span>
                    <span className="shrink-0 text-ink-2">
                      {row.first_pass} pass · {row.auto_healed} heal · {row.needs_you} halt
                    </span>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        </div>
      )}
    </section>
  );
}

export function HeroVerifiedReceipt({
  latest,
  needsTop,
  workingCount,
  totalCount,
  onInspect,
  onMerge,
  onRetry,
}: {
  latest: Session | null;
  needsTop: Session | null;
  workingCount: number;
  totalCount: number;
  onInspect: (id: string, tab?: TabId) => void;
  onMerge: (s: Session) => Promise<void>;
  onRetry: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);

  if (!latest) {
    return (
      <section
        aria-label="Latest verified receipt"
        data-answers="3"
        className="border-b border-hairline bg-surface px-4 py-4 md:px-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Pill variant="secondary" className="py-0.5 text-xs">
                <PillIndicator variant={needsTop ? "warning" : "info"} pulse={workingCount > 0} />
                <span>{totalCount === 0 ? "No verified receipt yet" : "Awaiting verified receipt"}</span>
              </Pill>
              {workingCount > 0 && (
                <span className="font-mono text-xs text-ink-2 tabular-nums">
                  {plural(workingCount, "session")} in progress
                </span>
              )}
            </div>
            <p className="text-sm text-ink-2 [overflow-wrap:anywhere]">
              {totalCount === 0
                ? "Hand out a task with New session. Fleet runs the agent in an isolated git worktree and writes its receipt here only after your check command passes."
                : needsTop
                  ? `No check has passed yet — "${needsTop.task}" is waiting in Needs you.`
                  : "Agents are working in isolated git worktrees. The first session whose check passes lands here with its diff and command receipt."}
            </p>
          </div>
          {needsTop && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onInspect(needsTop.id, "rc")}
                className="max-md:min-h-11 max-md:px-4"
              >
                Inspect failure
              </Button>
              <Button size="sm" onClick={() => onRetry(needsTop.id)} className="max-md:min-h-11 max-md:px-4">
                <RotateCcw className="size-4" strokeWidth={1.5} aria-hidden />Retry
              </Button>
            </div>
          )}
        </div>
      </section>
    );
  }

  const ds = diffStat(latest.diff);
  const merged = latest.status === "merged";
  const heroHeal = healBadgeInfo(latest);
  const mergePrompt = latest.merge_target
    ? `Merge ${latest.branch || "this branch"} into ${latest.merge_target}? Fleet refuses if the target is dirty.`
    : `Merge ${latest.branch || "this branch"}? Fleet refuses if the target is dirty.`;

  return (
    <section
      aria-label="Latest verified receipt"
      data-answers="3"
      className="border-b border-hairline bg-surface px-4 py-3 md:px-6 md:py-4"
    >
      <div className="relative rounded-card border border-hairline bg-canvas px-4 py-3.5 md:p-5">
        <Corners size={9} />
        <div className="flex flex-wrap items-center gap-2">
          <Pill variant="success" className="py-0.5 text-xs font-medium">
            <PillIndicator variant="success" />
            <span>{merged ? "Latest receipt · merged" : "Latest verified receipt"}</span>
          </Pill>
          {heroHeal && (
            <span className="inline-flex items-center gap-1 rounded-chip bg-pill-active-bg px-2 py-0.5 font-mono text-xs font-medium text-pill-active-fg">
              <Wrench className="size-3" strokeWidth={1.5} aria-hidden />
              <span>{heroHeal.fullLabel}</span>
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center rounded-chip px-2 py-0.5 text-xs font-medium [overflow-wrap:anywhere]",
              projectSkin(latest.project),
            )}
          >
            {latest.project}
          </span>
          {latest.branch && (
            <span className="inline-flex min-w-0 items-center gap-1 rounded-chip bg-track px-2 py-0.5 font-mono text-xs text-ink-2">
              <GitBranch className="size-3.5 shrink-0 text-icon" strokeWidth={1.5} aria-hidden />
              <span className="truncate">{latest.branch}</span>
            </span>
          )}
          <span className="ml-auto hidden font-mono text-xs text-ink-3 sm:inline">
            verified by: <span className="text-ink">{latest.check_cmd || "policy check"}</span>
          </span>
        </div>

        <div className="mt-2.5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 flex-1 space-y-2">
            <h2 className="font-heading text-lg font-medium leading-snug text-ink md:text-[23px] [overflow-wrap:anywhere]">
              {latest.task}
            </h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-xs tabular-nums">
              <span className="inline-flex min-w-0 items-center gap-1.5 border-l-2 border-dot-green pl-2.5 text-sm text-ink [overflow-wrap:anywhere]">
                <CheckCircle2 className="size-4 shrink-0 text-success-foreground" strokeWidth={1.5} aria-hidden />
                <span className="truncate">{receiptLine(latest)}</span>
              </span>
              <span className="rounded-chip bg-track px-2 py-0.5 text-ink-2">{plural(ds.files, "file")}</span>
              <span className="rounded-chip bg-diff-add-bg px-2 py-0.5 font-medium text-diff-add-fg">+{ds.add}</span>
              <span className="rounded-chip bg-diff-del-bg px-2 py-0.5 font-medium text-diff-del-fg">−{ds.del}</span>
              <span className="text-ink-3 sm:hidden [overflow-wrap:anywhere]">
                verified by: <span className="text-ink">{latest.check_cmd || "policy check"}</span>
              </span>
            </div>
          </div>

          {!confirming ? (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onInspect(latest.id, "rc")}
                className="max-md:min-h-11 max-md:px-3.5"
              >
                <Terminal className="size-4" strokeWidth={1.5} aria-hidden />Inspect receipt
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onInspect(latest.id, "df")}
                className="max-md:min-h-11 max-md:px-3.5"
              >
                <FileDiff className="size-4" strokeWidth={1.5} aria-hidden />View diff
              </Button>
              {!merged && (
                <Button size="sm" onClick={() => setConfirming(true)} className="max-md:min-h-11 max-md:px-3.5">
                  <GitMerge className="size-4" strokeWidth={1.5} aria-hidden />Merge
                </Button>
              )}
            </div>
          ) : (
            <div
              role="group"
              aria-label="Confirm hero merge"
              className="flex flex-wrap items-center gap-2 rounded-control border border-hairline bg-surface p-2.5"
            >
              <span className="text-xs text-ink-2 [overflow-wrap:anywhere]">{mergePrompt}</span>
              <Button
                size="sm"
                disabled={merging}
                onClick={async () => {
                  setMerging(true);
                  await onMerge(latest);
                  setMerging(false);
                  setConfirming(false);
                }}
                className="max-md:min-h-11 max-md:px-3.5"
              >
                {merging ? "Merging..." : "Merge now"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirming(false)}
                className="max-md:min-h-11 max-md:px-3.5"
              >
                Keep it
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function BoardFilterBulkBar({
  viewMode,
  statusFilter,
  repoFilter,
  engineFilter,
  repos,
  engines,
  hasActiveFilters,
  multiSelect,
  selectedIds,
  visibleSessions,
  bulkBusy,
  onViewMode,
  onStatusFilter,
  onRepoFilter,
  onEngineFilter,
  onClearFilters,
  onToggleMultiSelect,
  onSelectVisible,
  onClearSelection,
  onBulkRetry,
  onBulkDismiss,
  onBulkMerge,
}: {
  viewMode: ViewMode;
  statusFilter: StatusFilter;
  repoFilter: string;
  engineFilter: string;
  repos: string[];
  engines: string[];
  hasActiveFilters: boolean;
  multiSelect: boolean;
  selectedIds: Set<string>;
  visibleSessions: Session[];
  bulkBusy: boolean;
  onViewMode: (v: ViewMode) => void;
  onStatusFilter: (s: StatusFilter) => void;
  onRepoFilter: (r: string) => void;
  onEngineFilter: (e: string) => void;
  onClearFilters: () => void;
  onToggleMultiSelect: () => void;
  onSelectVisible: () => void;
  onClearSelection: () => void;
  onBulkRetry: (ids: string[]) => Promise<void>;
  onBulkDismiss: (ids: string[]) => Promise<void>;
  onBulkMerge: (ids: string[]) => Promise<void>;
}) {
  const [confirmBulk, setConfirmBulk] = useState<"dismiss" | "merge" | null>(null);

  const selectedSessions = visibleSessions.filter((s) => selectedIds.has(s.id));
  const retryable = selectedSessions.filter((s) => s.status === "needs-you").map((s) => s.id);
  const dismissable = retryable;
  const mergeable = selectedSessions.filter((s) => isVerified(s) && s.status === "done").map((s) => s.id);

  return (
    <section
      aria-label="Filter and bulk actions"
      className="border-b border-hairline bg-surface/80 px-4 py-2.5 md:px-6"
    >
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl aria-label="Filter by status" size="sm" className="max-w-full overflow-x-auto">
          {(
            [
              ["all", "All"],
              ["needs-you", "Needs you"],
              ["working", "Working"],
              ["queued", "Queued"],
              ["done", "Done"],
            ] as const
          ).map(([id, label]) => (
            <SegmentedControlItem
              key={id}
              aria-pressed={statusFilter === id}
              data-checked={statusFilter === id ? "" : undefined}
              onClick={() => onStatusFilter(id)}
              className="whitespace-nowrap px-2.5 text-xs max-md:!min-h-11 max-md:!min-w-11"
            >
              {label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>

        {repos.length > 0 && (
          <Popover>
            <PopoverTrigger className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-control border border-hairline bg-canvas px-2.5 text-xs font-medium text-ink outline-none transition-colors duration-(--dur-press) ease-(--ease-house) hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 max-md:px-3">
              <FolderGit2 className="size-3.5 text-icon" strokeWidth={1.5} aria-hidden />
              <span>{repoFilter || "All repos"}</span>
            </PopoverTrigger>
            <PopoverContent align="start" className="z-30 w-56 rounded-card border border-hairline bg-surface p-1 text-ink shadow-lift">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onRepoFilter("")}
                className={cn("w-full justify-start text-xs max-md:min-h-11", !repoFilter && "bg-board font-medium")}
              >
                All repos
              </Button>
              {repos.map((r) => (
                <Button
                  key={r}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onRepoFilter(r)}
                  className={cn("w-full justify-start font-mono text-xs max-md:min-h-11", repoFilter === r && "bg-board font-medium")}
                >
                  <span className="truncate">{r}</span>
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        )}

        {engines.length > 0 && (
          <Popover>
            <PopoverTrigger className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-control border border-hairline bg-canvas px-2.5 text-xs font-medium text-ink outline-none transition-colors duration-(--dur-press) ease-(--ease-house) hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 max-md:px-3">
              <Cpu className="size-3.5 text-icon" strokeWidth={1.5} aria-hidden />
              <span>{engineFilter || "All engines"}</span>
            </PopoverTrigger>
            <PopoverContent align="start" className="z-30 w-48 rounded-card border border-hairline bg-surface p-1 text-ink shadow-lift">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onEngineFilter("")}
                className={cn("w-full justify-start text-xs max-md:min-h-11", !engineFilter && "bg-board font-medium")}
              >
                All engines
              </Button>
              {engines.map((eng) => (
                <Button
                  key={eng}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onEngineFilter(eng)}
                  className={cn("w-full justify-start font-mono text-xs max-md:min-h-11", engineFilter === eng && "bg-board font-medium")}
                >
                  {eng}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        )}

        {hasActiveFilters && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onClearFilters}
            className="h-8 px-2 text-xs max-md:min-h-11 max-md:px-3"
          >
            <X className="size-3.5" strokeWidth={1.5} aria-hidden />
            <span>Reset filters</span>
          </Button>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SegmentedControl aria-label="Workspace view" size="sm">
            <SegmentedControlItem
              data-testid="view-toggle-board"
              aria-pressed={viewMode === "board"}
              data-checked={viewMode === "board" ? "" : undefined}
              onClick={() => onViewMode("board")}
              className="gap-1.5 whitespace-nowrap px-2.5 text-xs max-md:!min-h-11 max-md:!min-w-11"
            >
              <LayoutGrid className="size-3.5" strokeWidth={1.5} aria-hidden />
              <span>Board</span>
            </SegmentedControlItem>
            <SegmentedControlItem
              data-testid="view-toggle-dag"
              aria-pressed={viewMode === "dag"}
              data-checked={viewMode === "dag" ? "" : undefined}
              onClick={() => onViewMode("dag")}
              className="gap-1.5 whitespace-nowrap px-2.5 text-xs max-md:!min-h-11 max-md:!min-w-11"
            >
              <Network className="size-3.5" strokeWidth={1.5} aria-hidden />
              <span>DAG Graph</span>
            </SegmentedControlItem>
          </SegmentedControl>

          <Button
            type="button"
            size="sm"
            variant={multiSelect ? "default" : "outline"}
            aria-pressed={multiSelect}
            onClick={() => {
              setConfirmBulk(null);
              onToggleMultiSelect();
            }}
            className="h-8 px-2.5 text-xs max-md:min-h-11 max-md:px-3"
          >
            <CheckSquare className="size-3.5" strokeWidth={1.5} aria-hidden />
            <span>{multiSelect ? `Selecting (${selectedIds.size})` : "Multi-select"}</span>
          </Button>
        </div>
      </div>

      {multiSelect && (
        <div
          role="region"
          aria-label="Bulk selection controls"
          className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-hairline pt-2.5"
        >
          <span className="font-mono text-xs tabular-nums text-ink-2">
            {selectedIds.size} selected
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onSelectVisible}
            className="h-8 px-2.5 text-xs max-md:min-h-11"
          >
            Select visible ({visibleSessions.length})
          </Button>
          {selectedIds.size > 0 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setConfirmBulk(null);
                onClearSelection();
              }}
              className="h-8 px-2.5 text-xs max-md:min-h-11"
            >
              Clear
            </Button>
          )}

          {!confirmBulk ? (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={bulkBusy || retryable.length === 0}
                onClick={() => void onBulkRetry(retryable)}
                className="h-8 px-2.5 text-xs max-md:min-h-11"
              >
                <RotateCcw className="size-3.5" strokeWidth={1.5} aria-hidden />
                <span>Bulk Retry ({retryable.length})</span>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={bulkBusy || dismissable.length === 0}
                onClick={() => setConfirmBulk("dismiss")}
                className="h-8 px-2.5 text-xs max-md:min-h-11"
              >
                <X className="size-3.5" strokeWidth={1.5} aria-hidden />
                <span>Bulk Dismiss ({dismissable.length})</span>
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={bulkBusy || mergeable.length === 0}
                onClick={() => setConfirmBulk("merge")}
                className="h-8 px-2.5 text-xs max-md:min-h-11"
              >
                <GitMerge className="size-3.5" strokeWidth={1.5} aria-hidden />
                <span>Bulk Merge ({mergeable.length})</span>
              </Button>
            </div>
          ) : (
            <div
              role="group"
              aria-label="Confirm bulk action"
              className="ml-auto flex flex-wrap items-center gap-2 rounded-control border border-hairline bg-canvas px-2.5 py-1.5"
            >
              <span className="text-xs text-ink-2">
                {confirmBulk === "merge"
                  ? `Merge ${mergeable.length} clean verified ${mergeable.length === 1 ? "session" : "sessions"}?`
                  : `Dismiss ${dismissable.length} Needs-you ${dismissable.length === 1 ? "session" : "sessions"}?`}
              </span>
              <Button
                type="button"
                size="sm"
                variant={confirmBulk === "merge" ? "default" : "destructive-outline"}
                disabled={bulkBusy}
                onClick={async () => {
                  const action = confirmBulk;
                  setConfirmBulk(null);
                  if (action === "merge") await onBulkMerge(mergeable);
                  else await onBulkDismiss(dismissable);
                }}
                className="h-8 px-2.5 text-xs max-md:min-h-11"
              >
                {confirmBulk === "merge" ? "Merge selected" : "Dismiss selected"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setConfirmBulk(null)}
                className="h-8 px-2.5 text-xs max-md:min-h-11"
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const TAIL_LINES = 2;
function RunningTail({ s }: { s: Session }) {
  const lines = Array.isArray(s.transcript) ? s.transcript : [];
  const from = Math.max(0, lines.length - TAIL_LINES);
  return (
    <div className="rounded-control border border-hairline bg-board p-2.5">
      <ol
        aria-label={`Newest lines of the transcript of ${s.task}`}
        className="space-y-1 font-mono text-xs leading-relaxed text-ink-2"
      >
        {lines.length === 0 && <li>Waiting for first output line...</li>}
        {lines.slice(from).map((l, i) => (
          <li key={from + i} className="break-words">
            {l}
          </li>
        ))}
      </ol>
    </div>
  );
}

function SessionCard({
  s,
  selected,
  bulkMode,
  bulkChecked,
  isLatestHero,
  onOpen,
  onToggleCheck,
  onRetry,
  onDismiss,
}: {
  s: Session;
  selected: boolean;
  bulkMode: boolean;
  bulkChecked: boolean;
  isLatestHero: boolean;
  onOpen: (tab?: TabId) => void;
  onToggleCheck: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const ds = diffStat(s.diff);
  const running = isActivelyRunning(s);
  const verified = isVerified(s);
  const honest = isHonest(s);
  const failed = isFailed(s);
  const badgeVariant = verified
    ? "success"
    : failed
      ? "error"
      : s.bucket === "needs-you"
        ? "info"
        : isQueuedOrBlocked(s)
          ? "warning"
          : s.bucket === "done"
            ? "success"
            : "secondary";

  const stepSummary =
    s.check_steps && s.check_steps.length > 1
      ? `${s.check_steps.filter((st) => st.status === "passed" || st.passed === true).length}/${s.check_steps.length} steps`
      : null;
  const healBadge = healBadgeInfo(s);

  return (
    <motion.article
      layout
      layoutId={"card-" + s.id}
      transition={layout}
      aria-label={s.task}
      className={cn(
        "relative flex min-w-0 flex-col gap-2.5 overflow-hidden rounded-card border p-3.5 transition-colors duration-(--dur-press) ease-(--ease-house) md:p-4",
        bulkChecked
          ? "border-blue bg-blue-soft/35"
          : selected
            ? "border-ink bg-raised"
            : "border-hairline bg-surface hover:bg-raised",
      )}
    >
      {running && <BorderTrail className="bg-ink" size={110} />}

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {bulkMode && (
          <button
            type="button"
            role="checkbox"
            aria-checked={bulkChecked}
            aria-label={`Select session ${s.task}`}
            onClick={onToggleCheck}
            className={cn(
              "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-chip border outline-none transition-colors duration-(--dur-press) ease-(--ease-house) focus-visible:ring-2 focus-visible:ring-ring max-md:size-11",
              bulkChecked
                ? "border-blue bg-blue text-blue-fg"
                : "border-edge bg-canvas text-ink-2 hover:bg-raised",
            )}
          >
            {bulkChecked ? (
              <Check className="size-3.5" strokeWidth={2} aria-hidden />
            ) : (
              <Square className="size-3.5 text-icon" strokeWidth={1.5} aria-hidden />
            )}
          </button>
        )}
        <span
          className={cn(
            "inline-flex max-w-full truncate rounded-chip px-2 py-0.5 text-xs font-medium",
            projectSkin(s.project),
          )}
        >
          {s.project}
        </span>
        {isLatestHero && (
          <span className="rounded-chip bg-track px-1.5 py-0.5 font-mono text-xs text-ink-2">hero</span>
        )}
        {s.depends_on && s.depends_on.length > 0 && (
          <span className="inline-flex items-center gap-1 rounded-chip bg-track px-1.5 py-0.5 font-mono text-xs text-ink-2">
            <GitBranch className="size-3 text-icon" strokeWidth={1.5} aria-hidden />
            <span>{s.depends_on.length} dep{s.depends_on.length === 1 ? "" : "s"}</span>
          </span>
        )}
        {healBadge && (
          <span
            data-testid="card-heal-badge"
            className={cn(
              "inline-flex items-center gap-1 rounded-chip px-1.5 py-0.5 font-mono text-xs font-medium",
              healBadge.tone === "healed"
                ? "bg-pill-active-bg text-pill-active-fg"
                : healBadge.tone === "healing"
                  ? "bg-pill-warn-bg text-pill-warn-fg"
                  : "bg-pill-pro-bg text-pill-pro-fg",
            )}
          >
            <Wrench className="size-3" strokeWidth={1.5} aria-hidden />
            <span>{healBadge.shortLabel}</span>
          </span>
        )}
        <Badge variant={badgeVariant} size="sm" className="ml-auto shrink-0">
          {verified ? (s.status === "merged" ? "merged" : "verified") : statusText(s)}
        </Badge>
      </div>

      <Button
        variant="ghost"
        data-open={s.id}
        aria-current={selected ? "true" : undefined}
        aria-label={`Open ${s.task}`}
        onClick={() => onOpen("tr")}
        className="h-auto sm:h-auto min-h-11 w-full justify-start whitespace-normal px-1.5 py-1.5 text-left font-heading text-[15px] font-medium leading-snug text-ink hover:bg-board [overflow-wrap:anywhere]"
      >
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{s.task}</span>
      </Button>

      {s.bucket === "needs-you" && (
        <div className="space-y-2">
          {honest ? (
            <p className="rounded-control bg-pill-warn-bg px-2.5 py-1.5 text-xs font-medium text-pill-warn-fg [overflow-wrap:anywhere]">
              {HONEST}
            </p>
          ) : null}
          {s.guardrail_violations && s.guardrail_violations.length > 0 && (
            <p className="inline-flex items-center gap-1.5 rounded-control bg-pill-pro-bg px-2 py-1 text-xs font-medium text-destructive-foreground">
              <ShieldAlert className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
              <span>File-scope guardrail blocked ({s.guardrail_violations.length})</span>
            </p>
          )}
          <p
            className={cn(
              "text-sm leading-relaxed [overflow-wrap:anywhere]",
              failed ? "text-destructive-foreground" : "text-info-foreground",
            )}
          >
            {s.reason || "Stopped and waiting on your review."}
          </p>
          {s.check_cmd && (
            <p className="truncate font-mono text-xs text-ink-3">
              check: <span className="text-ink-2">{s.check_cmd}</span>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Button size="sm" variant="outline" onClick={onRetry} className="max-md:min-h-11 max-md:px-3.5">
              <RotateCcw className="size-3.5" strokeWidth={1.5} aria-hidden />Retry
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismiss} className="max-md:min-h-11 max-md:px-3">
              <X className="size-3.5" strokeWidth={1.5} aria-hidden />Dismiss
            </Button>
          </div>
        </div>
      )}

      {s.bucket === "working" && (
        <div className="space-y-2">
          {running ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <TextShimmer className="text-xs font-medium" duration={2.2}>
                  {s.status === "checking" ? "The agent finished · running check" : "Agent running"}
                </TextShimmer>
                {s.check_cmd && <span className="truncate font-mono text-xs text-ink-3">{s.check_cmd}</span>}
              </div>
              <RunningTail s={s} />
            </>
          ) : s.status === "blocked" ? (
            <p className="text-sm text-ink-2">
              Blocked by upstream DAG: {(s.blocked_by || s.depends_on || []).join(", ")}.
            </p>
          ) : (
            <p className="text-sm text-ink-2">
              Waiting for a free slot (number {s.queue_position ?? "?"} in the queue).
            </p>
          )}
        </div>
      )}

      {s.bucket === "done" && (
        <div className="space-y-2">
          <p className="truncate border-l-2 border-dot-green pl-2 font-mono text-xs tabular-nums text-ink">
            {receiptLine(s)}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs tabular-nums">
            <span className="rounded-chip bg-track px-1.5 py-0.5 text-ink-2">{plural(ds.files, "file")}</span>
            <span className="rounded-chip bg-diff-add-bg px-1.5 py-0.5 text-diff-add-fg">+{ds.add}</span>
            <span className="rounded-chip bg-diff-del-bg px-1.5 py-0.5 text-diff-del-fg">−{ds.del}</span>
            {stepSummary && (
              <span className="rounded-chip bg-pill-active-bg px-1.5 py-0.5 text-pill-active-fg">
                {stepSummary}
              </span>
            )}
            {s.check_cmd && <span className="ml-auto truncate text-ink-3">{s.check_cmd}</span>}
          </div>
        </div>
      )}

      {(s.steer || []).length > 0 && (
        <p className="text-xs font-medium text-warning-foreground">
          {plural(s.steer!.length, "steering message")} queued
        </p>
      )}

      <div className="mt-auto flex min-w-0 items-center gap-2 border-t border-hairline pt-2 font-mono text-xs text-ink-3">
        <span className="shrink-0 text-ink-2">{s.test_mode ? "custom" : s.engine || s.agent || "agent"}</span>
        <span className="ml-auto min-w-0 truncate">{s.branch || s.id}</span>
      </div>
    </motion.article>
  );
}

function LaneSkeleton({ label, cards }: { label: string; cards: number }) {
  return (
    <section aria-label={`${label} loading`} className="flex min-w-0 flex-col gap-3 bg-canvas p-4 md:p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-heading text-base font-medium text-ink">{label}</h2>
        <span className="h-6 w-8 rounded-full bg-track" aria-hidden />
      </div>
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-card border border-hairline bg-surface p-4">
          <div className="flex items-center justify-between">
            <span className="h-4 w-16 rounded-chip bg-track" />
            <span className="h-5 w-14 rounded-chip bg-track" />
          </div>
          <div className="h-5 w-4/5 rounded-chip bg-track" />
          <div className="h-10 w-full rounded-control bg-board" />
        </div>
      ))}
    </section>
  );
}

function Lane({
  id,
  label,
  tone,
  pulse,
  count,
  empty,
  answers,
  children,
}: {
  id: string;
  label: string;
  tone: "error" | "info" | "success";
  pulse?: boolean;
  count: number;
  empty: string;
  answers: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`lane-${id}-h`} data-answers={answers} className="flex min-w-0 flex-col gap-3 bg-canvas p-4 md:p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 id={`lane-${id}-h`} tabIndex={-1} className="font-heading text-base font-medium text-ink outline-none">
          {label}
        </h2>
        <Pill variant="secondary" className="px-2.5 py-0.5 font-mono text-xs tabular-nums">
          <PillIndicator variant={tone} pulse={pulse} />
          <span>{count}</span>
        </Pill>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <AnimatePresence initial={false}>{children}</AnimatePresence>
        {count === 0 && (
          <p className="rounded-card border border-dashed border-hairline bg-surface/60 p-4 text-sm leading-relaxed text-ink-2">
            {empty}
          </p>
        )}
      </div>
    </section>
  );
}

export function ThreeLaneBoard({
  sessions,
  unreachable,
  selected,
  bulkMode,
  bulkSelected,
  latestHeroId,
  onOpen,
  onToggleBulk,
  onRetry,
  onDismiss,
}: {
  sessions: Session[] | null;
  unreachable: boolean;
  selected: string | null;
  bulkMode: boolean;
  bulkSelected: Set<string>;
  latestHeroId: string | null;
  onOpen: (id: string, tab?: TabId) => void;
  onToggleBulk: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (sessions === null && unreachable) {
    return (
      <p role="alert" className="m-4 rounded-card border border-hairline bg-surface p-4 text-sm text-ink md:m-6">
        Fleet has not answered yet, so there is no session list to show. Check that Fleet is running; this page asks again every two seconds.
      </p>
    );
  }

  if (sessions === null) {
    return (
      <div aria-label="Board loading" className="grid gap-px border-b border-hairline bg-hairline md:grid-cols-3">
        <LaneSkeleton label="Needs you" cards={2} />
        <LaneSkeleton label="Working" cards={1} />
        <LaneSkeleton label="Done" cards={2} />
      </div>
    );
  }

  const needs = sessions.filter((s) => s.bucket === "needs-you");
  const working = sessions.filter((s) => s.bucket === "working");
  const done = sessions.filter((s) => s.bucket === "done");
  const anyRunning = working.some(isActivelyRunning);

  return (
    <div
      aria-label="Session lanes"
      className="grid gap-px border-b border-hairline bg-hairline md:grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)_minmax(0,1fr)]"
    >
      <Lane
        id="needs"
        label="Needs you"
        tone={needs.length > 0 ? "error" : "info"}
        count={needs.length}
        empty="Nothing needs you. Failed checks and stopped runs land here with the reason."
        answers="1"
      >
        {needs.map((s) => (
          <SessionCard
            key={s.id}
            s={s}
            selected={selected === s.id}
            bulkMode={bulkMode}
            bulkChecked={bulkSelected.has(s.id)}
            isLatestHero={false}
            onOpen={(tab) => onOpen(s.id, tab)}
            onToggleCheck={() => onToggleBulk(s.id)}
            onRetry={() => onRetry(s.id)}
            onDismiss={() => onDismiss(s.id)}
          />
        ))}
      </Lane>

      <Lane
        id="working"
        label="Working"
        tone="info"
        pulse={anyRunning}
        count={working.length}
        empty="No agent is running right now."
        answers="2"
      >
        {working.map((s) => (
          <SessionCard
            key={s.id}
            s={s}
            selected={selected === s.id}
            bulkMode={bulkMode}
            bulkChecked={bulkSelected.has(s.id)}
            isLatestHero={false}
            onOpen={(tab) => onOpen(s.id, tab)}
            onToggleCheck={() => onToggleBulk(s.id)}
            onRetry={() => onRetry(s.id)}
            onDismiss={() => onDismiss(s.id)}
          />
        ))}
      </Lane>

      <Lane
        id="done"
        label="Done"
        tone="success"
        count={done.length}
        empty="Work appears here once its check passes, with the check line as its receipt."
        answers="3"
      >
        {done.map((s) => (
          <SessionCard
            key={s.id}
            s={s}
            selected={selected === s.id}
            bulkMode={bulkMode}
            bulkChecked={bulkSelected.has(s.id)}
            isLatestHero={s.id === latestHeroId}
            onOpen={(tab) => onOpen(s.id, tab)}
            onToggleCheck={() => onToggleBulk(s.id)}
            onRetry={() => onRetry(s.id)}
            onDismiss={() => onDismiss(s.id)}
          />
        ))}
      </Lane>
    </div>
  );
}
