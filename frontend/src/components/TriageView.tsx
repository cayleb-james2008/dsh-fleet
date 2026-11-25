import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  ExternalLink,
  FileCode2,
  Image as ImageIcon,
  Layers,
  MessageSquare,
  Pin,
  PinOff,
  Send,
  ShieldAlert,
  Sparkles,
  Wrench,
} from "lucide-react";
import {
  extractLocalFilePaths,
  openFileInAuxPane,
  openWorkerConversation,
  parseScreenshotLines,
  sendConfirmedNudge,
} from "../sidecar";
import type { SwarmMember, SwarmSnapshot, TriageItem } from "../types";
import { Badge, Button, Card, StatusDot, Textarea, cn, fmtElapsed, fmtTimeAgo, fmtTokens, humanizeStatus, toast } from "../ui";

const SEVERITY_BADGE: Record<TriageItem["severity"], { tone: "danger" | "warning" | "info"; label: string }> = {
  urgent: { tone: "danger", label: "Urgent" },
  attention: { tone: "warning", label: "Needs reply" },
  verify: { tone: "info", label: "Verify" },
};

const WORKSTREAM_TONE: Record<string, "success" | "info" | "danger" | "neutral"> = {
  done: "success",
  verified: "success",
  completed: "success",
  running: "info",
  in_progress: "info",
  blocked: "danger",
  failed: "danger",
};

function unstickPresetFor(item: TriageItem): Array<{ label: string; prompt: string }> {
  const ref = item.seq > 0 ? ` (#${item.seq})` : "";
  if (item.kind === "quota") {
    return [
      { label: "Resume", prompt: `@${item.member} Quota/rate limit should be clear now${ref}. Resume your current task.` },
      { label: "Handoff status", prompt: `@${item.member} Post a brief summary of what remains${ref} so we can switch models or hand off.` },
    ];
  }
  if (item.kind === "stuck" || item.kind === "error" || item.kind === "blocked") {
    return [
      { label: "Unstick", prompt: `@${item.member} You appear ${item.kind}${ref}. Isolate the failing step, summarize root cause, and post [blocked] or continue.` },
      { label: "Ask status", prompt: `@${item.member} Share exact error output and files touched so far${ref}.` },
    ];
  }
  return [
    { label: "Follow up", prompt: item.suggestedPrompt },
    { label: "Proceed", prompt: `@${item.member} Approved${ref}. Proceed with your recommended option and report [done] when verified.` },
  ];
}

export function TriageView({
  snap,
  pinnedSeqs,
  selectedIdx = 0,
  replyNonce = 0,
  onSelectIdx,
  onTogglePin,
  onJumpToBoardSeq,
  onRefresh,
}: {
  snap: SwarmSnapshot;
  pinnedSeqs: number[];
  selectedIdx?: number;
  replyNonce?: number;
  onSelectIdx?: (idx: number) => void;
  onTogglePin: (seq: number) => void;
  onJumpToBoardSeq: (seq: number) => void;
  onRefresh: () => void;
}) {
  const [nudgeTarget, setNudgeTarget] = useState<TriageItem | null>(null);
  const [nudgeDraft, setNudgeDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [peekId, setPeekId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const triage = snap.triage || [];
  const plan = snap.plan;
  const frames = snap.frames || [];
  const pinnedSet = new Set(pinnedSeqs);
  const pinnedMsgs = (snap.messages || []).filter((m) => !m.control && pinnedSet.has(m.seq));
  const memberByName = new Map((snap.members || []).map((m) => [m.name, m]));
  const canNudge = Boolean(snap.capabilities?.canSendMessage || window.sidecar?.agent?.sendMessage);
  const canOpenAux = Boolean(window.sidecar?.ui?.toggleAuxPane);

  useEffect(() => {
    const el = cardRefs.current[selectedIdx];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  useEffect(() => {
    if (!replyNonce) return;
    const item = triage[selectedIdx];
    if (!item) return;
    const prefix = `@${item.member}${item.seq > 0 ? ` Re #${item.seq}` : ""}: `;
    if (canNudge && item.conversationId) {
      setNudgeTarget(item);
      setNudgeDraft(prefix);
    } else {
      handleCopy(prefix, `Copied reply prefix for @${item.member}`);
    }
  }, [replyNonce]);

  const openNudge = (item: TriageItem, customPrompt?: string) => {
    setNudgeTarget(item);
    setNudgeDraft(customPrompt ?? item.suggestedPrompt);
  };

  const handleConfirmNudge = async () => {
    if (!nudgeTarget || !nudgeDraft.trim()) return;
    setSending(true);
    try {
      await sendConfirmedNudge(nudgeTarget.conversationId, nudgeDraft.trim());
      toast.success(`Sent nudge to ${nudgeTarget.member}`);
      setNudgeTarget(null);
      setNudgeDraft("");
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send nudge");
    } finally {
      setSending(false);
    }
  };

  const handleCopy = async (text: string, label = "Copied") => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(label);
    } catch {
      toast.error("Clipboard unavailable");
    }
  };

  const handleOpenPath = (filePath: string) => {
    if (canOpenAux && openFileInAuxPane(filePath)) {
      toast.success(`Opened ${filePath.split("/").pop() || "file"}`);
      return;
    }
    handleCopy(filePath, "File path copied");
  };

  return (
    <div className="space-y-4">
      {/* Needs-You Triage Inbox */}
      <section aria-labelledby="triage-heading" className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="triage-heading" className="text-[14px] font-semibold text-[var(--ink)]">
            Needs you ({triage.length})
          </h2>
          {triage.length === 0 ? (
            <Badge tone="success">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              All clear
            </Badge>
          ) : (
            <div className="hidden sm:flex items-center gap-2 text-[12px] text-[var(--ink-3)] mono">
              <span>j/k move</span>
              <span>o chat</span>
              <span>p pin</span>
              <span>r reply</span>
              <span>? help</span>
            </div>
          )}
        </div>

        {triage.length === 0 ? (
          <Card className="p-3.5 bg-[var(--board)]">
            <p className="text-[14px] text-[var(--ink-2)]">
              No stalled workers, failed steps, open questions, or unverified deliverables right now.
            </p>
          </Card>
        ) : (
          <div className="space-y-2">
            {triage.map((item, idx) => {
              const isSelected = idx === selectedIdx;
              const isPinned = item.seq > 0 && pinnedSet.has(item.seq);
              const sev = SEVERITY_BADGE[item.severity];
              const editingThis = nudgeTarget?.id === item.id;
              const worker: SwarmMember | undefined = memberByName.get(item.member);
              const peeking = peekId === item.id;
              const tools = worker?.recentTools || [];
              const presets = unstickPresetFor(item);
              const { cleanText: cleanDetail, shots: detailShots } = parseScreenshotLines(item.detail);
              const paths = extractLocalFilePaths(cleanDetail);
              const lastTs = worker?.lastStepAt
                ? Date.parse(worker.lastStepAt)
                : worker?.transcriptMtime || worker?.lastPostTs || 0;
              const elapsedMs = lastTs > 0 ? Math.max(0, nowMs - lastTs) : 0;
              const elapsed = lastTs > 0 ? fmtElapsed(lastTs, nowMs) : "";
              const isStalled = item.kind === "stuck" || (!worker?.killed && worker?.status === "working" && elapsedMs >= 600_000);
              const askStatusPrompt = `@${item.member} Quick status check${item.seq > 0 ? ` (#${item.seq})` : ""}: current step and any blockers?`;

              return (
                <div
                  key={item.id}
                  ref={(el) => {
                    cardRefs.current[idx] = el;
                  }}
                  data-selected={isSelected ? "true" : undefined}
                  onClick={() => onSelectIdx?.(idx)}
                >
                  <Card
                    className={cn(
                      "p-3 space-y-2",
                      isSelected && "border-[var(--blue)] ring-1 ring-[var(--blue)]",
                    )}
                  >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={sev.tone}>
                          {item.severity === "urgent" ? (
                            <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : item.severity === "attention" ? (
                            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          {sev.label}
                        </Badge>
                        {worker && !worker.killed && (
                          <Badge tone={worker.status === "working" ? "success" : "neutral"} className="num">
                            {worker.status === "working" ? "working" : "waiting"}
                            {elapsed ? ` ${elapsed}` : ""}
                          </Badge>
                        )}
                        {isStalled && <Badge tone="danger">stalled</Badge>}
                        <span className="text-[12px] font-medium text-[var(--ink-2)] num">
                          {item.timestamp ? fmtTimeAgo(item.timestamp) : "now"}
                        </span>
                      </div>
                      <p className="text-[14px] font-medium text-[var(--ink)] break-words">{item.title}</p>
                    </div>
                  </div>

                  {cleanDetail && (
                    <p className="text-[13px] text-[var(--ink-2)] break-words leading-snug">{cleanDetail}</p>
                  )}

                  {(detailShots.length > 0 || paths.length > 0) && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {detailShots.map((s) => (
                        <Button
                          key={s.path}
                          variant="secondary"
                          size="sm"
                          onClick={() => handleOpenPath(s.path)}
                          className="max-w-full"
                        >
                          <ImageIcon className="h-3.5 w-3.5 shrink-0 text-[var(--info-foreground)]" aria-hidden="true" />
                          <span className="truncate">{s.caption || s.fileName}</span>
                        </Button>
                      ))}
                      {paths.map((fp) => (
                        <Button
                          key={fp}
                          variant="secondary"
                          size="sm"
                          onClick={() => handleOpenPath(fp)}
                          className="max-w-full"
                        >
                          <FileCode2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span className="truncate mono">{fp.split("/").pop()}</span>
                        </Button>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    {item.conversationId && window.sidecar?.ui?.toggleConversation && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => openWorkerConversation(item.conversationId)}
                      >
                        <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                        Open chat
                      </Button>
                    )}

                    {canNudge && item.conversationId ? (
                      <>
                        <Button variant="outline" size="sm" onClick={() => openNudge(item, presets[0].prompt)}>
                          {item.severity === "urgent" ? (
                            <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <Send className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          {item.severity === "urgent" ? presets[0].label : "Nudge"}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openNudge(item, askStatusPrompt)}>
                          Ask status
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleCopy(presets[0].prompt, "Follow-up prompt copied")}
                        >
                          <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
                          Copy {item.severity === "urgent" ? presets[0].label.toLowerCase() : "follow-up"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleCopy(askStatusPrompt, "Status prompt copied")}
                        >
                          Ask status
                        </Button>
                      </>
                    )}

                    {worker && (tools.length > 0 || worker.thinkingHeading) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-expanded={peeking}
                        onClick={() => setPeekId(peeking ? null : item.id)}
                      >
                        {peeking ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
                        Peek
                      </Button>
                    )}

                    {item.seq > 0 && (
                      <div className="flex items-center gap-1 ml-auto">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-pressed={isPinned}
                          aria-label={isPinned ? `Unpin #${item.seq}` : `Pin #${item.seq}`}
                          onClick={() => onTogglePin(item.seq)}
                          className="px-2"
                        >
                          {isPinned ? <PinOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Pin className="h-3.5 w-3.5" aria-hidden="true" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onJumpToBoardSeq(item.seq)}
                          className="num"
                        >
                          #{item.seq}
                          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    )}
                  </div>

                  {peeking && worker && (
                    <div className="rounded-[var(--radius-chip)] bg-[var(--board)] p-2.5 space-y-1.5 text-[12px]">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[var(--ink-2)] num">
                        <span className="font-medium text-[var(--ink)]">{worker.steps} steps</span>
                        <span>
                          {fmtTokens(worker.usage.totalTokens)} tok (in {fmtTokens(worker.usage.inputTokens)} / cache{" "}
                          {fmtTokens(worker.usage.cacheReadTokens)} / out {fmtTokens(worker.usage.outputTokens)})
                        </span>
                      </div>
                      {worker.thinkingHeading && (
                        <p className="text-[var(--ink-2)] truncate">Thinking: {worker.thinkingHeading}</p>
                      )}
                      {tools.length > 0 && (
                        <ul className="space-y-1 text-[var(--ink-2)]" aria-label={`Recent tool calls for ${worker.name}`}>
                          {tools.map((tc, idx) => (
                            <li key={idx} className="flex items-center justify-between gap-2">
                              <span className="truncate">{tc.summary}</span>
                              <span className="text-[var(--ink-3)] shrink-0 mono">{tc.name}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {editingThis && (
                    <div className="pt-2 border-t border-[var(--hairline)] space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <label htmlFor={`nudge-${item.id}`} className="text-[12px] font-medium text-[var(--ink-2)]">
                          Confirm message to @{item.member}
                        </label>
                        <div className="flex flex-wrap items-center gap-1">
                          {presets.map((p) => (
                            <button
                              key={p.label}
                              type="button"
                              onClick={() => setNudgeDraft(p.prompt)}
                              className="rounded-[var(--radius-chip)] bg-[var(--track)] px-2 py-0.5 text-[12px] font-medium text-[var(--ink)] hover:bg-[var(--hairline)] cursor-pointer"
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <Textarea
                        id={`nudge-${item.id}`}
                        rows={2}
                        value={nudgeDraft}
                        onChange={(e) => setNudgeDraft(e.target.value)}
                      />
                      <div className="flex items-center justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setNudgeTarget(null)}>
                          Cancel
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={sending || !nudgeDraft.trim()}
                          onClick={handleConfirmNudge}
                        >
                          <Send className="h-3.5 w-3.5" aria-hidden="true" />
                          {sending ? "Sending..." : "Confirm & send"}
                        </Button>
                      </div>
                    </div>
                  )}
                  </Card>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Pinned Board Posts */}
      {pinnedMsgs.length > 0 && (
        <section aria-labelledby="pinned-triage-heading" className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Pin className="h-4 w-4 text-[var(--info-foreground)]" aria-hidden="true" />
            <h2 id="pinned-triage-heading" className="text-[14px] font-semibold text-[var(--ink)]">
              Pinned posts ({pinnedMsgs.length})
            </h2>
          </div>
          <Card className="p-2.5">
            <ul className="divide-y divide-[var(--hairline)]">
              {pinnedMsgs.map((pm) => (
                <li key={pm.seq} className="flex items-center justify-between gap-2 py-1.5 first:pt-0.5 last:pb-0.5">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[var(--ink)] truncate">
                      <span className="num">#{pm.seq}</span> {pm.agent}
                    </p>
                    <p className="text-[12px] text-[var(--ink-2)] truncate">{parseScreenshotLines(pm.text).cleanText || pm.text.replace(/\/home\/[^/\s]+\//g, "~/")}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="sm" className="num" onClick={() => onJumpToBoardSeq(pm.seq)}>
                      #{pm.seq}
                      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`Unpin #${pm.seq}`} onClick={() => onTogglePin(pm.seq)}>
                      <PinOff className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {/* Coordinator Plan & Workstreams (single tonal card, hairline dividers) */}
      {plan && (
        <section aria-labelledby="plan-heading" className="space-y-2.5">
          <div className="flex items-center gap-1.5">
            <Layers className="h-4 w-4 text-[var(--ink-3)]" aria-hidden="true" />
            <h2 id="plan-heading" className="text-[14px] font-semibold text-[var(--ink)]">
              Swarm plan
            </h2>
          </div>

          <Card className="p-3 space-y-2.5">
            {plan.goal && <p className="text-[14px] font-medium text-[var(--ink)] break-words">{plan.goal}</p>}
            {plan.gate && (
              <div className="rounded-[var(--radius-chip)] bg-[var(--board)] px-2.5 py-1.5 text-[12px] text-[var(--ink-2)]">
                <span className="font-medium text-[var(--ink)]">Gate: </span>
                <code className="mono break-all">{plan.gate}</code>
              </div>
            )}
            {Array.isArray(plan.workstreams) && plan.workstreams.length > 0 && (
              <ul className="divide-y divide-[var(--hairline)]" aria-label="Workstreams">
                {plan.workstreams.map((ws, i) => {
                  const st = String(ws.status || "pending").toLowerCase();
                  return (
                    <li key={ws.id || i} className="flex items-center justify-between gap-2 py-2 first:pt-1 last:pb-0">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-[var(--ink)] truncate">{ws.title}</p>
                        {ws.owner && <p className="text-[12px] text-[var(--ink-3)]">@{ws.owner}</p>}
                      </div>
                      <Badge tone={WORKSTREAM_TONE[st] || "neutral"}>{humanizeStatus(ws.status)}</Badge>
                    </li>
                  );
                })}
              </ul>
            )}
            {Array.isArray(plan.milestones) && plan.milestones.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {plan.milestones.map((ms, idx) => (
                  <Badge key={idx} tone={WORKSTREAM_TONE[String(ms.status || "").toLowerCase()] || "neutral"}>
                    <StatusDot state={ms.status === "done" || ms.status === "completed" ? "ok" : "waiting"} />
                    {ms.title} ({humanizeStatus(ms.status)})
                  </Badge>
                ))}
              </div>
            )}
          </Card>
        </section>
      )}

      {/* Screenshot Reel with 1-click Open file in Aux Pane */}
      {frames.length > 0 && (
        <section aria-labelledby="reel-heading" className="space-y-2.5">
          <div className="flex items-center gap-1.5">
            <ImageIcon className="h-4 w-4 text-[var(--ink-3)]" aria-hidden="true" />
            <h2 id="reel-heading" className="text-[14px] font-semibold text-[var(--ink)]">
              Verified captures ({frames.length})
            </h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {frames.map((frame) => {
              const src = `/api/frame?conversationId=${encodeURIComponent(snap.swarm || snap.conversationId || "")}&path=${encodeURIComponent(frame.path)}`;
              return (
                <Card key={frame.path} className="overflow-hidden">
                  <div className="bg-[var(--board)] border-b border-[var(--hairline)] aspect-video flex items-center justify-center overflow-hidden">
                    <img
                      src={src}
                      alt={frame.caption || `Screenshot from #${frame.seq}`}
                      loading="lazy"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                    <span className="text-[12px] text-[var(--ink-2)] truncate">
                      {frame.caption || frame.path.split("/").pop()}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Open ${frame.caption || "capture"} file`}
                        onClick={() => handleOpenPath(frame.path)}
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        Open file
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="num"
                        onClick={() => onJumpToBoardSeq(frame.seq)}
                      >
                        #{frame.seq}
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
