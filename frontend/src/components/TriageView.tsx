import { useEffect, useRef, useState } from "../hooks";
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
  Wrench,
} from "../icons";
import {
  extractLocalFilePaths,
  openWorkerConversation,
  parseScreenshotLines,
} from "../sidecar";
import type { SwarmMember, SwarmSnapshot, TriageItem } from "../types";
import { ActivityPeek, Badge, Button, Card, GateReadinessCard, InlineComposer, MediaPathChips, Pill, PinnedList, SegBar, StatusDot, TokenBurnStrip, canLiveNudge, cn, copyText, fmtTimeAgo, fmtTokens, formatBlockerContext, humanizeStatus, memberMeta, openOrCopyPath, submitNudge, useNowMs } from "../ui";

const SEVERITY_BADGE: Record<TriageItem["severity"], { tone: "danger" | "warning" | "info"; label: string; Icon: typeof AlertTriangle }> = {
  urgent: { tone: "danger", label: "Urgent", Icon: ShieldAlert },
  attention: { tone: "warning", label: "Needs reply", Icon: AlertTriangle },
  verify: { tone: "info", label: "Verify", Icon: CheckCircle2 },
};

const WORKSTREAM_TONE: Record<string, "success" | "info" | "danger" | "neutral"> = {
  done: "success", verified: "success", completed: "success",
  running: "info", in_progress: "info", blocked: "danger", failed: "danger",
};

function unstickPresetFor(item: TriageItem): Array<{ label: string; prompt: string }> {
  const ref = item.seq > 0 ? ` (#${item.seq})` : "";
  if (item.kind === "quota") return [
    { label: "Resume", prompt: `@${item.member} Quota clear${ref}. Resume.` },
    { label: "Handoff", prompt: `@${item.member} Summarize status${ref}.` },
  ];
  if (item.kind !== "question" && item.kind !== "verify") return [
    { label: "Unstick", prompt: `@${item.member} ${item.kind}${ref}: isolate failure or continue.` },
    { label: "Status", prompt: `@${item.member} Share error and files touched${ref}.` },
  ];
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
  const nowMs = useNowMs();
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);

  const triage = snap.triage || [];
  const plan = snap.plan;
  const frames = snap.frames || [];
  const pinnedSet = new Set(pinnedSeqs);
  const pinnedMsgs = (snap.messages || []).filter((m) => !m.control && pinnedSet.has(m.seq));
  const memberByName = new Map((snap.members || []).map((m) => [m.name, m]));
  const canNudge = canLiveNudge(snap);

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
  const topBlocker = triage.find((t) => (t.severity === "urgent" || t.kind === "blocked") && t.seq > 0) || triage.find((t) => t.seq > 0);
  const buckets = [
    { label: "working", count: workingCount, cls: "bg-blue" },
    { label: "waiting", count: waitingCount, cls: "bg-warn" },
    { label: "blocked", count: blockedCount, cls: "bg-danger" },
  ];

  return (
    <div className="space-y-4">
      {/* Needs-You Triage Inbox */}
      <section aria-labelledby="triage-heading" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="triage-heading" className="h2">
            Needs you ({triage.length})
          </h2>
          {triage.length === 0 ? (
            <Badge tone="success">
              <CheckCircle2 />
              All clear
            </Badge>
          ) : (
            <div className="hidden sm:flex items-center gap-2 t3 mono">
              {["j/k move", "o chat", "p pin", "r reply", "? help"].map((k) => <span key={k}>{k}</span>)}
            </div>
          )}
        </div>

        {(liveMembers.length > 0 || triage.length > 0) && (
          <Card className="p-2 space-y-1" data-testid="bottleneck-heat-bar">
            <div className="row flex-wrap text-[12px]">
              <div className="wrap gap-2 text-ink-2">
                {buckets.map((b) => (
                  <span key={b.label} className="inline-flex items-center gap-1">
                    <span className={cn("h-2 w-2 rounded-full", b.cls)} aria-hidden="true" />
                    <span className="num">{b.count}</span> {b.label}
                  </span>
                ))}
              </div>
              {topBlocker && (
                <Button data-testid="top-blocker-jump" onClick={() => onJumpToBoardSeq(topBlocker.seq)} className="bg-board num">
                  Top #{topBlocker.seq}
                  <ArrowUpRight className="h-3 w-3" />
                </Button>
              )}
            </div>
            <SegBar
              segments={buckets.map((b) => ({ key: b.label, pct: (b.count / heatTotal) * 100, cls: b.cls }))}
              label={`Swarm activity: ${workingCount} working, ${waitingCount} waiting, ${blockedCount} blocked`}
            />
          </Card>
        )}

        <TokenBurnStrip snap={snap} />

        <GateReadinessCard snap={snap} onJump={onJumpToBoardSeq} />

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
              const { elapsed, isStalled: memberStalled } = memberMeta(worker, nowMs);
              const isStalled = item.kind === "stuck" || memberStalled;
              const askStatusPrompt = `@${item.member} Status & blockers${item.seq > 0 ? ` (#${item.seq})` : ""}?`;

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
                  <div className="space-y-1">
                    <div className="wrap">
                      <Badge tone={sev.tone}>
                        <sev.Icon />
                        {sev.label}
                      </Badge>
                      {worker && !worker.killed && (
                        <Badge tone={worker.status === "working" ? "success" : "neutral"}>
                          {worker.status}{elapsed ? ` ${elapsed}` : ""}
                        </Badge>
                      )}
                      {isStalled && <Badge tone="danger">stalled</Badge>}
                      <span className="text-[12px] font-medium text-ink-2 num">{item.timestamp ? fmtTimeAgo(item.timestamp) : "now"}</span>
                    </div>
                    <p className="text-[14px] font-medium text-ink break-words">{item.title}</p>
                  </div>

                  {cleanDetail && <p className="text-[13px] text-ink-2 break-words leading-snug">{cleanDetail}</p>}

                  <MediaPathChips shots={detailShots} paths={paths} onOpen={openOrCopyPath} />

                  {(() => {
                    const live = Boolean(canNudge && item.conversationId);
                    const urgent = item.severity === "urgent";
                    return (
                  <div className="wrap pt-1">
                    {item.conversationId && window.sidecar?.ui?.toggleConversation && (
                      <Button variant="primary" onClick={() => openWorkerConversation(item.conversationId)}>
                        <MessageSquare />
                        Open chat
                      </Button>
                    )}
                    <Button onClick={() => live ? openNudge(item, presets[0].prompt) : handleCopy(presets[0].prompt, "Follow-up prompt copied")}>
                      {!live ? <ClipboardCopy /> : urgent ? <Wrench /> : <Send />}
                      {live ? (urgent ? presets[0].label : "Nudge") : `Copy ${urgent ? presets[0].label.toLowerCase() : "follow-up"}`}
                    </Button>
                    <Button variant="ghost" onClick={() => live ? openNudge(item, askStatusPrompt) : handleCopy(askStatusPrompt, "Status prompt copied")}>
                      Ask status
                    </Button>
                    {item.kind !== "question" && (
                      <Button variant="ghost" data-testid={`copy-blocker-${item.id}`} onClick={() => handleCopy(formatBlockerContext(item, worker, snap), "Blocker context copied")}>
                        <ClipboardCopy />
                        Copy blocker
                      </Button>
                    )}
                    {worker && (tools.length > 0 || worker.thinkingHeading) && (
                      <Button variant="ghost" aria-expanded={peeking} onClick={() => setPeekId(peeking ? null : item.id)}>
                        {peeking ? <ChevronUp /> : <ChevronDown />}
                        Peek
                      </Button>
                    )}
                    {item.seq > 0 && (
                      <div className="f1 ml-auto">
                        <Button variant="ghost" aria-pressed={isPinned} aria-label={isPinned ? `Unpin #${item.seq}` : `Pin #${item.seq}`} onClick={() => onTogglePin(item.seq)} className="px-2">
                          {isPinned ? <PinOff /> : <Pin />}
                        </Button>
                        <Button variant="ghost" onClick={() => onJumpToBoardSeq(item.seq)} className="num">
                          #{item.seq}
                          <ArrowUpRight />
                        </Button>
                      </div>
                    )}
                  </div>
                    );
                  })()}

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
                        <div className="wrap gap-1">
                          {presets.map((p) => (
                            <Pill key={p.label} onClick={() => setNudgeDraft(p.prompt)} className="text-ink hover:bg-hairline">
                              {p.label}
                            </Pill>
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
          <div className="f1">
            <Pin className="text-info" />
            <h2 id="pinned-triage-heading" className="h2">Pinned posts ({pinnedMsgs.length})</h2>
          </div>
          <Card className="p-2"><PinnedList messages={pinnedMsgs} onJump={onJumpToBoardSeq} onUnpin={onTogglePin} /></Card>
        </section>
      )}

      {/* Coordinator Plan & Workstreams */}
      {plan && (
        <section aria-labelledby="plan-heading" className="space-y-2">
          <div className="f1">
            <Layers className="text-ink-3" />
            <h2 id="plan-heading" className="h2">Swarm plan</h2>
          </div>
          <Card className="p-3 space-y-2">
            {plan.goal && <p className="text-[14px] font-medium text-ink break-words">{plan.goal}</p>}
            {plan.gate && (
              <div className="rounded-chip bg-board px-2 py-1 text-[12px] text-ink-2">
                <span className="font-medium text-ink">Gate: </span>
                <code className="mono break-all">{plan.gate}</code>
              </div>
            )}
            {Array.isArray(plan.workstreams) && plan.workstreams.length > 0 && (
              <ul className="divide-y divide-hairline" aria-label="Workstreams">
                {plan.workstreams.map((ws, i) => (
                  <li key={ws.id || i} className="row py-2 first:pt-1 last:pb-0">
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-ink truncate">{ws.title}</p>
                      {ws.owner && <p className="t3">@{ws.owner}</p>}
                    </div>
                    <Badge tone={WORKSTREAM_TONE[String(ws.status || "pending").toLowerCase()] || "neutral"}>{humanizeStatus(ws.status)}</Badge>
                  </li>
                ))}
              </ul>
            )}
            {Array.isArray(plan.milestones) && plan.milestones.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
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

      {/* Screenshot Reel */}
      {frames.length > 0 && (
        <section aria-labelledby="reel-heading" className="space-y-2">
          <div className="f1">
            <ImageIcon className="text-ink-3" />
            <h2 id="reel-heading" className="h2">Verified captures ({frames.length})</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {frames.map((frame) => (
              <Card key={frame.path} className="overflow-hidden">
                <div className="bg-board border-b border-hairline aspect-video flex items-center justify-center overflow-hidden">
                  <img
                    src={`/api/frame?conversationId=${encodeURIComponent(snap.swarm || snap.conversationId || "")}&path=${encodeURIComponent(frame.path)}`}
                    alt={frame.caption || `Screenshot from #${frame.seq}`}
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="row px-2 py-2">
                  <span className="text-[12px] text-ink-2 truncate">{frame.caption || frame.path.split("/").pop()}</span>
                  <div className="f1 shrink-0">
                    <Button aria-label={`Open ${frame.caption || "capture"} file`} onClick={() => openOrCopyPath(frame.path, frame.path)}>
                      <ExternalLink />
                      Open file
                    </Button>
                    <Button variant="ghost" className="num" onClick={() => onJumpToBoardSeq(frame.seq)}>#{frame.seq}</Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
