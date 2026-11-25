import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  CheckCircle2,
  Clock,
  FileCode2,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Play,
  RotateCcw,
  Send,
  ShieldAlert,
  Square,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import {
  Badge,
  Button,
  Expandable,
  StatusDot,
  Textarea,
  cn,
  toast,
} from "./ui";
import { glide, instant } from "./motion";
import {
  formatDurationMs,
  getWebEngine,
  healBadgeInfo,
  HONEST,
  isActivelyRunning,
  isFailed,
  isHonest,
  isVerified,
  postJson,
  receiptLine,
  statusText,
  type CheckStepReceipt,
  type MergeCheckResult,
  type MergeStrategy,
  type Session,
  type TabId,
} from "./api";
import { VirtualizedTranscript } from "./transcript";
import { MERGE_STRATEGIES, MergeStrategyControl, RichDiffViewer } from "./diff";

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
    <Expandable
      triggerLabel={`Edit branch worktree files (${names.length})`}
      openLabel={`Hide branch worktree editor (${names.length})`}
      className="mt-4"
    >
      <div className="space-y-2.5 pt-2">
        <div className="flex flex-wrap gap-1.5">
          {names.map((name) => (
            <Button
              key={name}
              type="button"
              size="sm"
              variant={activeFile === name ? "primary" : "outline"}
              onClick={() => selectFile(name)}
              className="mono"
            >
              <FileCode2 className="size-3.5" strokeWidth={1.5} aria-hidden />
              <span>{name}</span>
            </Button>
          ))}
        </div>
        <Textarea
          aria-label={`Source code of ${activeFile}`}
          rows={10}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="mono text-[12px] leading-relaxed"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12px] text-[var(--ink-3)]">
            Edits apply only to this session branch and re-run the Web Worker check pipeline.
          </p>
          <Button type="button" size="sm" variant="primary" disabled={saving} onClick={saveAndCheck}>
            <Play className="size-3.5" strokeWidth={1.5} aria-hidden />
            <span>{saving ? "Running check..." : "Save and re-run check"}</span>
          </Button>
        </div>
      </div>
    </Expandable>
  );
}

function AutoHealTimeline({ s }: { s: Session }) {
  const attempts = s.heal_attempts ?? [];
  if (attempts.length === 0) return null;
  const badge = healBadgeInfo(s);
  const totalMs = attempts.reduce((acc, a) => acc + (typeof a.elapsed_ms === "number" ? a.elapsed_ms : 0), 0);

  return (
    <section
      aria-label="Auto-heal timeline"
      data-testid="auto-heal-timeline"
      className="space-y-3 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] p-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--ink)]">
          <Wrench className="size-4 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
          <span>Auto-heal timeline</span>
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {badge && (
            <Badge tone={badge.tone === "healed" ? "success" : badge.tone === "healing" ? "warning" : "danger"} className="mono">
              <StatusDot
                tone={badge.tone === "healed" ? "green" : badge.tone === "healing" ? "amber" : "red"}
                pulse={badge.tone === "healing"}
              />
              <span>{badge.fullLabel}</span>
            </Badge>
          )}
          {totalMs > 0 && (
            <span className="rounded-[var(--radius-chip)] bg-[var(--track)] px-2 py-0.5 mono text-[12px] text-[var(--ink-2)]">
              {formatDurationMs(totalMs)}
            </span>
          )}
        </div>
      </div>

      <ol aria-label="Auto-heal attempts" className="space-y-2">
        {attempts.map((a) => (
          <li key={a.attempt} className="rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--surface)] p-3 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--track)] mono text-[12px] text-[var(--ink-2)]">
                {a.attempt}
              </span>
              {a.healed ? (
                <CheckCircle2 className="size-4 shrink-0 text-[var(--success-foreground)]" strokeWidth={1.5} aria-hidden />
              ) : (
                <XCircle className="size-4 shrink-0 text-[var(--destructive-foreground)]" strokeWidth={1.5} aria-hidden />
              )}
              <span className="mono text-[12px] font-medium text-[var(--ink)]">{a.trigger_step}</span>
              <Badge tone={a.healed ? "success" : "warning"} className="ml-auto mono">
                {a.healed ? "healed" : a.exit_code !== null ? `exit ${a.exit_code}` : "retried"}
              </Badge>
              {a.elapsed_ms !== null && (
                <span className="rounded-[var(--radius-chip)] bg-[var(--track)] px-2 py-0.5 mono text-[12px] text-[var(--ink-2)]">
                  {formatDurationMs(a.elapsed_ms)}
                </span>
              )}
            </div>

            {a.stderr_tail && (
              <p className="mt-2 border-l-2 border-[var(--dot-red)] pl-2.5 mono text-[12px] text-[var(--destructive-foreground)] [overflow-wrap:anywhere]">
                {a.stderr_tail}
              </p>
            )}

            {a.prompt_sent && (
              <Expandable
                triggerLabel={`Diagnostic steer prompt for attempt ${a.attempt}`}
                openLabel={`Hide steer prompt (${a.attempt})`}
                className="mt-2 bg-[var(--canvas)]"
              >
                <pre className="max-h-[24vh] overflow-y-auto whitespace-pre-wrap break-all mono text-[12px] leading-relaxed text-[var(--ink)]">
                  {a.prompt_sent}
                </pre>
              </Expandable>
            )}
          </li>
        ))}
      </ol>
    </section>
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
            "text-[14px] font-medium",
            ranCheck ? (s.check_passed ? "text-[var(--success-foreground)]" : "text-[var(--destructive-foreground)]") : "text-[var(--ink-2)]",
          )}
        >
          {!ranCheck
            ? "No check has run yet."
            : s.check_passed
              ? `Passed (${steps.filter((x) => x.status === "passed").length}/${steps.length} ${steps.length === 1 ? "step" : "steps"}).`
              : `Failed${s.check_exit != null ? ` with exit code ${s.check_exit}` : ""}.`}
        </p>
        {totalMs > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-chip)] bg-[var(--track)] px-2 py-0.5 mono text-[12px] text-[var(--ink-2)]">
            <Clock className="size-3 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
            <span>{formatDurationMs(totalMs)}</span>
          </span>
        )}
      </div>

      {s.guardrail_violations && s.guardrail_violations.length > 0 && (
        <div role="status" className="rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--bad-soft)] p-3 text-[var(--destructive-foreground)]">
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--ink)]">
            <ShieldAlert className="size-4 text-[var(--destructive-foreground)]" strokeWidth={1.5} aria-hidden />
            <span>File-scope guardrail blocked completion</span>
          </p>
          <ul className="mt-2 space-y-1 mono text-[12px] text-[var(--ink)]">
            {s.guardrail_violations.map((v) => (
              <li key={v} className="break-all">{v}</li>
            ))}
          </ul>
        </div>
      )}

      <AutoHealTimeline s={s} />

      {steps.length > 0 ? (
        <ol aria-label="Check pipeline steps" className="space-y-2">
          {steps.map((step, idx) => {
            const passed = step.status === "passed" || step.passed === true;
            const failed = step.status === "failed" || step.passed === false;
            const skipped = step.status === "skipped";
            return (
              <li
                key={`${step.name}-${idx}`}
                className="rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--track)] mono text-[12px] text-[var(--ink-2)]">
                    {idx + 1}
                  </span>
                  {passed ? (
                    <CheckCircle2 className="size-4 shrink-0 text-[var(--success-foreground)]" strokeWidth={1.5} aria-hidden />
                  ) : failed ? (
                    <XCircle className="size-4 shrink-0 text-[var(--destructive-foreground)]" strokeWidth={1.5} aria-hidden />
                  ) : (
                    <Clock className="size-4 shrink-0 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
                  )}
                  <span className="font-medium text-[14px] text-[var(--ink)]">{step.name}</span>
                  <Badge
                    tone={passed ? "success" : failed ? "danger" : skipped ? "neutral" : "warning"}
                    className="ml-auto mono"
                  >
                    {step.exit_code !== null ? `exit ${step.exit_code}` : step.status}
                  </Badge>
                  {step.elapsed_ms !== null && (
                    <span className="rounded-[var(--radius-chip)] bg-[var(--track)] px-2 py-0.5 mono text-[12px] text-[var(--ink-2)]">
                      {formatDurationMs(step.elapsed_ms)}
                    </span>
                  )}
                </div>

                <p className="mt-1.5 mono text-[12px] text-[var(--ink-3)] [overflow-wrap:anywhere]">$ {step.cmd}</p>
                {step.tail_line && (
                  <p
                    className={cn(
                      "mt-1.5 border-l-2 pl-2.5 mono text-[12px] [overflow-wrap:anywhere]",
                      passed
                        ? "border-[var(--dot-green)] text-[var(--ink)]"
                        : failed
                          ? "border-[var(--dot-red)] text-[var(--destructive-foreground)]"
                          : "border-[var(--hairline)] text-[var(--ink-2)]",
                    )}
                  >
                    {step.tail_line}
                  </p>
                )}

                {step.output && step.output.trim() && (
                  <Expandable
                    triggerLabel={`Output of step ${step.name}`}
                    openLabel={`Hide output (${step.name})`}
                    className="mt-2 bg-[var(--surface)]"
                  >
                    <pre className="max-h-[28vh] overflow-y-auto whitespace-pre-wrap break-all mono text-[12px] leading-relaxed text-[var(--ink)]">
                      {step.output}
                    </pre>
                  </Expandable>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <pre className="max-h-[36vh] min-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] p-3 mono text-[12px] leading-relaxed text-[var(--ink)]">
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
  mergeCheck,
  checkingMerge,
  onRecheckMerge,
  onTabChange,
  onClose,
  onOpenSession,
  onOpenPrPreview,
  onChanged,
  onDismissed,
}: {
  s: Session;
  allSessions: Session[];
  requestedTab: TabId;
  openSeq: number;
  supportsServerV050: boolean;
  mergeCheck: MergeCheckResult | null;
  checkingMerge: boolean;
  onRecheckMerge: () => void;
  onTabChange?: (tab: TabId) => void;
  onClose?: () => void;
  onOpenSession: (id: string, tab?: TabId) => void;
  onOpenPrPreview: (s: Session) => void;
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

  useEffect(() => {
    if (openSeq > 0) {
      requestAnimationFrame(() => headingRef.current?.focus());
    }
  }, [openSeq, s.id]);

  const setActiveTab = (next: TabId) => {
    setTab(next);
    onTabChange?.(next);
  };

  const verified = isVerified(s);
  const honest = isHonest(s);
  const healBadge = healBadgeInfo(s);
  const ranCheck = s.check_ran !== undefined ? Boolean(s.check_ran) : s.check_passed === true || s.check_passed === false;
  const agent = s.test_mode ? "test script" : s.engine || s.agent || "default";

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

  const [tabByKey, setTabByKey] = useState(false);
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
    setTabByKey(true);
    setActiveTab(order[j]);
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
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--hairline)] pb-3.5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              tone={
                verified
                  ? "success"
                  : isFailed(s)
                    ? "danger"
                    : s.bucket === "needs-you"
                      ? "info"
                      : s.bucket === "done"
                        ? "success"
                        : "neutral"
              }
            >
              {verified ? (s.status === "merged" ? "merged" : "verified") : statusText(s)}
            </Badge>
            <span className="mono text-[12px] text-[var(--ink-3)]">{s.id}</span>
            <span className="text-[13px] font-medium text-[var(--ink-2)]">{s.project}</span>
            <span className="mono text-[12px] text-[var(--ink-3)]">{agent}</span>
            {healBadge && (
              <Badge
                tone={healBadge.tone === "healed" ? "success" : healBadge.tone === "healing" ? "warning" : "danger"}
                className="mono"
                data-testid="workspace-heal-badge"
              >
                {healBadge.fullLabel}
              </Badge>
            )}
          </div>
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-[18px] font-semibold leading-snug text-[var(--ink)] outline-none [overflow-wrap:anywhere]"
          >
            {s.task}
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {s.status === "done" && (
            <Button variant="primary" size="sm" onClick={() => setAct("merge")}>
              <GitMerge className="size-3.5" strokeWidth={1.5} aria-hidden />
              <span>Merge</span>
            </Button>
          )}
          {s.branch && (s.status === "done" || s.status === "merged" || s.status === "needs-you") && (
            <Button
              variant={s.status === "merged" ? "primary" : "outline"}
              size="sm"
              data-testid="open-pr-preview"
              onClick={() => onOpenPrPreview(s)}
            >
              <GitPullRequest className="size-3.5" strokeWidth={1.5} aria-hidden />
              <span>PR preview</span>
            </Button>
          )}
          {s.status === "needs-you" && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void run(() => postJson(`/api/sessions/${s.id}/retry`), "Retrying the session")}
            >
              <RotateCcw className="size-3.5" strokeWidth={1.5} aria-hidden />
              <span>Retry</span>
            </Button>
          )}
          {s.status === "needs-you" && (
            <Button variant="ghost" size="sm" onClick={() => setAct("dismiss")}>
              Dismiss
            </Button>
          )}
          {(s.status === "queued" || s.status === "blocked" || s.status === "working" || s.status === "checking") && (
            <Button variant="danger" size="sm" onClick={() => setAct("stop")}>
              <Square className="size-3.5" strokeWidth={1.5} aria-hidden />
              <span>Stop</span>
            </Button>
          )}
          {onClose && (
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Clear active session">
              <X className="size-4" strokeWidth={1.5} />
            </Button>
          )}
        </div>
      </div>

      {honest && (
        <div role="status" className="rounded-[var(--radius)] border border-[var(--hairline)] border-l-2 border-l-[var(--dot-amber)] bg-[var(--surface)] px-3.5 py-2.5 text-[13px]">
          <p className="font-medium text-[var(--warning-foreground)]">{HONEST}</p>
          <p className="mt-1 text-[var(--ink-2)] [overflow-wrap:anywhere]">{s.reason || ""}</p>
        </div>
      )}

      {s.status === "needs-you" && s.reason && !honest && (
        <p
          role="status"
          className={cn(
            "rounded-[var(--radius)] border border-[var(--hairline)] border-l-2 bg-[var(--surface)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--ink)] [overflow-wrap:anywhere]",
            isFailed(s) ? "border-l-[var(--unread)]" : "border-l-[var(--blue)]",
          )}
        >
          {s.reason}
        </p>
      )}

      {act && (
        <div role="group" aria-label="Confirm action" className="rounded-[var(--radius)] border border-[var(--hairline-s)] bg-[var(--board)] p-3.5">
          <p className="text-[13px] text-[var(--ink)] [overflow-wrap:anywhere]">
            {act === "merge"
              ? mergeQ
              : act === "dismiss"
                ? "Dismiss this session? It leaves the inbox. Its log stays on disk."
                : "Stop this run now? It lands in Needs you as stopped by you."}
          </p>
          {act === "merge" && (
            <div className="mt-2.5">
              <MergeStrategyControl value={strategy} onChange={setStrategy} />
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant={act === "merge" ? "primary" : "danger"}
              size="sm"
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
            <Button variant="outline" size="sm" onClick={() => setAct(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mergeOk && (
        <p role="status" className="border-l-2 border-[var(--dot-green)] pl-3 text-[13px] text-[var(--ink)] [overflow-wrap:anywhere]">
          {mergeOk}
        </p>
      )}

      {s.merge_error && (
        <div className="rounded-[var(--radius)] border border-[var(--hairline)] border-l-2 border-l-[var(--unread)] bg-[var(--surface)] px-3.5 py-2.5">
          <p className="text-[13px] font-medium text-[var(--ink)] [overflow-wrap:anywhere]">
            {s.merge_error.message || "The merge was refused."}
          </p>
          {s.merge_error.detail && (
            <Expandable triggerLabel="Details of the refused merge" openLabel="Hide merge details" className="mt-2 bg-[var(--surface)]">
              <pre className="max-h-[28vh] overflow-y-auto whitespace-pre-wrap break-all mono text-[12px] text-[var(--ink-2)]">
                {s.merge_error.detail}
              </pre>
            </Expandable>
          )}
        </div>
      )}

      {err && (
        <p role="alert" className="text-[13px] text-[var(--destructive-foreground)] [overflow-wrap:anywhere]">
          {err}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="tablist"
          aria-label="Session views"
          onKeyDown={onTabKey}
          className="inline-flex items-center gap-0.5 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--track)] p-0.5"
        >
          {(
            [
              ["tr", "Transcript"],
              ["df", "Diff"],
              ["rc", "Receipt"],
            ] as const
          ).map(([id, label]) => {
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                data-id={id}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onPointerDown={() => setTabByKey(false)}
                onClick={() => setActiveTab(id)}
                className={cn(
                  "relative inline-flex items-center justify-center rounded-[var(--radius-segment)] px-3 h-8 text-[13px] font-medium cursor-pointer transition motion-safe:active:scale-[0.97] max-md:min-h-11",
                  "focus-visible:outline-2 focus-visible:outline-[var(--ring)]",
                  active ? "text-[var(--ink)]" : "text-[var(--ink-2)] hover:text-[var(--ink)]",
                )}
              >
                {active && (
                  <motion.span
                    layoutId="fleet-workspace-tab"
                    transition={tabByKey ? instant : glide}
                    aria-hidden="true"
                    className="absolute inset-0 rounded-[var(--radius-segment)] bg-[var(--raised)] border border-[var(--hairline)] shadow-[var(--elev-raised)]"
                  />
                )}
                <span className="relative z-10">{label}</span>
              </button>
            );
          })}
        </div>

        {((s.depends_on && s.depends_on.length > 0) || downstream.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
            <GitBranch className="size-3.5 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
            {(s.depends_on ?? []).map((depId) => {
              const target = allSessions.find((x) => x.id === depId);
              return (
                <Button
                  key={depId}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => target && onOpenSession(target.id, "tr")}
                  disabled={!target}
                  className="mono"
                >
                  dep: {depId}
                </Button>
              );
            })}
            {downstream.map((child) => (
              <Button
                key={child.id}
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onOpenSession(child.id, "tr")}
                className="mono"
              >
                next: {child.id}
              </Button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
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
          <div className="space-y-3 overflow-y-auto pr-0.5">
            <RichDiffViewer
              session={s}
              supportsServerV050={supportsServerV050}
              mergeCheck={mergeCheck}
              checkingMerge={checkingMerge}
              onRecheckMerge={onRecheckMerge}
            />
            {s.status !== "merged" && <BranchFileEditor sessionId={s.id} onSaved={onChanged} />}
          </div>
        )}

        {tab === "rc" && (
          <div className="space-y-4 overflow-y-auto pr-0.5">
            {verified && (
              <section aria-label="Receipt" className="rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] p-4">
                <p className="border-l-2 border-[var(--dot-green)] pl-2.5 text-[14px] font-medium text-[var(--ink)]">
                  Check passed: verified done
                </p>
                <p className="mt-2 mono text-[13px] text-[var(--ink)] [overflow-wrap:anywhere]">{receiptLine(s)}</p>
                <p className="mt-1 mono text-[12px] text-[var(--ink-3)] [overflow-wrap:anywhere]">
                  verified by: <span className="text-[var(--ink-2)]">{s.check_cmd || "policy check"}</span>
                </p>
                <Expandable
                  triggerLabel="Details of the check output"
                  openLabel="Hide details"
                  className="mt-3 bg-[var(--surface)]"
                >
                  <pre className="max-h-[30vh] overflow-y-auto whitespace-pre-wrap break-all mono text-[12px] text-[var(--ink-2)]">
                    {s.check_output || "(printed nothing)"}
                  </pre>
                </Expandable>
              </section>
            )}
            <ReceiptStepTimeline s={s} ranCheck={ranCheck} />
          </div>
        )}
      </div>

      {s.status !== "merged" && (
        <section className="border-t border-[var(--hairline)] pt-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="steerText" className="text-[13px] font-medium text-[var(--ink)]">
              Steer this session
            </label>
            <span id="steerHint" className="text-[12px] text-[var(--ink-3)]">
              {hint}
            </span>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Textarea
              id="steerText"
              rows={2}
              placeholder="Tell the agent what to change (Ctrl+Enter to send)"
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
              className="flex-1 min-w-[220px] min-h-11"
            />
            <Button variant="outline" size="md" onClick={() => void sendSteer()}>
              <Send className="size-4" strokeWidth={1.5} aria-hidden />
              <span>Send</span>
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
