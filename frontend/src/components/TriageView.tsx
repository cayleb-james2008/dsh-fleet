import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  ExternalLink,
  Image as ImageIcon,
  Layers,
  MessageSquare,
  Pin,
  PinOff,
  Send,
  ShieldAlert,
  Sparkles,
  Wrench,
} from "../icons";
import {
  extractLocalFilePaths,
  openWorkerConversation,
  parseScreenshotLines,
} from "../sidecar";
import type { SwarmMember, SwarmSnapshot, TriageItem } from "../types";
import { ActivityPeek, Badge, Button, Card, InlineComposer, MediaPathChips, PinnedList, StatusDot, cn, copyText, fmtElapsed, fmtTimeAgo, fmtTokens, formatBlockerContext, humanizeStatus, openOrCopyPath, submitNudge } from "../ui";

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
      { label: "Resume", prompt: `@${item.member} Quota clear${ref}. Resume current task.` },
      { label: "Handoff", prompt: `@${item.member} Summarize remaining work${ref} for handoff.` },
    ];
  }
  if (item.kind === "stuck" || item.kind === "error" || item.kind === "blocked") {
    return [
      { label: "Unstick", prompt: `@${item.member} ${item.kind}${ref}: isolate failure and post [blocked] or continue.` },
      { label: "Status", prompt: `@${item.member} Share error and files touched${ref}.` },
    ];
  }
  return [
    { label: "Follow up", prompt: item.suggestedPrompt },
    { label: "Proceed", prompt: `@${item.member} Approved${ref}. Proceed and post [done].` },
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

  const handleConfirmNudge = () => {
    if (!nudgeTarget) return;
    return submitNudge(nudgeTarget.conversationId, nudgeDraft, `Sent nudge to ${nudgeTarget.member}`, setSending, () => {
      setNudgeTarget(null);
      setNudgeDraft("");
      onRefresh();
    });
  };

  const handleCopy = (text: string, label = "Copied") => {
    void copyText(text, label);
  };

  const liveMembers = (snap.members || []).filter((m) => !m.killed);
  const blockedNames = new Set(
    triage.filter((t) => t.severity === "urgent" || t.kind === "blocked" || t.kind === "stuck").map((t) => t.member),
  );
  const blockedCount = Math.max(blockedNames.size, triage.filter((t) => t.severity === "urgent" || t.kind === "blocked").length);
  const workingCount = liveMembers.filter((m) => m.status === "working" && !blockedNames.has(m.name)).length;
  const waitingCount = liveMembers.filter((m) => m.status === "waiting" && !blockedNames.has(m.name)).length;
  const heatTotal = Math.max(1, workingCount + waitingCount + blockedCount);
  const topBlocker =
    triage.find((t) => (t.severity === "urgent" || t.kind === "blocked") && t.seq > 0) ||
    triage.find((t) => t.seq > 0);

  return (
    <div className="space-y-4">
      {/* Needs-You Triage Inbox */}
      <section aria-labelledby="triage-heading" className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="triage-heading" className="text-[14px] font-semibold text-ink">
            Needs you ({triage.length})
          </h2>
          {triage.length === 0 ? (
            <Badge tone="success">
              <CheckCircle2 className="h-3.5 w-3.5" />
              All clear
            </Badge>
          ) : (
            <div className="hidden sm:flex items-center gap-2 text-[12px] text-ink-3 mono">
              {["j/k move", "o chat", "p pin", "r reply", "? help"].map((k) => <span key={k}>{k}</span>)}
            </div>
          )}
        </div>

        {(liveMembers.length > 0 || triage.length > 0) && (() => {
          const buckets = [
            { label: "working", count: workingCount, cls: "bg-blue" },
            { label: "waiting", count: waitingCount, cls: "bg-warn" },
            { label: "blocked", count: blockedCount, cls: "bg-danger" },
          ];
          return (
            <Card className="p-2.5 space-y-1.5" data-testid="bottleneck-heat-bar">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <div className="flex flex-wrap items-center gap-2.5 text-ink-2">
                  {buckets.map((b) => (
                    <span key={b.label} className="inline-flex items-center gap-1">
                      <span className={cn("h-2 w-2 rounded-full", b.cls)} aria-hidden="true" />
                      <span className="num">{b.count}</span> {b.label}
                    </span>
                  ))}
                </div>
                {topBlocker && (
                  <Button
                    data-testid="top-blocker-jump"
                    onClick={() => onJumpToBoardSeq(topBlocker.seq)}
                    className="bg-board num"
                  >
                    Top #{topBlocker.seq}
                    <ArrowUpRight className="h-3 w-3" />
                  </Button>
                )}
              </div>
              <div
                className="h-1.5 w-full rounded-full overflow-hidden bg-track flex gap-px"
                role="img"
                aria-label={`Swarm activity: ${workingCount} working, ${waitingCount} waiting, ${blockedCount} blocked`}
              >
                {buckets.map((b) => b.count > 0 && <div key={b.label} className={cn("h-full", b.cls)} style={{ width: `${(b.count / heatTotal) * 100}%` }} />)}
              </div>
            </Card>
          );
        })()}

        {triage.length === 0 ? (
          <Card className="p-3 bg-board">
            <p className="text-[14px] text-ink-2">No blockers or unverified items.</p>
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
                <Card
                  key={item.id}
                  ref={(el) => {
                    cardRefs.current[idx] = el;
                  }}
                  data-selected={isSelected ? "true" : undefined}
                  onClick={() => onSelectIdx?.(idx)}
                  className={cn("p-3 space-y-2", isSelected && "border-blue outline-1 outline-blue")}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={sev.tone}>
                          {item.severity === "urgent" ? (
                            <ShieldAlert className="h-3.5 w-3.5" />
                          ) : item.severity === "attention" ? (
                            <AlertTriangle className="h-3.5 w-3.5" />
                          ) : (
                            <Sparkles className="h-3.5 w-3.5" />
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
                        <span className="text-[12px] font-medium text-ink-2 num">
                          {item.timestamp ? fmtTimeAgo(item.timestamp) : "now"}
                        </span>
                      </div>
                      <p className="text-[14px] font-medium text-ink break-words">{item.title}</p>
                    </div>
                  </div>

                  {cleanDetail && (
                    <p className="text-[13px] text-ink-2 break-words leading-snug">{cleanDetail}</p>
                  )}

                  <MediaPathChips shots={detailShots} paths={paths} onOpen={openOrCopyPath} />

                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    {item.conversationId && window.sidecar?.ui?.toggleConversation && (
                      <Button
                        variant="primary"
                        onClick={() => openWorkerConversation(item.conversationId)}
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                        Open chat
                      </Button>
                    )}

                    {(() => {
                      const live = Boolean(canNudge && item.conversationId);
                      const urgent = item.severity === "urgent";
                      return (
                        <>
                          <Button
                            onClick={() =>
                              live
                                ? openNudge(item, presets[0].prompt)
                                : handleCopy(presets[0].prompt, "Follow-up prompt copied")
                            }
                          >
                            {!live ? (
                              <ClipboardCopy className="h-3.5 w-3.5" />
                            ) : urgent ? (
                              <Wrench className="h-3.5 w-3.5" />
                            ) : (
                              <Send className="h-3.5 w-3.5" />
                            )}
                            {live
                              ? urgent
                                ? presets[0].label
                                : "Nudge"
                              : `Copy ${urgent ? presets[0].label.toLowerCase() : "follow-up"}`}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              live
                                ? openNudge(item, askStatusPrompt)
                                : handleCopy(askStatusPrompt, "Status prompt copied")
                            }
                          >
                            Ask status
                          </Button>
                        </>
                      );
                    })()}

                    {(item.severity === "urgent" ||
                      item.kind === "blocked" ||
                      item.kind === "error" ||
                      item.kind === "quota" ||
                      item.kind === "verify") && (
                      <Button
                        variant="ghost"
                        data-testid={`copy-blocker-${item.id}`}
                        onClick={() => handleCopy(formatBlockerContext(item, worker, snap), "Blocker context copied")}
                      >
                        <ClipboardCopy className="h-3.5 w-3.5" />
                        Copy blocker
                      </Button>
                    )}

                    {worker && (tools.length > 0 || worker.thinkingHeading) && (
                      <Button
                        variant="ghost"
                        aria-expanded={peeking}
                        onClick={() => setPeekId(peeking ? null : item.id)}
                      >
                        {peeking ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        Peek
                      </Button>
                    )}

                    {item.seq > 0 && (
                      <div className="flex items-center gap-1 ml-auto">
                        <Button
                          variant="ghost"
                          aria-pressed={isPinned}
                          aria-label={isPinned ? `Unpin #${item.seq}` : `Pin #${item.seq}`}
                          onClick={() => onTogglePin(item.seq)}
                          className="px-2"
                        >
                          {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => onJumpToBoardSeq(item.seq)}
                          className="num"
                        >
                          #{item.seq}
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>

                  {peeking && worker && <ActivityPeek member={worker} mode="triage" />}

                  {editingThis && (
                    <InlineComposer
                      id={`nudge-${item.id}`}
                      label={`@${item.member}`}
                      value={nudgeDraft}
                      onChange={setNudgeDraft}
                      onCancel={() => setNudgeTarget(null)}
                      onSubmit={handleConfirmNudge}
                      submitLabel={sending ? "Sending..." : "Confirm & send"}
                      disabled={sending}
                      headerRight={
                        <div className="flex flex-wrap items-center gap-1">
                          {presets.map((p) => (
                            <button
                              key={p.label}
                              type="button"
                              onClick={() => setNudgeDraft(p.prompt)}
                              className="rounded-chip bg-track px-2 py-0.5 text-[12px] font-medium text-ink hover:bg-hairline cursor-pointer"
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                      }
                    />
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* Pinned Board Posts */}
      {pinnedMsgs.length > 0 && (
        <section aria-labelledby="pinned-triage-heading" className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Pin className="h-4 w-4 text-info" />
            <h2 id="pinned-triage-heading" className="text-[14px] font-semibold text-ink">
              Pinned posts ({pinnedMsgs.length})
            </h2>
          </div>
          <Card className="p-2.5">
            <PinnedList messages={pinnedMsgs} onJump={onJumpToBoardSeq} onUnpin={onTogglePin} />
          </Card>
        </section>
      )}

      {/* Coordinator Plan & Workstreams (single tonal card, hairline dividers) */}
      {plan && (
        <section aria-labelledby="plan-heading" className="space-y-2.5">
          <div className="flex items-center gap-1.5">
            <Layers className="h-4 w-4 text-ink-3" />
            <h2 id="plan-heading" className="text-[14px] font-semibold text-ink">
              Swarm plan
            </h2>
          </div>

          <Card className="p-3 space-y-2.5">
            {plan.goal && <p className="text-[14px] font-medium text-ink break-words">{plan.goal}</p>}
            {plan.gate && (
              <div className="rounded-chip bg-board px-2.5 py-1.5 text-[12px] text-ink-2">
                <span className="font-medium text-ink">Gate: </span>
                <code className="mono break-all">{plan.gate}</code>
              </div>
            )}
            {Array.isArray(plan.workstreams) && plan.workstreams.length > 0 && (
              <ul className="divide-y divide-hairline" aria-label="Workstreams">
                {plan.workstreams.map((ws, i) => {
                  const st = String(ws.status || "pending").toLowerCase();
                  return (
                    <li key={ws.id || i} className="flex items-center justify-between gap-2 py-2 first:pt-1 last:pb-0">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-ink truncate">{ws.title}</p>
                        {ws.owner && <p className="text-[12px] text-ink-3">@{ws.owner}</p>}
                      </div>
                      <Badge tone={WORKSTREAM_TONE[st] || "neutral"}>{humanizeStatus(ws.status)}</Badge>
                    </li>
                  );
                })}
              </ul>
            )}
            {Array.isArray(plan.milestones) && plan.milestones.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {plan.milestones.map((ms, idx) => {
                  const tone = WORKSTREAM_TONE[String(ms.status || "").toLowerCase()] || "neutral";
                  return (
                    <Badge key={idx} tone={tone}>
                      <StatusDot state={tone === "success" ? "ok" : "waiting"} />
                      {ms.title} ({humanizeStatus(ms.status)})
                    </Badge>
                  );
                })}
              </div>
            )}
          </Card>
        </section>
      )}

      {/* Screenshot Reel with 1-click Open file in Aux Pane */}
      {frames.length > 0 && (
        <section aria-labelledby="reel-heading" className="space-y-2.5">
          <div className="flex items-center gap-1.5">
            <ImageIcon className="h-4 w-4 text-ink-3" />
            <h2 id="reel-heading" className="text-[14px] font-semibold text-ink">
              Verified captures ({frames.length})
            </h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {frames.map((frame) => {
              const src = `/api/frame?conversationId=${encodeURIComponent(snap.swarm || snap.conversationId || "")}&path=${encodeURIComponent(frame.path)}`;
              return (
                <Card key={frame.path} className="overflow-hidden">
                  <div className="bg-board border-b border-hairline aspect-video flex items-center justify-center overflow-hidden">
                    <img
                      src={src}
                      alt={frame.caption || `Screenshot from #${frame.seq}`}
                      loading="lazy"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                    <span className="text-[12px] text-ink-2 truncate">
                      {frame.caption || frame.path.split("/").pop()}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        aria-label={`Open ${frame.caption || "capture"} file`}
                        onClick={() => openOrCopyPath(frame.path, frame.path)}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open file
                      </Button>
                      <Button
                        variant="ghost"
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
