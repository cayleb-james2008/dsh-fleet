// The control room: every session that is running or needs a person is a live pane on one wall, streaming its own
// transcript. Opening a pane pins its full detail large (live transcript, diff, receipt, steering) while the others line
// up compact beside it; work whose check
// passed docks as receipts in the rail below. Everything shown is the session list Fleet serves; nothing is simulated.
import { type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Maximize2, RotateCcw, X } from "lucide-react";
import { BorderTrail } from "@/components/ui/border-trail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { layout } from "@/motion";
import { cn } from "@/lib/utils";
import { HONEST, isFailed, isHonest, isVerified, receiptLine, statusText, type Session } from "./api";

const dotOf = (s: Session) => isVerified(s) ? "bg-dot-green" : isFailed(s) ? "bg-unread" : s.bucket === "needs-you" ? "bg-dot-clay" : s.status === "queued" ? "bg-dot-amber" : "bg-ink-3";
const toneOf = (s: Session) => isFailed(s) ? "error" : s.bucket === "needs-you" ? "info" : s.bucket === "done" ? "success" : s.status === "queued" ? "warning" : "secondary";
const motionLayout = { transition: layout };

/** The transcript's newest lines, like `tail`: each new line pushes the oldest out. The whole transcript is in the detail. */
const TAIL = 5;
function Log({ s }: { s: Session }) {
  const n = s.transcript.length;
  const from = Math.max(0, n - TAIL);
  return (
    <div className="rounded-control bg-board p-3">
      {from > 0 && <p className="mb-1 text-xs text-ink-3">{from} earlier {from === 1 ? "line" : "lines"} in the detail</p>}
      <ol aria-label={`Newest lines of the transcript of ${s.task}`} className="font-mono text-sm leading-relaxed text-ink-2">
        {n === 0 && <li>No output yet.</li>}
        {s.transcript.slice(from).map((l, i) => <li key={from + i} className="break-words">{l}</li>)}
      </ol>
    </div>
  );
}

function Pane({ s, small, onOpen, onRetry, onDismiss }: { s: Session; small?: boolean; onOpen: () => void; onRetry: () => void; onDismiss: () => void }) {
  const running = s.bucket === "working" && s.status !== "queued";
  return (
    <motion.article layout layoutId={"pane-" + s.id} {...motionLayout} aria-label={s.task}
      className="relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-card border border-hairline bg-surface p-4 md:p-5">
      {running && <BorderTrail className="bg-ink" size={120} />}
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dotOf(s))} />
        <Badge variant={toneOf(s)} size="sm" className="shrink-0">{statusText(s)}</Badge>
        <span className="min-w-0 truncate font-mono text-xs text-ink-3">{s.project}{s.branch ? " / " + s.branch : ""}</span>
        <Button variant="ghost" size="icon" className="ml-auto size-11 shrink-0" data-open={s.id} onClick={onOpen} aria-label={"Open " + s.task}>
          <Maximize2 className="size-4" strokeWidth={1.5} aria-hidden />
        </Button>
      </div>
      <h2 className={cn("font-heading font-light tracking-[-0.03em] text-balance text-ink", small ? "text-base leading-snug" : "text-lg leading-snug")}>{s.task}</h2>
      {!small && <Log s={s} />}
      <div className="text-sm">
        {s.bucket === "needs-you" ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className={cn("min-w-0 basis-full text-pretty", isFailed(s) ? "text-destructive-foreground" : "text-info-foreground")}>
              {isHonest(s) ? HONEST : s.reason || "This session stopped and needs you."}
            </p>
            <Button variant="outline" className="min-h-11" onClick={onRetry}><RotateCcw className="size-4" strokeWidth={1.5} aria-hidden />Retry</Button>
            <Button variant="ghost" className="min-h-11" onClick={onDismiss}><X className="size-4" strokeWidth={1.5} aria-hidden />Dismiss</Button>
          </div>
        ) : s.status === "queued" ? (
          <p className="text-ink-2">Waiting for a free slot (number {s.queue_position ?? "?"} in the queue).</p>
        ) : s.status === "checking" ? (
          <p className="text-ink-2">The agent finished. Running the check{s.check_cmd ? <> <span className="font-mono">{s.check_cmd}</span></> : null}.</p>
        ) : (
          <p className="text-ink-2">Running. The check{s.check_cmd ? <> <span className="font-mono">{s.check_cmd}</span></> : null} decides when it is done.</p>
        )}
      </div>
    </motion.article>
  );
}

function Receipt({ s, selected, onOpen }: { s: Session; selected: boolean; onOpen: () => void }) {
  return (
    <motion.button layout layoutId={"receipt-" + s.id} {...motionLayout} type="button" data-open={s.id} onClick={onOpen} aria-current={selected ? "true" : undefined}
      className={cn("inline-flex min-h-11 max-w-full cursor-pointer items-center gap-2 rounded-full border px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-ink bg-raised" : "border-hairline bg-surface hover:bg-raised")}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dotOf(s))} />
      <span className="min-w-0 max-w-[260px] truncate text-ink">{s.task}</span>
      <span className="min-w-0 max-w-[200px] truncate font-mono text-xs text-ink-2">{isVerified(s) ? receiptLine(s) : statusText(s)}</span>
    </motion.button>
  );
}

export function Wall({ sessions, selected, pinWide, detail, onOpen, onRetry, onDismiss }: {
  sessions: Session[] | null; selected: string | null; pinWide: boolean; detail: ReactNode;
  onOpen: (id: string) => void; onRetry: (id: string) => void; onDismiss: (id: string) => void;
}) {
  if (sessions === null) {
    return (
      <div aria-label="Live panes, loading" className="grid gap-3 p-4 sm:grid-cols-2 md:p-6">
        {[0, 1].map((i) => <div key={i} className="h-[280px] rounded-card border border-hairline bg-track/60" />)}
      </div>
    );
  }
  const live = sessions.filter((s) => s.bucket === "needs-you" || s.bucket === "working");
  // Needs you first (it waits on a person), then running, then queued.
  const rank = (s: Session) => (s.bucket === "needs-you" ? 0 : s.status === "queued" ? 2 : 1);
  const pinned = pinWide && selected ? sessions.find((s) => s.id === selected) ?? null : null;
  const wall = live.filter((s) => s.id !== pinned?.id).sort((a, b) => rank(a) - rank(b));
  const docked = sessions.filter((s) => s.bucket === "done");
  const pane = (s: Session) => (
    <Pane key={s.id} s={s} small={!!pinned} onOpen={() => onOpen(s.id)} onRetry={() => onRetry(s.id)} onDismiss={() => onDismiss(s.id)} />
  );
  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <section aria-label="Live panes" className={pinned ? "grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]" : "grid gap-3 sm:grid-cols-2"}>
        {pinned && (
          <motion.div layout layoutId={"pane-" + pinned.id} {...motionLayout} aria-label={"Pinned: " + pinned.task}
            className="relative min-w-0 overflow-hidden rounded-card border border-ink bg-surface p-4 md:p-6">
            {pinned.bucket === "working" && pinned.status !== "queued" && <BorderTrail className="bg-ink" size={120} />}
            {detail}
          </motion.div>
        )}
        <div className={pinned ? "grid min-w-0 content-start gap-3" : "contents"}>
          <AnimatePresence initial={false}>{wall.map((s) => pane(s))}</AnimatePresence>
          {wall.length === 0 && (
            <p className={cn("rounded-card border border-dashed border-hairline p-4 text-sm leading-relaxed text-ink-2", !pinned && "sm:col-span-2")}>
              {pinned ? "Nothing else is running or waiting on you." : "No agent is running and nothing needs you. Hand out a task with New session; its pane appears here and streams its transcript."}
            </p>
          )}
        </div>
      </section>
      <section aria-labelledby="receipts-h" className="border-t border-hairline pt-3">
        <h2 id="receipts-h" tabIndex={-1} className="mb-2 flex items-baseline gap-2 text-sm font-medium text-ink-2 outline-none">
          Receipts <span className="font-mono text-xs tabular-nums">{docked.length}</span>
        </h2>
        <div className="flex flex-wrap gap-2">
          <AnimatePresence initial={false}>{docked.map((s) => <Receipt key={s.id} s={s} selected={selected === s.id} onOpen={() => onOpen(s.id)} />)}</AnimatePresence>
          {docked.length === 0 && <p className="text-sm text-ink-2">Work docks here once its check passes, with the check's own last line as its receipt.</p>}
        </div>
      </section>
    </div>
  );
}
