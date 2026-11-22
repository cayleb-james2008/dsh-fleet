// Split-Pane Session Inspector (desktop right pane >=1100px, Vaul bottom drawer <1100px).
// Preserves all behavioral contracts: confirms before merge/stop/dismiss, honest check-passed-but-needs-you banner,
// Cult UI Expandable disclosures (zero <details>), roving ArrowLeft/ArrowRight/Home/End tabs across Transcript · Diff · Receipt,
// syntax-tinted +/- diff lines in Geist Mono, focus management on open/close, and per-session Steer composer.
import { useEffect, useRef, useState } from "react";
import { X, Send, RotateCcw, GitMerge, Square } from "lucide-react";
import { AnimatedBackground } from "@/components/ui/animated-background";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Expandable, ExpandableContent, ExpandableTrigger } from "@/components/ui/expandable";
import { glide } from "@/motion";
import { cn } from "@/lib/utils";
import {
  diffStat,
  HONEST,
  isFailed,
  isHonest,
  isVerified,
  parseDiffLines,
  postJson,
  receiptLine,
  statusText,
  type Session,
  type TabId,
} from "./api";
import { toast } from "sonner";

type Act = "merge" | "stop" | "dismiss" | null;

const draftKey = (id: string) => "fleet-steer:" + id;
export function draftGet(id: string): string {
  try { return sessionStorage.getItem(draftKey(id)) || ""; } catch { return ""; }
}
function draftSet(id: string, v: string) {
  try { if (v) sessionStorage.setItem(draftKey(id), v); else sessionStorage.removeItem(draftKey(id)); } catch { /* private window */ }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function DiffViewer({ diff }: { diff?: string }) {
  const rows = parseDiffLines(diff);
  if (rows.length === 0) {
    return (
      <pre className="min-h-24 rounded-card border border-hairline bg-canvas p-3 font-mono text-xs leading-relaxed text-ink-2">
        No changes on this branch yet.
      </pre>
    );
  }
  return (
    <div className="max-h-[46vh] overflow-x-auto overflow-y-auto rounded-card border border-hairline bg-canvas font-mono text-xs leading-relaxed">
      <div className="min-w-full py-1.5">
        {rows.map((r, idx) => (
          <div
            key={idx}
            className={cn(
              "whitespace-pre px-3 py-0.5",
              r.kind === "meta" && "bg-board font-medium text-ink",
              r.kind === "hunk" && "bg-track/60 text-ink-3",
              r.kind === "add" && "bg-diff-add-bg text-diff-add-fg",
              r.kind === "del" && "bg-diff-del-bg text-diff-del-fg",
              r.kind === "ctx" && "text-ink-2",
            )}
          >
            {r.text || " "}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DetailBody({
  s,
  requestedTab,
  openSeq,
  onClose,
  onChanged,
  onDismissed,
}: {
  s: Session;
  requestedTab: TabId;
  openSeq: number;
  onClose: () => void;
  onChanged: () => void;
  onDismissed: () => void;
}) {
  const [tab, setTab] = useState<TabId>(requestedTab);
  const [act, setAct] = useState<Act>(null);
  const [err, setErr] = useState("");
  const [mergeOk, setMergeOk] = useState("");
  const [steer, setSteer] = useState(() => draftGet(s.id));
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setSteer(draftGet(s.id));
    setAct(null);
    setErr("");
    setMergeOk("");
  }, [s.id]);

  useEffect(() => {
    setTab(requestedTab);
  }, [requestedTab, openSeq]);

  // Focus moves to the inspector's session heading when opened via click/keyboard.
  useEffect(() => {
    if (openSeq > 0) {
      requestAnimationFrame(() => headingRef.current?.focus());
    }
  }, [openSeq, s.id]);

  const verified = isVerified(s);
  const honest = isHonest(s);
  const ds = diffStat(s.diff);
  const ranCheck = s.check_ran !== undefined ? Boolean(s.check_ran) : s.check_passed === true || s.check_passed === false;
  const agent = s.test_mode ? "test mode (custom command)" : s.engine || s.agent || "unknown";
  const chain: string[] = [];
  if (s.spawned_from) chain.push(`Handed out automatically when ${s.spawned_from} finished.`);
  if (s.successor) chain.push(`Its finish handed out ${s.successor}.`);
  if ((s.next_queue || []).length) chain.push(`Then: ${s.next_queue!.join(", ")}.`);

  const hint =
    s.status === "needs-you"
      ? "Sending also retries the session: your message goes to the agent first, before anything is re-checked."
      : s.status === "done"
        ? "Sending reopens this session: the agent gets your message and the work is re-checked before it can be merged."
        : "Delivered when the current run ends, before anything is committed or checked.";

  const order: TabId[] = ["tr", "df", "rc"];
  function onTabKey(e: React.KeyboardEvent<HTMLElement>) {
    const i = order.indexOf(tab);
    let j: number | null = null;
    if (e.key === "ArrowRight") j = (i + 1) % 3;
    else if (e.key === "ArrowLeft") j = (i + 2) % 3;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = 2;
    if (j === null) return;
    e.preventDefault();
    setTab(order[j]);
    const host = e.currentTarget;
    host.querySelector<HTMLElement>(`[data-id="${order[j]}"]`)?.focus();
  }

  async function run(fn: () => Promise<string | null>, ok: string) {
    const e = await fn();
    setErr(e || "");
    if (e) toast.error(e); else if (ok) toast.success(ok);
    onChanged();
  }

  const doMerge = async () => {
    setAct(null);
    try {
      const r = await fetch(`/api/sessions/${s.id}/merge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        const text = `Merged ${s.branch} into ${j.branch || s.merge_target || "the target branch"}.`;
        setMergeOk(text);
        setErr("");
        toast.success(text);
      } else {
        setMergeOk("");
        const j = await r.json().catch(() => ({}));
        const e = j.error || "request failed";
        setErr(e);
        toast.error(e);
      }
    } catch {
      setErr("Could not reach Fleet. Is it running?");
    }
    onChanged();
  };

  const sendSteer = async () => {
    const msg = steer.trim();
    if (!msg) { setErr("Write the message first."); return; }
    const e = await postJson(`/api/sessions/${s.id}/steer`, { message: msg });
    if (!e) {
      draftSet(s.id, "");
      setSteer("");
      toast.success("Steering message sent");
    } else {
      toast.error(e);
    }
    setErr(e || "");
    onChanged();
  };

  const mergeQ = s.merge_target
    ? `Merge ${s.branch || "this session"} into ${s.merge_target}? Fleet refuses if the target is dirty or in the middle of a merge.`
    : `Merge ${s.branch || "this session"}? Fleet refuses if the target is dirty or in the middle of a merge.`;

  return (
    <div className="flex min-h-0 flex-col gap-5">
      <div className="flex items-center gap-2">
        <Badge
          variant={verified ? "success" : isFailed(s) ? "error" : s.bucket === "needs-you" ? "info" : s.bucket === "done" ? "success" : "secondary"}
          size="sm"
        >
          {verified ? (s.status === "merged" ? "merged" : "verified") : statusText(s)}
        </Badge>
        <Button variant="ghost" size="sm" className="ml-auto max-md:min-h-11 max-md:px-3" onClick={onClose} aria-label="Close this session">
          <X className="size-4" strokeWidth={1.5} aria-hidden />Close
        </Button>
      </div>

      {honest && (
        <div role="status" className="rounded-card bg-pill-warn-bg p-3">
          <p className="font-medium text-pill-warn-fg">{HONEST}</p>
          <p className="mt-1 text-sm text-ink [overflow-wrap:anywhere]">{s.reason || ""}</p>
        </div>
      )}

      <div className="min-w-0">
        <h2 ref={headingRef} tabIndex={-1} className="font-heading text-xl font-medium leading-tight text-ink outline-none md:text-[24px] [overflow-wrap:anywhere]">
          {s.task}
        </h2>
        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-ink-2 tabular-nums">
          <div className="flex min-w-0 gap-2"><dt className="text-ink-3">Project</dt><dd className="min-w-0 [overflow-wrap:anywhere] text-ink">{s.project}</dd></div>
          <div className="flex gap-2"><dt className="text-ink-3">Agent</dt><dd className="text-ink">{agent}</dd></div>
          <div className="flex min-w-0 gap-2"><dt className="text-ink-3">Branch</dt><dd className="min-w-0 break-all font-mono text-xs text-ink">{s.branch || "—"}</dd></div>
          {s.queue_position ? <div className="flex gap-2"><dt className="text-ink-3">Queue</dt><dd className="font-mono text-ink">#{s.queue_position}</dd></div> : null}
        </dl>
        {chain.map((c) => <p key={c} className="mt-2 text-sm text-ink-2 [overflow-wrap:anywhere]">{c}</p>)}
        {s.transcript.some((l) => l.includes("restored from its record")) && (
          <p className="mt-2 text-sm text-ink-2">This session was restored from its record after the session store was lost.</p>
        )}
      </div>

      {verified && (
        <section aria-label="Receipt" className="relative rounded-card border border-hairline bg-canvas p-4">
          <p className="border-l-2 border-dot-green pl-2.5 font-medium text-ink">Check passed: verified done</p>
          <p className="mt-2 font-mono text-sm text-ink [overflow-wrap:anywhere]">{receiptLine(s)}</p>
          <p className="mt-1 font-mono text-xs text-ink-3 [overflow-wrap:anywhere]">verified by: <span className="text-ink-2">{s.check_cmd || "policy check"}</span></p>
          <Expandable expandDirection="vertical" expandBehavior="push" className="mt-3">
            {({ isExpanded }) => (
              <>
                <ExpandableTrigger aria-label="Details of the check output" className="inline-flex cursor-pointer items-center rounded-control text-sm text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 max-md:px-2">
                  {isExpanded ? "Hide details" : "Details"}
                </ExpandableTrigger>
                <ExpandableContent preset="fade">
                  <pre className="mt-2 max-h-[30vh] overflow-y-auto whitespace-pre-wrap break-all rounded-control border border-hairline bg-surface p-2.5 font-mono text-xs text-ink-2">
                    {s.check_output || "(printed nothing)"}
                  </pre>
                </ExpandableContent>
              </>
            )}
          </Expandable>
        </section>
      )}

      {s.status === "needs-you" && s.reason && !honest && (
        <p
          role="status"
          className={cn(
            "rounded-card p-3 text-sm leading-relaxed [overflow-wrap:anywhere]",
            isFailed(s) ? "bg-pill-pro-bg text-destructive-foreground" : "bg-blue-soft text-info-foreground",
          )}
        >
          {s.reason}
        </p>
      )}

      {act && (
        <div role="group" aria-label="Confirm" className="rounded-card border border-hairline bg-raised p-4">
          <p className="text-sm text-ink-2 [overflow-wrap:anywhere]">
            {act === "merge"
              ? mergeQ
              : act === "dismiss"
                ? "Dismiss this session? It leaves the board and the inbox. Its log stays on disk."
                : "Stop this run now? It lands in Needs you as stopped by you."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant={act === "merge" ? "default" : "destructive-outline"}
              className="max-md:min-h-11 max-md:px-4"
              onClick={() => (act === "merge" ? doMerge() : act === "dismiss" ? onDismissed() : run(() => postJson(`/api/sessions/${s.id}/stop`), "Stopped"))}
            >
              {act === "merge" ? "Merge now" : act === "dismiss" ? "Dismiss now" : "Stop now"}
            </Button>
            <Button variant="outline" className="max-md:min-h-11 max-md:px-4" onClick={() => setAct(null)}>Keep it</Button>
          </div>
        </div>
      )}

      {!act && (
        <div className="flex flex-wrap gap-2">
          {s.status === "done" && (
            <Button onClick={() => setAct("merge")} className="max-md:min-h-11 max-md:px-4">
              <GitMerge className="size-4" strokeWidth={1.5} aria-hidden />Merge this work
            </Button>
          )}
          {s.status === "needs-you" && (
            <Button variant="outline" onClick={() => run(() => postJson(`/api/sessions/${s.id}/retry`), "Retrying the session")} className="max-md:min-h-11 max-md:px-4">
              <RotateCcw className="size-4" strokeWidth={1.5} aria-hidden />Retry this session
            </Button>
          )}
          {s.status === "needs-you" && (
            <Button variant="ghost" onClick={() => setAct("dismiss")} className="max-md:min-h-11 max-md:px-4">Dismiss</Button>
          )}
          {(s.status === "queued" || s.status === "working" || s.status === "checking") && (
            <Button variant="destructive-outline" onClick={() => setAct("stop")} className="max-md:min-h-11 max-md:px-4">
              <Square className="size-4" strokeWidth={1.5} aria-hidden />Stop this session
            </Button>
          )}
        </div>
      )}

      {mergeOk && <p role="status" className="border-l-2 border-dot-green pl-2.5 text-sm text-ink [overflow-wrap:anywhere]">{mergeOk}</p>}

      {s.merge_error && (
        <div className="rounded-card bg-pill-pro-bg p-3 text-destructive-foreground">
          <p className="text-sm font-medium text-ink [overflow-wrap:anywhere]">{s.merge_error.message || "The merge was refused."}</p>
          {s.merge_error.detail && (
            <Expandable expandDirection="vertical" expandBehavior="push" className="mt-2">
              {({ isExpanded }) => (
                <>
                  <ExpandableTrigger aria-label="Details of the refused merge" className="inline-flex cursor-pointer items-center rounded-control text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 max-md:px-2">
                    {isExpanded ? "Hide details" : "Details"}
                  </ExpandableTrigger>
                  <ExpandableContent preset="fade">
                    <pre className="mt-2 max-h-[30vh] overflow-y-auto whitespace-pre-wrap break-all rounded-control border border-hairline bg-canvas p-2.5 font-mono text-xs text-ink-2">
                      {s.merge_error!.detail}
                    </pre>
                  </ExpandableContent>
                </>
              )}
            </Expandable>
          )}
        </div>
      )}

      {err && <p role="alert" className="text-sm text-destructive-foreground [overflow-wrap:anywhere]">{err}</p>}

      <div>
        <div role="tablist" aria-label="Session views" onKeyDown={onTabKey} className="inline-flex gap-0.5 rounded-control bg-track p-0.5">
          <AnimatedBackground
            defaultValue={tab}
            onValueChange={(id) => id && setTab(id as TabId)}
            className="rounded-segment bg-ink-button"
            transition={glide}
          >
            {([["tr", "Transcript"], ["df", "Diff"], ["rc", "Receipt"]] as const).map(([id, label]) => (
              <Button
                key={id}
                type="button"
                variant="ghost"
                size="sm"
                data-id={id}
                role="tab"
                aria-selected={tab === id}
                tabIndex={tab === id ? 0 : -1}
                className="h-8 cursor-pointer rounded-segment border-0 px-3 text-sm font-medium text-ink-2 hover:bg-transparent aria-[selected=true]:text-ink-button-fg data-[checked=true]:text-ink-button-fg max-md:min-h-11 max-md:px-3.5"
              >
                {label}
              </Button>
            ))}
          </AnimatedBackground>
        </div>

        <div className="mt-4">
          {tab === "tr" && (
            <>
              <p className="mb-2 text-sm text-ink-3">{plural(s.transcript.length, "line")} so far.</p>
              <pre className="max-h-[46vh] min-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded-card border border-hairline bg-canvas p-3 font-mono text-xs leading-relaxed text-ink">
                {s.transcript.length ? s.transcript.join("\n") : "No output yet."}
              </pre>
              {s.transcript.length >= 2000 && (
                <p className="mt-2 text-xs text-ink-3">Showing the most recent lines. The full log is kept on disk as logs/{s.id}.log in the Fleet data folder.</p>
              )}
            </>
          )}

          {tab === "df" && (
            <>
              <p className="mb-2 flex flex-wrap items-center gap-1.5 text-sm text-ink-2 tabular-nums">
                <span>{plural(ds.files, "file")} changed,</span>
                <span className="rounded-chip bg-diff-add-bg px-1.5 py-0.5 font-mono text-xs text-diff-add-fg">+{ds.add}</span>
                <span className="rounded-chip bg-diff-del-bg px-1.5 py-0.5 font-mono text-xs text-diff-del-fg">−{ds.del}</span>
                <span>lines against base branch.</span>
              </p>
              <DiffViewer diff={s.diff} />
            </>
          )}

          {tab === "rc" && (
            <>
              <p className={cn("mb-1 text-sm font-medium", ranCheck ? (s.check_passed ? "text-success-foreground" : "text-destructive-foreground") : "text-ink-2")}>
                {!ranCheck ? "No check has run yet." : s.check_passed ? "Passed." : `Failed${s.check_exit != null ? ` with exit code ${s.check_exit}` : ""}.`}
              </p>
              <p className="mb-2 font-mono text-xs text-ink-3 [overflow-wrap:anywhere]">
                {ranCheck ? `Command: ${s.check_cmd || ""}` : s.check_cmd ? `Check command: ${s.check_cmd}` : ""}
              </p>
              <pre className="max-h-[46vh] min-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded-card border border-hairline bg-canvas p-3 font-mono text-xs leading-relaxed text-ink">
                {ranCheck ? s.check_output || "(printed nothing)" : "Waiting for the agent run to finish before executing the check."}
              </pre>
            </>
          )}
        </div>
      </div>

      {s.status !== "merged" && (
        <section className="border-t border-hairline pt-5">
          <h3 className="text-sm font-medium text-ink">Steer this session</h3>
          <Textarea
            id="steerText"
            className="mt-2"
            rows={2}
            placeholder="Tell the agent what to change"
            aria-describedby="steerHint"
            value={steer}
            onChange={(e) => { setSteer(e.target.value); draftSet(s.id, e.target.value); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                sendSteer();
              }
            }}
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={sendSteer} className="max-md:min-h-11 max-md:px-4">
              <Send className="size-4" strokeWidth={1.5} aria-hidden />Send to the agent
            </Button>
          </div>
          <p id="steerHint" className="mt-2 text-xs leading-relaxed text-ink-3">{hint}</p>
        </section>
      )}
    </div>
  );
}
