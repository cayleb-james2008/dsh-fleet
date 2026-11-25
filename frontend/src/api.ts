// The /api routes of Fleet (v0.4.0..v0.7.0), with defensive normalization and graceful fallbacks
// so malformed, partial, null, or pending endpoints never throw or blank the board.

export type Bucket = "needs-you" | "working" | "done";
export type TabId = "tr" | "df" | "rc";
export type ViewMode = "board" | "dag";
export type MergeStrategy = "merge" | "squash" | "ff";
export type StatusFilter = "all" | "needs-you" | "working" | "queued" | "done";

export type CheckStepSpec = {
  name: string;
  cmd: string;
  timeout_secs?: number;
};

export type CheckStepReceipt = {
  name: string;
  cmd: string;
  exit_code: number | null;
  elapsed_ms: number | null;
  passed: boolean | null;
  tail_line: string;
  output: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
};

export type FailureClassification = {
  category: string;
  label: string;
  hint: string;
  retryable: boolean;
};

export type HealAttempt = {
  attempt: number;
  trigger_step: string;
  exit_code: number | null;
  stderr_tail: string;
  prompt_sent: string;
  started_ms: number | null;
  elapsed_ms: number | null;
  healed: boolean;
  failure_category?: string | null;
  failure_label?: string | null;
};

export type PlaybookTaskSpec = {
  key?: string;
  alias?: string;
  repo?: string;
  project?: string;
  task: string;
  agent?: string;
  check?: string;
  depends_on?: string[];
};

export type PlaybookTemplate = {
  id: string;
  name: string;
  description: string;
  repo?: string;
  check_steps?: CheckStepSpec[];
  allowed_globs?: string[];
  forbidden_globs?: string[];
  auto_steer_budget?: number | null;
  tasks?: PlaybookTaskSpec[];
  builtin?: boolean;
};

export type RepoMetricsRow = {
  repo: string;
  total: number;
  first_pass: number;
  auto_healed: number;
  needs_you: number;
  median_check_ms: number | null;
};

export type BudgetStatus = {
  max_session_mins: number;
  daily_session_limit: number;
  max_heal_attempts: number;
  sessions_today: number;
  remaining_today: number;
  limit_reached: boolean;
  utilization_pct: number;
  total_heal_attempts_today?: number;
  source: "server" | "local";
};

export type BatchMergeItemResult = {
  id: string;
  task?: string;
  repo?: string;
  branch?: string;
  target?: string;
  status: "ready" | "conflict" | "merged" | "skipped" | "failed";
  clean: boolean;
  can_apply: boolean;
  diff_files?: number;
  diff_add?: number;
  diff_del?: number;
  conflicting_files: string[];
  commits_ahead?: number;
  commits_behind?: number;
  error?: string | null;
};

export type BatchMergeResponse = {
  ok: boolean;
  dry_run: boolean;
  strategy: MergeStrategy;
  total: number;
  clean_count: number;
  conflict_count: number;
  merged_count: number;
  skipped_count: number;
  failed_count: number;
  preflight?: {
    ready_ids: string[];
    conflicted_ids: string[];
    skipped_ids: string[];
  };
  results: BatchMergeItemResult[];
  error?: string;
};

export type BatchPrItemResult = {
  id: string;
  task?: string;
  repo?: string;
  branch?: string;
  base_branch?: string;
  title?: string;
  url?: string;
  pushed?: boolean;
  ready: boolean;
  status: "ready" | "blocked" | "created" | "skipped" | "failed";
  diff_files?: number;
  diff_add?: number;
  diff_del?: number;
  warnings?: string[];
  error?: string | null;
};

export type BatchPrResponse = {
  ok: boolean;
  dry_run: boolean;
  draft: boolean;
  total: number;
  ready_count: number;
  created_count: number;
  skipped_count: number;
  failed_count: number;
  results: BatchPrItemResult[];
  error?: string;
};

export type PrPreview = {
  session_id: string;
  repo: string;
  title: string;
  body: string;
  base_branch: string;
  head_branch: string;
  gh_available: boolean;
  gh_status?: string;
  can_create: boolean;
  warnings: string[];
  diff_files: number;
  diff_add: number;
  diff_del: number;
  source: "server" | "local";
};

export type PrCreateResult = {
  ok: boolean;
  url?: string;
  number?: number;
  draft?: boolean;
  dry_run?: boolean;
  message: string;
  error?: string;
};

export type WorktreeEntry = {
  repo: string;
  project: string;
  path: string;
  branch: string;
  head?: string;
  is_main: boolean;
  is_orphan: boolean;
  dirty: boolean;
  is_locked?: boolean;
  lock_reason?: string | null;
  removable: boolean;
  session_id?: string | null;
  session_status?: string | null;
  session_task?: string | null;
};

export type BoardMetrics = {
  total: number;
  first_pass_count: number;
  auto_healed_count: number;
  needs_you_count: number;
  first_pass_rate_pct: number;
  effective_pass_rate_pct: number;
  median_check_ms: number | null;
  active_slots: number;
  max_parallel: number;
  queued_count: number;
  per_repo_breakdown: RepoMetricsRow[];
  budget?: BudgetStatus;
  source: "server" | "local";
};

export type MergeCheckResult = {
  clean: boolean;
  conflicting_files: string[];
  commits_ahead: number;
  commits_behind: number;
  source?: "server" | "fallback";
  error?: string;
};

export type PolicyTestRequest = {
  repo: string;
  project?: string;
  task: string;
  engine?: string;
};

export type PolicyTestResult = {
  engine: string;
  model: string | null;
  check_cmd: string;
  check_steps: CheckStepSpec[];
  timeout_secs: number;
  max_parallel: number;
  auto_retry_budget: number;
  auto_steer_budget: number;
  allowed_globs: string[];
  forbidden_globs: string[];
  matched_rule: string;
  warnings: string[];
  source: "server" | "fallback";
};

export type BatchDispatchItem = {
  alias?: string;
  repo: string;
  project?: string;
  task: string;
  agent?: string;
  check?: string;
  check_steps?: CheckStepSpec[];
  next?: string;
  depends_on?: string[];
  allowed_globs?: string[];
  forbidden_globs?: string[];
  auto_steer_budget?: number;
};

export type Session = {
  id: string;
  task: string;
  project: string;
  repo?: string;
  status: string;
  bucket: Bucket;
  branch?: string;
  engine?: string;
  agent?: string;
  model?: string | null;
  test_mode?: boolean;
  reason?: string | null;
  check_cmd?: string;
  check_output?: string;
  check_passed?: boolean | null;
  check_ran?: boolean;
  check_exit?: number | null;
  check_steps?: CheckStepReceipt[];
  heal_attempts?: HealAttempt[];
  auto_healed?: boolean;
  failure_classification?: FailureClassification | null;
  auto_steer_budget?: number | null;
  queue_position?: number | null;
  transcript: string[];
  transcript_total?: number | null;
  diff?: string;
  steer?: string[];
  successor?: string | null;
  spawned_from?: string | null;
  next_queue?: string[];
  depends_on?: string[];
  blocked_by?: string[];
  allowed_globs?: string[];
  forbidden_globs?: string[];
  guardrail_violations?: string[];
  merge_target?: string | null;
  merge_strategy?: MergeStrategy | null;
  merge_error?: { message?: string; detail?: string } | null;
  elapsed_ms?: number | null;
  created_at_ms?: number | null;
  started_at_ms?: number | null;
  finished_at_ms?: number | null;
  run_elapsed_ms?: number | null;
  duration_ms?: number | null;
  heal_budget_total?: number | null;
  heal_budget_remaining?: number | null;
};

export type Agent = { name: string; found: boolean; path?: string };
export type EngineModels = {
  opencode?: string | null;
  claude?: string | null;
  codex?: string | null;
};
export type PolicyFeatures = {
  sse?: boolean;
  batch?: boolean;
  batch_merge?: boolean;
  batch_pr?: boolean;
  wave_preflight?: boolean;
  failure_classifier?: boolean;
  smart_router?: boolean;
  failure_memory?: boolean;
  merge_check?: boolean;
  policy_test?: boolean;
  prune_worktrees?: boolean;
  auto_heal?: boolean;
  templates?: boolean;
  metrics?: boolean;
  pr_preview?: boolean;
  worktrees?: boolean;
  budget?: boolean;
};
export type Policy = {
  agents: Agent[];
  max_parallel: number;
  timeout_secs: number;
  source: string;
  version?: string | null;
  default_agent?: string | null;
  default_agent_engine?: string;
  model?: string | null;
  models?: EngineModels;
  auto_retry_budget?: number;
  auto_steer_budget?: number;
  features?: PolicyFeatures;
};

export type RuntimeConfig = {
  default_agent?: string | null;
  default_agent_engine?: string | null;
  opencode_model?: string | null;
  claude_model?: string | null;
  codex_model?: string | null;
  effective_models?: EngineModels;
  policy_model?: string | null;
  env_model?: string | null;
  max_parallel?: number | null;
};

export type RepoInfo = {
  name: string;
  path: string;
  branch?: string | null;
};

export type WebEngineStatus = {
  mode: "browser" | "local";
  localUrl: string;
  byokBaseUrl: string;
  byokModel: string;
  byokConfigured: boolean;
};

export type WebEngineHandle = {
  getStatus: () => WebEngineStatus;
  setLocalConnection: (url: string, enable: boolean) => Promise<{ ok: boolean; error?: string }>;
  setByok: (cfg: { baseUrl: string; model: string; apiKey?: string; clearKey?: boolean }) => WebEngineStatus;
  resetWorkspace: () => Promise<void>;
  getSessionFiles: (sessionId: string) => Record<string, string> | null;
  updateSessionFile: (sessionId: string, filePath: string, content: string) => Promise<{ ok: boolean; error?: string }>;
};

export type UpdateState = {
  current?: string;
  latest?: string;
  available?: boolean;
  mode?: string;
  can_apply?: boolean;
  dev_build?: boolean;
  staged?: string | null;
  applied?: string | null;
  notes?: string | null;
  release_url?: string | null;
  error?: string | null;
  checked_at?: number | null;
};

export const VERSION_URL = "https://github.com/cayleb-james2008/fleet/releases/tag/v";
const LOCAL_PLAYBOOKS_KEY = "fleet-playbooks-v1";

export const DEFAULT_PLAYBOOKS: PlaybookTemplate[] = [
  {
    id: "feature-with-tests",
    name: "Feature + Unit Tests",
    description: "Implement a scoped change with syntax lint, test suite, and auto-heal recovery.",
    check_steps: [
      { name: "syntax-lint", cmd: "lint", timeout_secs: 60 },
      { name: "unit-tests", cmd: "npm test", timeout_secs: 300 },
    ],
    allowed_globs: ["src/**", "tests/**"],
    forbidden_globs: [".env*", "*.pem"],
    auto_steer_budget: 2,
    tasks: [{ task: "Implement the requested feature and cover edge cases with unit tests", check: "npm test" }],
    builtin: true,
  },
  {
    id: "two-wave-dag",
    name: "Two-Wave DAG Rollout",
    description: "Wave 1 lands core API helper; Wave 2 runs automatically once Wave 1 is verified done.",
    check_steps: [{ name: "verify", cmd: "npm test", timeout_secs: 300 }],
    allowed_globs: ["src/**", "tests/**"],
    forbidden_globs: [".env*"],
    auto_steer_budget: 2,
    tasks: [
      { alias: "#1", task: "Wave 1: Implement shared helper and baseline tests", check: "npm test" },
      { alias: "#2", task: "Wave 2: Integrate downstream consumer and regression checks", check: "npm test", depends_on: ["#1"] },
    ],
    builtin: true,
  },
  {
    id: "strict-scope-hotfix",
    name: "Strict-Scope Hotfix",
    description: "Restricts edits to src/** and tests/** with zero unplanned file drift and auto-heal enabled.",
    check_steps: [{ name: "regression-suite", cmd: "npm test", timeout_secs: 180 }],
    allowed_globs: ["src/**", "tests/**"],
    forbidden_globs: ["package-lock.json", "Cargo.lock", ".env*"],
    auto_steer_budget: 2,
    tasks: [{ task: "Fix the reported defect without touching configuration or lockfiles", check: "npm test" }],
    builtin: true,
  },
  {
    id: "parallel-audit-fanout",
    name: "Parallel Repo Audit Fan-Out",
    description: "Runs parallel hardening tasks across multiple repositories under shared concurrency limits.",
    check_steps: [
      { name: "syntax-lint", cmd: "lint", timeout_secs: 60 },
      { name: "test-suite", cmd: "npm test", timeout_secs: 300 },
    ],
    allowed_globs: ["src/**", "tests/**"],
    forbidden_globs: [".env*", "*.key"],
    auto_steer_budget: 1,
    tasks: [
      { alias: "#1", task: "Add boundary input validation and unit coverage", check: "npm test" },
      { alias: "#2", task: "Audit error paths and add deterministic regression assertions", check: "npm test" },
    ],
    builtin: true,
  },
];

export function getWebEngine(): WebEngineHandle | null {
  if (typeof window === "undefined") return null;
  return (window as { __FLEET_WEB_ENGINE__?: WebEngineHandle }).__FLEET_WEB_ENGINE__ ?? null;
}

export function isWebEngineMode(): boolean {
  return getWebEngine() !== null;
}

export function semverGte(version: string | null | undefined, target: [number, number, number]): boolean {
  if (!version) return false;
  const clean = version.trim().replace(/^v/i, "").split("-")[0];
  const parts = clean.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return false;
  const [maj = 0, min = 0, pat = 0] = parts;
  if (maj !== target[0]) return maj > target[0];
  if (min !== target[1]) return min > target[1];
  return pat >= target[2];
}

export function supportsV050(version?: string | null, policy?: Policy | null): boolean {
  if (isWebEngineMode()) return true;
  if (policy?.features && Object.values(policy.features).some(Boolean)) return true;
  return semverGte(version || policy?.version, [0, 5, 0]);
}

export function supportsV060(version?: string | null, policy?: Policy | null): boolean {
  if (isWebEngineMode()) return true;
  if (policy?.features?.auto_heal || policy?.features?.templates || policy?.features?.metrics) return true;
  return semverGte(version || policy?.version, [0, 6, 0]);
}

export function supportsV070(version?: string | null, policy?: Policy | null): boolean {
  if (isWebEngineMode()) return true;
  if (policy?.features?.pr_preview || policy?.features?.worktrees || policy?.features?.budget) return true;
  return semverGte(version || policy?.version, [0, 7, 0]);
}

export function repoBasename(repoPath: string): string {
  const parts = (repoPath || "").trim().replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "";
}

function asStr(v: unknown, fallback = ""): string {
  if (v === null || v === undefined) return fallback;
  return typeof v === "string" ? v : String(v);
}

function asStrList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x !== null && x !== undefined)
    .map((x) => asStr(x).trim())
    .filter(Boolean);
}

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function normalizeHealAttempt(raw: unknown, idx = 0): HealAttempt | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const attempt = asNum(o.attempt) ?? idx + 1;
  return {
    attempt,
    trigger_step: asStr(o.trigger_step ?? o.step ?? o.check_step, "verify") || "verify",
    exit_code: asNum(o.exit_code ?? o.exitCode),
    stderr_tail: asStr(o.stderr_tail ?? o.stderr ?? o.error, "").trim(),
    prompt_sent: asStr(o.prompt_sent ?? o.prompt, "").trim(),
    started_ms: asNum(o.started_ms ?? o.startedMs),
    elapsed_ms: asNum(o.elapsed_ms ?? o.elapsedMs ?? o.duration_ms),
    healed: Boolean(o.healed ?? o.succeeded ?? o.ok),
    failure_category: o.failure_category ? asStr(o.failure_category) : null,
    failure_label: o.failure_label ? asStr(o.failure_label) : null,
  };
}

function normalizeCheckStep(raw: unknown, idx: number): CheckStepReceipt | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const cmd = asStr(o.cmd ?? o.command, "").trim();
  const name = asStr(o.name, "").trim() || cmd || `Step ${idx + 1}`;
  const exitCode = asNum(o.exit_code ?? o.exitCode ?? o.exit);
  const elapsedMs = asNum(o.elapsed_ms ?? o.elapsedMs ?? o.duration_ms ?? o.durationMs);
  const passed =
    typeof o.passed === "boolean"
      ? o.passed
      : typeof o.ok === "boolean"
        ? o.ok
        : exitCode !== null
          ? exitCode === 0
          : null;
  const output = asStr(o.output ?? o.stdout ?? "", "");
  const tailLine =
    asStr(o.tail_line ?? o.tailLine, "").trim() ||
    output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ||
    "";
  const rawStatus = asStr(o.status, "").toLowerCase();
  let status: CheckStepReceipt["status"] = "pending";
  if (rawStatus === "running" || rawStatus === "passed" || rawStatus === "failed" || rawStatus === "skipped" || rawStatus === "pending") {
    status = rawStatus;
  } else if (passed === true) {
    status = "passed";
  } else if (passed === false) {
    status = "failed";
  }
  return {
    name,
    cmd: cmd || name,
    exit_code: exitCode,
    elapsed_ms: elapsedMs,
    passed,
    tail_line: tailLine,
    output,
    status,
  };
}

export function normalizeSession(raw: unknown, idx = 0): Session | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rawStatus = asStr(r.status, "working").trim() || "working";
  const rawBucket = asStr(r.bucket, "").trim();
  if (rawStatus === "archived" || rawBucket === "archived") return null;

  let bucket: Bucket = "working";
  if (rawBucket === "needs-you" || rawBucket === "working" || rawBucket === "done") {
    bucket = rawBucket;
  } else if (rawStatus === "needs-you") {
    bucket = "needs-you";
  } else if (rawStatus === "done" || rawStatus === "merged") {
    bucket = "done";
  }

  const id = asStr(r.id, "").trim() || `session-${idx}`;
  const task = asStr(r.task, "").trim() || "Untitled session";
  const project = asStr(r.project, "").trim() || "default";
  const transcript = Array.isArray(r.transcript)
    ? r.transcript.filter((x) => x !== null && x !== undefined).map((x) => asStr(x))
    : [];
  const steer = asStrList(r.steer);
  const nextQueue = asStrList(r.next_queue);
  const dependsOn = asStrList(r.depends_on);
  const blockedBy = asStrList(r.blocked_by);
  const allowedGlobs = asStrList(r.allowed_globs);
  const forbiddenGlobs = asStrList(r.forbidden_globs);
  const guardrailViolations = asStrList(r.guardrail_violations ?? r.scope_violations);

  const rawSteps = Array.isArray(r.check_steps)
    ? r.check_steps
    : Array.isArray(r.step_receipts)
      ? r.step_receipts
      : Array.isArray(r.receipt_steps)
        ? r.receipt_steps
        : [];
  const checkSteps = rawSteps
    .map((item, i) => normalizeCheckStep(item, i))
    .filter((item): item is CheckStepReceipt => item !== null);

  const rawHeals = Array.isArray(r.heal_attempts)
    ? r.heal_attempts
    : Array.isArray(r.auto_heal_attempts)
      ? r.auto_heal_attempts
      : [];
  const healAttempts = rawHeals
    .map((item, i) => normalizeHealAttempt(item, i))
    .filter((item): item is HealAttempt => item !== null);
  const autoHealed =
    typeof r.auto_healed === "boolean"
      ? r.auto_healed
      : healAttempts.some((a) => a.healed) && (rawStatus === "done" || rawStatus === "merged");

  const mergeErr =
    r.merge_error && typeof r.merge_error === "object"
      ? {
          message: asStr((r.merge_error as Record<string, unknown>).message, ""),
          detail: asStr((r.merge_error as Record<string, unknown>).detail, ""),
        }
      : null;

  const rawStrategy = asStr(r.merge_strategy, "").toLowerCase();
  const mergeStrategy: MergeStrategy | null =
    rawStrategy === "squash"
      ? "squash"
      : rawStrategy === "ff" || rawStrategy === "ff-only" || rawStrategy === "fast-forward" || rawStrategy === "fast-forward-only"
        ? "ff"
        : rawStrategy === "merge" || rawStrategy === "merge-commit"
          ? "merge"
          : null;

  return {
    id,
    task,
    project,
    repo: asStr(r.repo, ""),
    status: rawStatus,
    bucket,
    branch: asStr(r.branch, ""),
    engine: asStr(r.engine, ""),
    agent: asStr(r.agent, ""),
    model: r.model ? asStr(r.model) : null,
    test_mode: Boolean(r.test_mode),
    reason: r.reason === null || r.reason === undefined ? null : asStr(r.reason),
    check_cmd: asStr(r.check_cmd, ""),
    check_output: asStr(r.check_output, ""),
    check_passed: typeof r.check_passed === "boolean" ? r.check_passed : null,
    check_ran: typeof r.check_ran === "boolean" ? r.check_ran : undefined,
    check_exit: asNum(r.check_exit),
    check_steps: checkSteps.length ? checkSteps : undefined,
    heal_attempts: healAttempts.length ? healAttempts : undefined,
    auto_healed: autoHealed || undefined,
    auto_steer_budget: asNum(r.auto_steer_budget ?? r.heal_budget),
    queue_position: asNum(r.queue_position),
    transcript,
    transcript_total: asNum(r.transcript_total),
    diff: typeof r.diff === "string" ? r.diff : "",
    steer,
    successor: r.successor ? asStr(r.successor) : null,
    spawned_from: r.spawned_from ? asStr(r.spawned_from) : null,
    next_queue: nextQueue,
    depends_on: dependsOn.length ? dependsOn : undefined,
    blocked_by: blockedBy.length ? blockedBy : undefined,
    allowed_globs: allowedGlobs.length ? allowedGlobs : undefined,
    forbidden_globs: forbiddenGlobs.length ? forbiddenGlobs : undefined,
    guardrail_violations: guardrailViolations.length ? guardrailViolations : undefined,
    merge_target: r.merge_target ? asStr(r.merge_target) : null,
    merge_strategy: mergeStrategy,
    merge_error: mergeErr,
    elapsed_ms: asNum(r.elapsed_ms),
    created_at_ms: asNum(r.created_at_ms),
    started_at_ms: asNum(r.started_at_ms),
    finished_at_ms: asNum(r.finished_at_ms),
    run_elapsed_ms: asNum(r.run_elapsed_ms),
    duration_ms: asNum(r.duration_ms),
    heal_budget_total: asNum(r.heal_budget_total),
    heal_budget_remaining: asNum(r.heal_budget_remaining),
    failure_classification:
      r.failure_classification && typeof r.failure_classification === "object"
        ? {
            category: asStr((r.failure_classification as Record<string, unknown>).category, "unknown"),
            label: asStr((r.failure_classification as Record<string, unknown>).label, "Check failure"),
            hint: asStr((r.failure_classification as Record<string, unknown>).hint, ""),
            retryable: Boolean((r.failure_classification as Record<string, unknown>).retryable ?? true),
          }
        : null,
  };
}

export function normalizeSessions(raw: unknown): Session[] | null {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).sessions)
      ? ((raw as Record<string, unknown>).sessions as unknown[])
      : null;
  if (!arr) return null;
  const out: Session[] = [];
  arr.forEach((item, i) => {
    const s = normalizeSession(item, i);
    if (s) out.push(s);
  });
  return out;
}

export function normalizePlaybook(raw: unknown, idx = 0): PlaybookTemplate | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = asStr(o.name, "").trim();
  if (!name) return null;
  const id = asStr(o.id, "").trim() || `tpl-${idx + 1}`;
  const rawSteps = Array.isArray(o.check_steps) ? o.check_steps : [];
  const checkSteps: CheckStepSpec[] = rawSteps
    .filter((x) => x && typeof x === "object")
    .map((x, i) => {
      const s = x as Record<string, unknown>;
      return {
        name: asStr(s.name, `step-${i + 1}`),
        cmd: asStr(s.cmd ?? s.command, "").trim(),
        timeout_secs: asNum(s.timeout_secs) ?? undefined,
      };
    })
    .filter((s) => Boolean(s.cmd));
  const rawTasks = Array.isArray(o.tasks) ? o.tasks : [];
  const tasks: PlaybookTaskSpec[] = rawTasks
    .map((x): PlaybookTaskSpec | null => {
      if (typeof x === "string") {
        const clean = x.trim();
        return clean ? { task: clean } : null;
      }
      if (!x || typeof x !== "object") return null;
      const t = x as Record<string, unknown>;
      const taskText = asStr(t.task, "").trim();
      if (!taskText) return null;
      const keyVal = t.key ? asStr(t.key).trim() : t.alias ? asStr(t.alias).trim() : undefined;
      return {
        key: keyVal || undefined,
        alias: keyVal || undefined,
        repo: t.repo ? asStr(t.repo) : undefined,
        project: t.project ? asStr(t.project) : undefined,
        task: taskText,
        agent: t.agent ? asStr(t.agent) : undefined,
        check: t.check ? asStr(t.check) : undefined,
        depends_on: asStrList(t.depends_on),
      };
    })
    .filter((t): t is PlaybookTaskSpec => t !== null);

  return {
    id,
    name,
    description: asStr(o.description, "").trim(),
    repo: o.repo ? asStr(o.repo).trim() : undefined,
    check_steps: checkSteps.length ? checkSteps : undefined,
    allowed_globs: asStrList(o.allowed_globs),
    forbidden_globs: asStrList(o.forbidden_globs),
    auto_steer_budget: asNum(o.auto_steer_budget),
    tasks: tasks.length ? tasks : undefined,
    builtin: Boolean(o.builtin),
  };
}

export function normalizePolicy(raw: unknown): Policy | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).agents)) return null;
  const r = raw as Record<string, unknown>;
  const agents: Agent[] = (r.agents as unknown[])
    .filter((a) => a && typeof a === "object")
    .map((a, idx) => {
      const o = a as Record<string, unknown>;
      return {
        name: asStr(o.name, "").trim() || `agent-${idx + 1}`,
        found: Boolean(o.found),
        path: o.path ? asStr(o.path) : undefined,
      };
    });
  const mRaw = r.models && typeof r.models === "object" ? (r.models as Record<string, unknown>) : null;
  const fRaw = r.features && typeof r.features === "object" ? (r.features as Record<string, unknown>) : null;
  return {
    agents,
    max_parallel: typeof r.max_parallel === "number" && Number.isFinite(r.max_parallel) ? r.max_parallel : 1,
    timeout_secs: typeof r.timeout_secs === "number" && Number.isFinite(r.timeout_secs) ? r.timeout_secs : 1800,
    source: asStr(r.source, "policies.rn") || "policies.rn",
    version: r.version ? asStr(r.version) : null,
    default_agent: r.default_agent ? asStr(r.default_agent) : null,
    default_agent_engine: r.default_agent_engine ? asStr(r.default_agent_engine) : undefined,
    model: r.model ? asStr(r.model) : null,
    models: mRaw
      ? {
          opencode: mRaw.opencode ? asStr(mRaw.opencode) : null,
          claude: mRaw.claude ? asStr(mRaw.claude) : null,
          codex: mRaw.codex ? asStr(mRaw.codex) : null,
        }
      : undefined,
    auto_retry_budget: asNum(r.auto_retry_budget) ?? undefined,
    auto_steer_budget: asNum(r.auto_steer_budget) ?? undefined,
    features: fRaw
      ? {
          sse: Boolean(fRaw.sse),
          batch: Boolean(fRaw.batch),
          batch_merge: Boolean(fRaw.batch_merge),
          batch_pr: Boolean(fRaw.batch_pr),
          wave_preflight: Boolean(fRaw.wave_preflight),
          failure_classifier: Boolean(fRaw.failure_classifier),
          smart_router: Boolean(fRaw.smart_router),
          failure_memory: Boolean(fRaw.failure_memory),
          merge_check: Boolean(fRaw.merge_check),
          policy_test: Boolean(fRaw.policy_test),
          prune_worktrees: Boolean(fRaw.prune_worktrees),
          auto_heal: Boolean(fRaw.auto_heal),
          templates: Boolean(fRaw.templates),
          metrics: Boolean(fRaw.metrics),
          pr_preview: Boolean(fRaw.pr_preview),
          worktrees: Boolean(fRaw.worktrees),
          budget: Boolean(fRaw.budget),
        }
      : undefined,
  };
}

export function normalizeConfig(raw: unknown): RuntimeConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const effRaw =
    r.effective_models && typeof r.effective_models === "object"
      ? (r.effective_models as Record<string, unknown>)
      : null;
  return {
    default_agent: r.default_agent ? asStr(r.default_agent) : null,
    default_agent_engine: r.default_agent_engine ? asStr(r.default_agent_engine) : null,
    opencode_model: r.opencode_model ? asStr(r.opencode_model) : null,
    claude_model: r.claude_model ? asStr(r.claude_model) : null,
    codex_model: r.codex_model ? asStr(r.codex_model) : null,
    effective_models: effRaw
      ? {
          opencode: effRaw.opencode ? asStr(effRaw.opencode) : null,
          claude: effRaw.claude ? asStr(effRaw.claude) : null,
          codex: effRaw.codex ? asStr(effRaw.codex) : null,
        }
      : undefined,
    policy_model: r.policy_model ? asStr(r.policy_model) : null,
    env_model: r.env_model ? asStr(r.env_model) : null,
    max_parallel: asNum(r.max_parallel ?? r.max_parallel_agents),
  };
}

export function normalizeRepos(raw: unknown): RepoInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: RepoInfo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const p = asStr(o.path, "").trim();
    if (!p) continue;
    const name = asStr(o.name, "").trim() || repoBasename(p) || p;
    out.push({ name, path: p, branch: o.branch ? asStr(o.branch) : null });
  }
  return out;
}

export async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/** Returns null on success, or the server's own words (the error field, or a plain fallback). */
export async function postJson(url: string, body: unknown = {}): Promise<string | null> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return null;
    try {
      const j = await r.json();
      return (j && typeof j.error === "string" && j.error) || "request failed";
    } catch {
      return "request failed";
    }
  } catch {
    return "Could not reach Fleet. Is it running?";
  }
}

function medianOf(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function sessionCheckElapsedMs(s: Session): number | null {
  if (typeof s.elapsed_ms === "number" && Number.isFinite(s.elapsed_ms) && s.elapsed_ms > 0) return s.elapsed_ms;
  if (s.check_steps && s.check_steps.length > 0) {
    const sum = s.check_steps.reduce((acc, st) => acc + (typeof st.elapsed_ms === "number" ? st.elapsed_ms : 0), 0);
    if (sum > 0) return sum;
  }
  return null;
}

export function computeLocalMetrics(sessions: Session[], maxParallel: number): BoardMetrics {
  const total = sessions.length;
  let firstPass = 0;
  let autoHealed = 0;
  let needsYou = 0;
  let activeSlots = 0;
  let queuedCount = 0;
  const allDurations: number[] = [];
  const byRepo = new Map<string, { total: number; first_pass: number; auto_healed: number; needs_you: number; durs: number[] }>();

  for (const s of sessions) {
    const repoKey = s.project || repoBasename(s.repo || "") || "default";
    const bucket = byRepo.get(repoKey) ?? { total: 0, first_pass: 0, auto_healed: 0, needs_you: 0, durs: [] };
    bucket.total++;

    const dur = sessionCheckElapsedMs(s);
    if (dur !== null) {
      allDurations.push(dur);
      bucket.durs.push(dur);
    }

    if (isVerified(s)) {
      if (s.auto_healed || (s.heal_attempts && s.heal_attempts.some((a) => a.healed))) {
        autoHealed++;
        bucket.auto_healed++;
      } else {
        firstPass++;
        bucket.first_pass++;
      }
    } else if (s.bucket === "needs-you") {
      needsYou++;
      bucket.needs_you++;
    } else if (isActivelyRunning(s)) {
      activeSlots++;
    } else if (isQueuedOrBlocked(s)) {
      queuedCount++;
    }

    byRepo.set(repoKey, bucket);
  }

  const settled = firstPass + autoHealed + needsYou;
  const denom = settled > 0 ? settled : 0;
  const firstPassRate = denom > 0 ? Math.round((firstPass / denom) * 1000) / 10 : 0;
  const effectivePassRate = denom > 0 ? Math.round(((firstPass + autoHealed) / denom) * 1000) / 10 : 0;

  const perRepo: RepoMetricsRow[] = Array.from(byRepo.entries())
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .map(([repo, v]) => ({
      repo,
      total: v.total,
      first_pass: v.first_pass,
      auto_healed: v.auto_healed,
      needs_you: v.needs_you,
      median_check_ms: medianOf(v.durs),
    }));

  return {
    total,
    first_pass_count: firstPass,
    auto_healed_count: autoHealed,
    needs_you_count: needsYou,
    first_pass_rate_pct: firstPassRate,
    effective_pass_rate_pct: effectivePassRate,
    median_check_ms: medianOf(allDurations),
    active_slots: activeSlots,
    max_parallel: maxParallel,
    queued_count: queuedCount,
    per_repo_breakdown: perRepo,
    source: "local",
  };
}

export function computeLocalBudget(sessions: Session[], policy?: Policy | null): BudgetStatus {
  const dailyLimit = 50;
  const used = sessions.length;
  const remaining = Math.max(0, dailyLimit - used);
  const maxSessionMins = Math.max(1, Math.round((policy?.timeout_secs ?? 1800) / 60));
  const maxHealAttempts = policy?.auto_steer_budget ?? 2;
  const util = dailyLimit > 0 ? Math.min(100, Math.round((used / dailyLimit) * 1000) / 10) : 0;
  return {
    max_session_mins: maxSessionMins,
    daily_session_limit: dailyLimit,
    max_heal_attempts: maxHealAttempts,
    sessions_today: used,
    remaining_today: remaining,
    limit_reached: dailyLimit > 0 && used >= dailyLimit,
    utilization_pct: util,
    source: "local",
  };
}

export function normalizeBudgetStatus(raw: unknown, fallback: BudgetStatus): BudgetStatus {
  if (!raw || typeof raw !== "object") return fallback;
  const o = raw as Record<string, unknown>;
  const cfg = o.config && typeof o.config === "object" ? (o.config as Record<string, unknown>) : o;
  const dailyLimit = asNum(o.daily_session_limit ?? cfg.daily_session_limit) ?? fallback.daily_session_limit;
  const maxSessionMins = asNum(o.max_session_mins ?? cfg.max_session_mins) ?? fallback.max_session_mins;
  const maxHealAttempts = asNum(o.max_heal_attempts ?? cfg.max_heal_attempts) ?? fallback.max_heal_attempts;
  const used = asNum(o.sessions_today ?? o.dispatched_today ?? o.used_today) ?? fallback.sessions_today;
  const remaining =
    asNum(o.remaining_today ?? o.remaining) ?? (dailyLimit > 0 ? Math.max(0, dailyLimit - used) : fallback.remaining_today);
  const limitReached =
    typeof o.daily_limit_reached === "boolean"
      ? o.daily_limit_reached
      : typeof o.limit_reached === "boolean"
        ? o.limit_reached
        : typeof o.exhausted === "boolean"
          ? o.exhausted
          : typeof o.blocked === "boolean"
            ? o.blocked
            : dailyLimit > 0 && used >= dailyLimit;
  const util =
    asNum(o.usage_pct ?? o.utilization_pct) ??
    (dailyLimit > 0 ? Math.min(100, Math.round((used / dailyLimit) * 1000) / 10) : 0);
  return {
    max_session_mins: maxSessionMins,
    daily_session_limit: dailyLimit,
    max_heal_attempts: maxHealAttempts,
    sessions_today: used,
    remaining_today: remaining,
    limit_reached: limitReached,
    utilization_pct: util,
    total_heal_attempts_today: asNum(o.total_heal_attempts_today) ?? undefined,
    source: "server",
  };
}

export async function fetchBoardMetrics(
  sessions: Session[],
  maxParallel: number,
  useServer: boolean,
  policy?: Policy | null,
): Promise<BoardMetrics> {
  const localBudget = computeLocalBudget(sessions, policy);
  const local: BoardMetrics = { ...computeLocalMetrics(sessions, maxParallel), budget: localBudget };
  if (!useServer) return local;
  try {
    const r = await fetch("/api/metrics", { cache: "no-store" });
    if (!r.ok) return local;
    const raw = (await r.json()) as Record<string, unknown>;
    const rawRepos = Array.isArray(raw.per_repo_breakdown) ? raw.per_repo_breakdown : [];
    const perRepo: RepoMetricsRow[] = rawRepos
      .filter((x) => x && typeof x === "object")
      .map((x) => {
        const o = x as Record<string, unknown>;
        const projName = asStr(o.project, "").trim();
        const repoRaw = asStr(o.repo, "").trim();
        return {
          repo: projName || repoBasename(repoRaw) || repoRaw || "default",
          total: asNum(o.total) ?? 0,
          first_pass: asNum(o.first_pass ?? o.first_pass_count) ?? 0,
          auto_healed: asNum(o.auto_healed ?? o.auto_healed_count) ?? 0,
          needs_you: asNum(o.needs_you ?? o.needs_you_count) ?? 0,
          median_check_ms: asNum(o.median_check_ms),
        };
      });
    const rawQueued = asNum(raw.queued_count);
    const rawBlocked = asNum(raw.blocked_count) ?? 0;
    const rawBudget = raw.budget ?? raw.budget_status;
    return {
      total: asNum(raw.total) ?? local.total,
      first_pass_count: asNum(raw.first_pass_count) ?? local.first_pass_count,
      auto_healed_count: asNum(raw.auto_healed_count) ?? local.auto_healed_count,
      needs_you_count: asNum(raw.needs_you_count) ?? local.needs_you_count,
      first_pass_rate_pct: asNum(raw.first_pass_rate_pct) ?? local.first_pass_rate_pct,
      effective_pass_rate_pct: asNum(raw.effective_pass_rate_pct) ?? local.effective_pass_rate_pct,
      median_check_ms: asNum(raw.median_check_ms) ?? local.median_check_ms,
      active_slots: asNum(raw.active_slots) ?? local.active_slots,
      max_parallel: asNum(raw.max_slots ?? raw.max_parallel) ?? maxParallel,
      queued_count: rawQueued !== null ? rawQueued + rawBlocked : local.queued_count,
      per_repo_breakdown: perRepo.length ? perRepo : local.per_repo_breakdown,
      budget: rawBudget ? normalizeBudgetStatus(rawBudget, localBudget) : localBudget,
      source: "server",
    };
  } catch {
    return local;
  }
}

function readLocalCustomPlaybooks(): PlaybookTemplate[] {
  try {
    const raw = localStorage.getItem(LOCAL_PLAYBOOKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x, i) => normalizePlaybook(x, i))
      .filter((x): x is PlaybookTemplate => x !== null);
  } catch {
    return [];
  }
}

function writeLocalCustomPlaybooks(list: PlaybookTemplate[]) {
  try {
    localStorage.setItem(LOCAL_PLAYBOOKS_KEY, JSON.stringify(list));
  } catch {
    /* ignore quota/private mode */
  }
}

export async function fetchPlaybooks(useServer: boolean): Promise<PlaybookTemplate[]> {
  if (useServer) {
    try {
      const r = await fetch("/api/templates", { cache: "no-store" });
      if (r.ok) {
        const raw = (await r.json()) as unknown;
        const arr = Array.isArray(raw)
          ? raw
          : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).templates)
            ? ((raw as Record<string, unknown>).templates as unknown[])
            : null;
        if (arr) {
          return arr
            .map((x, i) => normalizePlaybook(x, i))
            .filter((x): x is PlaybookTemplate => x !== null);
        }
      }
    } catch {
      /* fallback below */
    }
  }
  return [...DEFAULT_PLAYBOOKS, ...readLocalCustomPlaybooks()];
}

export async function savePlaybook(
  draft: Omit<PlaybookTemplate, "id">,
  useServer: boolean,
): Promise<{ ok: boolean; template?: PlaybookTemplate; error?: string }> {
  const payload = {
    name: draft.name.trim(),
    description: (draft.description || "").trim(),
    repo: (draft.repo || "").trim(),
    check_steps: (draft.check_steps || []).map((st) => ({
      name: st.name,
      cmd: st.cmd,
      ...(typeof st.timeout_secs === "number" ? { timeout_secs: st.timeout_secs } : {}),
    })),
    allowed_globs: draft.allowed_globs || [],
    forbidden_globs: draft.forbidden_globs || [],
    auto_steer_budget:
      typeof draft.auto_steer_budget === "number" && Number.isFinite(draft.auto_steer_budget)
        ? Math.max(0, Math.round(draft.auto_steer_budget))
        : 0,
    tasks: (draft.tasks || []).map((t) => {
      const key = (t.key || t.alias || "").trim() || undefined;
      return {
        ...(key ? { key, alias: key } : {}),
        task: t.task.trim(),
        depends_on: t.depends_on || [],
        ...(t.agent ? { agent: t.agent } : {}),
        ...(t.repo ? { repo: t.repo } : {}),
      };
    }),
  };

  if (useServer) {
    try {
      const r = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        const raw = await r.json();
        const norm = normalizePlaybook(raw);
        return { ok: true, template: norm ?? undefined };
      }
      if (r.status !== 404 && r.status !== 405) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: j.error || "Could not save playbook." };
      }
    } catch {
      /* fallback below */
    }
  }
  const slug = draft.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  const created: PlaybookTemplate = {
    ...draft,
    id: `${slug || "playbook"}-${Date.now().toString(36)}`,
    builtin: false,
  };
  const custom = readLocalCustomPlaybooks();
  writeLocalCustomPlaybooks([...custom, created]);
  return { ok: true, template: created };
}

export async function deletePlaybook(id: string, useServer: boolean): Promise<{ ok: boolean; error?: string }> {
  if (useServer) {
    try {
      const r = await fetch(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (r.ok) return { ok: true };
      if (r.status !== 404 && r.status !== 405) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: j.error || "Could not delete playbook." };
      }
    } catch {
      /* fallback below */
    }
  }
  const custom = readLocalCustomPlaybooks().filter((t) => t.id !== id);
  writeLocalCustomPlaybooks(custom);
  return { ok: true };
}

export function healBadgeInfo(s: Session): {
  shortLabel: string;
  fullLabel: string;
  tone: "healed" | "healing" | "failed";
} | null {
  const attempts = s.heal_attempts ?? [];
  const budget = Math.max(s.auto_steer_budget ?? 0, attempts.length);
  const denom = budget > 0 ? budget : Math.max(attempts.length, 1);

  if (s.auto_healed || (isVerified(s) && attempts.some((a) => a.healed))) {
    const win = attempts.find((a) => a.healed)?.attempt ?? Math.max(attempts.length, 1);
    return {
      shortLabel: `Healed ${win}/${denom}`,
      fullLabel: `Healed on attempt ${win}/${denom}`,
      tone: "healed",
    };
  }
  if (s.status === "healing" || (s.bucket === "working" && attempts.length > 0)) {
    const cur = Math.max(attempts.length, 1);
    return {
      shortLabel: `Auto-healing ${cur}/${denom}`,
      fullLabel: `Auto-healing attempt ${cur}/${denom}`,
      tone: "healing",
    };
  }
  if (attempts.length > 0 && s.bucket === "needs-you") {
    return {
      shortLabel: `Auto-heal ${attempts.length}/${denom}`,
      fullLabel: `Auto-heal tried ${attempts.length}/${denom} · needs you`,
      tone: "failed",
    };
  }
  return null;
}

export async function fetchMergeCheck(
  session: Session,
  useServer: boolean,
): Promise<MergeCheckResult> {
  const fallback = (): MergeCheckResult => {
    const hasConflictError = Boolean(
      session.merge_error && /conflict/i.test(`${session.merge_error.message || ""} ${session.merge_error.detail || ""}`),
    );
    const ds = diffStat(session.diff);
    return {
      clean: !hasConflictError,
      conflicting_files: hasConflictError ? [session.merge_error?.message || "merge conflict"] : [],
      commits_ahead: ds.files > 0 ? 1 : 0,
      commits_behind: 0,
      source: "fallback",
    };
  };

  if (!useServer) return fallback();

  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/merge-check`, { cache: "no-store" });
    if (!r.ok) return fallback();
    const raw = (await r.json()) as Record<string, unknown>;
    const conflicts = asStrList(raw.conflicting_files ?? raw.conflicts);
    const clean = typeof raw.clean === "boolean" ? raw.clean : conflicts.length === 0;
    return {
      clean,
      conflicting_files: conflicts,
      commits_ahead: asNum(raw.commits_ahead) ?? 0,
      commits_behind: asNum(raw.commits_behind) ?? 0,
      source: "server",
    };
  } catch {
    return fallback();
  }
}

export function buildLocalPatchText(s: Session): string {
  const diffBody = (s.diff || "").trimEnd();
  const branch = s.branch || s.id;
  const header = [
    `From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001`,
    `From: Fleet Agent <fleet@local>`,
    `Date: ${new Date().toUTCString()}`,
    `Subject: [PATCH] ${s.task.replace(/\r?\n/g, " ")}`,
    ``,
    `Session: ${s.id}`,
    `Project: ${s.project}`,
    `Branch: ${branch}`,
    s.check_cmd ? `Verified-By: ${s.check_cmd}` : "",
    `---`,
    ``,
  ]
    .filter((line, idx) => idx < 7 || line !== "")
    .join("\n");
  return `${header}${diffBody}\n`;
}

export async function downloadSessionPatch(
  s: Session,
  useServer: boolean,
): Promise<{ ok: boolean; filename: string; source: "server" | "local"; error?: string }> {
  const safeName = (s.branch || s.id).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || s.id;
  const filename = `${safeName}.patch`;
  let patchText = "";
  let source: "server" | "local" = "local";

  if (useServer) {
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(s.id)}/patch`, { cache: "no-store" });
      if (r.ok) {
        const text = await r.text();
        if (text.trim()) {
          patchText = text;
          source = "server";
        }
      }
    } catch {
      /* fallback below */
    }
  }

  if (!patchText) {
    if (!s.diff || !s.diff.trim()) {
      return { ok: false, filename, source, error: "No diff changes to export yet." };
    }
    patchText = buildLocalPatchText(s);
  }

  try {
    const blob = new Blob([patchText], { type: "text/x-patch;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, filename, source };
  } catch {
    return { ok: false, filename, source, error: "Browser blocked patch file download." };
  }
}

export async function testPolicyRoute(
  req: PolicyTestRequest,
  policy: Policy | null,
  config: RuntimeConfig | null,
  useServer: boolean,
): Promise<PolicyTestResult> {
  const localEval = (): PolicyTestResult => {
    const proj = (req.project || repoBasename(req.repo) || "default").trim();
    const chosenEngine =
      (req.engine && req.engine !== "auto" ? req.engine : "") ||
      config?.default_agent_engine ||
      policy?.default_agent_engine ||
      policy?.default_agent ||
      "opencode";
    const model =
      chosenEngine === "opencode"
        ? config?.effective_models?.opencode || policy?.models?.opencode || policy?.model || "opencode/deepseek-v4.1-flash-free"
        : chosenEngine === "claude"
          ? config?.effective_models?.claude || policy?.models?.claude || null
          : chosenEngine === "codex"
            ? config?.effective_models?.codex || policy?.models?.codex || null
            : policy?.model || null;
    const lowerRepo = `${req.repo} ${proj}`.toLowerCase();
    const checkCmd = /rust|cargo|fleet|ergon|openbell|open-ro/.test(lowerRepo)
      ? "cargo test"
      : /web|ui|frontend|kit|limiter|node|js|ts/.test(lowerRepo)
        ? "npm test"
        : "cargo test";
    const warnings: string[] = [];
    if (!req.repo.trim()) warnings.push("No repository path supplied; project fallback rule applied.");
    const found = policy?.agents?.find((a) => a.name === chosenEngine)?.found;
    if (policy?.agents?.length && found === false) {
      warnings.push(`Engine "${chosenEngine}" is not currently detected on PATH.`);
    }
    return {
      engine: chosenEngine,
      model,
      check_cmd: checkCmd,
      check_steps: [{ name: "default-check", cmd: checkCmd, timeout_secs: policy?.timeout_secs ?? 1800 }],
      timeout_secs: policy?.timeout_secs ?? 1800,
      max_parallel: policy?.max_parallel ?? 4,
      auto_retry_budget: policy?.auto_retry_budget ?? 1,
      auto_steer_budget: policy?.auto_steer_budget ?? 2,
      allowed_globs: [],
      forbidden_globs: [".env*", "*.pem", "*.key"],
      matched_rule: `${policy?.source || "policies.rn"} -> ${proj}`,
      warnings,
      source: "fallback",
    };
  };

  if (!useServer) return localEval();

  try {
    const r = await fetch("/api/policies/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: req.repo.trim(),
        project: (req.project || repoBasename(req.repo) || "default").trim(),
        task: req.task.trim(),
        engine: req.engine && req.engine !== "auto" ? req.engine : undefined,
      }),
    });
    if (!r.ok) return localEval();
    const raw = (await r.json()) as Record<string, unknown>;
    const fallback = localEval();
    const rawSteps = Array.isArray(raw.check_steps) ? raw.check_steps : [];
    const steps: CheckStepSpec[] = rawSteps
      .filter((x) => x && typeof x === "object")
      .map((x, i) => {
        const o = x as Record<string, unknown>;
        return {
          name: asStr(o.name, `step-${i + 1}`),
          cmd: asStr(o.cmd ?? o.command, fallback.check_cmd),
          timeout_secs: asNum(o.timeout_secs) ?? undefined,
        };
      });
    return {
      engine: asStr(raw.engine ?? raw.agent, fallback.engine),
      model: raw.model ? asStr(raw.model) : fallback.model,
      check_cmd: asStr(raw.check_cmd ?? raw.check, fallback.check_cmd),
      check_steps: steps.length ? steps : fallback.check_steps,
      timeout_secs: asNum(raw.timeout_secs) ?? fallback.timeout_secs,
      max_parallel: asNum(raw.max_parallel) ?? fallback.max_parallel,
      auto_retry_budget: asNum(raw.auto_retry_budget) ?? fallback.auto_retry_budget,
      auto_steer_budget: asNum(raw.auto_steer_budget) ?? fallback.auto_steer_budget,
      allowed_globs: asStrList(raw.allowed_globs),
      forbidden_globs: asStrList(raw.forbidden_globs),
      matched_rule: asStr(raw.matched_rule ?? raw.rule, fallback.matched_rule),
      warnings: asStrList(raw.warnings),
      source: "server",
    };
  } catch {
    return localEval();
  }
}

export async function dispatchBatchSessions(
  items: BatchDispatchItem[],
  useServerBatch: boolean,
): Promise<{ created: Session[]; errors: string[]; mode: "batch" | "sequential" }> {
  if (useServerBatch && items.length > 1) {
    try {
      const wireItems = items.map((it, idx) => ({
        ...it,
        key: it.alias || `#${idx + 1}`,
        alias: it.alias || `#${idx + 1}`,
      }));
      const r = await fetch("/api/sessions/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks: wireItems, sessions: wireItems }),
      });
      if (r.ok) {
        const raw = (await r.json()) as unknown;
        const arr = Array.isArray(raw)
          ? raw
          : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).sessions)
            ? ((raw as Record<string, unknown>).sessions as unknown[])
            : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).created)
              ? ((raw as Record<string, unknown>).created as unknown[])
              : [];
        const created = normalizeSessions(arr) ?? [];
        return { created, errors: [], mode: "batch" };
      }
      if (r.status !== 404 && r.status !== 405) {
        let msg = "Could not dispatch batch.";
        try {
          const j = (await r.json()) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {
          /* fallback */
        }
        return { created: [], errors: [msg], mode: "batch" };
      }
    } catch {
      /* fallback to sequential below */
    }
  }

  // Graceful sequential fallback (resolves intra-batch alias refs like #1 -> real created ID)
  const created: Session[] = [];
  const errors: string[] = [];
  const aliasToId = new Map<string, string>();

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const resolvedDeps = (it.depends_on || []).map((dep) => aliasToId.get(dep) ?? dep);
    const payload: Record<string, unknown> = {
      repo: it.repo.trim(),
      project: (it.project || repoBasename(it.repo) || "default").trim(),
      task: it.task.trim(),
      check: (it.check || "").trim(),
    };
    if (it.agent) payload.agent = it.agent;
    if (it.next?.trim()) payload.next = it.next.trim();
    if (resolvedDeps.length) payload.depends_on = resolvedDeps;
    if (it.check_steps && it.check_steps.length) payload.check_steps = it.check_steps;
    if (it.allowed_globs && it.allowed_globs.length) payload.allowed_globs = it.allowed_globs;
    if (it.forbidden_globs && it.forbidden_globs.length) payload.forbidden_globs = it.forbidden_globs;
    if (typeof it.auto_steer_budget === "number") payload.auto_steer_budget = it.auto_steer_budget;

    try {
      const r = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        let msg = `Task #${i + 1}: could not hand out.`;
        try {
          const j = (await r.json()) as { error?: string };
          if (j?.error) msg = `Task #${i + 1}: ${j.error}`;
        } catch {
          /* fallback */
        }
        errors.push(msg);
        continue;
      }
      const raw = await r.json();
      const norm = normalizeSessions([raw])?.[0] ?? (raw as Session);
      created.push(norm);
      if (it.alias) aliasToId.set(it.alias, norm.id);
      aliasToId.set(`#${i + 1}`, norm.id);
    } catch {
      errors.push(`Task #${i + 1}: could not reach Fleet.`);
    }
  }

  return { created, errors, mode: "sequential" };
}

export async function pruneStaleWorktrees(useServer: boolean): Promise<{ ok: boolean; pruned?: number; message: string }> {
  if (!useServer) {
    return { ok: false, message: "Worktree pruning requires Fleet v0.5.0+ server." };
  }
  try {
    const r = await fetch("/api/repos/prune-worktrees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const raw = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      return { ok: false, message: asStr(raw.error, "Worktree prune failed.") };
    }
    const pruned =
      asNum(raw.removed) ??
      asNum(raw.pruned) ??
      (Array.isArray(raw.removed_worktrees) ? raw.removed_worktrees.length : 0);
    return {
      ok: true,
      pruned,
      message: asStr(raw.message, pruned === 0 ? "All worktrees are clean." : `Pruned ${pruned} stale worktree${pruned === 1 ? "" : "s"}.`),
    };
  } catch {
    return { ok: false, message: "Could not reach Fleet to prune worktrees." };
  }
}

export function buildLocalPrPreview(s: Session): PrPreview {
  const ds = diffStat(s.diff);
  const baseBranch = s.merge_target || "main";
  const headBranch = s.branch || `fleet/${s.id}`;
  const title = s.task.replace(/\s+/g, " ").trim().slice(0, 72) || `Session ${s.id}`;
  const lines: string[] = [
    `## Summary`,
    ``,
    s.task.trim(),
    ``,
    `- **Session:** \`${s.id}\``,
    `- **Project:** \`${s.project}\``,
    `- **Branch:** \`${headBranch}\` → \`${baseBranch}\``,
    `- **Diff:** ${ds.files} ${ds.files === 1 ? "file" : "files"} (+${ds.add} / -${ds.del})`,
    ``,
    `## Verification`,
    ``,
  ];
  if (s.check_steps && s.check_steps.length > 0) {
    for (const st of s.check_steps) {
      const mark = st.passed || st.status === "passed" ? "x" : " ";
      const dur = st.elapsed_ms !== null ? ` (${formatDurationMs(st.elapsed_ms)})` : "";
      lines.push(`- [${mark}] **${st.name}** \`${st.cmd}\` — ${st.tail_line || st.status}${dur}`);
    }
  } else {
    const mark = s.check_passed ? "x" : " ";
    lines.push(`- [${mark}] \`${s.check_cmd || "policy check"}\` — ${receiptLine(s)}`);
  }
  if (s.heal_attempts && s.heal_attempts.length > 0) {
    lines.push(``, `## Auto-Heal Timeline`, ``);
    for (const h of s.heal_attempts) {
      const outcome = h.healed ? "healed" : "retry";
      const dur = h.elapsed_ms !== null ? ` (${formatDurationMs(h.elapsed_ms)})` : "";
      lines.push(`- Attempt ${h.attempt} (\`${h.trigger_step}\`): ${outcome}${dur} — ${h.stderr_tail || "diagnostic steer"}`);
    }
  }
  const warnings: string[] = [];
  if (!isVerified(s)) {
    warnings.push("Session check has not passed verified done yet.");
  }
  if (ds.files === 0) {
    warnings.push("No diff changes detected on this branch yet.");
  }
  return {
    session_id: s.id,
    repo: s.repo || s.project,
    title,
    body: lines.join("\n"),
    base_branch: baseBranch,
    head_branch: headBranch,
    gh_available: false,
    gh_status: isWebEngineMode()
      ? "Standalone browser preview — copy Markdown or connect local Fleet with gh CLI to publish."
      : "PR preview generated locally (upgrade to Fleet v0.7.0+ for live gh CLI creation).",
    can_create: isWebEngineMode(),
    warnings,
    diff_files: ds.files,
    diff_add: ds.add,
    diff_del: ds.del,
    source: "local",
  };
}

export async function fetchPrPreview(s: Session, useServer: boolean): Promise<PrPreview> {
  const local = buildLocalPrPreview(s);
  if (!useServer) return local;
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(s.id)}/pr-preview`, { cache: "no-store" });
    if (!r.ok) return local;
    const raw = (await r.json()) as Record<string, unknown>;
    const dsObj = raw.diff_stat && typeof raw.diff_stat === "object" ? (raw.diff_stat as Record<string, unknown>) : null;
    const ghAvailable =
      typeof raw.gh_available === "boolean"
        ? raw.gh_available
        : typeof raw.gh_ready === "boolean"
          ? raw.gh_ready
          : typeof raw.has_gh === "boolean"
            ? raw.has_gh
            : false;
    return {
      session_id: asStr(raw.session_id, s.id),
      repo: asStr(raw.repo, local.repo),
      title: asStr(raw.title, local.title),
      body: asStr(raw.body ?? raw.markdown, local.body),
      base_branch: asStr(raw.base_branch ?? raw.base, local.base_branch),
      head_branch: asStr(raw.head_branch ?? raw.head ?? raw.branch, local.head_branch),
      gh_available: ghAvailable,
      gh_status: raw.gh_status
        ? asStr(raw.gh_status)
        : raw.gh_message
          ? asStr(raw.gh_message)
          : ghAvailable
            ? "gh CLI ready on host"
            : "gh CLI unavailable or unauthenticated on host — copy Markdown below or authenticate gh.",
      can_create:
        typeof raw.ready_to_create === "boolean"
          ? raw.ready_to_create
          : typeof raw.can_create === "boolean"
            ? raw.can_create
            : ghAvailable,
      warnings: asStrList(raw.warnings),
      diff_files: asNum(dsObj?.files_changed ?? raw.diff_files ?? raw.files_changed) ?? local.diff_files,
      diff_add: asNum(dsObj?.insertions ?? raw.diff_add ?? raw.insertions ?? dsObj?.add ?? dsObj?.additions) ?? local.diff_add,
      diff_del: asNum(dsObj?.deletions ?? raw.diff_del ?? raw.deletions ?? dsObj?.del) ?? local.diff_del,
      source: "server",
    };
  } catch {
    return local;
  }
}

export async function createSessionPr(
  sessionId: string,
  payload: { title: string; body: string; draft: boolean; confirm: boolean },
  useServer: boolean,
): Promise<PrCreateResult> {
  if (!payload.confirm) {
    return { ok: false, message: "Explicit confirmation is required before pushing or opening a PR.", error: "confirmation required" };
  }
  if (!useServer) {
    return { ok: false, message: "Creating a GitHub PR requires Fleet v0.7.0+ with gh CLI configured.", error: "unsupported" };
  }
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/pr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: payload.title.trim(),
        body: payload.body,
        draft: payload.draft,
        confirm: true,
      }),
    });
    const raw = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      const err = asStr(raw.error ?? raw.message, `Could not create pull request (HTTP ${r.status}).`);
      return { ok: false, message: err, error: err };
    }
    const url = raw.url ? asStr(raw.url) : raw.pr_url ? asStr(raw.pr_url) : undefined;
    const num = asNum(raw.number ?? raw.pr_number) ?? undefined;
    return {
      ok: true,
      url,
      number: num,
      draft: typeof raw.draft === "boolean" ? raw.draft : payload.draft,
      dry_run: Boolean(raw.dry_run),
      message: asStr(raw.message, url ? `Pull request created: ${url}` : "Pull request created."),
    };
  } catch {
    return { ok: false, message: "Could not reach Fleet to create pull request.", error: "network error" };
  }
}

export function normalizeWorktrees(raw: unknown): WorktreeEntry[] {
  const flat: Record<string, unknown>[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === "object") flat.push(item as Record<string, unknown>);
    }
  } else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.worktrees)) {
      for (const item of obj.worktrees) {
        if (item && typeof item === "object") flat.push(item as Record<string, unknown>);
      }
    } else if (Array.isArray(obj.repos)) {
      for (const grp of obj.repos) {
        if (!grp || typeof grp !== "object") continue;
        const g = grp as Record<string, unknown>;
        const repoPath = asStr(g.repo ?? g.path, "");
        if (Array.isArray(g.worktrees)) {
          for (const wt of g.worktrees) {
            if (wt && typeof wt === "object") {
              flat.push({ repo: repoPath, ...(wt as Record<string, unknown>) });
            }
          }
        }
      }
    }
  }

  return flat
    .map((o): WorktreeEntry | null => {
      const wtPath = asStr(o.path ?? o.worktree_path, "").trim();
      if (!wtPath) return null;
      const repoPath = asStr(o.repo ?? o.repo_path, wtPath).trim();
      const proj = asStr(o.project, "").trim() || repoBasename(repoPath) || repoBasename(wtPath) || "repo";
      const isMain = Boolean(o.is_main ?? o.main);
      const isLocked = Boolean(o.is_locked ?? o.locked);
      return {
        repo: repoPath,
        project: proj,
        path: wtPath,
        branch: asStr(o.branch, "(detached)"),
        head: o.head ? asStr(o.head) : undefined,
        is_main: isMain,
        is_orphan: Boolean(o.is_orphan ?? o.orphan),
        dirty: Boolean(o.dirty ?? o.is_dirty),
        is_locked: isLocked,
        lock_reason: o.lock_reason ? asStr(o.lock_reason) : null,
        removable: typeof o.removable === "boolean" ? o.removable : !isMain && !isLocked,
        session_id: o.session_id ? asStr(o.session_id) : null,
        session_status: o.session_status ? asStr(o.session_status) : null,
        session_task: o.session_task ? asStr(o.session_task) : null,
      };
    })
    .filter((w): w is WorktreeEntry => w !== null);
}

export async function fetchRepoWorktrees(
  sessions: Session[],
  repos: RepoInfo[],
  useServer: boolean,
): Promise<{ worktrees: WorktreeEntry[]; source: "server" | "local" }> {
  const local = (): WorktreeEntry[] => {
    const out: WorktreeEntry[] = [];
    for (const r of repos) {
      out.push({
        repo: r.path,
        project: r.name || repoBasename(r.path) || "repo",
        path: r.path,
        branch: r.branch || "main",
        is_main: true,
        is_orphan: false,
        dirty: false,
        removable: false,
      });
    }
    for (const s of sessions) {
      if (!s.branch) continue;
      const repoPath = s.repo || `/workspace/${s.project}`;
      out.push({
        repo: repoPath,
        project: s.project || repoBasename(repoPath) || "repo",
        path: `${repoPath}/.worktrees/${s.id}`,
        branch: s.branch,
        is_main: false,
        is_orphan: false,
        dirty: s.bucket === "working",
        removable: s.bucket !== "working",
        session_id: s.id,
        session_status: s.status,
        session_task: s.task,
      });
    }
    return out;
  };

  if (!useServer) return { worktrees: local(), source: "local" };
  try {
    const r = await fetch("/api/repos/worktrees", { cache: "no-store" });
    if (!r.ok) return { worktrees: local(), source: "local" };
    const raw = await r.json();
    return { worktrees: normalizeWorktrees(raw), source: "server" };
  } catch {
    return { worktrees: local(), source: "local" };
  }
}

export async function deleteRepoWorktree(
  entry: { repo: string; path: string },
  useServer: boolean,
): Promise<{ ok: boolean; message: string }> {
  if (!useServer) {
    return { ok: false, message: "Targeted worktree removal requires Fleet v0.7.0+." };
  }
  try {
    const qs = new URLSearchParams({ repo: entry.repo, path: entry.path }).toString();
    const r = await fetch(`/api/repos/worktrees?${qs}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: entry.repo, path: entry.path }),
    });
    const raw = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      return { ok: false, message: asStr(raw.error ?? raw.message, `Could not remove worktree (HTTP ${r.status}).`) };
    }
    return {
      ok: true,
      message: asStr(raw.message, `Removed worktree ${repoBasename(entry.path) || entry.path}.`),
    };
  } catch {
    return { ok: false, message: "Could not reach Fleet to remove worktree." };
  }
}

export function statusText(s: Session): string {
  if (s.bucket === "working" && s.status === "blocked") {
    const n = (s.blocked_by || s.depends_on || []).length;
    return n > 0 ? `waiting on ${n} dep${n === 1 ? "" : "s"}` : "blocked";
  }
  if (s.bucket === "working" && s.status === "queued") return `queued #${s.queue_position ?? "?"}`;
  return (s.status || "working").replace(/-/g, " ");
}

export async function batchMergeVerifiedWave(
  opts: { ids?: string[]; repo?: string; strategy?: MergeStrategy; dry_run?: boolean },
  sessions: Session[],
  supportsBatchMerge: boolean,
): Promise<BatchMergeResponse> {
  const strategy = opts.strategy || "merge";
  const dryRun = Boolean(opts.dry_run);
  if (supportsBatchMerge) {
    try {
      const r = await fetch("/api/sessions/batch-merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: opts.ids && opts.ids.length > 0 ? opts.ids : undefined,
          repo: opts.repo || undefined,
          strategy,
          dry_run: dryRun,
        }),
      });
      const raw = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (r.ok) {
        const results = Array.isArray(raw.results)
          ? raw.results.map((item) => {
              const x = (item || {}) as Record<string, unknown>;
              return {
                id: asStr(x.id, ""),
                task: asStr(x.task, ""),
                repo: asStr(x.repo, ""),
                branch: asStr(x.branch, ""),
                target: asStr(x.target, ""),
                status: (asStr(x.status, "skipped") as BatchMergeItemResult["status"]),
                clean: Boolean(x.clean),
                can_apply: Boolean(x.can_apply),
                diff_files: asNum(x.diff_files) ?? undefined,
                diff_add: asNum(x.diff_add) ?? undefined,
                diff_del: asNum(x.diff_del) ?? undefined,
                conflicting_files: asStrList(x.conflicting_files),
                commits_ahead: asNum(x.commits_ahead) ?? undefined,
                commits_behind: asNum(x.commits_behind) ?? undefined,
                error: x.error ? asStr(x.error) : null,
              };
            })
          : [];
        const pre = raw.preflight && typeof raw.preflight === "object" ? (raw.preflight as Record<string, unknown>) : null;
        return {
          ok: true,
          dry_run: Boolean(raw.dry_run),
          strategy,
          total: asNum(raw.total) ?? results.length,
          clean_count: asNum(raw.clean_count) ?? 0,
          conflict_count: asNum(raw.conflict_count) ?? 0,
          merged_count: asNum(raw.merged_count) ?? 0,
          skipped_count: asNum(raw.skipped_count) ?? 0,
          failed_count: asNum(raw.failed_count) ?? 0,
          preflight: pre
            ? {
                ready_ids: asStrList(pre.ready_ids),
                conflicted_ids: asStrList(pre.conflicted_ids),
                skipped_ids: asStrList(pre.skipped_ids),
              }
            : undefined,
          results,
        };
      }
      if (r.status !== 404) {
        return {
          ok: false,
          dry_run: dryRun,
          strategy,
          total: 0,
          clean_count: 0,
          conflict_count: 0,
          merged_count: 0,
          skipped_count: 0,
          failed_count: 0,
          results: [],
          error: asStr(raw.error, `Batch merge failed (${r.status}).`),
        };
      }
    } catch {
      return {
        ok: false,
        dry_run: dryRun,
        strategy,
        total: 0,
        clean_count: 0,
        conflict_count: 0,
        merged_count: 0,
        skipped_count: 0,
        failed_count: 0,
        results: [],
        error: "Could not reach Fleet for batch merge.",
      };
    }
  }

  // Fallback for older servers without POST /api/sessions/batch-merge
  const idSet = opts.ids && opts.ids.length > 0 ? new Set(opts.ids) : null;
  const targets = sessions.filter(
    (s) => s.status === "done" && isVerified(s) && (!idSet || idSet.has(s.id)) && (!opts.repo || s.repo === opts.repo),
  );
  const results: BatchMergeItemResult[] = [];
  let cleanCount = 0;
  let conflictCount = 0;
  let mergedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  for (const s of targets) {
    const chk = await fetchMergeCheck(s, true);
    if (!chk.clean) {
      conflictCount++;
      if (!dryRun) skippedCount++;
      results.push({
        id: s.id,
        task: s.task,
        repo: s.repo,
        branch: s.branch,
        status: dryRun ? "conflict" : "skipped",
        clean: false,
        can_apply: false,
        conflicting_files: chk.conflicting_files,
        error: chk.error || "Merge conflict detected during preflight check.",
      });
      continue;
    }
    cleanCount++;
    if (dryRun) {
      results.push({
        id: s.id,
        task: s.task,
        repo: s.repo,
        branch: s.branch,
        status: "ready",
        clean: true,
        can_apply: true,
        conflicting_files: [],
      });
      continue;
    }
    const err = await postJson(`/api/sessions/${s.id}/merge`, { strategy });
    if (err) {
      failedCount++;
      results.push({
        id: s.id,
        task: s.task,
        repo: s.repo,
        branch: s.branch,
        status: "failed",
        clean: true,
        can_apply: false,
        conflicting_files: [],
        error: err,
      });
    } else {
      mergedCount++;
      results.push({
        id: s.id,
        task: s.task,
        repo: s.repo,
        branch: s.branch,
        status: "merged",
        clean: true,
        can_apply: true,
        conflicting_files: [],
      });
    }
  }
  return {
    ok: true,
    dry_run: dryRun,
    strategy,
    total: targets.length,
    clean_count: cleanCount,
    conflict_count: conflictCount,
    merged_count: mergedCount,
    skipped_count: skippedCount,
    failed_count: failedCount,
    results,
  };
}

export async function batchCreateWavePr(
  opts: { ids?: string[]; repo?: string; base_branch?: string; draft?: boolean; confirm: boolean; dry_run?: boolean },
  sessions: Session[],
  supportsBatchPr: boolean,
): Promise<BatchPrResponse> {
  const dryRun = Boolean(opts.dry_run);
  const draft = Boolean(opts.draft);
  if (!dryRun && !opts.confirm) {
    return {
      ok: false,
      dry_run: false,
      draft,
      total: 0,
      ready_count: 0,
      created_count: 0,
      skipped_count: 0,
      failed_count: 0,
      results: [],
      error: "Batch PR creation requires explicit confirmation.",
    };
  }
  if (supportsBatchPr) {
    try {
      const r = await fetch("/api/sessions/batch-pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: opts.ids && opts.ids.length > 0 ? opts.ids : undefined,
          repo: opts.repo || undefined,
          base_branch: opts.base_branch || undefined,
          draft,
          confirm: opts.confirm,
          dry_run: dryRun,
        }),
      });
      const raw = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (r.ok) {
        const results: BatchPrItemResult[] = Array.isArray(raw.results)
          ? raw.results.map((item) => {
              const x = (item || {}) as Record<string, unknown>;
              return {
                id: asStr(x.id, ""),
                task: asStr(x.task, ""),
                repo: asStr(x.repo, ""),
                branch: asStr(x.branch, ""),
                base_branch: x.base_branch ? asStr(x.base_branch) : undefined,
                title: x.title ? asStr(x.title) : undefined,
                url: x.url ? asStr(x.url) : undefined,
                pushed: typeof x.pushed === "boolean" ? x.pushed : undefined,
                ready: Boolean(x.ready),
                status: (asStr(x.status, "skipped") as BatchPrItemResult["status"]),
                diff_files: asNum(x.diff_files) ?? undefined,
                diff_add: asNum(x.diff_add) ?? undefined,
                diff_del: asNum(x.diff_del) ?? undefined,
                warnings: asStrList(x.warnings),
                error: x.error ? asStr(x.error) : null,
              };
            })
          : [];
        return {
          ok: true,
          dry_run: Boolean(raw.dry_run),
          draft: Boolean(raw.draft),
          total: asNum(raw.total) ?? results.length,
          ready_count: asNum(raw.ready_count) ?? 0,
          created_count: asNum(raw.created_count) ?? 0,
          skipped_count: asNum(raw.skipped_count) ?? 0,
          failed_count: asNum(raw.failed_count) ?? 0,
          results,
        };
      }
      if (r.status !== 404) {
        return {
          ok: false,
          dry_run: dryRun,
          draft,
          total: 0,
          ready_count: 0,
          created_count: 0,
          skipped_count: 0,
          failed_count: 0,
          results: [],
          error: asStr(raw.error, `Batch PR failed (${r.status}).`),
        };
      }
    } catch {
      return {
        ok: false,
        dry_run: dryRun,
        draft,
        total: 0,
        ready_count: 0,
        created_count: 0,
        skipped_count: 0,
        failed_count: 0,
        results: [],
        error: "Could not reach Fleet for batch PR.",
      };
    }
  }

  const idSet = opts.ids && opts.ids.length > 0 ? new Set(opts.ids) : null;
  const targets = sessions.filter(
    (s) => s.status === "done" && isVerified(s) && (!idSet || idSet.has(s.id)) && (!opts.repo || s.repo === opts.repo),
  );
  const results: BatchPrItemResult[] = [];
  let readyCount = 0;
  let createdCount = 0;
  let failedCount = 0;
  for (const s of targets) {
    if (dryRun) {
      const ds = diffStat(s.diff);
      readyCount++;
      results.push({
        id: s.id,
        task: s.task,
        repo: s.repo,
        branch: s.branch,
        base_branch: s.merge_target || "main",
        title: s.task,
        ready: true,
        status: "ready",
        diff_files: ds.files,
        diff_add: ds.add,
        diff_del: ds.del,
      });
      continue;
    }
    const res = await createSessionPr(s.id, { title: s.task, body: "", draft, confirm: true }, true);
    if (res.ok) {
      createdCount++;
      results.push({
        id: s.id,
        task: s.task,
        repo: s.repo,
        branch: s.branch,
        base_branch: s.merge_target || "main",
        title: s.task,
        url: res.url,
        ready: true,
        status: "created",
      });
    } else {
      failedCount++;
      results.push({
        id: s.id,
        task: s.task,
        repo: s.repo,
        branch: s.branch,
        ready: false,
        status: "failed",
        error: res.error || res.message,
      });
    }
  }
  return {
    ok: true,
    dry_run: dryRun,
    draft,
    total: targets.length,
    ready_count: readyCount,
    created_count: createdCount,
    skipped_count: 0,
    failed_count: failedCount,
    results,
  };
}

export type RunnerScore = {
  name: string;
  engine: string;
  found: boolean;
  total_runs: number;
  first_pass_count: number;
  healed_count: number;
  failed_count: number;
  pass_rate_pct: number;
  median_elapsed_ms?: number | null;
  heal_efficiency_pct: number;
  score: number;
};

export type FailureLesson = {
  id: string;
  repo: string;
  category: string;
  trigger_step: string;
  fingerprint: string;
  symptom: string;
  fix_summary: string;
  changed_files: string[];
  hits: number;
  updated_ms: number;
};

export type CliRecommendation = {
  recommended_agent?: string | null;
  recommended_engine?: string | null;
  confidence: string;
  reason: string;
  runners: RunnerScore[];
  matching_lessons: FailureLesson[];
};

export async function fetchCliRecommendation(repo: string, task: string): Promise<CliRecommendation | null> {
  try {
    const qs = new URLSearchParams();
    if (repo.trim()) qs.set("repo", repo.trim());
    if (task.trim()) qs.set("task", task.trim().slice(0, 200));
    const r = await fetch(`/api/router/recommend?${qs.toString()}`);
    if (!r.ok) return null;
    const raw = (await r.json().catch(() => null)) as CliRecommendation | null;
    return raw && typeof raw === "object"
      ? {
          ...raw,
          runners: Array.isArray(raw.runners) ? raw.runners : [],
          matching_lessons: Array.isArray(raw.matching_lessons) ? raw.matching_lessons : [],
        }
      : null;
  } catch {
    return null;
  }
}

export function liveSessionDurationMs(s: Session, nowMs: number): number | null {
  if (typeof s.run_elapsed_ms === "number" && Number.isFinite(s.run_elapsed_ms)) {
    return s.run_elapsed_ms;
  }
  if (typeof s.duration_ms === "number" && Number.isFinite(s.duration_ms)) {
    return s.duration_ms;
  }
  if (isActivelyRunning(s) && typeof s.started_at_ms === "number" && s.started_at_ms > 0) {
    return Math.max(0, nowMs - s.started_at_ms);
  }
  if (typeof s.elapsed_ms === "number" && Number.isFinite(s.elapsed_ms)) {
    return s.elapsed_ms;
  }
  return null;
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

// The check's own last printed line ("3 passed in 4.12s") is the receipt line.
export function receiptLine(s: Session): string {
  if (s.check_steps && s.check_steps.length > 0) {
    const failed = s.check_steps.find((st) => st.passed === false || st.status === "failed");
    const last = failed || s.check_steps[s.check_steps.length - 1];
    if (last?.tail_line) return last.tail_line;
  }
  const lines = (s.check_output || "").split("\n").map((x) => x.trim()).filter(Boolean);
  if (lines.length) return lines[lines.length - 1];
  return s.check_passed === true ? "Check passed (0 exit, clean output)" : s.check_cmd || "";
}

export function diffStat(d?: string) {
  let files = 0, add = 0, del = 0;
  for (const l of (d || "").split("\n")) {
    if (l.startsWith("diff --git")) files++;
    else if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return { files, add, del };
}

export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "ctx";
export function parseDiffLines(d?: string): { kind: DiffLineKind; text: string }[] {
  if (!d || !d.trim()) return [];
  return d.split("\n").map((text) => {
    if (text.startsWith("diff --git") || text.startsWith("index ") || text.startsWith("--- ") || text.startsWith("+++ ")) {
      return { kind: "meta", text };
    }
    if (text.startsWith("@@")) return { kind: "hunk", text };
    if (text.startsWith("+")) return { kind: "add", text };
    if (text.startsWith("-")) return { kind: "del", text };
    return { kind: "ctx", text };
  });
}

export const HONEST = "Check passed — but this session needs you";
export const isVerified = (s: Session) => s.check_passed === true && (s.status === "done" || s.status === "merged");
export const isHonest = (s: Session) => s.check_passed === true && s.status === "needs-you";
export const isFailed = (s: Session) => s.status === "needs-you" && s.check_ran === true && s.check_passed === false;
export const isQueuedOrBlocked = (s: Session) => s.bucket === "working" && (s.status === "queued" || s.status === "blocked");
export const isActivelyRunning = (s: Session) => s.bucket === "working" && s.status !== "queued" && s.status !== "blocked";

export type GoalPlanTask = BatchDispatchItem & {
  alias: string;
  title?: string;
};

export type GoalPlanResponse = {
  goal: string;
  repo: string;
  engine: string;
  model?: string | null;
  check_cmd: string;
  auto_steer_budget: number;
  tasks: GoalPlanTask[];
};

export function planGoalLocally(req: { goal: string; repo: string; agent?: string }): GoalPlanResponse {
  const goal = req.goal.trim();
  const repo = req.repo.trim();
  const clauses = goal
    .split(/\n+|;\s*|\s+then\s+/i)
    .map((c) => c.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean);
  const rawSteps = clauses.length > 0 ? clauses : [goal || "Implement requested task with tests"];
  const tasks: GoalPlanTask[] = rawSteps.slice(0, 6).map((step, idx) => ({
    alias: `#${idx + 1}`,
    repo,
    task: step,
    agent: req.agent || undefined,
    depends_on: idx > 0 && /\bthen\b/i.test(goal) ? [`#${idx}`] : undefined,
    auto_steer_budget: 2,
  }));
  return {
    goal,
    repo,
    engine: req.agent || "opencode",
    model: null,
    check_cmd: "npm test",
    auto_steer_budget: 2,
    tasks,
  };
}

export async function planGoal(req: { goal: string; repo: string; agent?: string }): Promise<GoalPlanResponse> {
  try {
    const r = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!r.ok) return planGoalLocally(req);
    const raw = (await r.json()) as Partial<GoalPlanResponse>;
    if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) return planGoalLocally(req);
    return {
      goal: asStr(raw.goal, req.goal),
      repo: asStr(raw.repo, req.repo),
      engine: asStr(raw.engine, req.agent || "opencode"),
      model: raw.model ? asStr(raw.model) : null,
      check_cmd: asStr(raw.check_cmd, "npm test"),
      auto_steer_budget: typeof raw.auto_steer_budget === "number" ? raw.auto_steer_budget : 2,
      tasks: raw.tasks.map((t, i) => ({
        alias: asStr((t as GoalPlanTask).alias, `#${i + 1}`),
        repo: asStr(t.repo, req.repo),
        task: asStr(t.task, req.goal),
        agent: t.agent ? asStr(t.agent) : undefined,
        check: t.check ? asStr(t.check) : undefined,
        depends_on: Array.isArray(t.depends_on) ? t.depends_on.map((d) => asStr(d)).filter(Boolean) : undefined,
        allowed_globs: Array.isArray(t.allowed_globs) ? t.allowed_globs.map((g) => asStr(g)).filter(Boolean) : undefined,
        forbidden_globs: Array.isArray(t.forbidden_globs) ? t.forbidden_globs.map((g) => asStr(g)).filter(Boolean) : undefined,
        auto_steer_budget: typeof t.auto_steer_budget === "number" ? t.auto_steer_budget : 2,
      })),
    };
  } catch {
    return planGoalLocally(req);
  }
}
