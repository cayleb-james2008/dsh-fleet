// Split-Pane Session Inspector (desktop right pane >=1100px, Vaul bottom drawer <1100px).
// Upgraded for v0.5.0: Virtualized searchable Transcript (50k+ lines, Jump to first error),
// Unified & Side-by-Side Diff Viewer with Pre-Merge Conflict Badge, Merge Strategy selector,
// Download .patch, Per-Step Timed Receipt Timeline, DAG depends_on links, and File-Scope Guardrails.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock,
  FileCode2,
  GitBranch,
  GitMerge,
  Play,
  RotateCcw,
  Send,
  ShieldAlert,
  Square,
  X,
  XCircle,
} from "lucide-react";
import { AnimatedBackground } from "@/components/ui/animated-background";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Expandable, ExpandableContent, ExpandableTrigger } from "@/components/ui/expandable";
import { Pill, PillIndicator } from "@/components/kibo-ui/pill";
import { glide } from "@/motion";
import { cn } from "@/lib/utils";
import {
  formatDurationMs,
  getWebEngine,
  HONEST,
  isActivelyRunning,
  isFailed,
  isHonest,
  isVerified,
  postJson,
  receiptLine,
  statusText,
  type CheckStepReceipt,
  type MergeStrategy,
  type Session,
  type TabId,
} from "./api";
import { VirtualizedTranscript } from "./transcript";
import { MERGE_STRATEGIES, MergeStrategyControl, RichDiffViewer, useMergeCheck } from "./diff";
import { toast } from "sonner";

type Act = "merge" | "stop" | "dismiss" | null;

const draftKey = (id: string) => "fleet-steer:" + id;
export function draftGet(id: string): string {
  try {
    return sessionStorage.getItem(draftKey(id)) || "";
  } catch {
    return "";
  }
}
function draftSet(id: string, v: string) {
  try {
    if (v) sessionStorage.setItem(draftKey(id), v);
    else sessionStorage.removeItem(draftKey(id));
  } catch {
    /* private window */
  }
}

function BranchFileEditor({ sessionId, onSaved }: { sessionId: string; onSaved: () => void }) {
  const engine = getWebEngine();
  const files = engine?.getSessionFiles(sessionId) ?? null;
  const names = files ? Object.keys(files).sort() : [];
  const [activeFile, setActiveFile] = useState<string>(() => names[0] || "");
  const [draft, setDraft] = useState<string>(() => (files && names[0] ? files[names[0]] : ""));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const f = getWebEngine()?.getSessionFiles(sessionId) ?? null;
    const keys = f ? Object.keys(f).sort() : [];
    const next = keys.includes(activeFile) ? activeFile : keys[0] || "";
    setActiveFile(next);
    setDraft(f && next ? f[next] : "");
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!engine || !files || names.length === 0) return null;

  const selectFile = (name: string) => {
    setActiveFile(name);
    setDraft(files[name] ?? "");
  };

  const saveAndCheck = async () => {
    if (!activeFile || saving) return;
    setSaving(true);
    const res = await engine.updateSessionFile(sessionId, activeFile, draft);
    setSaving(false);
    if (res.ok) {
      toast.success(`Saved ${activeFile} and re-ran Web Worker check.`);
      onSaved();
    } else {
      toast.error(res.error || "Could not update branch file.");
    }
  };

  return (
    <Expandable expandDirection="vertical" expandBehavior="push" className="mt-4 rounded-card border border-hairline bg-surface p-3">
      {({ isExpanded }) => (
        <>
          <ExpandableTrigger
            aria-label="Edit branch worktree files"
            className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-control text-left text-sm font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
          >
            <span className="inline-flex items-center gap-1.5">
              <FileCode2 className="size-4 text-icon" strokeWidth={1.5} aria-hidden />
              <span>Edit branch worktree files ({names.length})</span>
            </span>
            <span className="text-xs font-normal text-ink-3">{isExpanded ? "Hide editor" : "Open editor"}</span>
          </ExpandableTrigger>
          <ExpandableContent preset="fade">
            <div className="mt-3 space-y-2.5 border-t border-hairline pt-3">
              <div className="flex flex-wrap gap-1.5">
                {names.map((name) => (
                  <Button
                    key={name}
                    type="button"
                    size="sm"
                    variant={activeFile === name ? "default" : "outline"}
                    onClick={() => selectFile(name)}
                    className="h-7 px-2 font-mono text-xs max-md:min-h-11"
                  >
                    {name}
                  </Button>
                ))}
              </div>
              <Textarea
                aria-label={`Source code of ${activeFile}`}
                rows={10}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="font-mono text-xs leading-relaxed"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-ink-3">Edits apply only to this session’s branch and re-run the Web Worker check pipeline.</p>
                <Button type="button" size="sm" disabled={saving} onClick={saveAndCheck} className="max-md:min-h-11 max-md:px-4">
                  <Play className="size-3.5" strokeWidth={1.5} aria-hidden />
                  {saving ? "Running check..." : "Save and re-run check"}
                </Button>
              </div>
            </div>
          </ExpandableContent>
        </>
      )}
    </Expandable>
  );
}

function ReceiptStepTimeline({ s, ranCheck }: { s: Session; ranCheck: boolean }) {
  const steps: CheckStepReceipt[] = useMemo(() => {
    if (s.check_steps && s.check_steps.length > 0) return s.check_steps;
    if (!ranCheck && !s.check_cmd) return [];
    return [
      {
        name: "verify",
        cmd: s.check_cmd || "policy check",
        exit_code: s.check_exit ?? (s.check_passed === true ? 0 : s.check_passed === false ? 1 : null),
        elapsed_ms: s.elapsed_ms ?? null,
        passed: ranCheck ? Boolean(s.check_passed) : null,
        tail_line: ranCheck ? receiptLine(s) : "Waiting for agent run to finish",
        output: s.check_output || "",
        status: !ranCheck ? "pending" : s.check_passed ? "passed" : "failed",
      },
    ];
  }, [s, ranCheck]);

  const totalMs = useMemo(
    () => steps.reduce((acc, st) => acc + (typeof st.elapsed_ms === "number" ? st.elapsed_ms : 0), 0),
    [steps],
  );

  return (
    <div className="space-y-3" data-testid="receipt-timeline">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          className={cn(
            "text-sm font-medium",
            ranCheck ? (s.check_passed ? "text-success-foreground" : "text-destructive-foreground") : "text-ink-2",
          )}
        >
          {!ranCheck
            ? "No check has run yet."
            : s.check_passed
              ? `Passed (${steps.filter((x) => x.status === "passed").length}/${steps.length} ${steps.length === 1 ? "step" : "steps"}).`
              : `Failed${s.check_exit != null ? ` with exit code ${s.check_exit}` : ""}.`}
        </p>
        {totalMs > 0 && (
          <span className="inline-flex items-center gap-1 rounded-chip bg-track px-2 py-0.5 font-mono text-xs tabular-nums text-ink-2">
            <Clock className="size-3 text-icon" strokeWidth={1.5} aria-hidden />
            <span>{formatDurationMs(totalMs)}</span>
          </span>
        )}
      </div>

      {s.guardrail_violations && s.guardrail_violations.length > 0 && (
        <div role="status" className="rounded-card border border-hairline bg-pill-pro-bg p-3 text-destructive-foreground">
          <p className="flex items-center gap-1.5 text-xs font-medium text-ink">
            <ShieldAlert className="size-4 text-destructive-foreground" strokeWidth={1.5} aria-hidden />
            <span>File-scope guardrail blocked completion</span>
          </p>
          <ul className="mt-2 space-y-1 font-mono text-xs text-ink">
            {s.guardrail_violations.map((v) => (
              <li key={v} className="break-all">{v}</li>
            ))}
          </ul>
        </div>
      )}

      {steps.length > 0 ? (
        <ol aria-label="Check pipeline steps" className="space-y-2">
          {steps.map((step, idx) => {
            const passed = step.status === "passed" || step.passed === true;
            const failed = step.status === "failed" || step.passed === false;
            const skipped = step.status === "skipped";
            return (
              <li
                key={`${step.name}-${idx}`}
                className="rounded-card border border-hairline bg-canvas p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-track font-mono text-xs text-ink-2">
                    {idx + 1}
                  </span>
                  {passed ? (
                    <CheckCircle2 className="size-4 shrink-0 text-success-foreground" strokeWidth={1.5} aria-hidden />
                  ) : failed ? (
                    <XCircle className="size-4 shrink-0 text-destructive-foreground" strokeWidth={1.5} aria-hidden />
                  ) : (
                    <Clock className="size-4 shrink-0 text-icon" strokeWidth={1.5} aria-hidden />
                  )}
                  <span className="font-medium text-sm text-ink">{step.name}</span>
                  <Badge
                    variant={passed ? "success" : failed ? "error" : skipped ? "secondary" : "warning"}
                    size="sm"
                    className="ml-auto font-mono"
                  >
                    {step.exit_code !== null ? `exit ${step.exit_code}` : step.status}
                  </Badge>
                  {step.elapsed_ms !== null && (
                    <span className="rounded-chip bg-track px-1.5 py-0.5 font-mono text-xs tabular-nums text-ink-2">
                      {formatDurationMs(step.elapsed_ms)}
                    </span>
                  )}
                </div>

                <p className="mt-1.5 font-mono text-xs text-ink-3 [overflow-wrap:anywhere]">$ {step.cmd}</p>
                {step.tail_line && (
                  <p
                    className={cn(
                      "mt-1.5 border-l-2 pl-2 font-mono text-xs [overflow-wrap:anywhere]",
                      passed
                        ? "border-dot-green text-ink"
                        : failed
                          ? "border-unread text-destructive-foreground"
                          : "border-hairline text-ink-2",
                    )}
                  >
                    {step.tail_line}
                  </p>
                )}

                {step.output && step.output.trim() && (
                  <Expandable expandDirection="vertical" expandBehavior="push" className="mt-2">
                    {({ isExpanded }) => (
                      <>
                        <ExpandableTrigger
                          aria-label={`Output of step ${step.name}`}
                          className="inline-flex cursor-pointer items-center rounded-control text-xs font-medium text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 max-md:px-2"
                        >
                          {isExpanded ? "Hide step output" : "Show step output"}
                        </ExpandableTrigger>
                        <ExpandableContent preset="fade">
                          <pre className="mt-2 max-h-[28vh] overflow-y-auto whitespace-pre-wrap break-all rounded-control border border-hairline bg-surface p-2.5 font-mono text-xs leading-relaxed text-ink">
                            {step.output}
                          </pre>
                        </ExpandableContent>
                      </>
                    )}
                  </Expandable>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <pre className="max-h-[36vh] min-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded-card border border-hairline bg-canvas p-3 font-mono text-xs leading-relaxed text-ink">
          Waiting for the agent run to finish before executing the check.
        </pre>
      )}
    </div>
  );
}

export function DetailBody({
  s,
  allSessions,
  requestedTab,
  openSeq,
  supportsServerV050,
  onClose,
  onOpenSession,
  onChanged,
  onDismissed,
}: {
  s: Session;
  allSessions: Session[];
  requestedTab: TabId;
  openSeq: number;
  supportsServerV050: boolean;
  onClose: () => void;
  onOpenSession: (id: string, tab?: TabId) => void;
  onChanged: () => void;
  onDismissed: () => void;
}) {
  const [tab, setTab] = useState<TabId>(requestedTab);
  const [act, setAct] = useState<Act>(null);
  const [strategy, setStrategy] = useState<MergeStrategy>(s.merge_strategy || "merge");
  const [err, setErr] = useState("");
  const [mergeOk, setMergeOk] = useState("");
  const [steer, setSteer] = useState(() => draftGet(s.id));
  const headingRef = useRef<HTMLHeadingElement>(null);

  const { mergeCheck, checkingMerge, recheckMerge } = useMergeCheck(s, supportsServerV050);

  useEffect(() => {
    setSteer(draftGet(s.id));
    setAct(null);
    setErr("");
    setMergeOk("");
    setStrategy(s.merge_strategy || "merge");
  }, [s.id, s.merge_strategy]);

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
  const ranCheck = s.check_ran !== undefined ? Boolean(s.check_ran) : s.check_passed === true || s.check_passed === false;
  const agent = s.test_mode ? "test mode (custom command)" : s.engine || s.agent || "unknown";
  const chain: string[] = [];
  if (s.spawned_from) chain.push(`Handed out automatically when ${s.spawned_from} finished.`);
  if (s.successor) chain.push(`Its finish handed out ${s.successor}.`);
  if ((s.next_queue || []).length) chain.push(`Then: ${s.next_queue!.join(", ")}.`);

  const downstream = useMemo(
    () => allSessions.filter((other) => (other.depends_on || []).includes(s.id)),
    [allSessions, s.id],
  );

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
    if (e) toast.error(e);
    else if (ok) toast.success(ok);
    onChanged();
  }

  const doMerge = async () => {
    setAct(null);
    try {
      const r = await fetch(`/api/sessions/${s.id}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy }),
      });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        const label = MERGE_STRATEGIES.find((m) => m.id === strategy)?.label || strategy;
        const text = `Merged ${s.branch} into ${j.branch || s.merge_target || "the target branch"} (${label}).`;
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
    if (!msg) {
      setErr("Write the message first.");
      return;
    }
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

  const stratLabel = MERGE_STRATEGIES.find((m) => m.id === strategy)?.label || strategy;
  const mergeQ = s.merge_target
    ? `Merge ${s.branch || "this session"} into ${s.merge_target} using ${stratLabel}? Fleet refuses if the target is dirty or conflicts.`
    : `Merge ${s.branch || "this session"} using ${stratLabel}? Fleet refuses if the target is dirty or conflicts.`;

  return (
    <div className="flex min-h-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            verified
              ? "success"
              : isFailed(s)
                ? "error"
                : s.bucket === "needs-you"
                  ? "info"
                  : s.bucket === "done"
                    ? "success"
                    : "secondary"
          }
          size="sm"
        >
          {verified ? (s.status === "merged" ? "merged" : "verified") : statusText(s)}
        </Badge>
        {s.status === "done" && mergeCheck && (
          <Pill variant={mergeCheck.clean ? "success" : "destructive"} className="px-2 py-0.5 font-mono text-xs">
            <PillIndicator variant={mergeCheck.clean ? "success" : "error"} />
            <span>
              {mergeCheck.clean
                ? "Clean merge"
                : `${mergeCheck.conflicting_files.length || 1} conflicts`}
            </span>
          </Pill>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto max-md:min-h-11 max-md:px-3"
          onClick={onClose}
          aria-label="Close this session"
        >
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
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="font-heading text-xl font-medium leading-tight text-ink outline-none md:text-[24px] [overflow-wrap:anywhere]"
        >
          {s.task}
        </h2>
        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-ink-2 tabular-nums">
          <div className="flex min-w-0 gap-2">
            <dt className="text-ink-3">Project</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere] text-ink">{s.project}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-ink-3">Agent</dt>
            <dd className="text-ink">{agent}</dd>
          </div>
          {s.model && (
            <div className="flex min-w-0 gap-2">
              <dt className="text-ink-3">Model</dt>
              <dd className="min-w-0 break-all font-mono text-xs text-ink">{s.model}</dd>
            </div>
          )}
          <div className="flex min-w-0 gap-2">
            <dt className="text-ink-3">Branch</dt>
            <dd className="min-w-0 break-all font-mono text-xs text-ink">{s.branch || "—"}</dd>
          </div>
          {s.queue_position ? (
            <div className="flex gap-2">
              <dt className="text-ink-3">Queue</dt>
              <dd className="font-mono text-ink">#{s.queue_position}</dd>
            </div>
          ) : null}
        </dl>

        {((s.depends_on && s.depends_on.length > 0) || downstream.length > 0) && (
          <div className="mt-3 space-y-1.5 rounded-card border border-hairline bg-canvas p-2.5 text-xs">
            {s.depends_on && s.depends_on.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1 font-medium text-ink-2">
                  <GitBranch className="size-3.5 text-icon" strokeWidth={1.5} aria-hidden />
                  <span>Depends on:</span>
                </span>
                {s.depends_on.map((depId) => {
                  const target = allSessions.find((x) => x.id === depId);
                  return (
                    <Button
                      key={depId}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => target && onOpenSession(target.id, "tr")}
                      disabled={!target}
                      className="h-7 px-2 font-mono text-xs max-md:min-h-11"
                    >
                      {depId}
                      {target ? ` (${statusText(target)})` : ""}
                    </Button>
                  );
                })}
              </div>
            )}
            {downstream.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-ink-2">Unblocks:</span>
                {downstream.map((child) => (
                  <Button
                    key={child.id}
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onOpenSession(child.id, "tr")}
                    className="h-7 px-2 font-mono text-xs max-md:min-h-11"
                  >
                    {child.id}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}

        {s.allowed_globs && s.allowed_globs.length > 0 && (
          <p className="mt-2 font-mono text-xs text-ink-3 [overflow-wrap:anywhere]">
            Allowed scope: <span className="text-ink-2">{s.allowed_globs.join(", ")}</span>
          </p>
        )}

        {chain.map((c) => (
          <p key={c} className="mt-2 text-sm text-ink-2 [overflow-wrap:anywhere]">
            {c}
          </p>
        ))}
        {s.transcript.some((l) => l.includes("restored from its record")) && (
          <p className="mt-2 text-sm text-ink-2">This session was restored from its record after the session store was lost.</p>
        )}
      </div>

      {verified && (
        <section aria-label="Receipt" className="relative rounded-card border border-hairline bg-canvas p-4">
          <p className="border-l-2 border-dot-green pl-2.5 font-medium text-ink">Check passed: verified done</p>
          <p className="mt-2 font-mono text-sm text-ink [overflow-wrap:anywhere]">{receiptLine(s)}</p>
          <p className="mt-1 font-mono text-xs text-ink-3 [overflow-wrap:anywhere]">
            verified by: <span className="text-ink-2">{s.check_cmd || "policy check"}</span>
          </p>
          <Expandable expandDirection="vertical" expandBehavior="push" className="mt-3">
            {({ isExpanded }) => (
              <>
                <ExpandableTrigger
                  aria-label="Details of the check output"
                  className="inline-flex cursor-pointer items-center rounded-control text-sm text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 max-md:px-2"
                >
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

      {s.status === "done" && (
        <div className="space-y-2.5 rounded-card border border-hairline bg-canvas p-3">
          <MergeStrategyControl value={strategy} onChange={setStrategy} />
        </div>
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
              onClick={() =>
                act === "merge"
                  ? void doMerge()
                  : act === "dismiss"
                    ? onDismissed()
                    : void run(() => postJson(`/api/sessions/${s.id}/stop`), "Stopped")
              }
            >
              {act === "merge" ? "Merge now" : act === "dismiss" ? "Dismiss now" : "Stop now"}
            </Button>
            <Button variant="outline" className="max-md:min-h-11 max-md:px-4" onClick={() => setAct(null)}>
              Keep it
            </Button>
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
            <Button
              variant="outline"
              onClick={() => void run(() => postJson(`/api/sessions/${s.id}/retry`), "Retrying the session")}
              className="max-md:min-h-11 max-md:px-4"
            >
              <RotateCcw className="size-4" strokeWidth={1.5} aria-hidden />Retry this session
            </Button>
          )}
          {s.status === "needs-you" && (
            <Button variant="ghost" onClick={() => setAct("dismiss")} className="max-md:min-h-11 max-md:px-4">
              Dismiss
            </Button>
          )}
          {(s.status === "queued" || s.status === "blocked" || s.status === "working" || s.status === "checking") && (
            <Button variant="destructive-outline" onClick={() => setAct("stop")} className="max-md:min-h-11 max-md:px-4">
              <Square className="size-4" strokeWidth={1.5} aria-hidden />Stop this session
            </Button>
          )}
        </div>
      )}

      {mergeOk && (
        <p role="status" className="border-l-2 border-dot-green pl-2.5 text-sm text-ink [overflow-wrap:anywhere]">
          {mergeOk}
        </p>
      )}

      {s.merge_error && (
        <div className="rounded-card bg-pill-pro-bg p-3 text-destructive-foreground">
          <p className="text-sm font-medium text-ink [overflow-wrap:anywhere]">
            {s.merge_error.message || "The merge was refused."}
          </p>
          {s.merge_error.detail && (
            <Expandable expandDirection="vertical" expandBehavior="push" className="mt-2">
              {({ isExpanded }) => (
                <>
                  <ExpandableTrigger
                    aria-label="Details of the refused merge"
                    className="inline-flex cursor-pointer items-center rounded-control text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 max-md:px-2"
                  >
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

      {err && (
        <p role="alert" className="text-sm text-destructive-foreground [overflow-wrap:anywhere]">
          {err}
        </p>
      )}

      <div>
        <div
          role="tablist"
          aria-label="Session views"
          onKeyDown={onTabKey}
          className="inline-flex gap-0.5 rounded-control bg-track p-0.5"
        >
          <AnimatedBackground
            defaultValue={tab}
            onValueChange={(id) => id && setTab(id as TabId)}
            className="rounded-segment bg-ink-button"
            transition={glide}
          >
            {(
              [
                ["tr", "Transcript"],
                ["df", "Diff"],
                ["rc", "Receipt"],
              ] as const
            ).map(([id, label]) => (
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
            <VirtualizedTranscript
              sessionId={s.id}
              lines={s.transcript}
              totalHint={s.transcript_total}
              isRunning={isActivelyRunning(s)}
              supportsServerV050={supportsServerV050}
            />
          )}

          {tab === "df" && (
            <>
              <RichDiffViewer
                session={s}
                supportsServerV050={supportsServerV050}
                mergeCheck={mergeCheck}
                checkingMerge={checkingMerge}
                onRecheckMerge={recheckMerge}
              />
              {s.status !== "merged" && <BranchFileEditor sessionId={s.id} onSaved={onChanged} />}
            </>
          )}

          {tab === "rc" && <ReceiptStepTimeline s={s} ranCheck={ranCheck} />}
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
            onChange={(e) => {
              setSteer(e.target.value);
              draftSet(s.id, e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void sendSteer();
              }
            }}
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => void sendSteer()} className="max-md:min-h-11 max-md:px-4">
              <Send className="size-4" strokeWidth={1.5} aria-hidden />Send to the agent
            </Button>
          </div>
          <p id="steerHint" className="mt-2 text-xs leading-relaxed text-ink-3">
            {hint}
          </p>
        </section>
      )}
    </div>
  );
}
