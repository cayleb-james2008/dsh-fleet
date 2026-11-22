// The /api routes of Fleet, with defensive normalization so malformed, partial, or null fields never throw or blank the board.

export type Bucket = "needs-you" | "working" | "done";
export type TabId = "tr" | "df" | "rc";

export type Session = {
  id: string;
  task: string;
  project: string;
  status: string;
  bucket: Bucket;
  branch?: string;
  engine?: string;
  agent?: string;
  test_mode?: boolean;
  reason?: string | null;
  check_cmd?: string;
  check_output?: string;
  check_passed?: boolean | null;
  check_ran?: boolean;
  check_exit?: number | null;
  queue_position?: number | null;
  transcript: string[];
  diff?: string;
  steer?: string[];
  successor?: string | null;
  spawned_from?: string | null;
  next_queue?: string[];
  merge_target?: string | null;
  merge_error?: { message?: string; detail?: string } | null;
};

export type Agent = { name: string; found: boolean };
export type Policy = {
  agents: Agent[];
  max_parallel: number;
  timeout_secs: number;
  source: string;
  default_agent?: string | null;
  default_agent_engine?: string;
  model?: string | null;
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

export function isDemoMode(): boolean {
  return typeof window !== "undefined" && Boolean((window as { __FLEET_DEMO__?: boolean }).__FLEET_DEMO__);
}

function asStr(v: unknown, fallback = ""): string {
  if (v === null || v === undefined) return fallback;
  return typeof v === "string" ? v : String(v);
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
  const steer = Array.isArray(r.steer)
    ? r.steer.filter((x) => x !== null && x !== undefined).map((x) => asStr(x)).filter(Boolean)
    : [];
  const nextQueue = Array.isArray(r.next_queue)
    ? r.next_queue.filter((x) => x !== null && x !== undefined).map((x) => asStr(x)).filter(Boolean)
    : [];
  const mergeErr =
    r.merge_error && typeof r.merge_error === "object"
      ? {
          message: asStr((r.merge_error as Record<string, unknown>).message, ""),
          detail: asStr((r.merge_error as Record<string, unknown>).detail, ""),
        }
      : null;

  return {
    id,
    task,
    project,
    status: rawStatus,
    bucket,
    branch: asStr(r.branch, ""),
    engine: asStr(r.engine, ""),
    agent: asStr(r.agent, ""),
    test_mode: Boolean(r.test_mode),
    reason: r.reason === null || r.reason === undefined ? null : asStr(r.reason),
    check_cmd: asStr(r.check_cmd, ""),
    check_output: asStr(r.check_output, ""),
    check_passed: typeof r.check_passed === "boolean" ? r.check_passed : null,
    check_ran: typeof r.check_ran === "boolean" ? r.check_ran : undefined,
    check_exit: typeof r.check_exit === "number" && Number.isFinite(r.check_exit) ? r.check_exit : null,
    queue_position: typeof r.queue_position === "number" && Number.isFinite(r.queue_position) ? r.queue_position : null,
    transcript,
    diff: typeof r.diff === "string" ? r.diff : "",
    steer,
    successor: r.successor ? asStr(r.successor) : null,
    spawned_from: r.spawned_from ? asStr(r.spawned_from) : null,
    next_queue: nextQueue,
    merge_target: r.merge_target ? asStr(r.merge_target) : null,
    merge_error: mergeErr,
  };
}

export function normalizeSessions(raw: unknown): Session[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Session[] = [];
  raw.forEach((item, i) => {
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
      return { name: asStr(o.name, "").trim() || `agent-${idx + 1}`, found: Boolean(o.found) };
    });
  return {
    agents,
    max_parallel: typeof r.max_parallel === "number" && Number.isFinite(r.max_parallel) ? r.max_parallel : 1,
    timeout_secs: typeof r.timeout_secs === "number" && Number.isFinite(r.timeout_secs) ? r.timeout_secs : 1800,
    source: asStr(r.source, "policies.rn") || "policies.rn",
    default_agent: r.default_agent ? asStr(r.default_agent) : null,
    default_agent_engine: r.default_agent_engine ? asStr(r.default_agent_engine) : undefined,
    model: r.model ? asStr(r.model) : null,
  };
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

export function statusText(s: Session): string {
  if (s.bucket === "working" && s.status === "queued") return `queued #${s.queue_position ?? "?"}`;
  return (s.status || "working").replace(/-/g, " ");
}

// The check's own last printed line ("3 passed in 4.12s") is the receipt line.
export function receiptLine(s: Session): string {
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
