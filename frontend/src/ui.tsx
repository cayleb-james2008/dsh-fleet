import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { ClipboardCopy, FileCode2, Image as ImageIcon, Send, X } from "./icons";
import { animatePanelEnter } from "./motion";
import type { SwarmMember, SwarmSnapshot, WorktreesPayload } from "./types";

export async function copyText(text: string, okMsg = "Copied"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okMsg);
  } catch {
    toast.error("Clipboard unavailable");
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

function emitToast(kind: ToastKind, msg: string) {
  const id = nextToastId++;
  toastQueue = [...toastQueue.slice(-2), { id, kind, text: String(msg || "") }];
  for (const fn of toastListeners) fn(toastQueue);
  setTimeout(() => {
    toastQueue = toastQueue.filter((t) => t.id !== id);
    for (const fn of toastListeners) fn(toastQueue);
  }, 3200);
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

export function formatSwarmDigest(
  snap: SwarmSnapshot,
  pinnedSeqs: number[] = [],
  worktrees: WorktreesPayload | null = null,
): string {
  const mask = (s: string) => s.replace(/\/home\/[^/\s]+\//g, "~/");
  const clean = (s: string) => mask(s).replace(/\s+/g, " ").slice(0, 140);
  const members = snap.members || [];
  const live = members.filter((m) => !m.killed);
  const working = live.filter((m) => m.status === "working").length;
  const waiting = live.filter((m) => m.status === "waiting").length;
  const lines = [
    `# ${snap.title || "Fleet Swarm"}`,
    `- Status: ${working} working, ${waiting} waiting, ${members.length} members, #${snap.head || 0} posts, ${fmtTokens(snap.usage?.totalTokens)} tokens`,
    snap.plan?.goal && `- Goal: ${snap.plan.goal}`,
    snap.plan?.gate && `- Gate: \`${snap.plan.gate}\``,
  ].filter(Boolean) as string[];
  const sec = (title: string, rows: string[]) => { if (rows.length) lines.push("", `## ${title}`, ...rows); };
  const pinSet = new Set(pinnedSeqs);
  sec("Pinned", (snap.messages || []).filter((m) => !m.control && pinSet.has(m.seq)).map((pm) => `- #${pm.seq} @${pm.agent}: ${clean(pm.text)}`));
  sec("Workers", live.map((m) => {
    const ts = m.lastStepAt ? Date.parse(m.lastStepAt) : m.transcriptMtime || m.lastPostTs || 0;
    return `- @${m.name}: ${m.status}${ts > 0 ? ` ${fmtElapsed(ts)}` : ""} (${m.steps} steps, ${fmtTokens(m.usage.totalTokens)} tok)`;
  }));
  sec("Workstreams", (snap.plan?.workstreams || []).map((ws) => `- [${humanizeStatus(ws.status)}] ${ws.title}${ws.owner ? ` (@${ws.owner})` : ""}`));
  sec("Needs you", (snap.triage || []).map((it) => `- **${it.title}**: ${mask(it.detail)}`));
  sec("Recent deliverables", (snap.messages || []).filter((m) => !m.control && /\[(done|verified|blocked)\]/i.test(m.text)).slice(-5).map((m) => `- #${m.seq} @${m.agent}: ${clean(m.text)}`));
  sec("Dirty worktrees", (worktrees?.worktrees || []).filter((w) => !w.clean && w.files?.length).map((wt) => `- \`${wt.branch}\` (${mask(wt.path)}): ${wt.files!.slice(0, 8).map((f) => `${f.state} ${f.path}`).join(", ")}`));
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
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--ink-button)] text-[var(--ink-button-fg)] border border-[color-mix(in_oklab,var(--ink-button)_82%,transparent)] shadow-[var(--elev-primary)] hover:opacity-90 font-medium",
  secondary:
    "bg-track text-ink border border-hairline-s hover:bg-board active:bg-hairline font-medium",
  outline:
    "bg-surface text-ink border border-[var(--input)] hover:bg-board active:bg-track font-medium",
  ghost:
    "bg-transparent text-ink-2 border border-transparent hover:bg-track hover:text-ink active:bg-hairline font-medium",
  danger:
    "bg-surface text-danger border border-[color-mix(in_oklab,var(--destructive-foreground)_40%,var(--hairline))] hover:bg-bad-soft font-medium",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 min-w-8 px-2.5 text-[12px] rounded-chip",
  md: "h-9 min-w-9 px-3.5 text-[14px] rounded-[var(--radius)]",
  icon: "h-8 w-8 min-w-8 min-h-8 p-0 rounded-chip",
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
      className={cn(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer select-none transition motion-safe:active:scale-[0.97]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
        "disabled:bg-track disabled:text-[var(--disabled)] disabled:border-hairline disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "violet";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-track text-ink-2 border-hairline",
  info: "bg-blue-soft text-info border-transparent",
  success: "bg-ok-soft text-ok border-transparent",
  warning: "bg-warn-soft text-warn border-transparent",
  danger: "bg-bad-soft text-danger border-transparent",
  violet: "bg-violet-soft text-violet border-transparent",
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
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-chip border px-2 py-0.5 text-[12px] font-medium leading-5 whitespace-nowrap",
        BADGE_TONES[tone],
        className,
      )}
      {...props}
    >
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
  if (state === "waiting") {
    return (
      <span
        aria-hidden="true"
        className={cn("inline-block h-2 w-2 rounded-full border-[1.5px] border-ink-3 shrink-0", className)}
      />
    );
  }
  const color =
    state === "working" || state === "ok"
      ? "bg-[var(--dot-green)]"
      : state === "danger"
        ? "bg-[var(--dot-red)]"
        : state === "warn"
          ? "bg-[var(--dot-amber)]"
          : "bg-[var(--edge)]";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block h-2 w-2 rounded-full shrink-0",
        color,
        state === "working" && "motion-safe:animate-pulse",
        className,
      )}
    />
  );
}

export function Card({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-card border border-hairline bg-surface shadow-[var(--elev-card)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-8 w-full min-w-0 rounded-chip border border-hairline-s bg-surface px-2.5 text-[14px] text-ink placeholder:text-ink-3",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ring)]",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full min-w-0 rounded-card border border-hairline-s bg-surface px-3 py-2 text-[14px] text-ink placeholder:text-ink-3",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ring)]",
        className,
      )}
      {...props}
    />
  );
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
      className="inline-flex rounded-[var(--radius-segment)] border border-hairline bg-track p-0.5"
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
              "relative h-7 px-2.5 text-[12px] font-medium rounded-[4px] cursor-pointer transition",
              active
                ? "bg-[var(--raised)] text-ink shadow-[var(--elev-raised)]"
                : "text-ink-2 hover:text-ink",
            )}
          >
            <span>{opt.label}</span>
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
  const titleId = useId();
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-[440px] max-h-[85vh] overflow-y-auto rounded-[var(--radius-dialog)] border border-hairline bg-surface p-4 shadow-[var(--elev-lift)]"
      >
        <div className="flex items-center justify-between gap-2 pb-3 border-b border-hairline">
          <h2 id={titleId} className="text-[15px] font-semibold text-ink">
            {title}
          </h2>
          <Button variant="ghost" size="icon" aria-label="Close dialog" onClick={onClose}>
            <X className="h-4 w-4" aria-hidden="true" />
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
      className="pointer-events-none fixed bottom-3 right-3 z-50 flex max-w-[340px] flex-col gap-1.5"
    >
      {items.map((item) => (
        <div
          key={item.id}
          role="status"
          className={cn(
            "pointer-events-auto flex items-center justify-between gap-2 rounded-card border px-3 py-2 text-[13px] shadow-[var(--elev-lift)]",
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
            onClick={() => {
              toastQueue = toastQueue.filter((t) => t.id !== item.id);
              for (const fn of toastListeners) fn(toastQueue);
            }}
            className="shrink-0 rounded p-0.5 text-ink-3 hover:text-ink cursor-pointer"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
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
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <label htmlFor={id} className="text-[12px] font-medium text-ink-2">
          {label}
        </label>
        {headerRight}
      </div>
      <Textarea id={id} rows={2} maxLength={4000} value={value} onChange={(e) => onChange(e.target.value)} />
      <div className="flex items-center justify-between gap-2">
        {showCounter ? (
          <span className="text-[12px] text-ink-3 num">{value.length}/4000</span>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={disabled || !value.trim()} onClick={onSubmit}>
            {copyOnly ? <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" /> : <Send className="h-3.5 w-3.5" aria-hidden="true" />}
            <span>{submitLabel}</span>
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
  if (shots.length === 0 && paths.length === 0) return null;
  const chipCls = compact
    ? "inline-flex items-center gap-1 rounded-chip px-2 py-0.5 text-[12px] cursor-pointer max-w-full"
    : undefined;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", compact && "pt-1.5")}>
      {shots.map((s) =>
        compact ? (
          <button
            key={s.path}
            type="button"
            onClick={() => onOpen(s.path, s.caption || s.fileName)}
            className={cn(chipCls, "bg-blue-soft text-info hover:opacity-90")}
          >
            <ImageIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{s.caption || s.fileName}</span>
          </button>
        ) : (
          <Button key={s.path} variant="secondary" size="sm" onClick={() => onOpen(s.path)} className="max-w-full">
            <ImageIcon className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden="true" />
            <span className="truncate">{s.caption || s.fileName}</span>
          </Button>
        ),
      )}
      {paths.map((fp) =>
        compact ? (
          <button
            key={fp}
            type="button"
            onClick={() => onOpen(fp, fp)}
            className={cn(chipCls, "bg-track text-ink-2 hover:text-ink")}
          >
            <FileCode2 className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate mono">{fp.split("/").pop()}</span>
          </button>
        ) : (
          <Button key={fp} variant="secondary" size="sm" onClick={() => onOpen(fp)} className="max-w-full">
            <FileCode2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate mono">{fp.split("/").pop()}</span>
          </Button>
        ),
      )}
    </div>
  );
}

/** Shared worker activity peek drawer (thinking heading + recent tool calls). */
export function ActivityPeek({ member, mode = "roster" }: { member: SwarmMember; mode?: "triage" | "roster" }) {
  const tools = member.recentTools || [];
  return (
    <div className="rounded-chip bg-board px-2.5 py-2 space-y-1.5 text-[12px]">
      {mode === "triage" ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-ink-2 num">
          <span className="font-medium text-ink">{member.steps} steps</span>
          <span>
            {fmtTokens(member.usage.totalTokens)} tok (in {fmtTokens(member.usage.inputTokens)} / cache{" "}
            {fmtTokens(member.usage.cacheReadTokens)} / out {fmtTokens(member.usage.outputTokens)})
          </span>
        </div>
      ) : (
        <p className="font-semibold text-ink">Recent worker activity</p>
      )}
      {member.thinkingHeading && (
        <p className="text-ink-2 truncate">
          {mode === "triage" ? "Thinking" : "Thought"}: {member.thinkingHeading}
        </p>
      )}
      {tools.length > 0 ? (
        <ul
          className={mode === "roster" ? "divide-y divide-hairline" : "space-y-1 text-ink-2"}
          aria-label={mode === "roster" ? `Last tool calls for ${member.name}` : `Recent tool calls for ${member.name}`}
        >
          {tools.map((tc, i) => (
            <li
              key={i}
              className={cn(
                "flex items-center justify-between gap-2",
                mode === "roster" && "py-1 first:pt-0 last:pb-0",
              )}
            >
              <span className={cn("truncate", mode === "roster" && "text-ink")}>{tc.summary}</span>
              <span className="text-ink-3 shrink-0 mono">{tc.name}</span>
            </li>
          ))}
        </ul>
      ) : mode === "roster" ? (
        <p className="text-ink-3">No recent tool calls recorded.</p>
      ) : null}
    </div>
  );
}
