// The receipt: the signature of Fleet. A finished session is a measured scan card: corner ticks, the task as the
// headline, mono readings with their units, and "verified by" with the check that passed. A session that needs a
// person carries its reason at the same weight as the headline; a running one shows that it runs.
import { BorderTrail } from "@/components/ui/border-trail";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { diffStat, HONEST, isFailed, isHonest, isVerified, receiptLine, statusText, type Session } from "./api";

function Corners({ size }: { size: number }) {
  const s = `${size}px`;
  const c = "pointer-events-none absolute border-ink-3";
  return (
    <>
      <span aria-hidden className={cn(c, "left-0 top-0 border-l border-t")} style={{ width: s, height: s }} />
      <span aria-hidden className={cn(c, "right-0 top-0 border-r border-t")} style={{ width: s, height: s }} />
      <span aria-hidden className={cn(c, "bottom-0 left-0 border-b border-l")} style={{ width: s, height: s }} />
      <span aria-hidden className={cn(c, "bottom-0 right-0 border-b border-r")} style={{ width: s, height: s }} />
    </>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** One session in a lane. The session shown in the hero is replaced by a one-line "shown above" row. */
export function ReceiptCard({ s, selected, onOpen }: { s: Session; selected: boolean; onOpen: () => void }) {
  const ds = diffStat(s.diff);
  const live = s.bucket === "working" && s.status !== "queued";
  const verified = isVerified(s);
  const honest = isHonest(s);
  const tone = isFailed(s) ? "error" : s.bucket === "needs-you" ? "info" : s.bucket === "done" ? "success" : s.status === "queued" ? "warning" : "secondary";
  return (
    <button
      type="button"
      onClick={onOpen}
      data-sid={s.id}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "relative block w-full min-w-0 cursor-pointer overflow-hidden rounded-card border border-hairline p-4 text-left outline-none transition-colors duration-(--dur-press) ease-(--ease-house) focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "bg-raised" : "bg-canvas hover:bg-raised",
      )}
    >
      <Corners size={10} />
      {live && <BorderTrail className="bg-ink" size={120} />}
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-xs text-ink-3">{s.project}</span>
        <Badge variant={tone} size="sm" className="ml-auto shrink-0">{verified ? "verified" : statusText(s)}</Badge>
      </div>
      <p className="mt-2.5 line-clamp-2 font-heading text-base font-light leading-snug text-ink">{s.task}</p>

      {s.bucket === "needs-you" && s.reason && (
        <p className={cn("mt-2 line-clamp-2 font-heading text-base font-light leading-snug", isFailed(s) ? "text-destructive-foreground" : "text-info-foreground")}>{s.reason}</p>
      )}
      {honest && <p className="mt-1.5 text-sm text-pill-warn-fg">{HONEST}</p>}
      {s.status === "checking" && <p className="mt-2 text-sm text-ink-2">The agent finished. Running your check.</p>}
      {live && <TextShimmer className="mt-2 text-sm font-medium" duration={2.4}>Agent running</TextShimmer>}

      {s.bucket === "done" && (
        <>
          <p className="mt-2.5 truncate border-l-2 border-dot-green pl-2 font-mono text-sm tabular-nums text-ink">{receiptLine(s)}</p>
          <div className="mt-2 flex flex-wrap gap-x-4 font-mono text-xs tabular-nums text-ink-2">
            <span>{plural(ds.files, "file")}</span>
            <span>+{ds.add}</span>
            <span>−{ds.del}</span>
          </div>
        </>
      )}
      {(s.steer || []).length > 0 && (
        <p className="mt-2 text-sm text-pill-warn-fg">{plural(s.steer!.length, "steering message")} waiting</p>
      )}

      <div className="mt-3 flex min-w-0 items-center gap-2 border-t border-hairline pt-2.5">
        {!s.test_mode && <Badge variant="outline" size="sm" className="shrink-0">{s.engine || s.agent || "agent"}</Badge>}
        <span className="ml-auto min-w-0 truncate font-mono text-xs text-ink-3">{s.branch || ""}</span>
      </div>
    </button>
  );
}

/** A lane row that stands in for the session already drawn in the hero. */
export function ShownAbove({ s, onOpen }: { s: Session; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="flex min-w-0 items-center gap-2 rounded-card px-1 py-1.5 text-left text-sm text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring">
      <span className="min-w-0 truncate">{s.task}</span>
      <span className="ml-auto shrink-0 font-mono text-xs text-ink-3">shown above</span>
    </button>
  );
}

/**
 * The first screen's object, capped: the top session that needs a person, or else the newest verified receipt.
 * Desktop: a capped block (headline two lines, the one action as keys). Phone: one receipt row.
 */
export function HeroReceipt({
  s, onOpen, onRetry, onDismiss,
}: {
  s: Session;
  onOpen: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const needs = s.bucket === "needs-you";
  const ds = diffStat(s.diff);
  const label = needs ? "Needs you now" : "Latest receipt";
  return (
    <section aria-label={label} className="relative min-w-0 border-b border-hairline bg-surface">
      {/* Phone: one receipt row */}
      <div className="flex min-w-0 items-center gap-3 p-3 md:hidden">
        <div className="min-w-0 flex-1">
          <p className={cn("font-mono text-xs", needs ? (isFailed(s) ? "text-destructive-foreground" : "text-info-foreground") : "text-ink-3")}>{label}</p>
          <p className="truncate font-heading text-base font-light text-ink">{s.task}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => onOpen(s.id)}>Open</Button>
      </div>

      {/* Desktop: the capped receipt */}
      <div className="relative hidden max-h-[260px] min-w-0 overflow-hidden p-6 md:flex md:flex-col">
        <Corners size={14} />
        <p className={cn("font-mono text-xs", needs ? (isFailed(s) ? "text-destructive-foreground" : "text-info-foreground") : "text-ink-3")}>{label} · {s.project}</p>
        <h2 className="mt-2 line-clamp-2 font-heading text-[32px] font-light leading-[1.1] tracking-[-0.035em] text-ink">{s.task}</h2>
        {needs ? (
          <p className={cn("mt-2 line-clamp-2 font-heading text-[20px] font-light leading-snug", isFailed(s) ? "text-destructive-foreground" : "text-info-foreground")}>{s.reason || "needs you"}</p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 font-mono tabular-nums">
            <div className="border-l-2 border-dot-green pl-3"><div className="text-xs text-ink-3">check</div><div className="text-sm text-ink">passed</div></div>
            <div><div className="text-xs text-ink-3">changed</div><div className="text-sm text-ink">{plural(ds.files, "file")}</div></div>
            <div><div className="text-xs text-ink-3">lines</div><div className="text-sm text-ink">+{ds.add} −{ds.del}</div></div>
            <div className="min-w-0"><div className="text-xs text-ink-3">verified by</div><div className="truncate text-sm text-ink">{s.check_cmd || "the project check"}</div></div>
          </div>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
          {needs && <Button size="sm" onClick={() => onRetry(s.id)}>Retry</Button>}
          {needs && <Button size="sm" variant="ghost" onClick={() => onDismiss(s.id)}>Dismiss</Button>}
          <Button size="sm" variant="outline" onClick={() => onOpen(s.id)}>Open {needs ? "" : "receipt"}<span className="font-mono text-xs text-ink-3">↵</span></Button>
        </div>
      </div>
    </section>
  );
}
