// The /api routes of Fleet (v0.4.0 + v0.5.0 + v0.6.0), with defensive normalization and graceful fallbacks
// so malformed, partial, null, or pending endpoints never throw or blank the board.

export type Bucket = "needs-you" | "working" | "done";
export type TabId = "tr" | "df" | "rc";
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

export type HealAttempt = {
  attempt: number;
  trigger_step: string;
  exit_code: number | null;
  stderr_tail: string;
  prompt_sent: string;
  started_ms: number | null;
  elapsed_ms: number | null;
  healed: boolean;
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
  merge_check?: boolean;
  policy_test?: boolean;
  prune_worktrees?: boolean;
  auto_heal?: boolean;
  templates?: boolean;
  metrics?: boolean;
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

export const VERSION_URL = "https://github.com/cayleb-james2008/dsh-fleet/releases/tag/v";
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
          merge_check: Boolean(fRaw.merge_check),
          policy_test: Boolean(fRaw.policy_test),
          prune_worktrees: Boolean(fRaw.prune_worktrees),
          auto_heal: Boolean(fRaw.auto_heal),
          templates: Boolean(fRaw.templates),
          metrics: Boolean(fRaw.metrics),
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

export async function fetchBoardMetrics(
  sessions: Session[],
  maxParallel: number,
  useServer: boolean,
): Promise<BoardMetrics> {
  const local = computeLocalMetrics(sessions, maxParallel);
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

export function statusText(s: Session): string {
  if (s.bucket === "working" && s.status === "blocked") {
    const n = (s.blocked_by || s.depends_on || []).length;
    return n > 0 ? `waiting on ${n} dep${n === 1 ? "" : "s"}` : "blocked";
  }
  if (s.bucket === "working" && s.status === "queued") return `queued #${s.queue_position ?? "?"}`;
  return (s.status || "working").replace(/-/g, " ");
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
