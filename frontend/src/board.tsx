import { useState } from "react";
import {
  BookMarked,
  CheckCircle2,
  CheckSquare,
  Clock,
  Download,
  FileDiff,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Layers,
  Play,
  RefreshCw,
  RotateCcw,
  Shield,
  Sparkles,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import { Badge, Button, Input, StatusDot, Textarea, cn, toast } from "./ui";
import {
  diffStat,
  dispatchBatchSessions,
  downloadSessionPatch,
  formatDurationMs,
  healBadgeInfo,
  isActivelyRunning,
  isFailed,
  isQueuedOrBlocked,
  isVerified,
  planGoal,
  receiptLine,
  repoBasename,
  statusText,
  type BoardMetrics,
  type GoalPlanTask,
  type MergeCheckResult,
  type PlaybookTemplate,
  type Policy,
  type RepoInfo,
  type Session,
  type StatusFilter,
  type TabId,
} from "./api";

const STATUS_TABS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "needs-you", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "done", label: "Done" },
];

export function SessionInboxRail({
  sessions,
  allSessions,
  unreachable,
  selectedId,
  statusFilter,
  repoFilter,
  repos,
  query,
  multiSelect,
  bulkSelected,
  bulkBusy,
  onQuery,
  onStatusFilter,
  onRepoFilter,
  onClearFilters,
  onToggleMultiSelect,
  onToggleBulk,
  onSelectVisible,
  onClearSelection,
  onBulkRetry,
  onBulkDismiss,
  onBulkMerge,
  onOpen,
  onRetry,
  onDismiss,
  searchInputRef,
}: {
  sessions: Session[] | null;
  allSessions: Session[];
  unreachable: boolean;
  selectedId: string | null;
  statusFilter: StatusFilter;
  repoFilter: string;
  repos: string[];
  query: string;
  multiSelect: boolean;
  bulkSelected: Set<string>;
  bulkBusy: boolean;
  onQuery: (q: string) => void;
  onStatusFilter: (f: StatusFilter) => void;
  onRepoFilter: (r: string) => void;
  onClearFilters: () => void;
  onToggleMultiSelect: () => void;
  onToggleBulk: (id: string) => void;
  onSelectVisible: () => void;
  onClearSelection: () => void;
  onBulkRetry: (ids: string[]) => void;
  onBulkDismiss: (ids: string[]) => void;
  onBulkMerge: (ids: string[]) => void;
  onOpen: (id: string, tab?: TabId) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const hasFilters = Boolean(query.trim() || statusFilter !== "all" || repoFilter);
  const selectedArr = Array.from(bulkSelected);
  const needsSelected = selectedArr.filter((id) => allSessions.find((s) => s.id === id)?.bucket === "needs-you");
  const mergeableSelected = selectedArr.filter((id) => {
    const s = allSessions.find((x) => x.id === id);
    return Boolean(s && isVerified(s) && s.status === "done");
  });

  const sorted = (sessions ?? []).slice().sort((a, b) => {
    const rank = (s: Session) => (s.bucket === "needs-you" ? 0 : isActivelyRunning(s) ? 1 : isQueuedOrBlocked(s) ? 2 : 3);
    return rank(a) - rank(b);
  });

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--board)]">
      <div className="space-y-2 border-b border-[var(--hairline)] p-2.5">
        <div className="flex items-center gap-2">
          <Input
            ref={searchInputRef}
            type="search"
            aria-label="Search sessions"
            placeholder="Filter runs (/)"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            className="flex-1 h-8 text-[13px]"
          />
          <Button
            type="button"
            size="sm"
            variant={multiSelect ? "primary" : "outline"}
            aria-pressed={multiSelect}
            onClick={onToggleMultiSelect}
            aria-label="Select multiple sessions"
          >
            <CheckSquare className="size-3.5" strokeWidth={1.5} aria-hidden />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Status filter">
          {STATUS_TABS.map((t) => {
            const active = statusFilter === t.id;
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={active}
                onClick={() => onStatusFilter(t.id)}
                className={cn(
                  "inline-flex items-center justify-center rounded-[var(--radius-chip)] px-2.5 h-8 text-[12px] font-medium cursor-pointer transition active:bg-[var(--track)] max-md:min-h-11 max-md:min-w-11 max-md:px-3",
                  "focus-visible:outline-2 focus-visible:outline-[var(--ring)]",
                  active
                    ? "bg-[var(--surface)] text-[var(--ink)] border border-[var(--input)]"
                    : "text-[var(--ink-2)] border border-transparent hover:text-[var(--ink)] hover:bg-[var(--track)]",
                )}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {repos.length > 1 && (
          <div className="flex items-center gap-2">
            <select
              aria-label="Filter by repository"
              value={repoFilter}
              onChange={(e) => onRepoFilter(e.target.value)}
              className="w-full h-9 rounded-[var(--radius-chip)] border border-[var(--input)] bg-[var(--surface)] px-2.5 text-[12px] text-[var(--ink)] max-md:min-h-11"
            >
              <option value="">All repositories ({repos.length})</option>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            {hasFilters && (
              <Button type="button" size="sm" variant="ghost" onClick={onClearFilters} aria-label="Reset filters">
                <X className="size-3.5" strokeWidth={1.5} />
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" aria-label="Session lanes">
        {sessions === null ? (
          <div className="p-4 text-[13px] text-[var(--ink-2)]">
            {unreachable ? (
              <p role="status">Fleet has not answered yet. Retrying in the background.</p>
            ) : (
              <p>Loading sessions...</p>
            )}
          </div>
        ) : sorted.length === 0 ? (
          <div className="p-4 text-[13px] text-[var(--ink-2)] space-y-2">
            <p role="status">
              {allSessions.length === 0
                ? "No sessions yet. Plan a goal or launch a run."
                : `No session matches ${query.trim() ? `"${query.trim()}"` : "active filters"}.`}
            </p>
            {hasFilters && (
              <Button type="button" size="sm" variant="outline" onClick={onClearFilters}>
                Clear filters
              </Button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-[var(--hairline)]">
            {sorted.map((s) => {
              const isSelected = selectedId === s.id;
              const ds = diffStat(s.diff);
              const verified = isVerified(s);
              const failed = isFailed(s);
              const running = isActivelyRunning(s);
              const queued = isQueuedOrBlocked(s);
              const heal = healBadgeInfo(s);
              const tail = running && s.transcript.length > 0 ? s.transcript[s.transcript.length - 1] : "";
              const checked = bulkSelected.has(s.id);
              const tone = verified ? "green" : failed ? "red" : running ? "blue" : queued ? "amber" : "muted";

              return (
                <article
                  key={s.id}
                  aria-label={s.task || "Untitled session"}
                  className={cn(
                    "group relative px-3 py-2 transition",
                    isSelected ? "bg-[var(--blue-soft)]" : "hover:bg-[var(--surface)]/80",
                  )}
                >
                  {isSelected && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-1 left-0 w-[3px] rounded-r bg-[var(--blue)]"
                    />
                  )}

                  <div className="flex items-start gap-2">
                    {multiSelect && (
                      <input
                        type="checkbox"
                        checked={checked}
                        aria-label={`Select ${s.task}`}
                        onChange={() => onToggleBulk(s.id)}
                        className="mt-1 size-4 shrink-0 accent-[var(--blue)]"
                      />
                    )}
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-1.5 text-[12px] text-[var(--ink-3)]">
                        <StatusDot tone={tone} pulse={running} />
                        <span className="truncate font-medium text-[var(--ink-2)]">{s.project}</span>
                        <span className="ml-auto shrink-0 mono">{s.id}</span>
                      </div>

                      <p className="text-[14px] font-medium leading-snug text-[var(--ink)] [overflow-wrap:anywhere]">
                        {s.task}
                      </p>

                      {tail && (
                        <p data-testid="live-tail" className="mono text-[12px] text-[var(--ink-3)] break-words">
                          {tail.length > 72 ? `${tail.slice(0, 69)}...` : tail}
                        </p>
                      )}

                      {s.status === "needs-you" && s.reason && (
                        <p
                          className={cn(
                            "text-[12px] break-words",
                            failed ? "text-[var(--destructive-foreground)]" : "text-[var(--info-foreground)]",
                          )}
                        >
                          {s.reason.length > 88 ? `${s.reason.slice(0, 85)}...` : s.reason}
                        </p>
                      )}

                      <div className="pt-0.5 flex flex-wrap items-center gap-2 mono text-[12px]">
                        <span className="text-[var(--ink-3)]">
                          {verified ? (s.status === "merged" ? "merged" : "verified") : statusText(s)}
                        </span>
                        {heal && (
                          <span className="rounded-[var(--radius-chip)] bg-[var(--ok-soft)] px-1.5 py-0.5 text-[var(--success-foreground)]">
                            {heal.shortLabel}
                          </span>
                        )}
                        {ds.files > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <span className="text-[var(--diff-add-fg)]">+{ds.add}</span>
                            <span className="text-[var(--diff-del-fg)]">-{ds.del}</span>
                          </span>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant={isSelected ? "primary" : "ghost"}
                          data-open={s.id}
                          aria-label={`Open ${s.task}`}
                          onClick={() => onOpen(s.id, "tr")}
                          className="ml-auto font-sans"
                        >
                          {isSelected ? "Active" : "Open"}
                        </Button>
                      </div>
                    </div>
                  </div>

                  {s.bucket === "needs-you" && (
                    <div className="mt-2 flex items-center gap-1.5">
                      <Button type="button" size="sm" variant="outline" onClick={() => onRetry(s.id)}>
                        <RotateCcw className="size-3.5" strokeWidth={1.5} aria-hidden />
                        <span>Retry</span>
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => onDismiss(s.id)}>
                        Dismiss
                      </Button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>

      {multiSelect && (
        <div
          data-testid="bulk-action-bar"
          className="border-t border-[var(--hairline)] bg-[var(--surface)] p-2.5 space-y-2"
        >
          <div className="flex items-center justify-between text-[12px] text-[var(--ink-2)]">
            <span className="mono">{bulkSelected.size} selected</span>
            <div className="flex items-center gap-1.5">
              <Button type="button" size="sm" variant="ghost" onClick={onSelectVisible}>
                All
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onClearSelection}>
                None
              </Button>
            </div>
          </div>
          {bulkSelected.size > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {needsSelected.length > 0 && (
                <>
                  <Button type="button" size="sm" variant="outline" disabled={bulkBusy} onClick={() => onBulkRetry(needsSelected)}>
                    Retry ({needsSelected.length})
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={bulkBusy} onClick={() => onBulkDismiss(needsSelected)}>
                    Dismiss ({needsSelected.length})
                  </Button>
                </>
              )}
              {mergeableSelected.length > 0 && (
                <Button type="button" size="sm" variant="primary" disabled={bulkBusy} onClick={() => onBulkMerge(mergeableSelected)}>
                  Merge ({mergeableSelected.length})
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function GoalLaunchpad({
  repos,
  playbooks,
  policy,
  supportsServerV050,
  onDispatched,
  onApplyPlaybook,
}: {
  repos: RepoInfo[];
  playbooks: PlaybookTemplate[];
  policy: Policy | null;
  supportsServerV050: boolean;
  onDispatched: (created: Session[]) => void;
  onApplyPlaybook: (tpl: PlaybookTemplate) => void;
}) {
  const [goal, setGoal] = useState("");
  const [selectedRepo, setSelectedRepo] = useState("");
  const [planning, setPlanning] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [planned, setPlanned] = useState<GoalPlanTask[] | null>(null);

  const activeRepo = selectedRepo || repos[0]?.path || "/workspace/ledger-kit";

  const handlePlan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim() || planning) return;
    setPlanning(true);
    const res = await planGoal({ goal: goal.trim(), repo: activeRepo });
    setPlanned(res.tasks);
    setPlanning(false);
  };

  const handleLaunch = async () => {
    if (!planned || planned.length === 0 || dispatching) return;
    setDispatching(true);
    const items = planned.map((t, idx) => ({
      alias: t.alias || `#${idx + 1}`,
      repo: t.repo || activeRepo,
      project: repoBasename(t.repo || activeRepo) || "default",
      task: t.task,
      check: t.check,
      depends_on: t.depends_on,
      allowed_globs: t.allowed_globs,
      forbidden_globs: t.forbidden_globs,
      auto_steer_budget: t.auto_steer_budget ?? policy?.auto_steer_budget ?? 2,
    }));
    const res = await dispatchBatchSessions(items, supportsServerV050);
    setDispatching(false);
    if (res.created.length > 0) {
      toast.success(`Dispatched ${res.created.length} isolated worktree ${res.created.length === 1 ? "run" : "runs"}.`);
      setGoal("");
      setPlanned(null);
      onDispatched(res.created);
    } else {
      toast.error(res.errors.join(" ") || "Could not dispatch planned tasks.");
    }
  };

  return (
    <div data-testid="goal-launchpad" className="mx-auto max-w-3xl w-full space-y-6 py-4">
      <div className="space-y-1.5">
        <h2 className="text-[20px] font-semibold text-[var(--ink)]">Goal to parallel worktrees</h2>
        <p className="text-[14px] text-[var(--ink-2)]">
          Describe an outcome. Fleet splits it into isolated worktree tasks, checks every change automatically, and opens a reviewable diff.
        </p>
      </div>

      <form onSubmit={handlePlan} className="space-y-3 rounded-[var(--radius-panel)] border border-[var(--hairline)] bg-[var(--board)] p-4">
        {repos.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--ink-2)] mr-1">
              <FolderGit2 className="size-3.5 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
              <span>Repository:</span>
            </span>
            {repos.slice(0, 6).map((r) => (
              <Button
                key={r.path}
                type="button"
                size="sm"
                variant={activeRepo === r.path ? "primary" : "outline"}
                onClick={() => setSelectedRepo(r.path)}
                className="mono"
              >
                {r.name}
              </Button>
            ))}
          </div>
        )}

        <Textarea
          id="launchpad-goal"
          aria-label="Goal description"
          rows={3}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Example: Add input validation to createLedger; write edge-case tests; then verify ledger formatting"
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12px] text-[var(--ink-3)]">
            Separate parallel steps with semicolons or newlines; use &quot;then&quot; for sequential DAG waves.
          </span>
          <Button type="submit" variant="primary" size="md" disabled={planning || !goal.trim()}>
            <Sparkles className="size-4" strokeWidth={1.5} aria-hidden />
            <span>{planning ? "Planning..." : "Plan DAG"}</span>
          </Button>
        </div>
      </form>

      {planned && planned.length > 0 && (
        <div data-testid="planned-dag-preview" className="space-y-3 rounded-[var(--radius-panel)] border border-[var(--hairline-s)] bg-[var(--surface)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[15px] font-semibold text-[var(--ink)]">
              Planned execution graph ({planned.length} {planned.length === 1 ? "task" : "tasks"})
            </h3>
            <Button type="button" variant="primary" size="md" disabled={dispatching} onClick={() => void handleLaunch()}>
              <Play className="size-4" strokeWidth={1.5} aria-hidden />
              <span>{dispatching ? "Launching..." : `Launch ${planned.length} worktree ${planned.length === 1 ? "run" : "runs"}`}</span>
            </Button>
          </div>
          <ol className="space-y-2">
            {planned.map((t, idx) => (
              <li key={idx} className="flex flex-wrap items-center gap-2.5 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] p-3">
                <Badge tone="info" className="mono">{t.alias}</Badge>
                <input
                  aria-label={`Planned task ${t.alias}`}
                  value={t.task}
                  onChange={(e) => {
                    const val = e.target.value;
                    setPlanned((prev) => prev?.map((row, k) => (k === idx ? { ...row, task: val } : row)) ?? null);
                  }}
                  className="min-w-0 flex-1 bg-transparent text-[14px] text-[var(--ink)] outline-none focus-visible:underline"
                />
                {t.depends_on && t.depends_on.length > 0 && (
                  <Badge tone="neutral" className="mono">
                    after {t.depends_on.join(", ")}
                  </Badge>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {playbooks.length > 0 && (
        <section aria-label="Quick playbooks" className="space-y-2.5">
          <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--ink-2)]">
            <BookMarked className="size-4 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
            <span>Playbooks</span>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {playbooks.slice(0, 4).map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => onApplyPlaybook(tpl)}
                className="flex flex-col items-start gap-1 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--board)] p-3 text-left cursor-pointer transition hover:border-[var(--hairline-s)] hover:bg-[var(--surface)] max-md:min-h-11"
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="text-[14px] font-medium text-[var(--ink)]">{tpl.name}</span>
                  <Badge tone="neutral" className="mono">
                    {(tpl.tasks?.length ?? 1) > 1 ? `${tpl.tasks!.length} waves` : "single"}
                  </Badge>
                </div>
                <p className="text-[12px] text-[var(--ink-2)] line-clamp-2">{tpl.description}</p>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function RightInspectorRail({
  session,
  mergeCheck,
  checkingMerge,
  supportsServerV050,
  onRecheckMerge,
  onOpenTab,
  onOpenPrPreview,
}: {
  session: Session | null;
  mergeCheck: MergeCheckResult | null;
  checkingMerge: boolean;
  supportsServerV050: boolean;
  onRecheckMerge: () => void;
  onOpenTab: (tab: TabId) => void;
  onOpenPrPreview: (s: Session) => void;
}) {
  if (!session) {
    return (
      <aside aria-label="Session inspector" className="flex h-full flex-col justify-center bg-[var(--board)] p-5 text-[13px] text-[var(--ink-3)]">
        <p>Select a run from the inbox to inspect its isolated worktree, verification steps, and PR readiness.</p>
      </aside>
    );
  }

  const healBadge = healBadgeInfo(session);
  const ds = diffStat(session.diff);
  const steps = session.check_steps ?? [];
  const conflictCount = mergeCheck?.conflicting_files.length ?? 0;
  const ranCheck = session.check_ran !== undefined ? Boolean(session.check_ran) : session.check_passed === true || session.check_passed === false;

  const handlePatch = async () => {
    const res = await downloadSessionPatch(session, supportsServerV050);
    if (res.ok) toast.success(`Downloaded ${res.filename}`);
    else toast.error(res.error || "Could not export patch.");
  };

  return (
    <aside aria-label="Session inspector" className="flex h-full min-h-0 flex-col overflow-y-auto bg-[var(--board)] p-4 space-y-5">
      <section className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold text-[var(--ink)]">Worktree</h3>
          {healBadge && (
            <Badge
              tone={healBadge.tone === "healed" ? "success" : healBadge.tone === "healing" ? "warning" : "danger"}
              className="mono"
              data-testid="inspector-heal-badge"
            >
              <Wrench className="size-3" strokeWidth={1.5} aria-hidden />
              <span>{healBadge.fullLabel}</span>
            </Badge>
          )}
        </div>
        <dl className="space-y-2 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--surface)] p-3 text-[12px]">
          <div>
            <dt className="text-[var(--ink-3)]">Branch</dt>
            <dd className="mt-0.5 flex items-center gap-1.5 mono text-[var(--ink)] break-all">
              <GitBranch className="size-3.5 shrink-0 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
              <span>{session.branch || "none"}</span>
            </dd>
          </div>
          {session.merge_target && (
            <div>
              <dt className="text-[var(--ink-3)]">Target</dt>
              <dd className="mt-0.5 mono text-[var(--ink)]">{session.merge_target}</dd>
            </div>
          )}
          {session.repo && (
            <div>
              <dt className="text-[var(--ink-3)]">Repository</dt>
              <dd className="mt-0.5 mono text-[var(--ink-2)] break-all">{session.repo}</dd>
            </div>
          )}
          {session.model && (
            <div>
              <dt className="text-[var(--ink-3)]">Model</dt>
              <dd className="mt-0.5 mono text-[var(--ink)] break-all">{session.model}</dd>
            </div>
          )}
          {session.allowed_globs && session.allowed_globs.length > 0 && (
            <div>
              <dt className="text-[var(--ink-3)] flex items-center gap-1">
                <Shield className="size-3 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
                <span>Allowed scope</span>
              </dt>
              <dd className="mt-0.5 mono text-[var(--ink-2)] break-all">{session.allowed_globs.join(", ")}</dd>
            </div>
          )}
        </dl>
      </section>

      <section className="space-y-2.5 border-t border-[var(--hairline)] pt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold text-[var(--ink)]">Verification</h3>
          <Button type="button" size="sm" variant="ghost" onClick={() => onOpenTab("rc")}>
            View receipt
          </Button>
        </div>

        <div className="rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--surface)] p-3 space-y-2">
          {steps.length > 0 ? (
            <ul className="space-y-1.5">
              {steps.map((st, idx) => {
                const passed = st.status === "passed" || st.passed === true;
                const failed = st.status === "failed" || st.passed === false;
                return (
                  <li key={`${st.name}-${idx}`} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      {passed ? (
                        <CheckCircle2 className="size-3.5 shrink-0 text-[var(--success-foreground)]" strokeWidth={1.5} aria-hidden />
                      ) : failed ? (
                        <XCircle className="size-3.5 shrink-0 text-[var(--destructive-foreground)]" strokeWidth={1.5} aria-hidden />
                      ) : (
                        <Clock className="size-3.5 shrink-0 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
                      )}
                      <span className="truncate font-medium text-[var(--ink)]">{st.name}</span>
                    </span>
                    <span className="shrink-0 mono text-[var(--ink-3)]">
                      {st.elapsed_ms !== null ? formatDurationMs(st.elapsed_ms) : st.status}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[12px] text-[var(--ink-2)] [overflow-wrap:anywhere]">
              {ranCheck ? receiptLine(session) : "Check executes automatically once the agent finishes."}
            </p>
          )}
        </div>
      </section>

      <section className="space-y-2.5 border-t border-[var(--hairline)] pt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold text-[var(--ink)]">Diff and PR</h3>
          <Button type="button" size="sm" variant="ghost" onClick={() => onOpenTab("df")}>
            <FileDiff className="size-3.5" strokeWidth={1.5} aria-hidden />
            <span>Diff</span>
          </Button>
        </div>

        <div className="rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--surface)] p-3 space-y-2.5 text-[12px]">
          <div className="flex items-center justify-between gap-2 mono">
            <span className="text-[var(--ink-2)]">
              {ds.files} {ds.files === 1 ? "file" : "files"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="text-[var(--diff-add-fg)]">+{ds.add}</span>
              <span className="text-[var(--diff-del-fg)]">-{ds.del}</span>
            </span>
          </div>

          {session.status !== "merged" && (
            <div className="flex items-center justify-between gap-2">
              <Badge tone={!mergeCheck ? "neutral" : mergeCheck.clean ? "success" : "danger"} className="mono">
                {!mergeCheck
                  ? checkingMerge
                    ? "Checking..."
                    : "Not checked"
                  : mergeCheck.clean
                    ? "Clean merge"
                    : `${conflictCount || 1} ${conflictCount === 1 ? "conflict" : "conflicts"}`}
              </Badge>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Re-check merge status"
                disabled={checkingMerge}
                onClick={onRecheckMerge}
              >
                <RefreshCw className={cn("size-3.5", checkingMerge && "animate-spin")} strokeWidth={1.5} />
              </Button>
            </div>
          )}

          <div className="flex flex-col gap-2 pt-1">
            {session.branch && (
              <Button
                type="button"
                variant="primary"
                size="sm"
                data-testid="open-pr-preview"
                onClick={() => onOpenPrPreview(session)}
                className="w-full"
              >
                <GitPullRequest className="size-3.5" strokeWidth={1.5} aria-hidden />
                <span>PR preview</span>
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={ds.files === 0}
              onClick={() => void handlePatch()}
              className="w-full"
            >
              <Download className="size-3.5" strokeWidth={1.5} aria-hidden />
              <span>Export .patch</span>
            </Button>
          </div>
        </div>
      </section>
    </aside>
  );
}

export function BoardMetricsStrip({
  metrics,
  streamLabel,
  reachable,
}: {
  metrics: BoardMetrics;
  streamLabel: string;
  reachable: boolean;
}) {
  return (
    <section
      aria-label="Scan"
      data-testid="board-metrics-strip"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-[var(--hairline)] bg-[var(--surface)] px-4 py-1.5 text-[12px] text-[var(--ink-2)]"
    >
      <div className="flex flex-wrap items-center gap-4">
        <span className="inline-flex items-center gap-1.5" data-testid="stream-pill">
          <StatusDot tone={reachable ? "green" : "amber"} />
          <span className="mono">{streamLabel}</span>
        </span>
        <span data-testid="concurrency-indicator" className="mono">
          {metrics.active_slots} / {metrics.max_parallel} slots
        </span>
        <span>
          First-pass{" "}
          <span className="mono font-medium text-[var(--ink)]">
            {metrics.total > 0 ? `${Math.round(metrics.first_pass_rate_pct)}%` : "n/a"}
          </span>
        </span>
        <span>
          Auto-healed{" "}
          <span data-testid="metric-auto-healed" className="mono font-medium text-[var(--ink)]">
            {metrics.auto_healed_count}
          </span>
        </span>
        <span>
          Median check{" "}
          <span className="mono font-medium text-[var(--ink)]">
            {metrics.median_check_ms !== null ? formatDurationMs(metrics.median_check_ms) : "n/a"}
          </span>
        </span>
      </div>

      {metrics.budget && (
        <div className="flex items-center gap-3 mono">
          <span
            className={cn(
              metrics.budget.limit_reached ? "text-[var(--destructive-foreground)] font-medium" : "text-[var(--ink-2)]",
            )}
          >
            Budget {metrics.budget.sessions_today} / {metrics.budget.daily_session_limit}
          </span>
        </div>
      )}
    </section>
  );
}

export { Layers };
