// The /api routes of Fleet (v0.4.0 + v0.5.0), with defensive normalization and graceful fallbacks
// so malformed, partial, null, or pending v0.5.0 fields never throw or blank the board.

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

export async function fetchMergeCheck(
  session: Session,
  useServer: boolean,
): Promise<MergeCheckResult> {
  const fallback = (): MergeCheckResult => {
    const hasConflictError = Boolean(session.merge_error && /conflict/i.test(`${session.merge_error.message || ""} ${session.merge_error.detail || ""}`));
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
      const r = await fetch("/api/sessions/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks: items, sessions: items }),
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

  // Graceful sequential fallback (also resolves intra-batch alias references like #1 -> real created ID!)
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
    return { ok: false, message: "Worktree pruning requires Fleet v0.5.0 server." };
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
