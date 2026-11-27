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
import { AlertTriangle, ArrowUpRight, CheckCircle2, ChevronDown, ChevronUp, ClipboardCopy, Eye, EyeOff, FileCode2, Image as ImageIcon, Layers, Pin, PinOff, RefreshCw, Send, ShieldAlert, X } from "./icons";
import { animatePanelEnter } from "./motion";
import { fetchMemberTranscript, openFileInAuxPane, parseScreenshotLines, postOpAction, sendConfirmedNudge, sendSwarmControl } from "./sidecar";
import type {
  BoardMessage,
  BurnSummary,
  ControlDispatchResponse,
  CoordinatorDispatchState,
  CostSummary,
  NormalizedPlan,
  OpActionResponse,
  OperatorCommand,
  OperatorOpAction,
  PlanGoalObject,
  PlanMilestoneStatus,
  PlanRisk,
  PlanThread,
  PlanWorkstreamStatus,
  PortfolioResponse,
  PortfolioUrgentItem,
  SwarmMember,
  SwarmPlan,
  SwarmSnapshot,
  SwarmSummary,
  TabId,
  TokenUsage,
  TranscriptFilter,
  TranscriptStep,
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

export function isCoordinatorUnhealthy(state?: CoordinatorDispatchState | string | null): boolean {
  if (!state) return false;
  if (typeof state === "string") {
    const st = state.trim().toLowerCase();
    return Boolean(st && st !== "working" && st !== "waiting");
  }
  if (state.failure) return true;
  const st = String(state.status || "").trim().toLowerCase();
  return Boolean(st && st !== "working" && st !== "waiting");
}

export function formatCoordinatorWarning(state?: CoordinatorDispatchState | string | null): string {
  if (!state) return "";
  if (typeof state === "string") {
    const st = state.trim();
    return st ? `coordinator ${st}` : "coordinator unavailable";
  }
  if (state.failure) {
    const kind = state.failure.kind || "error";
    const txt = maskHome(state.failure.text || "").trim();
    return txt ? `coordinator ${kind}: ${txt}` : `coordinator ${kind}`;
  }
  const st = String(state.status || "").trim();
  return st ? `coordinator ${st}` : "coordinator unavailable";
}

export function notifyDispatch(res: ControlDispatchResponse | undefined, fallbackLabel: string): void {
  const opId = res?.opId ? String(res.opId).trim() : "";
  const base = opId
    ? `Dispatched ${opId} (awaiting coordinator)`
    : `Dispatched ${fallbackLabel} (awaiting coordinator)`;
  if (isCoordinatorUnhealthy(res?.coordinatorState)) {
    toast.error(`${base}: warning (${formatCoordinatorWarning(res?.coordinatorState)})`);
    return;
  }
  toast.message(base);
}

export function toDispatchedOp(
  res: ControlDispatchResponse | undefined,
  op: string,
  target?: string,
): OperatorCommand | null {
  const opId = res?.opId ? String(res.opId).trim() : "";
  if (!opId) return null;
  const now = Date.now();
  return {
    opId,
    op,
    ...(target ? { target } : {}),
    status: "dispatched",
    createdAt: now,
    updatedAt: now,
    ...(res?.coordinatorId ? { coordinatorId: res.coordinatorId } : {}),
  };
}

export async function submitNudge(
  target: string | string[],
  text: string,
  okMsg: string,
  setSending: (b: boolean) => void,
  onDone: (res?: ControlDispatchResponse) => void,
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
    const res = await sendConfirmedNudge(target, msg);
    notifyDispatch(res, okMsg);
    onDone(res);
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

export function safeFiniteNonNeg(val: unknown, fallback = 0): number {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function safePct(val: unknown): number {
  const n = Number(val);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
}

function finiteOptNonNeg(val: unknown): number | undefined {
  if (typeof val !== "number") return undefined;
  return Number.isFinite(val) && val >= 0 ? val : undefined;
}

function sanitizeUsage(u: TokenUsage | undefined | null): TokenUsage | null {
  if (!u || typeof u !== "object") return null;
  return {
    inputTokens: Math.round(safeFiniteNonNeg(u.inputTokens)),
    cacheReadTokens: Math.round(safeFiniteNonNeg(u.cacheReadTokens)),
    outputTokens: Math.round(safeFiniteNonNeg(u.outputTokens)),
    totalTokens: Math.round(safeFiniteNonNeg(u.totalTokens)),
  };
}

function sanitizeCost(c: CostSummary | undefined | null): CostSummary | null {
  if (!c || typeof c !== "object") return null;
  return {
    totalUsd: safeFiniteNonNeg(c.totalUsd),
    inputUsd: safeFiniteNonNeg(c.inputUsd),
    cacheReadUsd: safeFiniteNonNeg(c.cacheReadUsd),
    outputUsd: safeFiniteNonNeg(c.outputUsd),
    cacheSavingsUsd: safeFiniteNonNeg(c.cacheSavingsUsd),
    cacheHitPct: safePct(c.cacheHitPct),
    pricingKnown: Boolean(c.pricingKnown),
  };
}

function sanitizeContextLimit(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function sanitizeContextPct(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? safePct(v) : null;
}

function sanitizeBurnSummary(b: BurnSummary | undefined | null): BurnSummary | null {
  if (!b || typeof b !== "object") return null;
  const sanitizeWorker = (w: BurnSummary["workers"][number]) => ({
    ...w,
    totalTokens: Math.round(safeFiniteNonNeg(w.totalTokens)),
    sharePct: safePct(w.sharePct),
    ...(w.costUsd !== undefined ? { costUsd: safeFiniteNonNeg(w.costUsd) } : {}),
    ...(w.cacheHitPct !== undefined ? { cacheHitPct: safePct(w.cacheHitPct) } : {}),
    ...(w.cacheSavingsUsd !== undefined ? { cacheSavingsUsd: safeFiniteNonNeg(w.cacheSavingsUsd) } : {}),
  });
  return {
    ...b,
    totalTokens: Math.round(safeFiniteNonNeg(b.totalTokens)),
    highBurnCount: Math.round(safeFiniteNonNeg(b.highBurnCount)),
    topWorker: b.topWorker ? sanitizeWorker(b.topWorker) : null,
    workers: Array.isArray(b.workers) ? b.workers.map(sanitizeWorker) : [],
    ...(b.costUsd !== undefined ? { costUsd: safeFiniteNonNeg(b.costUsd) } : {}),
    ...(b.cacheHitPct !== undefined ? { cacheHitPct: safePct(b.cacheHitPct) } : {}),
    ...(b.cacheSavingsUsd !== undefined ? { cacheSavingsUsd: safeFiniteNonNeg(b.cacheSavingsUsd) } : {}),
  };
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
  const b = snap.burnSummary;
  const totalUsd = finiteOptNonNeg(snap.cost?.totalUsd) ?? finiteOptNonNeg(b?.costUsd);
  const pricingKnown = snap.cost?.pricingKnown ?? b?.pricingKnown;
  const rawHit = typeof snap.cost?.cacheHitPct === "number" ? snap.cost.cacheHitPct : b?.cacheHitPct;
  const cacheHitPct = typeof rawHit === "number" && Number.isFinite(rawHit) && rawHit > 0 ? safePct(rawHit) : 0;
  const cacheSavingsUsd = finiteOptNonNeg(snap.cost?.cacheSavingsUsd) ?? finiteOptNonNeg(b?.cacheSavingsUsd);
  const spendSummary = pricingKnown && totalUsd !== undefined
    ? `, ${fmtUsd(totalUsd)} spend${cacheHitPct > 0 ? `, ${cacheHitPct}% cache hit` : ""}${cacheSavingsUsd !== undefined && cacheSavingsUsd >= 0.005 ? ` (${fmtUsd(cacheSavingsUsd)} saved)` : ""}`
    : pricingKnown === false
      ? ", Unpriced"
      : "";
  const lines = [
    `# ${maskHome(snap.title || "Fleet")} Handoff Digest`,
    `- Status: ${cnt("working")} working, ${cnt("waiting")} waiting, ${members.length} members, #${snap.head || 0}, ${fmtTokens(snap.usage?.totalTokens)} tok${spendSummary}`,
    plan?.goal && `- Active goal: ${cleanDigestLine(plan.goal, 220)}`,
    plan?.gate && `- Verification gate: \`${maskHome(plan.gate)}\``,
    gate &&
      `- Gate readiness: ${gate.state}${vel ? `, ${safePct(vel.passRatePct)}% pass rate (${safeFiniteNonNeg(vel.wavesPerHr)}/hr, ${safeFiniteNonNeg(vel.done)} done, ${safeFiniteNonNeg(vel.verified)} verified)` : ""}`,
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
      const limit = sanitizeContextLimit(m.contextLimit) || 0;
      const ctxTok = safeFiniteNonNeg(m.lastContextTokens) || safeFiniteNonNeg(m.usage?.inputTokens) + safeFiniteNonNeg(m.usage?.cacheReadTokens);
      const pctVal = sanitizeContextPct(m.contextPct) ?? (limit > 0 ? safePct((ctxTok / limit) * 100) : null);
      const cap =
        limit > 0 && pctVal !== null
          ? `, ${pctVal}% of ${fmtContextCap(limit)} ctx`
          : ctxTok > 0
            ? `, ${fmtTokens(ctxTok)} / unknown ctx`
            : "";
      const mHit = m.cost && typeof m.cost.cacheHitPct === "number" && Number.isFinite(m.cost.cacheHitPct) && m.cost.cacheHitPct > 0
        ? safePct(m.cost.cacheHitPct)
        : 0;
      const spend = m.cost
        ? m.cost.pricingKnown
          ? `, ${fmtUsd(m.cost.totalUsd)}${mHit > 0 ? `, ${mHit}% cache hit` : ""}`
          : ", Unpriced"
        : "";
      return `- @${m.name}: ${m.status}${ts ? ` ${fmtElapsed(ts)}` : ""} (${safeFiniteNonNeg(m.steps)} steps, ${fmtTokens(m.usage?.totalTokens)} tok${cap}${spend}${err})`;
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
          usage: sanitizeUsage(snap.usage),
          contextLimit: sanitizeContextLimit(snap.contextLimit),
          contextPct: sanitizeContextPct(snap.contextPct),
          cost: sanitizeCost(snap.cost),
          byModel: snap.byModel || null,
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
          burnSummary: sanitizeBurnSummary(snap.burnSummary),
          members: (snap.members || []).map((m) => ({
            name: m.name,
            role: m.role,
            model: m.model,
            status: m.status,
            killed: m.killed,
            steps: Math.round(safeFiniteNonNeg(m.steps)),
            unread: Math.round(safeFiniteNonNeg(m.unread)),
            usage: sanitizeUsage(m.usage),
            contextLimit: sanitizeContextLimit(m.contextLimit),
            contextPct: sanitizeContextPct(m.contextPct),
            cost: sanitizeCost(m.cost),
            byModel: m.byModel || null,
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
  const v = Math.round(safeFiniteNonNeg(n, 0));
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

export function fmtUsd(n: number | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "$0.00";
  if (v < 0.001) return "<$0.01";
  if (v < 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

export function fmtContextCap(limit: number | undefined): string {
  const v = Number(limit);
  if (!Number.isFinite(v) || v <= 0) return "unknown";
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(Math.round(v));
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
  if (!b || !Number.isFinite(b.totalTokens) || b.totalTokens <= 0 || !Array.isArray(b.workers) || !b.workers.length) return null;
  const top = b.topWorker || b.workers[0];
  const topPct = safePct(top.sharePct);
  const shown = b.workers.slice(0, 4);
  const restPct = Math.max(0, 100 - shown.reduce((s, r) => s + safePct(r.sharePct), 0));

  const memberCosts = (snap.members || []).filter((m) => m.cost);
  const fallbackTotalUsd = memberCosts.length
    ? memberCosts.reduce((sum, m) => sum + (m.cost?.pricingKnown ? safeFiniteNonNeg(m.cost.totalUsd) : 0), 0)
    : undefined;
  const fallbackSavingsUsd = memberCosts.length
    ? memberCosts.reduce((sum, m) => sum + (m.cost?.pricingKnown ? safeFiniteNonNeg(m.cost.cacheSavingsUsd) : 0), 0)
    : undefined;
  const fallbackKnown = memberCosts.length ? memberCosts.some((m) => m.cost?.pricingKnown) : undefined;
  const totalUsd = finiteOptNonNeg(b.costUsd) ?? finiteOptNonNeg(snap.cost?.totalUsd) ?? fallbackTotalUsd;
  const pricingKnown = b.pricingKnown ?? snap.cost?.pricingKnown ?? fallbackKnown;
  const rawCacheHit = typeof b.cacheHitPct === "number" ? b.cacheHitPct : snap.cost?.cacheHitPct;
  const cacheHitPct = typeof rawCacheHit === "number" && Number.isFinite(rawCacheHit) && rawCacheHit > 0 ? safePct(rawCacheHit) : 0;
  const cacheSavingsUsd = finiteOptNonNeg(b.cacheSavingsUsd) ?? finiteOptNonNeg(snap.cost?.cacheSavingsUsd) ?? fallbackSavingsUsd;
  const topCostVal = finiteOptNonNeg(top.costUsd);
  const topCostText = top.pricingKnown && topCostVal !== undefined ? ` · ${fmtUsd(topCostVal)}` : "";

  const segs = [
    ...shown.map((w, i) => {
      const pct = safePct(w.sharePct);
      const wCost = finiteOptNonNeg(w.costUsd);
      return {
        key: w.name,
        pct,
        cls: BURN_COLS[i % 4],
        title: `@${w.name}: ${w.pricingKnown && wCost !== undefined ? `${fmtUsd(wCost)} · ` : ""}${fmtTokens(w.totalTokens)} (${pct}%)`,
      };
    }),
    ...(restPct > 0 ? [{ key: "rest", pct: restPct, cls: "bg-[var(--edge)]" }] : []),
  ];

  return (
    <Card className="p-2 space-y-1.5" data-testid="token-burn-strip">
      <div className="row flex-wrap gap-1.5 t2">
        <div className="wrap gap-1.5">
          <span className="font-semibold text-ink">Token burn</span>
          {pricingKnown && totalUsd !== undefined ? (
            <span className="font-semibold text-ink tabular-nums" data-testid="burn-total-usd">{fmtUsd(totalUsd)}</span>
          ) : pricingKnown === false ? (
            <span className="text-ink-3" data-testid="burn-total-usd">Unpriced</span>
          ) : null}
          <span className="tabular-nums">{fmtTokens(b.totalTokens)} tok</span>
          {cacheHitPct > 0 && (
            <span className="text-ok tabular-nums" data-testid="burn-cache-hit">
              {cacheHitPct}% cache hit{cacheSavingsUsd !== undefined && cacheSavingsUsd >= 0.005 ? ` (${fmtUsd(cacheSavingsUsd)} saved)` : ""}
            </span>
          )}
        </div>
        {top.level !== "normal" ? (
          <Badge tone={top.level === "critical" ? "danger" : "warning"} data-testid="high-burn-badge">
            High burn · @{top.name} {topPct}%{topCostText}
          </Badge>
        ) : (
          <Badge tone="neutral">Top @{top.name} {topPct}%{topCostText}</Badge>
        )}
      </div>
      <SegBar segments={segs} label={`Token share led by ${top.name} (${topPct}%)`} />
      <div className="wrap gap-x-2 gap-y-1 t2">
        {b.workers.slice(0, 3).map((w, i) => {
          const pct = safePct(w.sharePct);
          const wCost = finiteOptNonNeg(w.costUsd);
          return (
            <span key={w.name} className="inline-flex items-center gap-1">
              <span className={cn("h-2 w-2 rounded-full shrink-0", BURN_COLS[i % 4])} aria-hidden="true" />
              <span className="text-ink font-medium">{w.name}</span>
              <span className="tabular-nums">
                {w.pricingKnown && wCost !== undefined ? `${fmtUsd(wCost)} · ` : ""}
                {fmtTokens(w.totalTokens)} ({pct}%)
              </span>
            </span>
          );
        })}
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

const OP_LABELS: Record<string, string> = {
  board_post: "Board post",
  spawn_worker: "Spawn worker",
  switch_model: "Switch model",
  kill_worker: "Kill worker",
  channel_op: "Channel op",
  gate_verdict: "Gate verdict",
  nudge: "Nudge",
};

function opTimeMs(v?: number | string | null): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

/** Compact operator command queue strip showing pending, verified, and failed dispatches. */
export function OperatorOpsStrip({
  snap,
  onJumpToBoardSeq,
  onRefresh,
  onOpsUpdate,
  onRefreshOps,
}: {
  snap: SwarmSnapshot;
  onJumpToBoardSeq?: (seq: number, agent?: string) => void;
  onRefresh?: () => void;
  onOpsUpdate?: (ops: OperatorCommand[]) => void;
  onRefreshOps?: () => void | Promise<void>;
}) {
  const [busyOpId, setBusyOpId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [showAll, setShowAll] = useState(false);
  const lockRef = useRef<string | null>(null);

  const swarmConvId = snap.swarm || snap.conversationId || "";
  const allOps = Array.isArray(snap.ops) ? snap.ops : [];
  const activeOps = allOps
    .filter((o) => o && o.opId && o.status !== "dismissed")
    .slice()
    .sort((a, b) => (opTimeMs(b.updatedAt) || opTimeMs(b.createdAt)) - (opTimeMs(a.updatedAt) || opTimeMs(a.createdAt)));

  if (activeOps.length === 0) return null;

  const pendingCount = activeOps.filter((o) => o.status === "dispatched").length;
  const issueCount = activeOps.filter((o) => o.status === "failed" || o.status === "timed_out").length;
  const visibleOps = showAll ? activeOps : activeOps.slice(0, 5);

  const runAction = async (op: OperatorCommand, action: OperatorOpAction) => {
    if (!swarmConvId || lockRef.current === op.opId) return;
    lockRef.current = op.opId;
    setBusyOpId(op.opId);
    setActionError("");
    try {
      const res: OpActionResponse = await postOpAction({
        conversationId: swarmConvId,
        opId: op.opId,
        action,
      });
      if (Array.isArray(res.ops)) {
        onOpsUpdate?.(res.ops);
      } else {
        const nextStatus = action === "retry" ? "dispatched" : action === "mark_verified" ? "verified" : "dismissed";
        const nextOp: OperatorCommand = res.op || {
          ...op,
          status: nextStatus,
          updatedAt: Date.now(),
          ...(action === "retry" || action === "mark_verified" ? { error: undefined } : {}),
        };
        onOpsUpdate?.(allOps.map((item) => (item.opId === op.opId ? nextOp : item)));
      }
      if (action === "retry") {
        toast.message(`Retried ${op.opId} (awaiting coordinator)`);
      } else if (action === "mark_verified") {
        toast.success(`Marked ${op.opId} verified`);
      } else {
        toast.message(`Dismissed ${op.opId}`);
      }
      onRefresh?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Op action failed";
      setActionError(msg);
      toast.error(msg);
    } finally {
      lockRef.current = null;
      setBusyOpId(null);
    }
  };

  return (
    <Card className="p-2 space-y-1.5 min-w-0" data-testid="operator-ops-strip">
      <div className="row flex-wrap gap-1.5 t2 min-w-0">
        <div className="wrap gap-1.5 min-w-0">
          <span className="font-semibold text-ink">Command queue</span>
          {pendingCount > 0 && <Badge tone="info">{pendingCount} pending</Badge>}
          {issueCount > 0 && <Badge tone="danger">{issueCount} issue</Badge>}
          {pendingCount === 0 && issueCount === 0 && <Badge tone="neutral">{activeOps.length}</Badge>}
        </div>
        {onRefreshOps && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh command queue"
            data-testid="ops-refresh-btn"
            onClick={() => void onRefreshOps()}
            className="h-7 w-7 min-w-7 min-h-7"
          >
            <RefreshCw />
          </Button>
        )}
      </div>

      {actionError && (
        <p role="alert" className="rounded-chip border border-danger bg-bad-soft px-2 py-1 text-[12px] text-danger break-words">
          {maskHome(actionError)}
        </p>
      )}

      <div className="space-y-1.5 min-w-0">
        {visibleOps.map((op) => {
          const isPending = op.status === "dispatched";
          const isVerified = op.status === "verified";
          const isFailed = op.status === "failed";
          const isTimedOut = op.status === "timed_out";
          const isIssue = isFailed || isTimedOut;
          const busy = busyOpId === op.opId;
          const opLabel = OP_LABELS[op.op] || humanizeStatus(op.op);

          return (
            <div
              key={op.opId}
              data-testid={`op-row-${op.opId}`}
              data-op-status={op.status}
              className={cn(
                "rounded-chip border px-2 py-1.5 space-y-1 min-w-0",
                isIssue ? "border-danger bg-bad-soft" : "border-hairline bg-board",
              )}
            >
              <div className="row flex-wrap gap-1.5 min-w-0">
                <div className="wrap gap-1.5 min-w-0">
                  {isPending && (
                    <RefreshCw
                      className="h-3.5 w-3.5 text-info motion-safe:animate-spin shrink-0"
                      aria-hidden="true"
                      data-testid={`op-spinner-${op.opId}`}
                    />
                  )}
                  {isVerified && <CheckCircle2 className="h-3.5 w-3.5 text-ok shrink-0" aria-hidden="true" />}
                  {isIssue && (
                    <AlertTriangle
                      className={cn("h-3.5 w-3.5 shrink-0", isFailed ? "text-danger" : "text-warn")}
                      aria-hidden="true"
                    />
                  )}
                  <Badge
                    tone={isVerified ? "success" : isPending ? "info" : isFailed ? "danger" : "warning"}
                    data-testid={`op-status-${op.opId}`}
                  >
                    {isPending ? "Pending" : isVerified ? "Verified" : isFailed ? "Failed" : "Timed out"}
                  </Badge>
                  <span className="text-[12px] font-medium text-ink truncate">{opLabel}</span>
                  {op.target && <span className="text-[12px] text-ink-2 truncate max-w-full">@{op.target}</span>}
                  <span className="t3 mono truncate max-w-[110px]" title={op.opId}>{op.opId}</span>
                </div>

                {op.resolvedSeq != null && op.resolvedSeq > 0 && onJumpToBoardSeq ? (
                  <Button
                    variant="ghost"
                    data-testid={`op-seq-${op.opId}`}
                    onClick={() => onJumpToBoardSeq(op.resolvedSeq!)}
                    className="h-7 px-2 bg-surface num text-info shrink-0"
                  >
                    #{op.resolvedSeq}
                    <ArrowUpRight className="h-3 w-3" />
                  </Button>
                ) : null}
              </div>

              {isIssue && (
                <p role="alert" data-testid={`op-error-${op.opId}`} className="text-[12px] text-danger break-words">
                  {maskHome(op.error || (isTimedOut ? "Timed out waiting for coordinator confirmation." : "Command execution failed."))}
                </p>
              )}

              <div className="wrap gap-1 pt-0.5">
                {isIssue && (
                  <Button
                    variant="info"
                    data-testid={`op-retry-${op.opId}`}
                    disabled={busy}
                    onClick={() => void runAction(op, "retry")}
                    className="h-7 px-2"
                  >
                    <RefreshCw />
                    Retry
                  </Button>
                )}
                {!isVerified && (
                  <Button
                    variant="outline"
                    data-testid={`op-verify-${op.opId}`}
                    disabled={busy}
                    onClick={() => void runAction(op, "mark_verified")}
                    className="h-7 px-2"
                  >
                    <CheckCircle2 />
                    Mark Verified
                  </Button>
                )}
                <Button
                  variant="ghost"
                  data-testid={`op-dismiss-${op.opId}`}
                  disabled={busy}
                  onClick={() => void runAction(op, "dismiss")}
                  className="h-7 px-2"
                >
                  <X />
                  Dismiss
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {activeOps.length > 5 && (
        <Button variant="ghost" onClick={() => setShowAll((v) => !v)} className="h-7 px-2 w-full">
          {showAll ? "Show recent 5" : `Show all ${activeOps.length} commands`}
        </Button>
      )}
    </Card>
  );
}

export function GateReadinessCard({
  snap,
  onJump,
  onRefresh,
  onOpDispatched,
}: {
  snap: SwarmSnapshot;
  onJump: (seq: number, agent?: string) => void;
  onRefresh?: () => void;
  onOpDispatched?: (op: OperatorCommand) => void;
}) {
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
  const coord = members.find((m) => !m.killed && m.role === "coordinator");
  const hasCoordinator = Boolean(coord && coord.conversation_id);
  const coordIssue = !hasCoordinator || Boolean(coord?.failure);

  const submitVerdict = async () => {
    const note = verdictNote.trim();
    if (verdictLockRef.current || !swarmConvId || !note || hasControlChars(note) || note.length > 4000) return;
    verdictLockRef.current = true;
    setVerdictSending(true);
    setVerdictError("");
    try {
      const res = await sendSwarmControl({
        op: "gate_verdict",
        conversationId: swarmConvId,
        verdict: verdictKind,
        seq: gate.pendingSeq || snap.head || 1,
        targetMember: next?.target,
        note,
      });
      notifyDispatch(res, `${verdictKind} verdict`);
      const dispatched = toDispatchedOp(res, "gate_verdict", next?.target);
      if (dispatched) onOpDispatched?.(dispatched);
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
              await submitNudge(next.conversationId, draft, `nudge to @${next.target}`, setSending, (res) => {
                const dispatched = toDispatchedOp(res, "nudge", next.target);
                if (dispatched) onOpDispatched?.(dispatched);
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
          {members.length > 0 && coordIssue && (
            <p role="alert" className="rounded-chip border border-warn bg-warn-soft px-2 py-1 text-[12px] text-warn" data-testid="gate-missing-coordinator">
              {coord?.failure
                ? `Coordinator ${coord.failure.kind}: ${maskHome(coord.failure.text)}. Verdict delivery may fail.`
                : "No active coordinator in roster. Verdict delivery may fail."}
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

export interface TraceTarget {
  member: string;
  conversationId: string;
  model?: string;
  status?: string;
}

function fmtStepDuration(ms?: number | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTraceArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return maskHome(args);
  if (Array.isArray(args) && args.length === 0) return "";
  if (typeof args === "object" && Object.keys(args as Record<string, unknown>).length === 0) return "";
  try {
    return maskHome(JSON.stringify(args, null, 2));
  } catch {
    return maskHome(String(args));
  }
}

/** Expandable forensic step inspector inside ForensicTranscriptDrawer. */
export function StepInspector({
  step,
  expanded,
  onToggle,
}: {
  step: TranscriptStep;
  expanded: boolean;
  onToggle: () => void;
}) {
  const toolCalls = step.toolCalls || [];
  const stepStatusUpper = String(step.status || "").toUpperCase();
  const hasToolErr = toolCalls.some((tc) => {
    const st = String(tc.status || "").toUpperCase();
    return st === "ERROR" || st === "FAILED";
  });
  const isErr = Boolean(step.error) || stepStatusUpper === "ERROR" || stepStatusUpper === "FAILED" || hasToolErr;
  const tone: BadgeTone = isErr
    ? "danger"
    : stepStatusUpper === "DONE" || stepStatusUpper === "OK"
      ? "success"
      : "neutral";
  const durationLabel = fmtStepDuration(step.durationMs);
  const tsNum = typeof step.ts === "number" ? step.ts : step.ts ? Date.parse(String(step.ts)) : 0;
  const tsLabel = Number.isFinite(tsNum) && tsNum > 0 ? fmtClockTime(tsNum) : "";
  const firstTool = toolCalls[0];
  const previewText = step.error
    ? maskHome(step.error)
    : firstTool
      ? `${firstTool.name}${firstTool.summary ? `: ${maskHome(firstTool.summary)}` : ""}`
      : step.content
        ? maskHome(step.content)
        : step.thinking
          ? maskHome(step.thinking)
          : "";

  const typeLabel = humanizeStatus(step.type);
  const badgeLabel = step.status ? humanizeStatus(step.status) : isErr ? "Error" : typeLabel;

  return (
    <div
      data-testid={`trace-step-${step.stepIndex}`}
      className={cn("rounded-chip border bg-board min-w-0", isErr ? "border-danger" : "border-hairline")}
    >
      <button
        type="button"
        aria-expanded={expanded}
        data-testid={`trace-step-toggle-${step.stepIndex}`}
        onClick={onToggle}
        className="w-full text-left p-2.5 space-y-1 cursor-pointer hover:bg-track transition rounded-chip min-w-0"
      >
        <div className="row min-w-0">
          <div className="wrap gap-1.5 min-w-0">
            <span className="text-[12px] font-semibold text-ink num">#{step.stepIndex}</span>
            <Badge tone={tone}>{badgeLabel}</Badge>
            {badgeLabel !== typeLabel && <span className="text-[12px] text-ink-2 truncate">{typeLabel}</span>}
          </div>
          <div className="f1 shrink-0 text-[12px] text-ink-3">
            {durationLabel && <span className="num">{durationLabel}</span>}
            {tsLabel && <span className="num">{tsLabel}</span>}
            {expanded ? <ChevronUp /> : <ChevronDown />}
          </div>
        </div>

        {(step.model || step.usage || toolCalls.length > 0) && (
          <div className="wrap gap-2 text-[12px] text-ink-3 min-w-0">
            {step.model && <span className="truncate max-w-full">{step.model}</span>}
            {toolCalls.length > 0 && <span className="num">{toolCalls.length} tools</span>}
            {step.usage && (
              <span className="inline-flex items-center gap-2 num">
                <span>in {fmtTokens(step.usage.inputTokens)}</span>
                <span>cache {fmtTokens(step.usage.cacheReadTokens)}</span>
                <span>out {fmtTokens(step.usage.outputTokens)}</span>
              </span>
            )}
          </div>
        )}

        {previewText && !expanded && (
          <p className={cn("text-[12px] truncate min-w-0", isErr ? "text-danger" : "text-ink-2")}>
            {previewText}
          </p>
        )}
      </button>

      {expanded && (
        <div
          data-testid={`trace-step-body-${step.stepIndex}`}
          className="px-2.5 pb-2.5 pt-2 border-t border-hairline space-y-2 min-w-0"
        >
          {step.error && (
            <div className="space-y-1 min-w-0">
              <div className="row">
                <span className="text-[12px] font-medium text-danger">Error traceback</span>
                <Button
                  variant="ghost"
                  onClick={() => void copyText(maskHome(step.error), "Copied error")}
                  className="h-7 px-2"
                >
                  <ClipboardCopy />
                  Copy
                </Button>
              </div>
              <pre
                data-testid={`trace-step-error-${step.stepIndex}`}
                className="max-h-48 w-full max-w-full overflow-auto rounded-chip border border-danger bg-bad-soft p-2 text-[12px] leading-snug text-danger whitespace-pre-wrap break-words"
              >
                {maskHome(step.error)}
              </pre>
            </div>
          )}

          {step.thinking && (
            <div className="space-y-1 min-w-0">
              <span className="text-[12px] font-medium text-ink-2">Thinking</span>
              <p className="rounded-chip bg-surface px-2 py-1.5 text-[12px] text-ink-2 whitespace-pre-wrap break-words">
                {maskHome(step.thinking)}
              </p>
            </div>
          )}

          {step.content && (
            <div className="space-y-1 min-w-0">
              <span className="text-[12px] font-medium text-ink-2">Response</span>
              <p className="rounded-chip bg-surface px-2 py-1.5 text-[12px] text-ink whitespace-pre-wrap break-words">
                {maskHome(step.content)}
              </p>
            </div>
          )}

          {toolCalls.length > 0 && (
            <div className="space-y-2 min-w-0" data-testid={`trace-step-tools-${step.stepIndex}`}>
              <span className="text-[12px] font-medium text-ink-2">Tool calls ({toolCalls.length})</span>
              {toolCalls.map((tc, tcIdx) => {
                const tcStatus = String(tc.status || "").toUpperCase();
                const tcErr = tcStatus === "ERROR" || tcStatus === "FAILED";
                const argsText = formatTraceArgs(tc.args);
                const outText = tc.outputPreview ? maskHome(tc.outputPreview) : "";
                return (
                  <div
                    key={`${tc.name}-${tcIdx}`}
                    className="rounded-chip border border-hairline bg-surface p-2 space-y-1.5 min-w-0"
                  >
                    <div className="wrap gap-1.5 min-w-0">
                      <code className="text-[12px] font-medium text-ink break-all min-w-0">{tc.name}</code>
                      {tc.status && (
                        <Badge tone={tcErr ? "danger" : tcStatus === "DONE" || tcStatus === "OK" ? "success" : "neutral"}>
                          {humanizeStatus(tc.status)}
                        </Badge>
                      )}
                    </div>
                    {tc.summary && (
                      <p className="text-[12px] text-ink-2 break-words min-w-0">{maskHome(tc.summary)}</p>
                    )}
                    {argsText && (
                      <div className="space-y-1 min-w-0">
                        <span className="text-[12px] font-medium text-ink-3">Arguments</span>
                        <pre
                          data-testid={`trace-tool-args-${step.stepIndex}-${tcIdx}`}
                          className="max-h-40 w-full max-w-full overflow-auto rounded-chip border border-hairline bg-canvas p-2 text-[12px] leading-snug text-ink whitespace-pre-wrap break-words"
                        >
                          {argsText}
                        </pre>
                      </div>
                    )}
                    {outText && (
                      <div className="space-y-1 min-w-0">
                        <span className="text-[12px] font-medium text-ink-3">Output / stderr</span>
                        <pre
                          data-testid={`trace-tool-output-${step.stepIndex}-${tcIdx}`}
                          className={cn(
                            "max-h-48 w-full max-w-full overflow-auto rounded-chip border p-2 text-[12px] leading-snug whitespace-pre-wrap break-words",
                            tcErr ? "border-danger bg-bad-soft text-danger" : "border-hairline bg-canvas text-ink-2",
                          )}
                        >
                          {outText}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const TRACE_FILTERS: Array<{ value: TranscriptFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "errors", label: "Errors" },
  { value: "tools", label: "Tools" },
];

function mergeTraceSteps(prev: TranscriptStep[], incoming: TranscriptStep[]): TranscriptStep[] {
  const byIdx = new Map<number, TranscriptStep>();
  for (const s of prev) {
    if (s && typeof s.stepIndex === "number" && Number.isFinite(s.stepIndex)) byIdx.set(s.stepIndex, s);
  }
  for (const s of incoming) {
    if (s && typeof s.stepIndex === "number" && Number.isFinite(s.stepIndex)) byIdx.set(s.stepIndex, s);
  }
  return [...byIdx.values()].sort((a, b) => b.stepIndex - a.stepIndex);
}

/** Responsive slide-over forensic transcript inspector (380px sidebar + desktop). */
export function ForensicTranscriptDrawer({
  open,
  swarmConversationId,
  target,
  onClose,
}: {
  open: boolean;
  swarmConversationId: string;
  target: TraceTarget | null;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const loadOlderAcRef = useRef<AbortController | null>(null);
  const traceEpochRef = useRef(0);
  const targetKey = target ? `${target.member}\0${target.conversationId}` : "";
  const [prevTargetKey, setPrevTargetKey] = useState(targetKey);
  const [filter, setFilter] = useState<TranscriptFilter>("all");
  if (targetKey !== prevTargetKey) {
    setPrevTargetKey(targetKey);
    if (filter !== "all") setFilter("all");
  }
  const [steps, setSteps] = useState<TranscriptStep[]>([]);
  const [totalSteps, setTotalSteps] = useState(0);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!open || !targetKey) return;
    animatePanelEnter(panelRef.current);
  }, [open, targetKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    traceEpochRef.current += 1;
    loadOlderAcRef.current?.abort();
    loadOlderAcRef.current = null;
    setLoadingMore(false);

    if (!open || !target) {
      setLoading(false);
      setError("");
      return;
    }
    const convId = swarmConversationId || target.conversationId;
    if (!convId || !target.member) {
      setLoading(false);
      return;
    }
    const reqEpoch = traceEpochRef.current;
    const ac = new AbortController();
    setLoading(true);
    setError("");
    setSteps([]);
    setTotalSteps(0);
    setNextBefore(null);
    setHasMore(false);
    setExpanded({});
    fetchMemberTranscript("", {
      conversationId: convId,
      member: target.member,
      limit: 20,
      filter,
      signal: ac.signal,
    })
      .then((res) => {
        if (ac.signal.aborted || traceEpochRef.current !== reqEpoch) return;
        const incoming = Array.isArray(res.steps) ? res.steps : [];
        setSteps(mergeTraceSteps([], incoming));
        setTotalSteps(
          typeof res.totalSteps === "number" && Number.isFinite(res.totalSteps) && res.totalSteps >= 0
            ? res.totalSteps
            : incoming.length,
        );
        setNextBefore(typeof res.nextBefore === "number" && Number.isFinite(res.nextBefore) ? res.nextBefore : null);
        setHasMore(Boolean(res.hasMore));
      })
      .catch((err) => {
        if (ac.signal.aborted || traceEpochRef.current !== reqEpoch) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load transcript");
      })
      .finally(() => {
        if (!ac.signal.aborted && traceEpochRef.current === reqEpoch) setLoading(false);
      });
    return () => {
      traceEpochRef.current += 1;
      ac.abort();
      loadOlderAcRef.current?.abort();
      loadOlderAcRef.current = null;
    };
  }, [open, target?.member, target?.conversationId, swarmConversationId, filter, reloadNonce]);

  const handleLoadOlder = async () => {
    if (!open || !target || loading || loadingMore || !hasMore || nextBefore === null) return;
    const convId = swarmConversationId || target.conversationId;
    if (!convId || !target.member) return;
    loadOlderAcRef.current?.abort();
    const ac = new AbortController();
    loadOlderAcRef.current = ac;
    const reqEpoch = traceEpochRef.current;
    setLoadingMore(true);
    setError("");
    try {
      const res = await fetchMemberTranscript("", {
        conversationId: convId,
        member: target.member,
        before: nextBefore,
        limit: 20,
        filter,
        signal: ac.signal,
      });
      if (ac.signal.aborted || traceEpochRef.current !== reqEpoch) return;
      const incoming = Array.isArray(res.steps) ? res.steps : [];
      setSteps((prev) => mergeTraceSteps(prev, incoming));
      if (typeof res.totalSteps === "number" && Number.isFinite(res.totalSteps) && res.totalSteps >= 0) {
        setTotalSteps(res.totalSteps);
      }
      setNextBefore(typeof res.nextBefore === "number" && Number.isFinite(res.nextBefore) ? res.nextBefore : null);
      setHasMore(Boolean(res.hasMore));
    } catch (err) {
      if (ac.signal.aborted || traceEpochRef.current !== reqEpoch) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to load older steps");
    } finally {
      if (loadOlderAcRef.current === ac) loadOlderAcRef.current = null;
      if (!ac.signal.aborted && traceEpochRef.current === reqEpoch) setLoadingMore(false);
    }
  };

  if (!open || !target) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[var(--scrim)]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="forensic-trace-title"
        data-testid="forensic-trace-drawer"
        className="flex h-full w-full max-w-[380px] sm:max-w-[560px] lg:max-w-[680px] flex-col border-l border-hairline bg-surface shadow-[var(--elev-lift)] min-w-0"
      >
        <div className="p-3 border-b border-hairline space-y-2 shrink-0 min-w-0">
          <div className="row min-w-0">
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="wrap gap-1.5 min-w-0">
                <h2 id="forensic-trace-title" className="h2 truncate">
                  Trace: @{target.member}
                </h2>
                {totalSteps > 0 && <Badge tone="neutral">{totalSteps} steps</Badge>}
              </div>
              {(target.model || target.status) && (
                <div className="wrap gap-2 t3 min-w-0">
                  {target.status && <span>{humanizeStatus(target.status)}</span>}
                  {target.model && <span className="truncate max-w-full">{target.model}</span>}
                </div>
              )}
            </div>
            <div className="f1 shrink-0">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Refresh trace"
                data-testid="trace-refresh-btn"
                onClick={() => setReloadNonce((n) => n + 1)}
              >
                <RefreshCw />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close trace inspector"
                data-testid="trace-close-btn"
                onClick={onClose}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div role="tablist" aria-label="Transcript step filter" className="wrap gap-1.5">
            {TRACE_FILTERS.map((f) => (
              <Pill
                key={f.value}
                role="tab"
                aria-selected={filter === f.value}
                active={filter === f.value}
                data-testid={`trace-filter-${f.value}`}
                onClick={() => setFilter(f.value)}
              >
                {f.label}
              </Pill>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-2 min-w-0">
          {error && (
            <div
              role="alert"
              data-testid="trace-error-banner"
              className="rounded-chip border border-danger bg-bad-soft p-2.5 space-y-2 text-[12px] text-danger min-w-0"
            >
              <div className="flex items-start gap-1.5 min-w-0">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span className="break-words min-w-0">{maskHome(error)}</span>
              </div>
              <Button variant="outline" onClick={() => setReloadNonce((n) => n + 1)}>
                <RefreshCw />
                Retry
              </Button>
            </div>
          )}

          {loading ? (
            <div className="rounded-chip border border-hairline bg-board p-3 text-[13px] text-ink-2" data-testid="trace-loading">
              Loading transcript steps…
            </div>
          ) : steps.length === 0 && !error ? (
            <div className="rounded-chip border border-hairline bg-board p-3 space-y-2 text-[13px] text-ink-2 min-w-0" data-testid="trace-empty">
              <p>{filter === "all" ? "No transcript steps recorded yet." : "No transcript steps match this filter."}</p>
              {filter !== "all" && (
                <Button variant="outline" onClick={() => setFilter("all")}>
                  Show all steps
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-2 min-w-0" data-testid="trace-steps-list">
              {steps.map((step) => (
                <StepInspector
                  key={step.stepIndex}
                  step={step}
                  expanded={Boolean(expanded[step.stepIndex])}
                  onToggle={() => setExpanded((prev) => ({ ...prev, [step.stepIndex]: !prev[step.stepIndex] }))}
                />
              ))}
            </div>
          )}

          {hasMore && nextBefore !== null && (
            <Button
              variant="outline"
              data-testid="trace-load-older"
              disabled={loadingMore}
              onClick={handleLoadOlder}
              className="w-full"
            >
              {loadingMore ? "Loading older steps…" : "Load older steps"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

const GATE_BADGE_TONE: Record<string, { tone: BadgeTone; label: string }> = {
  blocked: { tone: "danger", label: "Gate: Blocked" },
  ready: { tone: "success", label: "Gate: Ready" },
  verifying: { tone: "info", label: "Gate: Verifying" },
};

/** Responsive slide-over Portfolio Command Drawer across active and archived swarms. */
export function PortfolioDrawer({
  open,
  portfolio,
  swarms,
  activeSwarmId,
  loading,
  error,
  onClose,
  onRefresh,
  onSelectSwarm,
  onArchiveSwarm,
}: {
  open: boolean;
  portfolio: PortfolioResponse | null;
  swarms: SwarmSummary[];
  activeSwarmId: string | null;
  loading: boolean;
  error: string;
  onClose: () => void;
  onRefresh: () => void;
  onSelectSwarm: (id: string, tab?: TabId) => void;
  onArchiveSwarm: (id: string, archived: boolean) => Promise<void>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [showArchived, setShowArchived] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    animatePanelEnter(panelRef.current);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const allSwarms = portfolio?.swarms?.length ? portfolio.swarms : swarms;
  const archivedCount = allSwarms.filter((s) => Boolean(s.archived)).length;
  const visibleSwarms = showArchived ? allSwarms : allSwarms.filter((s) => !s.archived);
  const activeCount = portfolio?.activeSwarms ?? allSwarms.filter((s) => !s.archived).length;
  const totalUsd = safeFiniteNonNeg(
    portfolio?.totalCostUsd,
    allSwarms.filter((s) => !s.archived).reduce((sum, s) => sum + safeFiniteNonNeg(s.costUsd), 0),
  );
  const totalTokens = Math.round(
    safeFiniteNonNeg(
      portfolio?.totalTokens,
      allSwarms.filter((s) => !s.archived).reduce((sum, s) => sum + safeFiniteNonNeg(s.totalTokens), 0),
    ),
  );
  const urgentQueue: PortfolioUrgentItem[] = Array.isArray(portfolio?.urgentTriage)
    ? portfolio.urgentTriage
    : [];
  const urgentCount = Math.round(safeFiniteNonNeg(portfolio?.urgentCount, urgentQueue.length));
  const titleById = new Map(allSwarms.map((s) => [s.id, s.title || s.id]));

  const toggleArchive = async (sw: SwarmSummary) => {
    if (archivingId === sw.id) return;
    setArchivingId(sw.id);
    try {
      await onArchiveSwarm(sw.id, !sw.archived);
    } finally {
      setArchivingId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[var(--scrim)]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="portfolio-drawer-title"
        data-testid="portfolio-drawer"
        className="flex h-full w-full max-w-[380px] sm:max-w-[520px] flex-col border-l border-hairline bg-surface shadow-[var(--elev-lift)] min-w-0"
      >
        <div className="p-3 border-b border-hairline row shrink-0 min-w-0">
          <div className="f1 min-w-0">
            <Layers className="h-4 w-4 text-info shrink-0" />
            <h2 id="portfolio-drawer-title" className="h2 truncate">Portfolio command</h2>
          </div>
          <div className="f1 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh portfolio"
              data-testid="portfolio-refresh-btn"
              onClick={onRefresh}
            >
              <RefreshCw className={cn("h-4 w-4", loading && "motion-safe:animate-spin")} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close portfolio"
              data-testid="portfolio-close-btn"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-4 min-w-0">
          {error && (
            <Card className="p-2.5 border-danger bg-bad-soft text-[12px] text-danger break-words" role="alert">
              {maskHome(error)}
            </Card>
          )}

          {/* Aggregated Spend & Health Summary */}
          <Card className="p-3 space-y-2 bg-board" data-testid="portfolio-summary-card">
            <div className="wrap justify-between gap-2">
              <div className="wrap gap-1.5">
                <Badge tone="neutral" data-testid="portfolio-active-swarms">
                  {activeCount} {activeCount === 1 ? "active swarm" : "active swarms"}
                </Badge>
                <Badge tone={urgentCount > 0 ? "danger" : "success"} data-testid="portfolio-urgent-count">
                  {urgentCount} urgent
                </Badge>
              </div>
              <span className="text-[14px] font-semibold text-ink num" data-testid="portfolio-total-usd">
                {fmtUsd(totalUsd)}
              </span>
            </div>
            <div className="row text-[12px] text-ink-2 num">
              <span>Aggregated token spend</span>
              <span>{fmtTokens(totalTokens)} tok</span>
            </div>
          </Card>

          {/* Cross-Swarm Urgent Triage Queue */}
          <section aria-labelledby="portfolio-urgent-heading" className="space-y-2" data-testid="portfolio-urgent-queue">
            <div className="row flex-wrap gap-2">
              <div className="f1">
                <ShieldAlert className={cn("h-3.5 w-3.5", urgentQueue.length > 0 ? "text-danger" : "text-ink-3")} />
                <h3 id="portfolio-urgent-heading" className="h2">Urgent queue ({urgentQueue.length})</h3>
              </div>
            </div>

            {urgentQueue.length === 0 ? (
              <Card className="p-2.5 bg-board text-[12px] text-ink-2">
                No urgent triage items across active swarms.
              </Card>
            ) : (
              <div className="space-y-2">
                {urgentQueue.map((item) => {
                  const targetSwarmId = item.swarmId || item.conversationId;
                  const swLabel = maskHome(item.swarmTitle || titleById.get(targetSwarmId) || targetSwarmId);
                  return (
                    <Card
                      key={`${targetSwarmId}-${item.id}`}
                      data-testid={`portfolio-urgent-item-${item.id}`}
                      className="p-2.5 space-y-1.5 min-w-0"
                    >
                      <div className="wrap gap-1.5">
                        <Badge tone="danger">{humanizeStatus(item.kind)}</Badge>
                        <Badge tone="neutral" className="max-w-full truncate">{swLabel}</Badge>
                        {item.member && <span className="text-[12px] font-medium text-ink-2">@{item.member}</span>}
                        {item.timestamp > 0 && <span className="t3 num ml-auto">{fmtTimeAgo(item.timestamp)}</span>}
                      </div>
                      <p className="text-[13px] font-medium text-ink break-words">{maskHome(item.title)}</p>
                      {item.detail && (
                        <p className="text-[12px] text-ink-2 break-words leading-snug">{maskHome(item.detail)}</p>
                      )}
                      {targetSwarmId && (
                        <div className="pt-0.5">
                          <Button
                            variant="outline"
                            data-testid={`portfolio-jump-urgent-${item.id}`}
                            onClick={() => {
                              onSelectSwarm(targetSwarmId, "triage");
                              onClose();
                            }}
                          >
                            Jump to swarm
                            <ArrowUpRight />
                          </Button>
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
          </section>

          {/* Swarm List + Gate States + Archive Toggle */}
          <section aria-labelledby="portfolio-swarms-heading" className="space-y-2" data-testid="portfolio-swarms-list">
            <div className="row flex-wrap gap-2">
              <h3 id="portfolio-swarms-heading" className="h2">Swarms ({visibleSwarms.length})</h3>
              <Button
                variant={showArchived ? "secondary" : "outline"}
                aria-pressed={showArchived}
                data-testid="portfolio-show-archived"
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived ? <EyeOff /> : <Eye />}
                {showArchived ? "Hide archived" : `Show archived${archivedCount > 0 ? ` (${archivedCount})` : ""}`}
              </Button>
            </div>

            {visibleSwarms.length === 0 ? (
              <Card className="p-2.5 bg-board text-[12px] text-ink-2">
                {archivedCount > 0 ? "All swarms are archived. Show archived to inspect or restore them." : "No swarms found."}
              </Card>
            ) : (
              <div className="space-y-2">
                {visibleSwarms.map((sw) => {
                  const isCurrent = sw.id === activeSwarmId;
                  const gateSpec = sw.gateState ? GATE_BADGE_TONE[String(sw.gateState).toLowerCase()] : undefined;
                  const blockedCnt = Math.round(safeFiniteNonNeg(sw.blockedCount));
                  const failCnt = Math.round(safeFiniteNonNeg(sw.failureCount));
                  const costVal = finiteOptNonNeg(sw.costUsd);
                  const busy = archivingId === sw.id;

                  return (
                    <Card
                      key={sw.id}
                      data-testid={`portfolio-swarm-${sw.id}`}
                      className={cn("p-2.5 space-y-2 min-w-0", isCurrent && "border-blue", sw.archived && "opacity-80")}
                    >
                      <div className="row flex-wrap gap-1.5 min-w-0">
                        <div className="wrap gap-1.5 min-w-0 flex-1">
                          <span className="text-[13px] font-semibold text-ink break-words">
                            {maskHome(sw.title || sw.id)}
                          </span>
                          {isCurrent && <Badge tone="info">Active</Badge>}
                          {sw.archived && <Badge tone="neutral">Archived</Badge>}
                        </div>
                        {gateSpec && (
                          <Badge tone={gateSpec.tone} data-testid={`portfolio-gate-${sw.id}`}>
                            {gateSpec.label}
                          </Badge>
                        )}
                      </div>

                      <div className="wrap gap-x-2.5 gap-y-1 text-[12px] text-ink-2 num">
                        <span>{sw.activeCount}/{sw.memberCount} working</span>
                        <span>#{sw.head}</span>
                        <span>{fmtTokens(sw.totalTokens)} tok</span>
                        {costVal !== undefined && <span className="font-medium text-ink">{fmtUsd(costVal)}</span>}
                        {blockedCnt > 0 && <span className="text-danger">{blockedCnt} blocked</span>}
                        {failCnt > 0 && <span className="text-danger">{failCnt} failed</span>}
                        {sw.triageCount > 0 && <span className="text-warn">{sw.triageCount} triage</span>}
                      </div>

                      {sw.repo && (
                        <p className="t3 mono truncate">{maskHome(sw.repo)}</p>
                      )}

                      {sw.topUrgent && (
                        <p className="rounded-chip bg-bad-soft px-2 py-1 text-[12px] text-danger break-words">
                          {maskHome(sw.topUrgent.title)}
                        </p>
                      )}

                      <div className="wrap gap-1.5">
                        <Button
                          variant={isCurrent ? "secondary" : "primary"}
                          data-testid={`portfolio-open-swarm-${sw.id}`}
                          onClick={() => {
                            onSelectSwarm(sw.id);
                            onClose();
                          }}
                        >
                          Open
                          <ArrowUpRight />
                        </Button>
                        <Button
                          variant="outline"
                          disabled={busy}
                          data-testid={`portfolio-archive-swarm-${sw.id}`}
                          onClick={() => void toggleArchive(sw)}
                        >
                          {sw.archived ? "Unarchive" : "Archive"}
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
