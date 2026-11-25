import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--blue)] text-[var(--blue-fg)] border border-transparent hover:bg-[var(--blue-hover)] active:translate-y-px font-medium",
  secondary:
    "bg-[var(--track)] text-[var(--ink)] border border-[var(--hairline-s)] hover:bg-[var(--board)] active:bg-[var(--hairline)] font-medium",
  outline:
    "bg-[var(--surface)] text-[var(--ink)] border border-[var(--input)] hover:bg-[var(--board)] active:bg-[var(--track)] font-medium",
  ghost:
    "bg-transparent text-[var(--ink-2)] border border-transparent hover:bg-[var(--track)] hover:text-[var(--ink)] active:bg-[var(--hairline)] font-medium",
  danger:
    "bg-[var(--bad-soft)] text-[var(--destructive-foreground)] border border-[color-mix(in_oklab,var(--destructive-foreground)_35%,transparent)] hover:bg-[color-mix(in_oklab,var(--destructive-foreground)_14%,transparent)] active:translate-y-px font-medium",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 min-w-8 px-3 text-[13px] rounded-[var(--radius-chip)] max-md:min-h-11 max-md:min-w-11 max-md:px-3.5",
  md: "h-9 min-w-9 px-3.5 text-[14px] rounded-[var(--radius)] max-md:min-h-11 max-md:min-w-11",
  icon: "h-8 w-8 min-w-8 min-h-8 p-0 rounded-[var(--radius-chip)] max-md:h-11 max-md:w-11 max-md:min-h-11 max-md:min-w-11",
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
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer select-none transition",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
        "disabled:bg-[var(--track)] disabled:text-[var(--disabled)] disabled:border-[var(--hairline)] disabled:cursor-not-allowed",
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
} & React.HTMLAttributes<HTMLSpanElement>) {
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

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "w-full min-h-9 rounded-[var(--radius)] border border-[var(--input)] bg-[var(--surface)] px-3 py-1.5 text-[14px] text-[var(--ink)]",
          "placeholder:text-[var(--ink-3)] max-md:min-h-11",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ring)] focus-visible:border-[var(--ring)]",
          "disabled:bg-[var(--track)] disabled:text-[var(--disabled)] disabled:border-[var(--hairline)] disabled:cursor-not-allowed",
          className,
        )}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "w-full min-h-20 rounded-[var(--radius)] border border-[var(--input)] bg-[var(--surface)] px-3 py-2 text-[14px] text-[var(--ink)]",
          "placeholder:text-[var(--ink-3)] max-md:min-h-24",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ring)] focus-visible:border-[var(--ring)]",
          "disabled:bg-[var(--track)] disabled:text-[var(--disabled)] disabled:border-[var(--hairline)] disabled:cursor-not-allowed",
          className,
        )}
        {...props}
      />
    );
  },
);

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center rounded-[var(--radius-chip)] border border-[var(--hairline-s)] bg-[var(--track)] px-1.5 py-0.5 text-[12px] font-medium text-[var(--ink-2)] leading-none",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string; count?: number; testId?: string; ariaLabel?: string }>;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-[var(--radius)] bg-[var(--track)] p-0.5 border border-[var(--hairline)]",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            data-testid={opt.testId}
            aria-label={opt.ariaLabel}
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[var(--radius-segment)] px-2.5 h-8 text-[13px] font-medium cursor-pointer transition active:bg-[var(--board)]",
              "max-md:min-h-11 max-md:px-3",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ring)]",
              active
                ? "bg-[var(--raised)] text-[var(--ink)] border border-[var(--hairline)]"
                : "bg-transparent text-[var(--ink-2)] border border-transparent hover:text-[var(--ink)]",
            )}
          >
            <span>{opt.label}</span>
            {opt.count !== undefined && (
              <span className="num text-[12px] text-[var(--ink-3)]">{opt.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Expandable({
  triggerLabel,
  openLabel,
  defaultOpen = false,
  className,
  children,
}: {
  triggerLabel: string;
  openLabel?: string;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <div className={cn("rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--board)]", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-[13px] font-medium text-[var(--ink-2)] hover:text-[var(--ink)] cursor-pointer max-md:min-h-11 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ring)] rounded-[var(--radius)]"
      >
        <span className="inline-flex items-center gap-1.5">
          {open ? <ChevronDown className="size-4" strokeWidth={1.5} /> : <ChevronRight className="size-4" strokeWidth={1.5} />}
          <span>{open && openLabel ? openLabel : triggerLabel}</span>
        </span>
      </button>
      {open && (
        <div id={contentId} className="px-3 pb-3 pt-1">
          {children}
        </div>
      )}
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  testId,
  maxWidth = "max-w-2xl",
  returnFocusTo,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  testId?: string;
  maxWidth?: string;
  returnFocusTo?: HTMLElement | null;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  const returnFocusRef = useRef(returnFocusTo);
  onCloseRef.current = onClose;
  returnFocusRef.current = returnFocusTo;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      const firstInput = panelRef.current?.querySelector<HTMLElement>(
        'input:not([type="hidden"]), textarea, select, [data-autofocus], button',
      );
      firstInput?.focus();
    }, 20);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey, true);
      const target = returnFocusRef.current ?? prev;
      if (target && target.isConnected) {
        window.setTimeout(() => target.focus(), 0);
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 max-md:p-2"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        style={{ boxShadow: "var(--elev-lift)" }}
        className={cn(
          "w-full rounded-[var(--radius-dialog)] border border-[var(--hairline-s)] bg-[var(--surface)] text-[var(--ink)] flex flex-col max-h-[90dvh]",
          maxWidth,
        )}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--hairline)]">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[17px] font-semibold text-[var(--ink)]">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-[13px] text-[var(--ink-2)]">{description}</p>}
          </div>
          <Button variant="ghost" size="icon" aria-label={`Close ${title}`} onClick={onClose}>
            <X className="size-4" strokeWidth={1.5} />
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  id,
  title,
  closeLabel = "Close panel",
  testId,
  children,
}: {
  open: boolean;
  onClose: () => void;
  id?: string;
  title: string;
  closeLabel?: string;
  testId?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>("button, input, select")?.focus();
    }, 20);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
      if (prev && prev.isConnected) {
        window.setTimeout(() => prev.focus(), 0);
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        style={{ boxShadow: "var(--elev-lift)" }}
        className="w-full max-w-[540px] h-full bg-[var(--surface)] text-[var(--ink)] border-l border-[var(--hairline-s)] flex flex-col"
      >
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-[var(--hairline)]">
          <h2 id={titleId} className="text-[17px] font-semibold text-[var(--ink)]">
            {title}
          </h2>
          <Button variant="ghost" size="icon" aria-label={closeLabel} onClick={onClose}>
            <X className="size-4" strokeWidth={1.5} />
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function StatusDot({
  tone,
  pulse,
}: {
  tone: "green" | "blue" | "red" | "amber" | "muted";
  pulse?: boolean;
}) {
  const colors = {
    green: "bg-[var(--dot-green)]",
    blue: "bg-[var(--dot-blue)]",
    red: "bg-[var(--dot-red)]",
    amber: "bg-[var(--dot-amber)]",
    muted: "bg-[var(--ink-3)]",
  }[tone];
  return (
    <span className="relative inline-flex size-2.5 shrink-0 items-center justify-center" aria-hidden="true">
      {pulse && <span className={cn("absolute inset-0 rounded-full opacity-35", colors)} />}
      <span className={cn("relative size-2 rounded-full", colors)} />
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-4 rounded-full border-2 border-current border-t-transparent animate-spin",
        className,
      )}
    />
  );
}

type ToastItem = { id: number; kind: "info" | "success" | "warning" | "error"; text: string };
let nextToastId = 1;
const toastListeners = new Set<(items: ToastItem[]) => void>();
let toastQueue: ToastItem[] = [];

function pushToast(kind: ToastItem["kind"], text: string) {
  const item: ToastItem = { id: nextToastId++, kind, text };
  toastQueue = [...toastQueue.slice(-3), item];
  for (const fn of toastListeners) fn(toastQueue);
  window.setTimeout(() => {
    toastQueue = toastQueue.filter((t) => t.id !== item.id);
    for (const fn of toastListeners) fn(toastQueue);
  }, 4200);
}

export const toast = Object.assign((text: string) => pushToast("info", text), {
  info: (text: string) => pushToast("info", text),
  success: (text: string) => pushToast("success", text),
  warning: (text: string) => pushToast("warning", text),
  error: (text: string) => pushToast("error", text),
});

export function ToastRegion() {
  const [items, setItems] = useState<ToastItem[]>(toastQueue);
  useEffect(() => {
    toastListeners.add(setItems);
    return () => {
      toastListeners.delete(setItems);
    };
  }, []);
  if (items.length === 0) return null;
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="fixed bottom-10 right-4 z-[70] flex flex-col gap-2 max-w-sm pointer-events-none max-md:right-2 max-md:left-2 max-md:max-w-none"
    >
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          style={{ boxShadow: "var(--elev-lift)" }}
          className={cn(
            "pointer-events-auto flex items-center justify-between gap-3 rounded-[var(--radius)] border px-3.5 py-2.5 text-[13px] font-medium bg-[var(--surface)] text-[var(--ink)]",
            t.kind === "error"
              ? "border-[var(--destructive-foreground)] text-[var(--destructive-foreground)]"
              : t.kind === "warning"
                ? "border-[var(--warning-foreground)] text-[var(--warning-foreground)]"
                : t.kind === "success"
                  ? "border-[var(--success-foreground)]"
                  : "border-[var(--hairline-s)]",
          )}
        >
          <span>{t.text}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => {
              toastQueue = toastQueue.filter((x) => x.id !== t.id);
              for (const fn of toastListeners) fn(toastQueue);
            }}
            className="inline-flex size-8 items-center justify-center rounded-[var(--radius-chip)] text-[var(--ink-3)] hover:text-[var(--ink)] active:bg-[var(--track)] cursor-pointer max-md:min-h-11 max-md:min-w-11"
          >
            <X className="size-3.5" strokeWidth={1.5} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function PopoverPanel({
  open,
  onClose,
  trigger,
  align = "end",
  side = "bottom",
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  align?: "start" | "end";
  side?: "top" | "bottom";
  className?: string;
  children: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div ref={wrapRef} className="relative inline-flex">
      {trigger}
      {open && (
        <div
          style={{ boxShadow: "var(--elev-lift)" }}
          className={cn(
            "absolute z-40 rounded-[var(--radius-menu)] border border-[var(--hairline-s)] bg-[var(--surface)] p-2 text-[var(--ink)]",
            side === "top" ? "bottom-full mb-2" : "top-full mt-2",
            align === "start" ? "left-0" : "right-0",
            className,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}
