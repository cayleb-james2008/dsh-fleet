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
import { ArrowUpRight, ClipboardCopy, FileCode2, Image as ImageIcon, Pin, PinOff, Send, X } from "./icons";
import { openFileInAuxPane, parseScreenshotLines, sendConfirmedNudge } from "./sidecar";
import type { BoardMessage, SwarmMember, SwarmSnapshot, TriageItem, WorktreesPayload } from "./types";

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
    `# ${title} — Board (${tags})`,
    `- Swarm: ${snap.id} | Showing: ${messages.length} | Head: #${snap.head || 0}`,
    "",
    ...messages.map((m) => `- **#${m.seq}**${m.time ? ` \`${m.time}\`` : ""} **@${m.agent}**: ${cleanDigestLine(m.text, 400)}`),
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

export const maskHome = (s: string): string => s.replace(/\/home\/[^/\s]+\//g, "~/");
const cleanDigestLine = (s: string, max = 140) => maskHome(s).replace(/\s+/g, " ").trim().slice(0, max);

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
  const lines = [
    `# ${snap.title || "Fleet"}`,
    `- ${cnt("working")} working, ${cnt("waiting")} waiting, ${members.length} members, #${snap.head || 0}, ${fmtTokens(snap.usage?.totalTokens)} tok`,
    snap.plan?.goal && `- Goal: ${snap.plan.goal}`,
    snap.plan?.gate && `- Gate: \`${snap.plan.gate}\``,
  ].filter(Boolean) as string[];
  const sec = (title: string, rows: string[]) => rows.length && lines.push("", `## ${title}`, ...rows);
  const pinSet = new Set(pinnedSeqs);
  sec("Pinned", (snap.messages || []).filter((m) => !m.control && pinSet.has(m.seq)).map((pm) => `- #${pm.seq} @${pm.agent}: ${cleanDigestLine(pm.text)}`));
  sec("Workers", live.map((m) => {
    const ts = memberLastTs(m);
    return `- @${m.name}: ${m.status}${ts ? ` ${fmtElapsed(ts)}` : ""} (${m.steps} steps, ${fmtTokens(m.usage.totalTokens)} tok)`;
  }));
  sec("Workstreams", (snap.plan?.workstreams || []).map((ws) => `- [${humanizeStatus(ws.status)}] ${ws.title}${ws.owner ? ` (@${ws.owner})` : ""}`));
  sec("Needs you", (snap.triage || []).map((it) => `- **${it.title}**: ${maskHome(it.detail)}`));
  sec("Deliverables", (snap.messages || []).filter((m) => !m.control && /\[(done|verified|blocked)\]/i.test(m.text)).slice(-5).map((m) => `- #${m.seq} @${m.agent}: ${cleanDigestLine(m.text)}`));
  sec("Worktrees", (worktrees?.worktrees || []).filter((w) => !w.clean && w.files?.length).map((wt) => `- \`${wt.branch}\` (${maskHome(wt.path)}): ${wt.files!.slice(0, 8).map((f) => `${f.state} ${f.path}`).join(", ")}`));
  return lines.join("\n");
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

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("inp h-8 rounded-chip px-2", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
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
    const el = panelRef.current;
    if (el && typeof el.animate === "function" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      el.animate([{ opacity: 0, transform: "translateY(6px) scale(0.98)" }, { opacity: 1, transform: "none" }], {
        duration: 220,
        easing: "cubic-bezier(0.23,1,0.32,1)",
        fill: "both",
      });
    }
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
      <div className="flex flex-wrap items-center justify-between gap-2">
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
        <div className="flex flex-wrap items-center justify-between gap-2 text-ink-2 num">
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

export function GateReadinessCard({ snap, onJump }: { snap: SwarmSnapshot; onJump: (seq: number) => void }) {
  const gate = snap.gateReadiness;
  if (!gate) return null;
  const tone = gate.state === "blocked" ? "danger" : gate.state === "ready" ? "success" : "info";
  const label = gate.state === "blocked" ? "Blocked" : gate.state === "ready" ? "Ready" : "Verifying";

  return (
    <Card className="p-2 space-y-1" data-testid="gate-readiness-card">
      <div className="row flex-wrap t2">
        <div className="wrap gap-1">
          <span className="font-semibold text-ink">Gate readiness</span>
          <Badge tone={tone}>{label}</Badge>
        </div>
        {gate.pendingSeq > 0 && (
          <Button data-testid="gate-pending-jump" onClick={() => onJump(gate.pendingSeq)} className="bg-board num">
            Gate #{gate.pendingSeq}
            <ArrowUpRight className="h-3 w-3" />
          </Button>
        )}
      </div>
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
    </Card>
  );
}
