import {
  forwardRef,
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
import { X } from "lucide-react";
import { animatePanelEnter } from "./motion";
import type { SwarmSnapshot } from "./types";

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

export function formatSwarmDigest(snap: SwarmSnapshot): string {
  const members = snap.members || [];
  const working = members.filter((m) => !m.killed && m.status === "working").length;
  const waiting = members.filter((m) => !m.killed && m.status === "waiting").length;
  const lines: string[] = [];
  lines.push(`# ${snap.title || "Fleet Swarm"}`);
  lines.push(
    `- Status: ${working} working, ${waiting} waiting, ${members.length} members, #${snap.head || 0} posts, ${fmtTokens(snap.usage?.totalTokens)} tokens`,
  );
  if (snap.plan?.goal) {
    lines.push(`- Goal: ${snap.plan.goal}`);
  }
  if (snap.plan?.gate) {
    lines.push(`- Gate: \`${snap.plan.gate}\``);
  }
  if (snap.plan?.workstreams?.length) {
    lines.push("", "## Workstreams");
    for (const ws of snap.plan.workstreams) {
      lines.push(`- [${humanizeStatus(ws.status)}] ${ws.title}${ws.owner ? ` (@${ws.owner})` : ""}`);
    }
  }
  if (snap.triage?.length) {
    lines.push("", "## Needs you");
    for (const item of snap.triage) {
      lines.push(`- **${item.title}**: ${item.detail}`);
    }
  }
  const deliverables = (snap.messages || []).filter((m) => !m.control && /\[(done|verified|blocked)\]/i.test(m.text));
  if (deliverables.length) {
    lines.push("", "## Recent deliverables");
    for (const msg of deliverables.slice(-5)) {
      lines.push(`- #${msg.seq} @${msg.agent}: ${msg.text.replace(/\s+/g, " ").slice(0, 140)}`);
    }
  }
  return lines.join("\n");
}

export function fmtTokens(n: number | undefined): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

export function fmtElapsed(ts: number | string | null | undefined, nowMs = Date.now()): string {
  const ms = typeof ts === "number" ? ts : ts ? Date.parse(String(ts)) : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const sec = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (sec < 60) return "<1m";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

export function fmtTimeAgo(ts: number | string | null | undefined): string {
  const ms = typeof ts === "number" ? ts : ts ? Date.parse(String(ts)) : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return "n/a";
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

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
    "bg-[var(--track)] text-[var(--ink)] border border-[var(--hairline-s)] hover:bg-[var(--board)] active:bg-[var(--hairline)] font-medium",
  outline:
    "bg-[var(--surface)] text-[var(--ink)] border border-[var(--input)] hover:bg-[var(--board)] active:bg-[var(--track)] font-medium",
  ghost:
    "bg-transparent text-[var(--ink-2)] border border-transparent hover:bg-[var(--track)] hover:text-[var(--ink)] active:bg-[var(--hairline)] font-medium",
  danger:
    "bg-[var(--surface)] text-[var(--destructive-foreground)] border border-[color-mix(in_oklab,var(--destructive-foreground)_40%,var(--hairline))] hover:bg-[var(--bad-soft)] font-medium",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 min-w-8 px-2.5 text-[12px] rounded-[var(--radius-chip)]",
  md: "h-9 min-w-9 px-3.5 text-[14px] rounded-[var(--radius)]",
  icon: "h-8 w-8 min-w-8 min-h-8 p-0 rounded-[var(--radius-chip)]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "outline", size = "sm", type = "button", className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer select-none transition motion-safe:active:scale-[0.97]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
        "disabled:bg-[var(--track)] disabled:text-[var(--disabled)] disabled:border-[var(--hairline)] disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "violet";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-[var(--track)] text-[var(--ink-2)] border-[var(--hairline)]",
  info: "bg-[var(--blue-soft)] text-[var(--info-foreground)] border-transparent",
  success: "bg-[var(--ok-soft)] text-[var(--success-foreground)] border-transparent",
  warning: "bg-[var(--warn-soft)] text-[var(--warning-foreground)] border-transparent",
  danger: "bg-[var(--bad-soft)] text-[var(--destructive-foreground)] border-transparent",
  violet: "bg-[var(--violet-soft)] text-[var(--violet)] border-transparent",
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
        "inline-flex items-center gap-1.5 rounded-[var(--radius-chip)] border px-2 py-0.5 text-[12px] font-medium leading-5 whitespace-nowrap",
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
        className={cn("inline-block h-2 w-2 rounded-full border-[1.5px] border-[var(--ink-3)] shrink-0", className)}
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
        "rounded-[var(--radius-card)] border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--elev-card)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-8 w-full min-w-0 rounded-[var(--radius-chip)] border border-[var(--hairline-s)] bg-[var(--surface)] px-2.5 text-[14px] text-[var(--ink)] placeholder:text-[var(--ink-3)]",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ring)]",
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "w-full min-w-0 rounded-[var(--radius-card)] border border-[var(--hairline-s)] bg-[var(--surface)] px-3 py-2 text-[14px] text-[var(--ink)] placeholder:text-[var(--ink-3)]",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ring)]",
          className,
        )}
        {...props}
      />
    );
  },
);

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
      className="inline-flex rounded-[var(--radius-segment)] border border-[var(--hairline)] bg-[var(--track)] p-0.5"
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
                ? "bg-[var(--raised)] text-[var(--ink)] shadow-[var(--elev-raised)]"
                : "text-[var(--ink-2)] hover:text-[var(--ink)]",
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
        className="w-full max-w-[440px] max-h-[85vh] overflow-y-auto rounded-[var(--radius-dialog)] border border-[var(--hairline)] bg-[var(--surface)] p-4 shadow-[var(--elev-lift)]"
      >
        <div className="flex items-center justify-between gap-2 pb-3 border-b border-[var(--hairline)]">
          <h2 id={titleId} className="text-[15px] font-semibold text-[var(--ink)]">
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
            "pointer-events-auto flex items-center justify-between gap-2 rounded-[var(--radius-card)] border px-3 py-2 text-[13px] shadow-[var(--elev-lift)]",
            item.kind === "error"
              ? "border-[var(--destructive-foreground)] bg-[var(--bad-soft)] text-[var(--destructive-foreground)]"
              : item.kind === "success"
                ? "border-[var(--success-foreground)] bg-[var(--surface)] text-[var(--ink)]"
                : "border-[var(--hairline)] bg-[var(--surface)] text-[var(--ink)]",
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
            className="shrink-0 rounded p-0.5 text-[var(--ink-3)] hover:text-[var(--ink)] cursor-pointer"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
