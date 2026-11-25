// Live Policy Tester (POST /api/policies/test), Budget Guardrails, and Worktrees Inspector
// (GET/DELETE /api/repos/worktrees + bulk prune) inside the Engines and settings Vaul drawer.
import { useCallback, useEffect, useState } from "react";
import {
  FlaskConical,
  FolderGit2,
  FolderSync,
  Gauge,
  GitBranch,
  Play,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { Badge, Button, Input, SegmentedControl, cn, toast } from "./ui";
import {
  computeLocalBudget,
  deleteRepoWorktree,
  fetchRepoWorktrees,
  pruneStaleWorktrees,
  testPolicyRoute,
  type BoardMetrics,
  type Policy,
  type PolicyTestResult,
  type RepoInfo,
  type RuntimeConfig,
  type Session,
  type WorktreeEntry,
} from "./api";

const ENGINE_OPTIONS = ["auto", "opencode", "claude", "codex"] as const;

export function PolicyTesterSection({
  policy,
  config,
  repos,
  sessions,
  metrics,
  settingsOpen,
  supportsServerV050,
  supportsServerV070,
  canPrune,
  onPruned,
}: {
  policy: Policy | null;
  config: RuntimeConfig | null;
  repos: RepoInfo[];
  sessions: Session[];
  metrics: BoardMetrics;
  settingsOpen: boolean;
  supportsServerV050: boolean;
  supportsServerV070: boolean;
  canPrune: boolean;
  onPruned?: () => void;
}) {
  const [repo, setRepo] = useState(() => repos[0]?.path || "/workspace/ledger-kit");
  const [task, setTask] = useState("Add regression test coverage and verify edge cases");
  const [engine, setEngine] = useState<string>("auto");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<PolicyTestResult | null>(null);
  const [pruning, setPruning] = useState(false);

  // Worktrees Inspector state
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [wtSource, setWtSource] = useState<"server" | "local">("local");
  const [wtLoading, setWtLoading] = useState(false);
  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);

  const loadWorktrees = useCallback(async () => {
    setWtLoading(true);
    const res = await fetchRepoWorktrees(sessions, repos, supportsServerV070);
    setWorktrees(res.worktrees);
    setWtSource(res.source);
    setWtLoading(false);
  }, [sessions, repos, supportsServerV070]);

  useEffect(() => {
    if (settingsOpen) {
      void loadWorktrees();
    }
  }, [settingsOpen, loadWorktrees]);

  const runTest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (testing) return;
    setTesting(true);
    const res = await testPolicyRoute(
      { repo, task, engine },
      policy,
      config,
      supportsServerV050,
    );
    setResult(res);
    setTesting(false);
  };

  const runPrune = async () => {
    if (pruning) return;
    setPruning(true);
    const res = await pruneStaleWorktrees(supportsServerV050);
    setPruning(false);
    if (res.ok) {
      toast.success(res.message);
      void loadWorktrees();
      onPruned?.();
    } else {
      toast.error(res.message);
    }
  };

  const removeOneWorktree = async (wt: WorktreeEntry) => {
    if (wt.is_main || deletingPath) return;
    setDeletingPath(wt.path);
    const res = await deleteRepoWorktree({ repo: wt.repo, path: wt.path }, supportsServerV070);
    setDeletingPath(null);
    setConfirmPath(null);
    if (res.ok) {
      toast.success(res.message);
      setWorktrees((prev) => prev.filter((item) => item.path !== wt.path));
      void loadWorktrees();
      onPruned?.();
    } else {
      toast.error(res.message);
    }
  };

  const budget = metrics.budget ?? computeLocalBudget(sessions, policy);
  const budgetPct =
    budget.daily_session_limit > 0
      ? Math.min(100, Math.round((budget.sessions_today / budget.daily_session_limit) * 100))
      : 0;
  const orphanCount = worktrees.filter((w) => w.is_orphan && !w.is_main).length;

  return (
    <>
      <section
        className="space-y-3 border-t border-[var(--hairline)] pt-5"
        aria-label="Budget guardrails"
        data-testid="budget-guardrails"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ink)]">
            <Gauge className="size-4 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
            <span>Budget guardrails</span>
          </h3>
          <Badge
            tone={budget.limit_reached ? "warning" : "success"}
            className="mono"
            data-testid="budget-status-pill"
          >
            {budget.limit_reached
              ? "daily cap reached"
              : `${budget.sessions_today} / ${budget.daily_session_limit} today`}
          </Badge>
        </div>
        <p className="text-[13px] leading-relaxed text-[var(--ink-3)]">
          Prevents runaway dispatch loops with daily session caps (HTTP 429 on overflow), per-session time ceilings, and auto-heal retry limits.
        </p>

        <div className="space-y-2.5 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] p-3 text-[13px]">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between mono text-[12px]">
              <span className="text-[var(--ink-2)]">Daily dispatch utilization</span>
              <span className={cn("font-medium", budget.limit_reached ? "text-[var(--destructive-foreground)]" : "text-[var(--ink)]")}>
                {budget.sessions_today} / {budget.daily_session_limit} ({budgetPct}%)
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--track)]">
              <div
                className={cn(
                  "h-full w-full origin-left transition",
                  budget.limit_reached
                    ? "bg-[var(--dot-red)]"
                    : budgetPct >= 80
                      ? "bg-[var(--dot-amber)]"
                      : "bg-[var(--dot-green)]",
                )}
                style={{ transform: `scaleX(${Math.max(budgetPct, budget.sessions_today > 0 ? 4 : 0) / 100})` }}
              />
            </div>
          </div>

          <dl className="grid grid-cols-3 gap-2 border-t border-[var(--hairline)] pt-2.5 mono text-[12px]">
            <div>
              <dt className="font-sans text-[var(--ink-3)]">Remaining</dt>
              <dd className="mt-0.5 font-medium text-[var(--ink)]">{budget.remaining_today}</dd>
            </div>
            <div>
              <dt className="font-sans text-[var(--ink-3)]">Max session</dt>
              <dd className="mt-0.5 font-medium text-[var(--ink)]">{budget.max_session_mins} min</dd>
            </div>
            <div>
              <dt className="font-sans text-[var(--ink-3)]">Max heals</dt>
              <dd className="mt-0.5 font-medium text-[var(--ink)]">{budget.max_heal_attempts} / run</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="space-y-3 border-t border-[var(--hairline)] pt-5" aria-label="Live Policy Tester">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ink)]">
            <FlaskConical className="size-4 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
            <span>Policy tester</span>
          </h3>
          {result && (
            <Badge tone={result.warnings.length ? "warning" : "success"} className="mono">
              {result.source === "server" ? "live rules" : "policy preview"}
            </Badge>
          )}
        </div>
        <p className="text-[13px] leading-relaxed text-[var(--ink-3)]">
          Dry-run a repo path, task prompt, and engine choice through <span className="mono text-[var(--ink-2)]">policies.rn</span> before dispatching.
        </p>

        <form onSubmit={runTest} className="space-y-2.5">
          <div className="space-y-1">
            <label htmlFor="policy-test-repo" className="block text-[13px] font-medium text-[var(--ink-2)]">
              Repository path or project
            </label>
            <Input
              id="policy-test-repo"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="/home/you/projects/app"
              className="mono text-[13px]"
            />
            {repos.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {repos.slice(0, 4).map((r) => (
                  <Button
                    key={r.path}
                    type="button"
                    size="sm"
                    variant={repo === r.path ? "primary" : "outline"}
                    onClick={() => setRepo(r.path)}
                    className="mono"
                  >
                    {r.name}
                  </Button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor="policy-test-task" className="block text-[13px] font-medium text-[var(--ink-2)]">
              Sample task
            </label>
            <Input
              id="policy-test-task"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Describe a sample coding task"
            />
          </div>

          <div className="space-y-1">
            <p className="text-[13px] font-medium text-[var(--ink-2)]">Engine override</p>
            <SegmentedControl
              label="Policy test engine"
              value={engine}
              onChange={(opt) => setEngine(opt)}
              options={ENGINE_OPTIONS.map((opt) => ({ value: opt, label: opt }))}
            />
          </div>

          <Button type="submit" size="sm" variant="outline" disabled={testing}>
            <Play className="size-3.5" strokeWidth={1.5} aria-hidden />
            <span>{testing ? "Evaluating..." : "Test policy"}</span>
          </Button>
        </form>

        {result && (
          <div
            data-testid="policy-test-result"
            className="space-y-2 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] p-3 text-[12px]"
          >
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 mono">
              <div>
                <dt className="text-[var(--ink-3)]">Routed engine</dt>
                <dd className="font-medium text-[var(--ink)]">{result.engine}</dd>
              </div>
              <div>
                <dt className="text-[var(--ink-3)]">Model</dt>
                <dd className="truncate text-[var(--ink)]">{result.model || "engine default"}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-[var(--ink-3)]">Check command</dt>
                <dd className="break-all text-[var(--ink)]">{result.check_cmd}</dd>
              </div>
              <div>
                <dt className="text-[var(--ink-3)]">Concurrency / Timeout</dt>
                <dd className="text-[var(--ink)]">{result.max_parallel} slots / {result.timeout_secs}s</dd>
              </div>
              <div>
                <dt className="text-[var(--ink-3)]">Retry / Steer budget</dt>
                <dd className="text-[var(--ink)]">{result.auto_retry_budget} retry / {result.auto_steer_budget} steer</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-[var(--ink-3)]">Matched rule</dt>
                <dd className="break-all text-[var(--ink-2)]">{result.matched_rule}</dd>
              </div>
              {result.allowed_globs.length > 0 && (
                <div className="col-span-2">
                  <dt className="text-[var(--ink-3)]">Allowed globs</dt>
                  <dd className="break-all text-[var(--ink-2)]">{result.allowed_globs.join(", ")}</dd>
                </div>
              )}
              {result.forbidden_globs.length > 0 && (
                <div className="col-span-2">
                  <dt className="text-[var(--ink-3)]">Forbidden globs</dt>
                  <dd className="break-all text-[var(--ink-2)]">{result.forbidden_globs.join(", ")}</dd>
                </div>
              )}
            </dl>

            {result.warnings.length > 0 && (
              <div className="space-y-1 border-t border-[var(--hairline)] pt-2 text-[var(--warning-foreground)]">
                {result.warnings.map((w, i) => (
                  <p key={i} className="flex items-start gap-1.5">
                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
                    <span>{w}</span>
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <section
        className="space-y-3 border-t border-[var(--hairline)] pt-5"
        aria-label="Worktrees inspector"
        data-testid="worktrees-inspector"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ink)]">
              <FolderGit2 className="size-4 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
              <span>Worktrees inspector</span>
            </h3>
            <p className="text-[13px] text-[var(--ink-3)]">
              Inspect git worktrees across repositories, spot orphans, and prune individual non-main checkouts.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={wtLoading}
              onClick={() => void loadWorktrees()}
              aria-label="Refresh worktrees"
            >
              <RefreshCw className={cn("size-3.5", wtLoading && "animate-spin")} strokeWidth={1.5} aria-hidden />
              <span>Refresh</span>
            </Button>
            {canPrune && supportsServerV050 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pruning}
                onClick={runPrune}
              >
                <FolderSync className="size-3.5" strokeWidth={1.5} aria-hidden />
                <span>{pruning ? "Pruning..." : "Prune all stale"}</span>
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 mono text-[12px] text-[var(--ink-3)]">
          <span>{worktrees.length} {worktrees.length === 1 ? "worktree" : "worktrees"}</span>
          {orphanCount > 0 && (
            <Badge tone="warning">
              {orphanCount} {orphanCount === 1 ? "orphan" : "orphans"}
            </Badge>
          )}
          <span className="ml-auto">{wtSource === "server" ? "live git list" : "session preview"}</span>
        </div>

        {worktrees.length === 0 ? (
          <p className="rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] px-3 py-2.5 text-[13px] text-[var(--ink-3)]">
            No git worktrees reported yet.
          </p>
        ) : (
          <ul className="space-y-2" aria-label="Repository worktrees">
            {worktrees.map((wt) => {
              const isConfirming = confirmPath === wt.path;
              const isDeleting = deletingPath === wt.path;
              return (
                <li
                  key={wt.path}
                  data-testid="worktree-row"
                  data-orphan={wt.is_orphan ? "true" : "false"}
                  className="space-y-1.5 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] p-2.5 text-[12px]"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-[var(--ink)]">{wt.project}</span>
                    <span className="inline-flex min-w-0 items-center gap-1 rounded-[var(--radius-chip)] bg-[var(--track)] px-1.5 py-0.5 mono text-[var(--ink-2)]">
                      <GitBranch className="size-3 shrink-0 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
                      <span className="truncate">{wt.branch}</span>
                    </span>
                    {wt.is_main && <Badge tone="neutral">main</Badge>}
                    {wt.is_orphan && !wt.is_main && <Badge tone="warning">orphan</Badge>}
                    {wt.dirty && <Badge tone="danger">dirty</Badge>}
                    {wt.session_id && (
                      <span className="rounded-[var(--radius-chip)] bg-[var(--board)] px-1.5 py-0.5 mono text-[var(--ink-2)]">
                        {wt.session_id} ({wt.session_status || "linked"})
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 flex-1 break-all mono text-[var(--ink-3)]">{wt.path}</p>
                    {!wt.is_main && wt.removable && supportsServerV070 && (
                      isConfirming ? (
                        <div className="flex items-center gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="danger"
                            disabled={isDeleting}
                            onClick={() => void removeOneWorktree(wt)}
                            data-testid="worktree-confirm-prune"
                          >
                            {isDeleting ? "Removing..." : "Confirm prune"}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmPath(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setConfirmPath(wt.path)}
                          data-testid="worktree-prune-btn"
                          aria-label={`Prune worktree ${wt.branch}`}
                        >
                          <Trash2 className="size-3.5" strokeWidth={1.5} aria-hidden />
                          <span>Prune</span>
                        </Button>
                      )
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
