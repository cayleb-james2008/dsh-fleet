import { useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  Image as ImageIcon,
  Layers,
  MessageSquare,
  Send,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { openWorkerConversation, sendConfirmedNudge } from "../sidecar";
import type { SwarmMember, SwarmSnapshot, TriageItem } from "../types";
import { Badge, Button, Card, StatusDot, Textarea, fmtTimeAgo, fmtTokens, humanizeStatus, toast } from "../ui";

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

export function TriageView({
  snap,
  onJumpToBoardSeq,
  onRefresh,
}: {
  snap: SwarmSnapshot;
  onJumpToBoardSeq: (seq: number) => void;
  onRefresh: () => void;
}) {
  const [nudgeTarget, setNudgeTarget] = useState<TriageItem | null>(null);
  const [nudgeDraft, setNudgeDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [peekId, setPeekId] = useState<string | null>(null);

  const triage = snap.triage || [];
  const plan = snap.plan;
  const frames = snap.frames || [];
  const memberByName = new Map((snap.members || []).map((m) => [m.name, m]));
  const canNudge = Boolean(snap.capabilities?.canSendMessage || window.sidecar?.agent?.sendMessage);

  const openNudge = (item: TriageItem) => {
    setNudgeTarget(item);
    setNudgeDraft(item.suggestedPrompt);
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

  const handleCopyPrompt = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Prompt copied");
    } catch {
      toast.error("Clipboard unavailable");
    }
  };

  return (
    <div className="space-y-4">
      {/* Needs-You Triage Inbox */}
      <section aria-labelledby="triage-heading" className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <h2 id="triage-heading" className="text-[14px] font-semibold text-[var(--ink)]">
            Needs you ({triage.length})
          </h2>
          {triage.length === 0 && (
            <Badge tone="success">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              All clear
            </Badge>
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
            {triage.map((item) => {
              const sev = SEVERITY_BADGE[item.severity];
              const editingThis = nudgeTarget?.id === item.id;
              const worker: SwarmMember | undefined = memberByName.get(item.member);
              const peeking = peekId === item.id;
              const tools = worker?.recentTools || [];
              return (
                <Card key={item.id} className="p-3 space-y-2">
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
                        <span className="text-[12px] font-medium text-[var(--ink-2)] num">
                          {item.timestamp ? fmtTimeAgo(item.timestamp) : "now"}
                        </span>
                      </div>
                      <p className="text-[14px] font-medium text-[var(--ink)] break-words">{item.title}</p>
                    </div>
                  </div>

                  {item.detail && (
                    <p className="text-[13px] text-[var(--ink-2)] break-words leading-snug">{item.detail}</p>
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
                      <Button variant="outline" size="sm" onClick={() => openNudge(item)}>
                        <Send className="h-3.5 w-3.5" aria-hidden="true" />
                        Nudge
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleCopyPrompt(item.suggestedPrompt)}
                      >
                        <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
                        Copy follow-up
                      </Button>
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
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onJumpToBoardSeq(item.seq)}
                        className="num"
                      >
                        #{item.seq}
                        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
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
                      <label htmlFor={`nudge-${item.id}`} className="block text-[12px] font-medium text-[var(--ink-2)]">
                        Confirm message to @{item.member}
                      </label>
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
              );
            })}
          </div>
        )}
      </section>

      {/* Coordinator Plan & Workstreams (single tonal card, hairline dividers — zero card-in-card) */}
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

      {/* Screenshot Reel */}
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
                    <Button
                      variant="ghost"
                      size="sm"
                      className="num shrink-0"
                      onClick={() => onJumpToBoardSeq(frame.seq)}
                    >
                      #{frame.seq}
                    </Button>
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
