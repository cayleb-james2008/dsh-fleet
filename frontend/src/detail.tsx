// The session detail: the receipt's full record, its three views, the actions with their confirms, and the steer box.
// Old behaviour kept (git show HEAD:assets/index.html): confirms before merge, stop and dismiss; refused actions say
// the server's own words; the steer draft lives per session in sessionStorage and survives a reload.
import { useEffect, useState } from "react";
import { X, Send, RotateCcw, GitMerge, Square } from "lucide-react";
import { AnimatedBackground } from "@/components/ui/animated-background";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { glide } from "@/motion";
import { cn } from "@/lib/utils";
import { diffStat, HONEST, isFailed, isHonest, isVerified, postJson, receiptLine, statusText, type Session } from "./api";
import { toast } from "sonner";
import { Expandable, ExpandableContent, ExpandableTrigger } from "@/components/ui/expandable";

type Tab = "tr" | "df" | "rc";
type Act = "merge" | "stop" | "dismiss" | null;

const draftKey = (id: string) => "fleet-steer:" + id;
export function draftGet(id: string): string {
  try { return sessionStorage.getItem(draftKey(id)) || ""; } catch { return ""; }
}
function draftSet(id: string, v: string) {
  try { if (v) sessionStorage.setItem(draftKey(id), v); else sessionStorage.removeItem(draftKey(id)); } catch { /* private window: keep it in memory only */ }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function DetailBody({ s, onClose, onChanged, onDismissed }: { s: Session; onClose: () => void; onChanged: () => void; onDismissed: () => void }) {
  const [tab, setTab] = useState<Tab>("tr");
  const [act, setAct] = useState<Act>(null);
  const [err, setErr] = useState("");
  const [mergeOk, setMergeOk] = useState("");
  const [steer, setSteer] = useState(() => draftGet(s.id));
  useEffect(() => { setSteer(draftGet(s.id)); setAct(null); setErr(""); setMergeOk(""); }, [s.id]);

  const verified = isVerified(s);
  const honest = isHonest(s);
  const ds = diffStat(s.diff);
  const ranCheck = s.check_ran !== undefined ? !!s.check_ran : s.check_passed === true || s.check_passed === false;
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

  const order: Tab[] = ["tr", "df", "rc"];
  // Arrow keys, Home and End move between the views (roving focus, as the old page did).
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
    // The buttons already exist; focus the next one now (React clears currentTarget after the handler returns).
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
        setMergeOk(text); setErr(""); toast.success(text);
      } else {
        setMergeOk("");
        const j = await r.json().catch(() => ({}));
        const e = j.error || "request failed";
        setErr(e); toast.error(e);
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
    if (!e) { draftSet(s.id, ""); setSteer(""); toast.success("Steering message sent"); }
    else toast.error(e);
    setErr(e || "");
    onChanged();
  };

  const mergeQ = s.merge_target
    ? `Merge ${s.branch || "this session"} into ${s.merge_target}? Fleet refuses if the target is dirty or in the middle of a merge.`
    : `Merge ${s.branch || "this session"}? Fleet refuses if the target is dirty or in the middle of a merge.`;

  return (
    <div className="flex min-h-0 flex-col gap-5">
      <div className="flex items-center gap-2">
        <Badge variant={verified ? "success" : isFailed(s) ? "error" : s.bucket === "needs-you" ? "info" : s.bucket === "done" ? "success" : "secondary"} size="sm">
          {verified ? "verified" : statusText(s)}
        </Badge>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose} aria-label="Close this session">
          <X className="size-4" strokeWidth={1.5} aria-hidden />Close
        </Button>
      </div>

      {honest && (
        <div role="status" className="rounded-card bg-pill-warn-bg p-3">
          <p className="font-medium text-pill-warn-fg">{HONEST}</p>
          <p className="mt-1 text-sm text-ink">{s.reason || ""}</p>
        </div>
      )}

      <div className="min-w-0">
        <h2 className="break-words font-heading text-[26px] font-light leading-tight text-ink md:text-[32px]">{s.task}</h2>
        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-ink-2 tabular-nums">
          <div className="flex gap-2"><dt className="text-ink-3">Project</dt><dd>{s.project}</dd></div>
          <div className="flex gap-2"><dt className="text-ink-3">Agent</dt><dd>{agent}</dd></div>
          <div className="flex min-w-0 gap-2"><dt className="text-ink-3">Branch</dt><dd className="min-w-0 break-all font-mono text-xs text-ink">{s.branch || ""}</dd></div>
          {s.queue_position ? <div className="flex gap-2"><dt className="text-ink-3">Queue</dt><dd>#{s.queue_position}</dd></div> : null}
        </dl>
        {chain.map((c) => <p key={c} className="mt-2 text-sm text-ink-2">{c}</p>)}
        {s.transcript.some((l) => l.includes("restored from its record")) && (
          <p className="mt-2 text-sm text-ink-2">This session was restored from its record after the session store was lost.</p>
        )}
      </div>

      {verified && (
        <section aria-label="Receipt" className="relative rounded-card border border-hairline bg-canvas p-4">
          <p className="border-l-2 border-dot-green pl-2 font-medium text-ink">Check passed: verified done</p>
          <p className="mt-2 font-mono text-sm text-ink">{receiptLine(s)}</p>
          <p className="mt-1 font-mono text-xs text-ink-3">Check: {s.check_cmd || ""}</p>
          <Expandable expandDirection="vertical" expandBehavior="push" className="mt-3">
            {({ isExpanded }) => (
              <>
                <ExpandableTrigger aria-label="Details of the check output" className="cursor-pointer rounded-control text-sm text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring">
                  {isExpanded ? "Hide details" : "Details"}
                </ExpandableTrigger>
                <ExpandableContent preset="fade">
                  <pre className="mt-2 max-h-[30vh] overflow-auto whitespace-pre-wrap break-all rounded-control bg-canvas p-2 font-mono text-xs text-ink-2">{s.check_output || "(printed nothing)"}</pre>
                </ExpandableContent>
              </>
            )}
          </Expandable>
        </section>
      )}
      {s.status === "needs-you" && s.reason && !honest && (
        <p role="status" className={cn("rounded-card p-3", isFailed(s) ? "bg-pill-pro-bg" : "bg-blue-soft", isFailed(s) ? "text-destructive-foreground" : "text-info-foreground")}>{s.reason}</p>
      )}

      {act && (
        <div role="group" aria-label="Confirm" className="rounded-card border border-hairline bg-raised p-4">
          <p className="text-sm text-ink-2">
            {act === "merge" ? mergeQ : act === "dismiss"
              ? "Dismiss this session? It leaves the board and the inbox. Its log stays on disk."
              : "Stop this run now? It lands in Needs you as stopped by you."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant={act === "merge" ? "default" : "destructive-outline"} onClick={() => (act === "merge" ? doMerge() : act === "dismiss" ? onDismissed() : run(() => postJson(`/api/sessions/${s.id}/stop`), "Stopped"))}>
              {act === "merge" ? "Merge now" : act === "dismiss" ? "Dismiss now" : "Stop now"}
            </Button>
            <Button variant="outline" onClick={() => setAct(null)}>Keep it</Button>
          </div>
        </div>
      )}
      {!act && (
        <div className="flex flex-wrap gap-2">
          {s.status === "done" && <Button onClick={() => setAct("merge")}><GitMerge className="size-4" strokeWidth={1.5} aria-hidden />Merge this work</Button>}
          {s.status === "needs-you" && <Button variant="outline" onClick={() => run(() => postJson(`/api/sessions/${s.id}/retry`), "Retrying the session")}><RotateCcw className="size-4" strokeWidth={1.5} aria-hidden />Retry this session</Button>}
          {s.status === "needs-you" && <Button variant="ghost" onClick={() => setAct("dismiss")}>Dismiss</Button>}
          {(s.status === "queued" || s.status === "working" || s.status === "checking") && (
            <Button variant="destructive-outline" onClick={() => setAct("stop")}><Square className="size-4" strokeWidth={1.5} aria-hidden />Stop this session</Button>
          )}
        </div>
      )}
      {mergeOk && <p role="status" className="border-l-2 border-dot-green pl-2 text-sm text-ink">{mergeOk}</p>}
      {s.merge_error && (
        <div className="rounded-card bg-pill-pro-bg p-3 text-destructive-foreground">
          <p className="text-ink">{s.merge_error.message || "The merge was refused."}</p>
          {s.merge_error.detail && (
            <Expandable expandDirection="vertical" expandBehavior="push" className="mt-2">
              {({ isExpanded }) => (
                <>
                  <ExpandableTrigger aria-label="Details of the refused merge" className="cursor-pointer rounded-control text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {isExpanded ? "Hide details" : "Details"}
                  </ExpandableTrigger>
                  <ExpandableContent preset="fade">
                    <pre className="mt-2 max-h-[30vh] overflow-auto whitespace-pre-wrap break-all rounded-control bg-canvas p-2 font-mono text-xs text-ink-2">{s.merge_error!.detail}</pre>
                  </ExpandableContent>
                </>
              )}
            </Expandable>
          )}
        </div>
      )}
      {err && <p role="alert" className="text-sm text-destructive-foreground">{err}</p>}

      <div>
        <div role="tablist" aria-label="Session views" onKeyDown={onTabKey} className="inline-flex gap-0.5 rounded-control bg-track p-0.5">
        <AnimatedBackground
          defaultValue={tab}
          onValueChange={(id) => id && setTab(id as Tab)}
          className="rounded-sm bg-ink"
          transition={glide}
        >
          {([["tr", "Transcript"], ["df", "Diff"], ["rc", "Receipt"]] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              data-id={id}
              role="tab"
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              className="h-8 cursor-pointer rounded-sm px-3 text-sm font-medium text-ink-2 aria-[selected=true]:text-ink-button-fg outline-none transition-colors duration-(--dur-press) ease-(--ease-house) focus-visible:ring-2 focus-visible:ring-ring data-[checked=true]:text-ink-button-fg"
            >
              {label}
            </button>
          ))}
        </AnimatedBackground>
        </div>
        <div className="mt-4">
          {tab === "tr" && (
            <>
              <p className="mb-2 text-sm text-ink-3">{plural(s.transcript.length, "line")} so far.</p>
              <pre className="max-h-[46vh] min-h-24 overflow-auto whitespace-pre-wrap break-all rounded-card border border-hairline bg-canvas p-3 font-mono text-xs leading-relaxed text-ink">
                {s.transcript.length ? s.transcript.join("\n") : "No output yet."}
              </pre>
              {s.transcript.length >= 2000 && (
                <p className="mt-2 text-xs text-ink-3">Showing the most recent lines. The full log is kept on disk as logs/{s.id}.log in the Fleet data folder.</p>
              )}
            </>
          )}
          {tab === "df" && (
            <>
              <p className="mb-2 text-sm text-ink-2 tabular-nums">
                {plural(ds.files, "file")} changed, <span>+{ds.add}</span> <span>−{ds.del}</span> lines, against the branch this session started from.
              </p>
              <pre className="max-h-[46vh] min-h-24 overflow-auto whitespace-pre rounded-card border border-hairline bg-canvas p-3 font-mono text-xs leading-relaxed text-ink">
                {s.diff || "No changes on this branch yet."}
              </pre>
            </>
          )}
          {tab === "rc" && (
            <>
              <p className={cn("mb-1 text-sm font-medium", ranCheck ? (s.check_passed ? "text-ink" : "text-destructive-foreground") : "text-ink-2")}>
                {!ranCheck ? "No check has run yet." : s.check_passed ? "Passed." : `Failed${s.check_exit != null ? ` with exit code ${s.check_exit}` : ""}.`}
              </p>
              <p className="mb-2 font-mono text-xs text-ink-3">{ranCheck ? `Command: ${s.check_cmd || ""}` : s.check_cmd ? `Check command: ${s.check_cmd}` : ""}</p>
              <pre className="max-h-[46vh] min-h-24 overflow-auto whitespace-pre-wrap break-all rounded-card border border-hairline bg-canvas p-3 font-mono text-xs leading-relaxed text-ink">
                {ranCheck ? s.check_output || "(printed nothing)" : ""}
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
          />
          <div className="mt-2.5 flex items-center gap-3">
            <Button variant="outline" onClick={sendSteer}><Send className="size-4" strokeWidth={1.5} aria-hidden />Send to the agent</Button>
          </div>
          <p id="steerHint" className="mt-2 text-xs leading-relaxed text-ink-3">{hint}</p>
        </section>
      )}
    </div>
  );
}
