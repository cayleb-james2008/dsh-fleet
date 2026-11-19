// The receipt: the signature of Fleet. A finished session is a measured scan card: corner ticks, the task as the
// headline, mono readings with their units, and the line "verified by" with the check that passed. A session that
// needs a person carries its reason at the same weight as the headline; a running one shows that it runs.
import { BorderTrail } from "@/components/ui/border-trail";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { diffStat, HONEST, isHonest, isVerified, receiptLine, statusText, type Session } from "./api";

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

/** One session as a receipt card in a lane. Needs-you and working cards say so; done cards are the receipt. */
export function ReceiptCard({ s, selected, onOpen }: { s: Session; selected: boolean; onOpen: () => void }) {
  const ds = diffStat(s.diff);
  const live = s.bucket === "working" && s.status !== "queued";
  const verified = isVerified(s);
  const honest = isHonest(s);
  const tone = s.bucket === "needs-you" ? "error" : s.bucket === "done" ? "success" : s.status === "queued" ? "warning" : "secondary";
  return (
    <button
      type="button"
      onClick={onOpen}
      data-sid={s.id}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "relative block w-full min-w-0 cursor-pointer overflow-hidden rounded-card border border-hairline p-4 text-left outline-none transition-colors duration-(--dur-press) ease-(--ease-house) focus-visible:ring-2 focus-visible:ring-blue",
        selected ? "bg-raised" : "bg-canvas hover:bg-raised",
      )}
    >
      <Corners size={10} />
      {live && <BorderTrail className="bg-ink-2" size={90} />}
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-xs text-ink-3">{s.project}</span>
        <Badge variant={tone} size="sm" className="ml-auto shrink-0">{verified ? "verified" : statusText(s)}</Badge>
      </div>
      <p className="mt-2.5 line-clamp-2 font-heading text-base font-light leading-snug text-ink">{s.task}</p>

      {s.bucket === "needs-you" && s.reason && (
        <p className="mt-2 line-clamp-2 font-heading text-base font-light leading-snug text-unread">{s.reason}</p>
      )}
      {honest && <p className="mt-1.5 text-sm text-pill-warn-fg">{HONEST}</p>}
      {s.status === "checking" && <p className="mt-2 text-sm text-ink-2">The agent finished. Running your check.</p>}
      {live && (
        <TextShimmer className="mt-2 text-sm font-medium" duration={2.4}>Agent running</TextShimmer>
      )}

      {s.bucket === "done" && (
        <>
          <p className="mt-2.5 truncate border-l-2 border-blue pl-2 font-mono text-sm tabular-nums text-ink">{receiptLine(s)}</p>
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
        {s.test_mode ? (
          <Badge variant="warning" size="sm" className="shrink-0">test mode</Badge>
        ) : (
          <Badge variant="outline" size="sm" className="shrink-0">{s.engine || s.agent || "agent"}</Badge>
        )}
        <span className="ml-auto min-w-0 truncate font-mono text-xs text-ink-3">{s.branch || ""}</span>
      </div>
    </button>
  );
}

/** The newest receipt, drawn large: the first screen's object. Empty, it still says what belongs here. */
export function HeroReceipt({ s, onOpen, newSession }: { s: Session | null; onOpen: (id: string) => void; newSession: React.ReactNode }) {
  if (!s) {
    return (
      <section aria-label="Latest receipt" className="relative min-w-0 rounded-panel border border-hairline bg-surface p-5 md:p-8">
        <Corners size={16} />
        <h2 className="font-heading text-[28px] font-light leading-tight text-ink md:text-[36px]">No receipt yet</h2>
        <p className="mt-3 max-w-prose text-base leading-relaxed text-ink-2">
          A session becomes a receipt when its check passes. Hand out a task and Fleet runs an agent on it in its own git worktree.
        </p>
        <div className="mt-6">{newSession}</div>
      </section>
    );
  }
  const ds = diffStat(s.diff);
  return (
    <section aria-label="Latest receipt" className="relative min-w-0 rounded-panel border border-hairline bg-surface p-5 md:p-8">
      <Corners size={16} />
      <p className="font-mono text-xs text-ink-3">{s.project}</p>
      <h2 className="mt-3 break-words font-heading text-[28px] font-light leading-[1.05] tracking-[-0.035em] text-ink md:text-[44px]">{s.task}</h2>
      <div className="mt-6 flex flex-wrap gap-x-8 gap-y-3 border-t border-hairline pt-5 font-mono tabular-nums">
        <div className="border-l-2 border-blue pl-3"><div className="text-xs text-ink-3">check</div><div className="text-base text-ink">passed</div></div>
        <div><div className="text-xs text-ink-3">changed</div><div className="text-base text-ink">{plural(ds.files, "file")}</div></div>
        <div><div className="text-xs text-ink-3">lines</div><div className="text-base text-ink">+{ds.add} −{ds.del}</div></div>
        <div className="min-w-0"><div className="text-xs text-ink-3">branch</div><div className="truncate text-base text-ink">{s.branch || ""}</div></div>
      </div>
      {s.check_output?.trim() && <p className="mt-5 truncate border-l-2 border-blue pl-2 font-mono text-sm text-ink">{receiptLine(s)}</p>}
      <p className="mt-1 truncate font-mono text-xs text-ink-3">verified by: {s.check_cmd || "the project check"}</p>
      <Button variant="outline" className="mt-6" onClick={() => onOpen(s.id)}>Open receipt</Button>
    </section>
  );
}
