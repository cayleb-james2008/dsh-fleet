// Fleet Mission Control: Latest Verified Receipt hero + Three-Lane Board (Needs you · Working · Done).
// Motion layoutId glides sessions across lanes when state changes; BorderTrail + TextShimmer appear strictly on running sessions.
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, FileDiff, GitBranch, GitMerge, RotateCcw, Terminal, X } from "lucide-react";
import { BorderTrail } from "@/components/ui/border-trail";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Pill, PillIndicator } from "@/components/kibo-ui/pill";
import { layout } from "@/motion";
import { cn } from "@/lib/utils";
import { diffStat, HONEST, isFailed, isHonest, isVerified, receiptLine, statusText, type Session, type TabId } from "./api";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function Corners({ size = 8 }: { size?: number }) {
  const s = `${size}px`;
  const c = "pointer-events-none absolute border-ink-3/45";
  return (
    <>
      <span aria-hidden className={cn(c, "left-2 top-2 border-l border-t")} style={{ width: s, height: s }} />
      <span aria-hidden className={cn(c, "right-2 top-2 border-r border-t")} style={{ width: s, height: s }} />
      <span aria-hidden className={cn(c, "bottom-2 left-2 border-b border-l")} style={{ width: s, height: s }} />
      <span aria-hidden className={cn(c, "bottom-2 right-2 border-b border-r")} style={{ width: s, height: s }} />
    </>
  );
}

const TAG_SKINS = [
  "bg-tag-ops-bg text-tag-ops-fg",
  "bg-tag-mint-bg text-tag-mint-fg",
  "bg-tag-research-bg text-tag-research-fg",
  "bg-tag-dev-bg text-tag-dev-fg",
  "bg-tag-plan-bg text-tag-plan-fg",
];

function projectSkin(project: string): string {
  let h = 0;
  for (let i = 0; i < project.length; i++) h = (h * 31 + project.charCodeAt(i)) >>> 0;
  return TAG_SKINS[h % TAG_SKINS.length];
}

export function HeroVerifiedReceipt({
  latest,
  needsTop,
  workingCount,
  totalCount,
  onInspect,
  onMerge,
  onRetry,
}: {
  latest: Session | null;
  needsTop: Session | null;
  workingCount: number;
  totalCount: number;
  onInspect: (id: string, tab?: TabId) => void;
  onMerge: (s: Session) => Promise<void>;
  onRetry: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);

  if (!latest) {
    return (
      <section aria-label="Latest verified receipt" data-answers="3" className="border-b border-hairline bg-surface px-4 py-4 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Pill variant="secondary" className="py-0.5 text-xs">
                <PillIndicator variant={needsTop ? "warning" : "info"} pulse={workingCount > 0} />
                <span>{totalCount === 0 ? "No verified receipt yet" : "Awaiting verified receipt"}</span>
              </Pill>
              {workingCount > 0 && (
                <span className="font-mono text-xs text-ink-2 tabular-nums">{plural(workingCount, "session")} in progress</span>
              )}
            </div>
            <p className="text-sm text-ink-2 [overflow-wrap:anywhere]">
              {totalCount === 0
                ? "Hand out a task with New session. Fleet runs the agent in an isolated git worktree and writes its receipt here only after your check command passes."
                : needsTop
                  ? `No check has passed yet — "${needsTop.task}" is waiting in Needs you.`
                  : "Agents are working in isolated git worktrees. The first session whose check passes lands here with its diff and command receipt."}
            </p>
          </div>
          {needsTop && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => onInspect(needsTop.id, "rc")} className="max-md:min-h-11 max-md:px-4">
                Inspect failure
              </Button>
              <Button size="sm" onClick={() => onRetry(needsTop.id)} className="max-md:min-h-11 max-md:px-4">
                <RotateCcw className="size-4" strokeWidth={1.5} aria-hidden />Retry
              </Button>
            </div>
          )}
        </div>
      </section>
    );
  }

  const ds = diffStat(latest.diff);
  const merged = latest.status === "merged";
  const mergePrompt = latest.merge_target
    ? `Merge ${latest.branch || "this branch"} into ${latest.merge_target}? Fleet refuses if the target is dirty.`
    : `Merge ${latest.branch || "this branch"}? Fleet refuses if the target is dirty.`;

  return (
    <section aria-label="Latest verified receipt" data-answers="3" className="border-b border-hairline bg-surface px-4 py-3 md:px-6 md:py-4">
      <div className="relative rounded-card border border-hairline bg-canvas px-4 py-3.5 md:p-5">
        <Corners size={9} />
        <div className="flex flex-wrap items-center gap-2">
          <Pill variant="success" className="py-0.5 text-xs font-medium">
            <PillIndicator variant="success" />
            <span>{merged ? "Latest receipt · merged" : "Latest verified receipt"}</span>
          </Pill>
          <span className={cn("inline-flex items-center rounded-chip px-2 py-0.5 text-xs font-medium [overflow-wrap:anywhere]", projectSkin(latest.project))}>
            {latest.project}
          </span>
          {latest.branch && (
            <span className="inline-flex min-w-0 items-center gap-1 rounded-chip bg-track px-2 py-0.5 font-mono text-xs text-ink-2">
              <GitBranch className="size-3.5 shrink-0 text-icon" strokeWidth={1.5} aria-hidden />
              <span className="truncate">{latest.branch}</span>
            </span>
          )}
          <span className="ml-auto hidden font-mono text-xs text-ink-3 sm:inline">
            verified by: <span className="text-ink">{latest.check_cmd || "policy check"}</span>
          </span>
        </div>

        <div className="mt-2.5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 flex-1 space-y-2">
            <h2 className="font-heading text-lg font-medium leading-snug text-ink md:text-[23px] [overflow-wrap:anywhere]">
              {latest.task}
            </h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-xs tabular-nums">
              <span className="inline-flex min-w-0 items-center gap-1.5 border-l-2 border-dot-green pl-2.5 text-sm text-ink [overflow-wrap:anywhere]">
                <CheckCircle2 className="size-4 shrink-0 text-success-foreground" strokeWidth={1.5} aria-hidden />
                <span className="truncate">{receiptLine(latest)}</span>
              </span>
              <span className="rounded-chip bg-track px-2 py-0.5 text-ink-2">{plural(ds.files, "file")}</span>
              <span className="rounded-chip bg-diff-add-bg px-2 py-0.5 font-medium text-diff-add-fg">+{ds.add}</span>
              <span className="rounded-chip bg-diff-del-bg px-2 py-0.5 font-medium text-diff-del-fg">−{ds.del}</span>
              <span className="text-ink-3 sm:hidden [overflow-wrap:anywhere]">
                verified by: <span className="text-ink">{latest.check_cmd || "policy check"}</span>
              </span>
            </div>
          </div>

          {!confirming ? (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <Button size="sm" variant="outline" onClick={() => onInspect(latest.id, "rc")} className="max-md:min-h-11 max-md:px-3.5">
                <Terminal className="size-4" strokeWidth={1.5} aria-hidden />Inspect receipt
              </Button>
              <Button size="sm" variant="outline" onClick={() => onInspect(latest.id, "df")} className="max-md:min-h-11 max-md:px-3.5">
                <FileDiff className="size-4" strokeWidth={1.5} aria-hidden />View diff
              </Button>
              {!merged && (
                <Button size="sm" onClick={() => setConfirming(true)} className="max-md:min-h-11 max-md:px-3.5">
                  <GitMerge className="size-4" strokeWidth={1.5} aria-hidden />Merge
                </Button>
              )}
            </div>
          ) : (
            <div role="group" aria-label="Confirm hero merge" className="flex flex-wrap items-center gap-2 rounded-control border border-hairline bg-surface p-2.5">
              <span className="text-xs text-ink-2 [overflow-wrap:anywhere]">{mergePrompt}</span>
              <Button
                size="sm"
                disabled={merging}
                onClick={async () => {
                  setMerging(true);
                  await onMerge(latest);
                  setMerging(false);
                  setConfirming(false);
                }}
                className="max-md:min-h-11 max-md:px-3.5"
              >
                {merging ? "Merging..." : "Merge now"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(false)} className="max-md:min-h-11 max-md:px-3.5">
                Keep it
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const TAIL_LINES = 2;
function RunningTail({ s }: { s: Session }) {
  const lines = Array.isArray(s.transcript) ? s.transcript : [];
  const from = Math.max(0, lines.length - TAIL_LINES);
  return (
    <div className="rounded-control border border-hairline bg-board p-2.5">
      <ol aria-label={`Newest lines of the transcript of ${s.task}`} className="space-y-1 font-mono text-xs leading-relaxed text-ink-2">
        {lines.length === 0 && <li>Waiting for first output line...</li>}
        {lines.slice(from).map((l, i) => (
          <li key={from + i} className="break-words">{l}</li>
        ))}
      </ol>
    </div>
  );
}

function SessionCard({
  s,
  selected,
  isLatestHero,
  onOpen,
  onRetry,
  onDismiss,
}: {
  s: Session;
  selected: boolean;
  isLatestHero: boolean;
  onOpen: (tab?: TabId) => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const ds = diffStat(s.diff);
  const running = s.bucket === "working" && s.status !== "queued";
  const verified = isVerified(s);
  const honest = isHonest(s);
  const failed = isFailed(s);
  const badgeVariant = verified ? "success" : failed ? "error" : s.bucket === "needs-you" ? "info" : s.status === "queued" ? "warning" : s.bucket === "done" ? "success" : "secondary";

  return (
    <motion.article
      layout
      layoutId={"card-" + s.id}
      transition={layout}
      aria-label={s.task}
      className={cn(
        "relative flex min-w-0 flex-col gap-2.5 overflow-hidden rounded-card border p-3.5 transition-colors duration-(--dur-press) ease-(--ease-house) md:p-4",
        selected ? "border-ink bg-raised" : "border-hairline bg-surface hover:bg-raised",
      )}
    >
      {running && <BorderTrail className="bg-ink" size={110} />}

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className={cn("inline-flex max-w-full truncate rounded-chip px-2 py-0.5 text-xs font-medium", projectSkin(s.project))}>
          {s.project}
        </span>
        {isLatestHero && (
          <span className="rounded-chip bg-track px-1.5 py-0.5 font-mono text-xs text-ink-2">hero</span>
        )}
        <Badge variant={badgeVariant} size="sm" className="ml-auto shrink-0">
          {verified ? (s.status === "merged" ? "merged" : "verified") : statusText(s)}
        </Badge>
      </div>

      <Button
        variant="ghost"
        data-open={s.id}
        aria-current={selected ? "true" : undefined}
        aria-label={`Open ${s.task}`}
        onClick={() => onOpen("tr")}
        className="h-auto min-h-11 w-full justify-start whitespace-normal px-1.5 py-1 text-left font-heading text-[15px] font-medium leading-snug text-ink hover:bg-board [overflow-wrap:anywhere]"
      >
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{s.task}</span>
      </Button>

      {s.bucket === "needs-you" && (
        <div className="space-y-2">
          {honest ? (
            <p className="rounded-control bg-pill-warn-bg px-2.5 py-1.5 text-xs font-medium text-pill-warn-fg [overflow-wrap:anywhere]">
              {HONEST}
            </p>
          ) : null}
          <p className={cn("text-sm leading-relaxed [overflow-wrap:anywhere]", failed ? "text-destructive-foreground" : "text-info-foreground")}>
            {s.reason || "Stopped and waiting on your review."}
          </p>
          {s.check_cmd && (
            <p className="truncate font-mono text-xs text-ink-3">
              check: <span className="text-ink-2">{s.check_cmd}</span>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Button size="sm" variant="outline" onClick={onRetry} className="max-md:min-h-11 max-md:px-3.5">
              <RotateCcw className="size-3.5" strokeWidth={1.5} aria-hidden />Retry
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismiss} className="max-md:min-h-11 max-md:px-3">
              <X className="size-3.5" strokeWidth={1.5} aria-hidden />Dismiss
            </Button>
          </div>
        </div>
      )}

      {s.bucket === "working" && (
        <div className="space-y-2">
          {running ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <TextShimmer className="text-xs font-medium" duration={2.2}>
                  {s.status === "checking" ? "The agent finished · running check" : "Agent running"}
                </TextShimmer>
                {s.check_cmd && <span className="truncate font-mono text-xs text-ink-3">{s.check_cmd}</span>}
              </div>
              <RunningTail s={s} />
            </>
          ) : (
            <p className="text-sm text-ink-2">
              Waiting for a free slot (number {s.queue_position ?? "?"} in the queue).
            </p>
          )}
        </div>
      )}

      {s.bucket === "done" && (
        <div className="space-y-2">
          <p className="truncate border-l-2 border-dot-green pl-2 font-mono text-xs tabular-nums text-ink">
            {receiptLine(s)}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs tabular-nums">
            <span className="rounded-chip bg-track px-1.5 py-0.5 text-ink-2">{plural(ds.files, "file")}</span>
            <span className="rounded-chip bg-diff-add-bg px-1.5 py-0.5 text-diff-add-fg">+{ds.add}</span>
            <span className="rounded-chip bg-diff-del-bg px-1.5 py-0.5 text-diff-del-fg">−{ds.del}</span>
            {s.check_cmd && <span className="ml-auto truncate text-ink-3">{s.check_cmd}</span>}
          </div>
        </div>
      )}

      {(s.steer || []).length > 0 && (
        <p className="text-xs font-medium text-warning-foreground">
          {plural(s.steer!.length, "steering message")} queued
        </p>
      )}

      <div className="mt-auto flex min-w-0 items-center gap-2 border-t border-hairline pt-2 font-mono text-xs text-ink-3">
        <span className="shrink-0 text-ink-2">{s.test_mode ? "fixture" : s.engine || s.agent || "agent"}</span>
        <span className="ml-auto min-w-0 truncate">{s.branch || s.id}</span>
      </div>
    </motion.article>
  );
}

function LaneSkeleton({ label, cards }: { label: string; cards: number }) {
  return (
    <section aria-label={`${label} loading`} className="flex min-w-0 flex-col gap-3 bg-canvas p-4 md:p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-heading text-base font-medium text-ink">{label}</h2>
        <span className="h-6 w-8 rounded-full bg-track" aria-hidden />
      </div>
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-card border border-hairline bg-surface p-4">
          <div className="flex items-center justify-between">
            <span className="h-4 w-16 rounded-chip bg-track" />
            <span className="h-5 w-14 rounded-chip bg-track" />
          </div>
          <div className="h-5 w-4/5 rounded-chip bg-track" />
          <div className="h-10 w-full rounded-control bg-board" />
        </div>
      ))}
    </section>
  );
}

function Lane({
  id,
  label,
  tone,
  pulse,
  count,
  empty,
  answers,
  children,
}: {
  id: string;
  label: string;
  tone: "error" | "info" | "success";
  pulse?: boolean;
  count: number;
  empty: string;
  answers: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`lane-${id}-h`} data-answers={answers} className="flex min-w-0 flex-col gap-3 bg-canvas p-4 md:p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 id={`lane-${id}-h`} tabIndex={-1} className="font-heading text-base font-medium text-ink outline-none">
          {label}
        </h2>
        <Pill variant="secondary" className="px-2.5 py-0.5 font-mono text-xs tabular-nums">
          <PillIndicator variant={tone} pulse={pulse} />
          <span>{count}</span>
        </Pill>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <AnimatePresence initial={false}>{children}</AnimatePresence>
        {count === 0 && (
          <p className="rounded-card border border-dashed border-hairline bg-surface/60 p-4 text-sm leading-relaxed text-ink-2">
            {empty}
          </p>
        )}
      </div>
    </section>
  );
}

export function ThreeLaneBoard({
  sessions,
  unreachable,
  selected,
  latestHeroId,
  onOpen,
  onRetry,
  onDismiss,
}: {
  sessions: Session[] | null;
  unreachable: boolean;
  selected: string | null;
  latestHeroId: string | null;
  onOpen: (id: string, tab?: TabId) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (sessions === null && unreachable) {
    return (
      <p role="alert" className="m-4 rounded-card border border-hairline bg-surface p-4 text-sm text-ink md:m-6">
        Fleet has not answered yet, so there is no session list to show. Check that Fleet is running; this page asks again every two seconds.
      </p>
    );
  }

  if (sessions === null) {
    return (
      <div aria-label="Board loading" className="grid gap-px border-b border-hairline bg-hairline md:grid-cols-3">
        <LaneSkeleton label="Needs you" cards={2} />
        <LaneSkeleton label="Working" cards={1} />
        <LaneSkeleton label="Done" cards={2} />
      </div>
    );
  }

  const needs = sessions.filter((s) => s.bucket === "needs-you");
  const working = sessions.filter((s) => s.bucket === "working");
  const done = sessions.filter((s) => s.bucket === "done");
  const anyRunning = working.some((s) => s.status !== "queued");

  return (
    <div aria-label="Session lanes" className="grid gap-px border-b border-hairline bg-hairline md:grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)_minmax(0,1fr)]">
      <Lane
        id="needs"
        label="Needs you"
        tone={needs.length > 0 ? "error" : "info"}
        count={needs.length}
        empty="Nothing needs you. Failed checks and stopped runs land here with the reason."
        answers="1"
      >
        {needs.map((s) => (
          <SessionCard
            key={s.id}
            s={s}
            selected={selected === s.id}
            isLatestHero={false}
            onOpen={(tab) => onOpen(s.id, tab)}
            onRetry={() => onRetry(s.id)}
            onDismiss={() => onDismiss(s.id)}
          />
        ))}
      </Lane>

      <Lane
        id="working"
        label="Working"
        tone="info"
        pulse={anyRunning}
        count={working.length}
        empty="No agent is running right now."
        answers="2"
      >
        {working.map((s) => (
          <SessionCard
            key={s.id}
            s={s}
            selected={selected === s.id}
            isLatestHero={false}
            onOpen={(tab) => onOpen(s.id, tab)}
            onRetry={() => onRetry(s.id)}
            onDismiss={() => onDismiss(s.id)}
          />
        ))}
      </Lane>

      <Lane
        id="done"
        label="Done"
        tone="success"
        count={done.length}
        empty="Work appears here once its check passes, with the check line as its receipt."
        answers="3"
      >
        {done.map((s) => (
          <SessionCard
            key={s.id}
            s={s}
            selected={selected === s.id}
            isLatestHero={s.id === latestHeroId}
            onOpen={(tab) => onOpen(s.id, tab)}
            onRetry={() => onRetry(s.id)}
            onDismiss={() => onDismiss(s.id)}
          />
        ))}
      </Lane>
    </div>
  );
}
