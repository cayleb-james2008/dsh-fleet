import {
  useEffect,
  useRef,
  useState,
} from "./hooks";
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
} from "react";
import { ArrowUpRight, CheckCircle2, ClipboardCopy, FileCode2, Image as ImageIcon, Pin, PinOff, Send, X } from "./icons";
import { animatePanelEnter } from "./motion";
import { openFileInAuxPane, parseScreenshotLines, sendConfirmedNudge, sendSwarmControl } from "./sidecar";
import type {
  BoardMessage,
  NormalizedPlan,
  PlanGoalObject,
  PlanMilestoneStatus,
  PlanRisk,
  PlanThread,
  PlanWorkstreamStatus,
  SwarmMember,
  SwarmPlan,
  SwarmSnapshot,
  TriageItem,
  WorktreesPayload,
} from "./types";

export const canLiveNudge = (snap: SwarmSnapshot): boolean =>
  Boolean(snap.capabilities?.canSendMessage || window.sidecar?.agent?.sendMessage);

export function Pill({
  active = false,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "pill transition",
        active ? "bg-[var(--ink-button)] text-[var(--ink-button-fg)]" : "bg-track text-ink-2 hover:text-ink",
        className,
      )}
      {...props}
    />
  );
}

export function useNowMs(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return nowMs;
}

export const memberLastTs = (m?: SwarmMember, fallback = 0): number =>
  m?.lastStepAt ? Date.parse(m.lastStepAt) : m?.transcriptMtime || m?.lastPostTs || fallback;

export function memberMeta(m?: SwarmMember, nowMs = Date.now()): { elapsed: string; isStalled: boolean } {
  const ts = memberLastTs(m);
  const elapsedMs = ts > 0 ? Math.max(0, nowMs - ts) : 0;
  return {
    elapsed: ts > 0 ? fmtElapsed(ts, nowMs) : "",
    isStalled: Boolean(m && !m.killed && m.status === "working" && !m.failure && elapsedMs >= 600_000),
  };
}

export const copyText = (text: string, okMsg = "Copied"): Promise<void> =>
  navigator.clipboard.writeText(text).then(() => toast.success(okMsg), () => toast.error("Copy failed"));

export const hasControlChars = (s: string): boolean => /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s);

export async function submitNudge(
  target: string | string[],
  text: string,
  okMsg: string,
  setSending: (b: boolean) => void,
  onDone: () => void,
): Promise<void> {
  if (hasControlChars(text)) {
    toast.error("Control characters not permitted");
    return;
  }
  const msg = text.trim();
  const hasTarget = Array.isArray(target) ? target.length > 0 : Boolean(target);
  if (!msg || msg.length > 4000 || !hasTarget) return;
  setSending(true);
  try {
    await sendConfirmedNudge(target, msg);
    toast.success(okMsg);
    onDone();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Send failed");
  } finally {
    setSending(false);
  }
}

export function formatFilteredBoardExport(
  snap: SwarmSnapshot,
  messages: BoardMessage[],
  filter: { quickFilter: string; agentFilter: string; query: string },
  format: "md" | "json",
): string {
  const title = maskHome(snap.title || "Fleet");
  if (format === "json") {
    return JSON.stringify(
      {
        swarm: snap.id,
        title,
        head: snap.head || 0,
        filter,
        count: messages.length,
        messages: messages.map((m) => ({
          seq: m.seq,
          agent: m.agent,
          time: m.time || "",
          mentions: m.mentions || [],
          text: maskHome(m.text),
        })),
      },
      null,
      2,
    );
  }
  const q = filter.query.trim();
  const tags = [filter.quickFilter, filter.agentFilter !== "all" && `@${filter.agentFilter}`, q && `"${q}"`].filter(Boolean).join(", ");
  return [
    `# ${title} (${tags})`,
    `- Swarm: ${snap.id} | Showing: ${messages.length} | Head: #${snap.head || 0}`,
    "",
    ...messages.map((m) => `- #${m.seq}${m.time ? ` \`${m.time}\`` : ""} @${m.agent}: ${cleanDigestLine(m.text, 400)}`),
  ].join("\n");
}

export function downloadTextFile(filename: string, content: string, mime: string, okMsg: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast.success(okMsg);
}

export function openOrCopyPath(target: string, fallbackCopy = target): void {
  if (openFileInAuxPane(target)) {
    toast.success(`Opened ${target.split("/").pop() || "file"}`);
  } else if (fallbackCopy) {
    void copyText(fallbackCopy, target === fallbackCopy ? "File path copied" : "Screenshot label copied");
  }
}

type ToastKind = "success" | "error" | "info";
interface ToastEntry {
  id: number;
  kind: ToastKind;
  text: string;
}

let nextToastId = 1;
let toastQueue: ToastEntry[] = [];
const toastListeners = new Set<(items: ToastEntry[]) => void>();

function setToasts(next: ToastEntry[]) {
  toastQueue = next;
  for (const fn of toastListeners) fn(next);
}

function emitToast(kind: ToastKind, msg: string) {
  const id = nextToastId++;
  setToasts([...toastQueue.slice(-2), { id, kind, text: String(msg || "") }]);
  setTimeout(() => setToasts(toastQueue.filter((t) => t.id !== id)), 3200);
}

export const toast = Object.assign((msg: string) => emitToast("info", msg), {
  message: (msg: string) => emitToast("info", msg),
  success: (msg: string) => emitToast("success", msg),
  error: (msg: string) => emitToast("error", msg),
});

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function humanizeStatus(raw: string | undefined): string {
  const s = String(raw || "pending").trim();
  if (!s) return "Pending";
  const cleaned = s.replace(/[_-]+/g, " ").toLowerCase();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export const maskHome = (s: unknown): string =>
  String(s ?? "").replace(/\/(?:home|Users)\/[^/\s]+(\/|$)/g, (_, sep) => `~${sep}`);
const cleanDigestLine = (s: unknown, max = 140) => maskHome(s).replace(/\s+/g, " ").trim().slice(0, max);

export function safePlanText(val: unknown, depth = 0): string {
  if (depth > 6 || val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number") return Number.isFinite(val) ? String(val) : "";
  if (typeof val === "boolean") return String(val);
  if (Array.isArray(val)) {
    return val
      .slice(0, 8)
      .map((item) => safePlanText(item, depth + 1).trim())
      .filter(Boolean)
      .join(", ");
  }
  if (typeof val === "object") {
    const o = val as Record<string, unknown>;
    const preferred = [
      "line",
      "title",
      "summary",
      "text",
      "detail",
      "description",
      "label",
      "name",
      "message",
      "note",
      "status",
      "value",
    ];
    for (const key of preferred) {
      if (Object.prototype.hasOwnProperty.call(o, key)) {
        const hit = safePlanText(o[key], depth + 1).trim();
        if (hit) return hit;
      }
    }
    const fallback: string[] = [];
    for (const [k, v] of Object.entries(o)) {
      if (fallback.length >= 3) break;
      const rendered = safePlanText(v, depth + 1).trim();
      if (rendered) fallback.push(`${k}: ${rendered}`);
    }
    return fallback.join(" · ");
  }
  return "";
}

const WS_STATUSES = new Set<PlanWorkstreamStatus>(["pending", "running", "done", "verified", "blocked"]);
const MS_STATUSES = new Set<PlanMilestoneStatus>(["pending", "in_progress", "done", "blocked"]);

function normalizeWsStatus(raw: unknown): PlanWorkstreamStatus {
  const s = safePlanText(raw).trim().toLowerCase();
  if (s === "in_progress") return "running";
  if (s === "completed") return "done";
  if (s === "failed") return "blocked";
  return WS_STATUSES.has(s as PlanWorkstreamStatus) ? (s as PlanWorkstreamStatus) : "pending";
}

function normalizeMsStatus(raw: unknown): PlanMilestoneStatus {
  const s = safePlanText(raw).trim().toLowerCase();
  if (s === "running") return "in_progress";
  if (s === "completed" || s === "verified") return "done";
  if (s === "failed") return "blocked";
  return MS_STATUSES.has(s as PlanMilestoneStatus) ? (s as PlanMilestoneStatus) : "pending";
}

export function normalizePlan(raw: SwarmPlan | NormalizedPlan | null | undefined): NormalizedPlan | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  let goalTitle = safePlanText(raw.goalTitle).trim() || undefined;
  let goalLine = safePlanText(raw.goalLine).trim() || undefined;
  let goal = "";
  if (typeof raw.goal === "string") {
    goal = raw.goal;
  } else if (raw.goal && typeof raw.goal === "object" && !Array.isArray(raw.goal)) {
    const g = raw.goal as PlanGoalObject;
    goalTitle = safePlanText(g.title).trim() || goalTitle;
    goalLine = safePlanText(g.line).trim() || goalLine;
    goal = goalLine || goalTitle || safePlanText(g).trim();
  } else {
    goal = safePlanText(raw.goal).trim() || goalLine || goalTitle || "";
  }

  const threads: PlanThread[] = Array.isArray(raw.threads)
    ? raw.threads
        .filter((t): t is NonNullable<typeof t> => Boolean(t && typeof t === "object"))
        .map((t, idx) => ({
          id: safePlanText(t.id) || `thread-${idx + 1}`,
          title: safePlanText(t.title),
          goal: safePlanText(t.goal),
          tasks: Array.isArray(t.tasks) ? t.tasks.map((x) => safePlanText(x)).filter(Boolean) : [],
        }))
    : [];

  const tasks: Record<string, string> = {};
  if (raw.tasks && typeof raw.tasks === "object" && !Array.isArray(raw.tasks)) {
    for (const [k, v] of Object.entries(raw.tasks)) {
      const key = String(k || "").trim();
      const desc = safePlanText(v).trim();
      if (key && desc) tasks[key] = desc;
    }
  }

  const workstreams: NormalizedPlan["workstreams"] = Array.isArray(raw.workstreams)
    ? raw.workstreams
        .filter((w): w is NonNullable<typeof w> => Boolean(w && typeof w === "object"))
        .map((w, idx) => {
          const note = safePlanText(w.note).trim();
          const threadId = safePlanText(w.threadId).trim();
          return {
            id: safePlanText(w.id) || `ws-${idx + 1}`,
            title: safePlanText(w.title),
            owner: safePlanText(w.owner),
            status: normalizeWsStatus(w.status),
            ...(note ? { note } : {}),
            ...(threadId ? { threadId } : {}),
          };
        })
    : [];

  const milestones: NormalizedPlan["milestones"] = Array.isArray(raw.milestones)
    ? raw.milestones
        .filter((m): m is NonNullable<typeof m> => Boolean(m && typeof m === "object"))
        .map((m) => ({
          title: safePlanText(m.title),
          status: normalizeMsStatus(m.status),
        }))
    : [];

  const risks: PlanRisk[] = Array.isArray(raw.risks)
    ? raw.risks
        .map((r) => {
          if (typeof r === "string") return { title: r };
          if (r && typeof r === "object") {
            const sev = safePlanText((r as PlanRisk).severity);
            return {
              title: safePlanText((r as PlanRisk).title),
              ...(sev ? { severity: sev } : {}),
            };
          }
          return null;
        })
        .filter((r): r is PlanRisk => Boolean(r && r.title))
    : [];

  const gate = safePlanText(raw.gate);
  const title = safePlanText(raw.title) || goalTitle || "";
  const hasNative = threads.length > 0 || Object.keys(tasks).length > 0 || Boolean(goalTitle || goalLine);
  const hasFleet = workstreams.length > 0 || milestones.length > 0 || Boolean(gate);
  const schema =
    raw.schema === "native" || raw.schema === "fleet" || raw.schema === "hybrid"
      ? raw.schema
      : hasNative && hasFleet
        ? "hybrid"
        : hasNative
          ? "native"
          : "fleet";

  return {
    schema,
    etag: typeof raw.etag === "string" ? raw.etag : "",
    title,
    goal,
    ...(goalTitle ? { goalTitle } : {}),
    ...(goalLine ? { goalLine } : {}),
    gate,
    ...(typeof raw.repo === "string" && raw.repo ? { repo: raw.repo } : {}),
    threads,
    tasks,
    workstreams,
    milestones,
    risks,
  };
}

export function formatBlockerContext(item: TriageItem, member?: SwarmMember, snap?: SwarmSnapshot): string {
  const ts = memberLastTs(member, item.timestamp || 0);
  const state = member ? `${member.status}${ts > 0 ? `, ${fmtElapsed(ts)}` : ""}` : item.kind;
  const tools = (member?.recentTools || []).slice(0, 3);
  return [
    `### Blocker: ${maskHome(item.title)}`,
    `- ${snap?.title || "Fleet"} | @${item.member} (${state})${item.seq > 0 ? ` | #${item.seq}` : ""}`,
    item.detail && `- Detail: ${cleanDigestLine(item.detail, 240)}`,
    member?.thinkingHeading && `- Thinking: ${maskHome(member.thinkingHeading)}`,
    ...(tools.length ? ["- Tools:", ...tools.map((t) => `  - ${t.name}: ${cleanDigestLine(t.summary, 140)}`)] : []),
  ].filter(Boolean).join("\n");
}

export function formatSwarmDigest(
  snap: SwarmSnapshot,
  pinnedSeqs: number[] = [],
  worktrees: WorktreesPayload | null = null,
): string {
  const members = snap.members || [];
  const live = members.filter((m) => !m.killed);
  const cnt = (st: string) => live.filter((m) => m.status === st).length;
  const gate = snap.gateReadiness;
  const vel = gate?.velocity;
  const plan = normalizePlan(snap.plan);
  const lines = [
    `# ${maskHome(snap.title || "Fleet")} Handoff Digest`,
    `- Status: ${cnt("working")} working, ${cnt("waiting")} waiting, ${members.length} members, #${snap.head || 0}, ${fmtTokens(snap.usage?.totalTokens)} tok`,
    plan?.goal && `- Active goal: ${cleanDigestLine(plan.goal, 220)}`,
    plan?.gate && `- Verification gate: \`${maskHome(plan.gate)}\``,
    gate &&
      `- Gate readiness: ${gate.state}${vel ? `, ${vel.passRatePct}% pass rate (${vel.wavesPerHr}/hr, ${vel.done} done, ${vel.verified} verified)` : ""}`,
  ].filter(Boolean) as string[];
  const sec = (title: string, rows: string[]) => rows.length && lines.push("", `## ${title}`, ...rows);
  const pinSet = new Set(pinnedSeqs);
  sec(
    "Pinned",
    (snap.messages || [])
      .filter((m) => !m.control && pinSet.has(m.seq))
      .map((pm) => `- #${pm.seq} @${pm.agent}: ${cleanDigestLine(pm.text)}`),
  );
  sec(
    "Workers",
    live.map((m) => {
      const ts = memberLastTs(m);
      const err = m.failure ? `, issue: ${cleanDigestLine(m.failure.kind, 40)}` : "";
      return `- @${m.name}: ${m.status}${ts ? ` ${fmtElapsed(ts)}` : ""} (${m.steps} steps, ${fmtTokens(m.usage.totalTokens)} tok${err})`;
    }),
  );
  sec(
    "Threads",
    (plan?.threads || []).map(
      (th) => `- ${cleanDigestLine(th.title || th.id, 120)}${th.goal ? `: ${cleanDigestLine(th.goal, 140)}` : ""}${th.tasks.length ? ` (${th.tasks.map((t) => `@${t}`).join(", ")})` : ""}`,
    ),
  );
  sec(
    "Tasks",
    Object.entries(plan?.tasks || {}).map(([owner, desc]) => `- @${owner}: ${cleanDigestLine(desc, 160)}`),
  );
  sec(
    "Workstreams",
    (plan?.workstreams || []).map(
      (ws) => `- [${humanizeStatus(ws.status)}] ${cleanDigestLine(ws.title, 140)}${ws.owner ? ` (@${ws.owner})` : ""}`,
    ),
  );
  sec("Blockers", (snap.triage || []).map((it) => `- ${cleanDigestLine(it.title, 120)}: ${cleanDigestLine(it.detail, 180)}`));
  const deliverables = (snap.messages || [])
    .filter((m) => !m.control && /\[(done|verified|scale-verified|blocked)\]/i.test(m.text))
    .slice(-6)
    .map((m) => `- #${m.seq} @${m.agent}: ${cleanDigestLine(m.text, 180)}`);
  const wtCommits = (worktrees?.worktrees || [])
    .filter((wt) => wt.lastCommitSha)
    .slice(0, 6)
    .map((wt) => `- Commit ${wt.lastCommitSha} on ${wt.branch}: ${cleanDigestLine(wt.lastCommitSubject || "(no subject)", 120)}`);
  sec("Verified deliverables", [...deliverables, ...wtCommits]);
  sec(
    "Worktree readiness",
    (worktrees?.worktrees || []).slice(0, 10).map((wt) => {
      const land = wt.landStatus || (wt.clean ? "ready" : "dirty");
      const delta = wt.ahead || wt.behind ? `, +${wt.ahead || 0}/-${wt.behind || 0}` : "";
      const sha = wt.lastCommitSha ? ` @ ${wt.lastCommitSha}` : "";
      const files = !wt.clean && wt.files?.length ? ` (${wt.files.slice(0, 6).map((f) => `${f.state} ${f.path}`).join(", ")})` : "";
      return `- \`${wt.branch}\` [${land}${delta}${sha}] ${maskHome(wt.path)}${files}`;
    }),
  );
  return maskHome(lines.join("\n"));
}

/** Sanitized Full Swarm Archive Export in Markdown or structured JSON (`0` `/home/` leaks). */
export function formatSwarmArchive(
  snap: SwarmSnapshot,
  pinnedSeqs: number[] = [],
  worktrees: WorktreesPayload | null = null,
  format: "md" | "json" = "md",
): string {
  const msgs = (snap.messages || []).filter((m) => !m.control);
  const plan = normalizePlan(snap.plan);
  if (format === "json") {
    return maskHome(
      JSON.stringify(
        {
          schema: "fleet.swarm-archive.v1",
          swarm: snap.id || snap.swarm || "",
          title: maskHome(snap.title || "Fleet"),
          head: snap.head || 0,
          pinnedSeqs,
          usage: snap.usage || null,
          plan: plan
            ? {
                ...plan,
                title: maskHome(plan.title),
                goal: maskHome(plan.goal),
                ...(plan.goalTitle ? { goalTitle: maskHome(plan.goalTitle) } : {}),
                ...(plan.goalLine ? { goalLine: maskHome(plan.goalLine) } : {}),
                gate: maskHome(plan.gate),
                ...(plan.repo ? { repo: maskHome(plan.repo) } : {}),
                threads: plan.threads.map((th) => ({
                  ...th,
                  title: maskHome(th.title),
                  goal: maskHome(th.goal),
                })),
                tasks: Object.fromEntries(
                  Object.entries(plan.tasks).map(([k, v]) => [k, maskHome(v)]),
                ),
                workstreams: plan.workstreams.map((ws) => ({
                  ...ws,
                  title: maskHome(ws.title),
                  ...(ws.note ? { note: maskHome(ws.note) } : {}),
                })),
                milestones: plan.milestones.map((ms) => ({
                  ...ms,
                  title: maskHome(ms.title),
                })),
                risks: plan.risks.map((r) => ({
                  ...r,
                  title: maskHome(r.title),
                })),
              }
            : null,
          gateReadiness: snap.gateReadiness || null,
          burnSummary: snap.burnSummary || null,
          members: (snap.members || []).map((m) => ({
            name: m.name,
            role: m.role,
            model: m.model,
            status: m.status,
            killed: m.killed,
            steps: m.steps,
            unread: m.unread,
            usage: m.usage,
            activityPeek: m.activityPeek ? { ...m.activityPeek, label: maskHome(m.activityPeek.label) } : null,
            failure: m.failure ? { ...m.failure, text: maskHome(m.failure.text) } : null,
          })),
          triage: (snap.triage || []).map((it) => ({
            id: it.id,
            kind: it.kind,
            severity: it.severity,
            member: it.member,
            seq: it.seq,
            title: maskHome(it.title),
            detail: maskHome(it.detail),
          })),
          messages: msgs.map((m) => ({
            seq: m.seq,
            agent: m.agent,
            time: m.time || "",
            mentions: m.mentions || [],
            text: maskHome(m.text),
          })),
          worktrees: (worktrees?.worktrees || []).map((wt) => ({
            branch: wt.branch,
            path: maskHome(wt.path),
            clean: wt.clean,
            landStatus: wt.landStatus || (wt.clean ? "ready" : "dirty"),
            ahead: wt.ahead || 0,
            behind: wt.behind || 0,
            lastCommitSha: wt.lastCommitSha || "",
            lastCommitSubject: maskHome(wt.lastCommitSubject || ""),
            files: (wt.files || []).map((f) => ({ state: f.state, path: f.path })),
          })),
        },
        null,
        2,
      ),
    );
  }
  const summary = formatSwarmDigest(snap, pinnedSeqs, worktrees);
  const transcriptRows = msgs.map(
    (m) => `- #${m.seq}${m.time ? ` \`${m.time}\`` : ""} @${m.agent}: ${cleanDigestLine(m.text, 400)}`,
  );
  return maskHome(
    [
      summary,
      "",
      `## Full Board Transcript (${msgs.length})`,
      ...(transcriptRows.length ? transcriptRows : ["- No board messages recorded."]),
    ].join("\n"),
  );
}

export function fmtTokens(n: number | undefined): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

function fmtRel(ts: number | string | null | undefined, nowMs: number, withAgo: boolean): string {
  const ms = typeof ts === "number" ? ts : ts ? Date.parse(String(ts)) : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return withAgo ? "n/a" : "";
  const sec = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (sec < 60) return withAgo ? `${sec}s ago` : "<1m";
  const min = Math.floor(sec / 60);
  const v = min < 60 ? `${min}m` : min < 1440 ? `${Math.floor(min / 60)}h` : `${Math.floor(min / 1440)}d`;
  return withAgo ? `${v} ago` : v;
}

export const fmtElapsed = (ts: number | string | null | undefined, nowMs = Date.now()): string =>
  fmtRel(ts, nowMs, false);

export const fmtTimeAgo = (ts: number | string | null | undefined): string => fmtRel(ts, Date.now(), true);

export function fmtClockTime(ts: number | null | undefined, fallback = ""): string {
  if (!ts) return fallback;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "info" | "danger";
export type ButtonSize = "sm" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-[var(--ink-button)] text-[var(--ink-button-fg)] border-[var(--ink-button)] shadow-[var(--elev-primary)] hover:opacity-90",
  secondary: "bg-track text-ink border-hairline-s hover:bg-board active:bg-hairline",
  outline: "bg-surface text-ink border-[var(--edge)] hover:bg-board active:bg-track",
  ghost: "bg-transparent text-ink-2 hover:bg-track hover:text-ink active:bg-hairline",
  info: "bg-blue-soft text-info border-hairline-s hover:opacity-90",
  danger: "bg-bad-soft text-danger border-hairline-s hover:opacity-90",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 min-w-8 px-2 text-[12px]",
  icon: "h-8 w-8 min-w-8 min-h-8 p-0",
};

export function Button({
  variant = "outline",
  size = "sm",
  type = "button",
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn("btn", BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
      {...props}
    >
      {children}
    </button>
  );
}

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "violet";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-track text-ink-2 border-hairline",
  info: "bg-blue-soft text-info",
  success: "bg-ok-soft text-ok",
  warning: "bg-warn-soft text-warn",
  danger: "bg-bad-soft text-danger",
  violet: "bg-violet-soft text-violet",
};

export function Badge({
  tone = "neutral",
  className,
  children,
  ...props
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("bdg", BADGE_TONES[tone], className)} {...props}>
      {children}
    </span>
  );
}

export function StatusDot({
  state,
  className,
}: {
  state: "working" | "waiting" | "killed" | "danger" | "ok" | "warn";
  className?: string;
}) {
  const cls = state === "waiting"
    ? "border-[1.5px] border-ink-3"
    : state === "working" || state === "ok"
      ? "bg-[var(--dot-green)]"
      : state === "danger"
        ? "bg-[var(--dot-red)]"
        : state === "warn"
          ? "bg-[var(--dot-amber)]"
          : "bg-[var(--edge)]";
  return <span aria-hidden="true" className={cn("inline-block h-2 w-2 rounded-full shrink-0", cls, state === "working" && "motion-safe:animate-pulse", className)} />;
}

export function Card({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  return (
    <div className={cn("crd", className)} {...props}>
      {children}
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input className={cn("inp h-8 rounded-chip px-2", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea className={cn("inp rounded-card px-3 py-2", className)} {...props} />;
}

export function SegmentControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-chip border border-hairline bg-track p-1"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "relative h-7 px-2 text-[12px] font-medium rounded-chip cursor-pointer transition",
              active ? "bg-[var(--raised)] text-ink shadow-[var(--elev-raised)]" : "text-ink-2 hover:text-ink",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    animatePanelEnter(panelRef.current);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] p-3"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fleet-modal-title"
        className="w-full max-w-[440px] max-h-[85vh] overflow-y-auto rounded-card border border-hairline bg-surface p-4 shadow-[var(--elev-lift)]"
      >
        <div className="row pb-3 border-b border-hairline">
          <h2 id="fleet-modal-title" className="h2">
            {title}
          </h2>
          <Button variant="ghost" size="icon" aria-label="Close dialog" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="pt-3">{children}</div>
      </div>
    </div>
  );
}

export function FleetToaster({ theme }: { theme: "light" | "dark" }) {
  const [items, setItems] = useState<ToastEntry[]>(toastQueue);

  useEffect(() => {
    toastListeners.add(setItems);
    return () => {
      toastListeners.delete(setItems);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      data-theme={theme}
      aria-live="polite"
      className="pointer-events-none fixed bottom-3 right-3 z-50 flex max-w-[340px] flex-col gap-1"
    >
      {items.map((item) => (
        <div
          key={item.id}
          role="status"
          className={cn(
            "pointer-events-auto row rounded-card border px-3 py-2 text-[13px] shadow-[var(--elev-lift)]",
            item.kind === "error"
              ? "border-danger bg-bad-soft text-danger"
              : item.kind === "success"
                ? "border-ok bg-surface text-ink"
                : "border-hairline bg-surface text-ink",
          )}
        >
          <span className="break-words">{item.text}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setToasts(toastQueue.filter((t) => t.id !== item.id))}
            className="shrink-0 rounded p-1 text-ink-3 hover:text-ink cursor-pointer"
          >
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Shared confirmation-gated inline message composer across Triage, Board, and Roster. */
export function InlineComposer({
  id,
  label,
  value,
  onChange,
  onCancel,
  onSubmit,
  submitLabel = "Confirm & send",
  copyOnly = false,
  disabled = false,
  showCounter = false,
  headerRight,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (val: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel?: string;
  copyOnly?: boolean;
  disabled?: boolean;
  showCounter?: boolean;
  headerRight?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("pt-2 border-t border-hairline space-y-2", className)}>
      <div className="row flex-wrap gap-2">
        <label htmlFor={id} className="text-[12px] font-medium text-ink-2">{label}</label>
        {headerRight}
      </div>
      <Textarea id={id} rows={2} maxLength={4000} value={value} onChange={(e) => onChange(e.target.value)} />
      <div className="row">
        <span className="t3 num">{showCounter ? `${value.length}/4000` : ""}</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" data-testid="composer-submit" disabled={disabled || !value.trim()} onClick={onSubmit}>
            {copyOnly ? <ClipboardCopy /> : <Send />}
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Shared sanitized Screenshot & local file chip strip. */
export function MediaPathChips({
  shots,
  paths,
  onOpen,
  compact = false,
}: {
  shots: Array<{ path: string; fileName: string; caption: string }>;
  paths: string[];
  onOpen: (target: string, fallbackCopy?: string) => void;
  compact?: boolean;
}) {
  if (!shots.length && !paths.length) return null;
  const items = [
    ...shots.map((s) => ({ key: s.path, label: s.caption || s.fileName, fallback: s.caption || s.fileName, shot: true })),
    ...paths.map((fp) => ({ key: fp, label: fp.split("/").pop() || fp, fallback: fp, shot: false })),
  ];
  return (
    <div className={cn("wrap", compact && "pt-1")}>
      {items.map((it) => {
        const Icon = it.shot ? ImageIcon : FileCode2;
        const inner = (
          <>
            <Icon className={cn(compact ? "h-3 w-3" : it.shot ? "text-info" : "", "shrink-0")} />
            <span className={cn("truncate", !it.shot && "mono")}>{it.label}</span>
          </>
        );
        return compact ? (
          <Pill key={it.key} onClick={() => onOpen(it.key, it.fallback)} className={cn("inline-flex items-center gap-1 max-w-full", it.shot && "bg-blue-soft text-info")}>
            {inner}
          </Pill>
        ) : (
          <Button key={it.key} variant="secondary" onClick={() => onOpen(it.key)} className="max-w-full">
            {inner}
          </Button>
        );
      })}
    </div>
  );
}

/** Shared worker activity peek drawer (thinking heading + recent tool calls). */
export function ActivityPeek({ member, mode = "roster" }: { member: SwarmMember; mode?: "triage" | "roster" }) {
  const tools = member.recentTools || [];
  const roster = mode === "roster";
  return (
    <div className="rounded-chip bg-board px-2 py-2 space-y-1 text-[12px]">
      {roster ? (
        <p className="font-semibold text-ink">Recent worker activity</p>
      ) : (
        <div className="row flex-wrap gap-2 text-ink-2 num">
          <span className="font-medium text-ink">{member.steps} steps</span>
          <span>
            {fmtTokens(member.usage.totalTokens)} tok ({fmtTokens(member.usage.inputTokens)}/{fmtTokens(member.usage.cacheReadTokens)}/{fmtTokens(member.usage.outputTokens)})
          </span>
        </div>
      )}
      {member.thinkingHeading && (
        <p className="text-ink-2 truncate">{roster ? "Thought" : "Thinking"}: {member.thinkingHeading}</p>
      )}
      {tools.length > 0 ? (
        <ul className={roster ? "divide-y divide-hairline" : "space-y-1 text-ink-2"} aria-label={`Tool calls for ${member.name}`}>
          {tools.map((tc, i) => (
            <li key={i} className={cn("row", roster && "py-1 first:pt-0 last:pb-0")}>
              <span className={cn("truncate", roster && "text-ink")}>{tc.summary}</span>
              <span className="text-ink-3 shrink-0 mono">{tc.name}</span>
            </li>
          ))}
        </ul>
      ) : (
        roster && <p className="text-ink-3">No tool calls.</p>
      )}
    </div>
  );
}

/** Compact 1-line bounded transcript tail activity strip (`status`, label, age). */
export function MemberActivityLine({ member, testId }: { member: SwarmMember; testId?: string }) {
  if (member.killed) return null;
  const peek = member.activityPeek;
  const rawLabel = peek?.label || (member.activity ? `${member.activityKind === "thinking" ? "Thinking: " : ""}${member.activity}` : "");
  const label = maskHome(rawLabel);
  if (!label) return null;
  const working = (peek?.status || member.status) === "working";
  const ts = peek?.ts || member.transcriptMtime || 0;
  return (
    <p
      data-testid={testId}
      className={cn("row gap-2 text-[12px] min-w-0", working ? "text-info fleet-live-shimmer" : "text-ink-2")}
    >
      <span className="truncate">{working ? "working" : "waiting"}: {label}</span>
      {ts > 0 && <span className="shrink-0 num text-ink-3">{fmtTimeAgo(ts)}</span>}
    </p>
  );
}

/** Shared pinned board posts list across Triage and Board views. */
export function PinnedList({
  messages,
  onJump,
  onUnpin,
  compact = false,
}: {
  messages: BoardMessage[];
  onJump: (seq: number) => void;
  onUnpin: (seq: number) => void;
  compact?: boolean;
}) {
  return (
    <ul className="divide-y divide-hairline">
      {messages.map((pm) => {
        const preview = parseScreenshotLines(pm.text).cleanText || maskHome(pm.text);
        return (
          <li key={pm.seq} className="row py-1">
            <button
              type="button"
              onClick={() => onJump(pm.seq)}
              className="min-w-0 flex-1 text-left text-[12px] text-ink hover:underline cursor-pointer truncate"
            >
              <span className="font-semibold num">#{pm.seq}</span> <span className="font-medium">{pm.agent}:</span>{" "}
              <span className="text-ink-2">{preview}</span>
            </button>
            <div className="f1 shrink-0">
              {!compact && (
                <Button variant="ghost" className="num" onClick={() => onJump(pm.seq)}>
                  #{pm.seq}
                  <ArrowUpRight />
                </Button>
              )}
              <Button variant="ghost" size="icon" aria-label={`Unpin #${pm.seq}`} onClick={() => onUnpin(pm.seq)}>
                <PinOff />
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function SegBar({ segments, label }: { segments: Array<{ key: string; pct: number; cls: string; title?: string }>; label: string }) {
  return (
    <div className="bar" role="img" aria-label={label}>
      {segments.map((s) => s.pct > 0 && <div key={s.key} title={s.title} className={cn("h-full", s.cls)} style={{ width: `${s.pct}%` }} />)}
    </div>
  );
}

const BURN_COLS = ["bg-blue", "bg-[var(--violet)]", "bg-warn", "bg-danger", "bg-[var(--edge)]"];

export function TokenBurnStrip({ snap }: { snap: SwarmSnapshot }) {
  const b = snap.burnSummary;
  if (!b || b.totalTokens <= 0 || !b.workers.length) return null;
  const top = b.topWorker || b.workers[0];
  const shown = b.workers.slice(0, 4);
  const restPct = Math.max(0, 100 - shown.reduce((s, r) => s + r.sharePct, 0));
  const segs = [
    ...shown.map((w, i) => ({ key: w.name, pct: w.sharePct, cls: BURN_COLS[i % 4], title: `@${w.name}: ${fmtTokens(w.totalTokens)} (${w.sharePct}%)` })),
    ...(restPct > 0 ? [{ key: "rest", pct: restPct, cls: "bg-[var(--edge)]" }] : []),
  ];

  return (
    <Card className="p-2 space-y-1" data-testid="token-burn-strip">
      <div className="row flex-wrap t2">
        <div className="wrap gap-1">
          <span className="font-semibold text-ink">Token burn</span>
          <span className="num">{fmtTokens(b.totalTokens)} tok</span>
        </div>
        {top.level !== "normal" ? (
          <Badge tone={top.level === "critical" ? "danger" : "warning"} data-testid="high-burn-badge">
            High burn · @{top.name} {top.sharePct}%
          </Badge>
        ) : (
          <Badge tone="neutral">Top @{top.name} {top.sharePct}%</Badge>
        )}
      </div>
      <SegBar segments={segs} label={`Token share led by ${top.name} (${top.sharePct}%)`} />
      <div className="wrap gap-2 t2 num">
        {b.workers.slice(0, 3).map((w, i) => (
          <span key={w.name} className="inline-flex items-center gap-1">
            <span className={cn("h-2 w-2 rounded-full", BURN_COLS[i % 4])} aria-hidden="true" />
            <span className="text-ink font-medium">{w.name}</span> {fmtTokens(w.totalTokens)} ({w.sharePct}%)
          </span>
        ))}
      </div>
    </Card>
  );
}

export function buildRecoverPrompt(m: Pick<SwarmMember, "name" | "lastPostSeq" | "failure" | "unread" | "status">): string {
  const ref = m.lastPostSeq > 0 ? ` Re #${m.lastPostSeq}:` : "";
  if (m.failure) return `@${m.name}${ref} Resume (${m.failure.kind}): ${m.failure.text}.`;
  if (m.unread > 0 && m.status === "waiting") return `@${m.name}${ref} ${m.unread} unread posts; catch up and post status.`;
  return `@${m.name}${ref} No update; post status or [blocked].`;
}

export function GateReadinessCard({ snap, onJump, onRefresh }: { snap: SwarmSnapshot; onJump: (seq: number, agent?: string) => void; onRefresh?: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [verdictOpen, setVerdictOpen] = useState(false);
  const [verdictKind, setVerdictKind] = useState<"verified" | "blocked" | "ship">("verified");
  const [verdictNote, setVerdictNote] = useState("");
  const [verdictSending, setVerdictSending] = useState(false);
  const [verdictError, setVerdictError] = useState("");
  const verdictLockRef = useRef(false);
  const gateNudgeLockRef = useRef(false);
  const gate = snap.gateReadiness;
  if (!gate) return null;
  const tone = gate.state === "blocked" ? "danger" : gate.state === "ready" ? "success" : "info";
  const label = gate.state === "blocked" ? "Blocked" : gate.state === "ready" ? "Ready" : "Verifying";
  const next = gate.nextAction;
  const v = gate.velocity;
  const live = Boolean(next && canLiveNudge(snap) && next.conversationId);
  const swarmConvId = snap.swarm || snap.conversationId || "";
  const canControl = Boolean(swarmConvId && canLiveNudge(snap));
  const members = snap.members || [];
  const hasCoordinator = members.some((m) => !m.killed && m.role === "coordinator" && Boolean(m.conversation_id));

  const submitVerdict = async () => {
    const note = verdictNote.trim();
    if (verdictLockRef.current || !swarmConvId || !note || hasControlChars(note) || note.length > 4000) return;
    verdictLockRef.current = true;
    setVerdictSending(true);
    setVerdictError("");
    try {
      await sendSwarmControl({
        op: "gate_verdict",
        conversationId: swarmConvId,
        verdict: verdictKind,
        seq: gate.pendingSeq || snap.head || 1,
        targetMember: next?.target,
        note,
      });
      toast.success(`Recorded ${verdictKind} verdict`);
      setVerdictOpen(false);
      setVerdictNote("");
      onRefresh?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Verdict failed";
      setVerdictError(msg);
      toast.error(msg);
    } finally {
      verdictLockRef.current = false;
      setVerdictSending(false);
    }
  };

  return (
    <Card className="p-2 space-y-1" data-testid="gate-readiness-card">
      <div className="row flex-wrap t2">
        <div className="wrap gap-1">
          <span className="font-semibold text-ink">Gate readiness</span>
          <Badge tone={tone}>{label}</Badge>
        </div>
        <div className="f1 flex-wrap">
          {next && (
            <Button
              variant="primary"
              data-testid="gate-next-action"
              onClick={() => live ? (setDraft(next.prompt), setOpen((v) => !v)) : void copyText(next.prompt, `Copied gate prompt for @${next.target}`)}
            >
              {live ? <Send /> : <ClipboardCopy />}
              {next.label}
            </Button>
          )}
          {canControl && (
            <Button
              variant={verdictOpen ? "secondary" : "outline"}
              data-testid="gate-verdict-toggle"
              onClick={() => {
                setVerdictOpen((cur) => !cur);
                if (!verdictNote) setVerdictNote(`Operator checked gate #${gate.pendingSeq || snap.head || 1}`);
              }}
            >
              <CheckCircle2 />
              Verdict
            </Button>
          )}
          {gate.pendingSeq > 0 && (
            <Button data-testid="gate-pending-jump" onClick={() => onJump(gate.pendingSeq)} className="bg-board num">
              Gate #{gate.pendingSeq}
              <ArrowUpRight className="h-3 w-3" />
            </Button>
          )}
          {next && (
            <Button variant="ghost" data-testid="gate-target-jump" onClick={() => onJump(next.seq || gate.pendingSeq, next.target)} className="bg-board">
              @{next.target}
              <ArrowUpRight className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
      {v && (
        <div className="row flex-wrap t2" data-testid="wave-velocity-pill">
          <div className="wrap gap-1.5">
            <Badge tone={v.blocked > 0 ? "warning" : "success"} className="num">
              {v.passRatePct}% pass{v.wavesPerHr > 0 ? ` · ${v.wavesPerHr}/hr` : ""}
            </Badge>
            <div className="num text-ink-2 inline-flex items-center divide-x divide-hairline">
              <span className="pr-1.5">{v.done}d</span>
              <span className="px-1.5">{v.verified}v</span>
              <span className="px-1.5">{v.scaleVerified}s</span>
              <span className="pl-1.5">{v.blocked}b</span>
            </div>
          </div>
          {v.shippedSeq > 0 && (
            <Button data-testid="gate-shipped-jump" onClick={() => onJump(v.shippedSeq)} className="bg-board num">
              {v.exactShipped ? "Shipped" : "Latest"} #{v.shippedSeq}
              <ArrowUpRight />
            </Button>
          )}
        </div>
      )}
      <div className="wrap gap-1">
        {gate.stages.map((st) =>
          st.seq > 0 ? (
            <Button
              key={st.key}
              variant={st.key === "blocked" ? "danger" : "info"}
              onClick={() => onJump(st.seq)}
              className="num"
            >
              {st.label} {st.count} · #{st.seq}
            </Button>
          ) : (
            <Badge key={st.key} tone="neutral" className="opacity-55">
              {st.label} 0
            </Badge>
          ),
        )}
      </div>
      {open && next && (
        <InlineComposer
          id="gate-next-nudge"
          label={`@${next.target}${next.seq ? ` · Re #${next.seq}` : ""}`}
          value={draft}
          onChange={setDraft}
          onCancel={() => setOpen(false)}
          onSubmit={async () => {
            if (gateNudgeLockRef.current) return;
            gateNudgeLockRef.current = true;
            try {
              await submitNudge(next.conversationId, draft, `Nudged @${next.target}`, setSending, () => {
                setOpen(false);
                onRefresh?.();
              });
            } finally {
              gateNudgeLockRef.current = false;
            }
          }}
          submitLabel={sending ? "Sending..." : "Confirm & send"}
          disabled={sending}
        />
      )}
      {verdictOpen && (
        <div className="pt-2 border-t border-hairline space-y-2" data-testid="gate-verdict-drawer">
          {members.length > 0 && !hasCoordinator && (
            <p role="alert" className="rounded-chip border border-warn bg-warn-soft px-2 py-1 text-[12px] text-warn" data-testid="gate-missing-coordinator">
              No active coordinator in roster. Verdict delivery may fail.
            </p>
          )}
          {verdictError && (
            <p role="alert" className="rounded-chip border border-danger bg-bad-soft px-2 py-1 text-[12px] text-danger" data-testid="gate-verdict-error">
              {verdictError}
            </p>
          )}
          <div className="wrap gap-1" role="group" aria-label="Gate verdict">
            {(["verified", "blocked", "ship"] as const).map((kind) => (
              <Pill
                key={kind}
                active={verdictKind === kind}
                data-testid={`gate-verdict-kind-${kind}`}
                onClick={() => setVerdictKind(kind)}
              >
                {kind === "verified" ? "[verified]" : kind === "blocked" ? "[blocked]" : "ship"}
              </Pill>
            ))}
          </div>
          <Input
            aria-label="Gate verdict note"
            data-testid="gate-verdict-note"
            maxLength={4000}
            value={verdictNote}
            onChange={(e) => {
              setVerdictNote(e.target.value);
              setVerdictError("");
            }}
            placeholder="Verdict note"
          />
          <div className="row">
            <span className="t3 num">Target #{gate.pendingSeq || snap.head || 1}</span>
            <div className="f1">
              <Button variant="ghost" onClick={() => setVerdictOpen(false)}>Close</Button>
              <Button
                variant={verdictKind === "blocked" ? "danger" : "primary"}
                data-testid="gate-verdict-submit"
                disabled={verdictSending || !verdictNote.trim() || hasControlChars(verdictNote)}
                onClick={submitVerdict}
              >
                <CheckCircle2 />
                {verdictSending ? "Sending..." : "Confirm verdict"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
