// The /api routes of Fleet, typed as the old page read them (git show HEAD:assets/index.html). Every read is guarded:
// a failed or malformed reply is null, never a throw, so the board can keep its last good list on screen.

export type Bucket = "needs-you" | "working" | "done";

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
      return (await r.json()).error || "request failed";
    } catch {
      return "request failed";
    }
  } catch {
    return "Could not reach Fleet. Is it running?";
  }
}

export function statusText(s: Session): string {
  if (s.bucket === "working" && s.status === "queued") return `queued #${s.queue_position ?? "?"}`;
  return s.status.replace("-", " ");
}

// The check's own last printed line ("3 passed in 4.12s") is the receipt line.
export function receiptLine(s: Session): string {
  const lines = (s.check_output || "").split("\n").map((x) => x.trim()).filter(Boolean);
  if (lines.length) return lines[lines.length - 1];
  return s.check_passed === true ? "Check passed (no output)" : s.check_cmd || "";
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

export const HONEST = "Check passed — but this session needs you";
export const isVerified = (s: Session) => s.check_passed === true && (s.status === "done" || s.status === "merged");
export const isHonest = (s: Session) => s.check_passed === true && s.status === "needs-you";
// A session whose check ran and failed: red. Other needs-you sessions (no check result, or a stop) are clay.
export const isFailed = (s: Session) => s.status === "needs-you" && s.check_ran === true && s.check_passed === false;
