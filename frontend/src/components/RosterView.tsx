import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ClipboardCopy, Cpu, Eye, EyeOff, MessageSquare, Send } from "../icons";
import { openWorkerConversation, sendConfirmedNudge } from "../sidecar";
import type { SwarmMember, SwarmSnapshot } from "../types";
import { ActivityPeek, Badge, Button, Card, InlineComposer, StatusDot, cn, copyText, fmtElapsed, fmtTokens, toast } from "../ui";

const ORDER: Record<SwarmMember["status"], number> = { working: 0, waiting: 1, killed: 2 };
const CONTEXT_BUDGET_TOKENS = 200_000;
const STALL_MS = 10 * 60 * 1000;

function contextPressure(m: SwarmMember): { pct: number; tone: "neutral" | "info" | "warning" | "danger"; label: string } {
  const ctx = m.lastContextTokens || m.usage.inputTokens + m.usage.cacheReadTokens;
  const pct = Math.min(100, Math.round((ctx / CONTEXT_BUDGET_TOKENS) * 100));
  if (m.failure?.kind === "quota") return { pct, tone: "danger", label: "Quota paused" };
  if (m.failure) return { pct, tone: "danger", label: "Error" };
  if (m.status === "working" && m.transcriptMtime && Date.now() - m.transcriptMtime > STALL_MS) {
    return { pct, tone: "warning", label: "Stalled" };
  }
  if (ctx >= 140_000) return { pct, tone: "danger", label: `${pct}% ctx` };
  if (ctx >= 90_000) return { pct, tone: "warning", label: `${pct}% ctx` };
  if (ctx > 0) return { pct, tone: "info", label: `${pct}% ctx` };
  return { pct: 0, tone: "neutral", label: "Idle ctx" };
}

export function RosterView({
  snap,
  onRefresh,
}: {
  snap: SwarmSnapshot;
  onRefresh: () => void;
}) {
  const [showKilled, setShowKilled] = useState(false);
  const [peekMember, setPeekMember] = useState<string | null>(null);
  const [nudgeMember, setNudgeMember] = useState<string | null>(null);
  const [nudgeText, setNudgeText] = useState("");
  const [sending, setSending] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const members = snap.members || [];
  const killedCount = members.filter((m) => m.killed).length;
  const canNudge = Boolean(snap.capabilities?.canSendMessage || window.sidecar?.agent?.sendMessage);

  const sorted = useMemo(() => {
    return members
      .filter((m) => showKilled || !m.killed)
      .slice()
      .sort(
        (a, b) =>
          ORDER[a.status] - ORDER[b.status] ||
          (a.role === "coordinator" ? -1 : 0) - (b.role === "coordinator" ? -1 : 0) ||
          a.name.localeCompare(b.name),
      );
  }, [members, showKilled]);

  const sendNudge = async (member: SwarmMember) => {
    if (!nudgeText.trim() || !member.conversation_id) return;
    setSending(true);
    try {
      await sendConfirmedNudge(member.conversation_id, nudgeText.trim());
      toast.success(`Message sent to ${member.name}`);
      setNudgeMember(null);
      setNudgeText("");
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Nudge failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <h2 className="text-[14px] font-semibold text-ink">
            Roster ({members.length - killedCount} active)
          </h2>
          {killedCount > 0 && <Badge tone="neutral">{killedCount} stopped</Badge>}
        </div>
        {killedCount > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setShowKilled((v) => !v)}>
            {showKilled ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
            {showKilled ? "Hide killed" : `Show killed (${killedCount})`}
          </Button>
        )}
      </div>

      {sorted.length === 0 ? (
        <Card className="p-4 text-[14px] text-ink-2 bg-board">No workers registered on this swarm.</Card>
      ) : (
        <div className="space-y-2">
          {sorted.map((m) => {
            const isYou = snap.member === m.name;
            const lastTs = m.lastStepAt ? Date.parse(m.lastStepAt) : m.transcriptMtime || m.lastPostTs || 0;
            const elapsedMs = lastTs > 0 ? Math.max(0, nowMs - lastTs) : 0;
            const elapsed = lastTs > 0 ? fmtElapsed(lastTs, nowMs) : "";
            const isStalled = !m.killed && m.status === "working" && !m.failure && elapsedMs >= STALL_MS;
            const dotState = m.failure ? "danger" : isStalled ? "warn" : m.status;
            const baseStatus = m.killed
              ? "Killed"
              : m.failure
                ? `Paused (${m.failure.kind})`
                : m.status === "working"
                  ? "Working"
                  : m.wake_mode
                    ? `Waiting (${m.wake_mode})`
                    : "Waiting";
            const statusText = !m.killed && elapsed ? `${baseStatus} ${elapsed}` : baseStatus;
            const peeking = peekMember === m.name;
            const tools = m.recentTools || [];
            const pressure = contextPressure(m);
            const askStatusPrompt = `@${m.name} Quick status check: what step are you on and any blockers?`;
            const wrapUpPrompt = `@${m.name} Wrap up your active slice, run final verification, and post [done].`;

            return (
              <Card key={m.name} className={cn("p-3 space-y-2", m.killed && "opacity-65")}>
                {/* Line 1: Identity & Actions */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                    <StatusDot state={dotState} />
                    <span className={cn("text-[14px] font-semibold text-ink truncate", m.killed && "line-through")}>
                      {m.name}
                    </span>
                    {isYou && <Badge tone="info">you</Badge>}
                    {m.role && m.role !== "worker" && <Badge tone="neutral">{m.role}</Badge>}
                    {m.workspace_mode && m.workspace_mode !== "inherit" && (
                      <Badge tone="violet">{m.workspace_mode}</Badge>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {(tools.length > 0 || m.thinkingHeading) && (
                      <Button
                        variant={peeking ? "secondary" : "ghost"}
                        size="sm"
                        aria-label={`Peek activity for ${m.name}`}
                        aria-expanded={peeking}
                        onClick={() => setPeekMember(peeking ? null : m.name)}
                      >
                        {peeking ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
                        Peek
                      </Button>
                    )}
                    {m.conversation_id && window.sidecar?.ui?.toggleConversation && (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Open ${m.name} chat`}
                        onClick={() => openWorkerConversation(m.conversation_id)}
                      >
                        <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                        Chat
                      </Button>
                    )}
                    {!m.killed && canNudge && m.conversation_id && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Nudge ${m.name}`}
                        onClick={() => {
                          setNudgeMember(nudgeMember === m.name ? null : m.name);
                          setNudgeText(`@${m.name} `);
                        }}
                      >
                        <Send className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                </div>

                {/* Line 2: Clean spaced pills + Context Pressure */}
                <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-2">
                  <Badge tone={m.status === "working" ? "success" : "neutral"} className="num">
                    {statusText}
                  </Badge>
                  {isStalled && <Badge tone="danger">stalled</Badge>}
                  {!m.killed && <Badge tone={pressure.tone} className="num">{pressure.label}</Badge>}
                  <Badge tone="neutral" className="num">{m.steps} steps</Badge>
                  <Badge tone="neutral" className="num">{m.posts} posts</Badge>
                  {m.unread > 0 && (
                    <Badge tone="danger" className="num">{m.unread} unread</Badge>
                  )}
                  {m.model && (
                    <span className="inline-flex items-center gap-1 text-ink-3 px-1">
                      <Cpu className="h-3 w-3" aria-hidden="true" />
                      {m.model}
                    </span>
                  )}
                </div>

                {/* Quick-Action chips for active workers */}
                {!m.killed && m.conversation_id && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {canNudge ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setNudgeMember(m.name);
                            setNudgeText(askStatusPrompt);
                          }}
                          className="h-7 px-2"
                        >
                          Ask status
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setNudgeMember(m.name);
                            setNudgeText(wrapUpPrompt);
                          }}
                          className="h-7 px-2"
                        >
                          Wrap up
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void copyText(askStatusPrompt, `Copied status check for ${m.name}`)}
                        className="h-7 px-2"
                      >
                        <ClipboardCopy className="h-3 w-3" aria-hidden="true" />
                        Ask status
                      </Button>
                    )}
                  </div>
                )}

                {/* Line 3: Token telemetry & Context saturation bar */}
                <div className="rounded-chip bg-board px-2.5 py-1.5 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2.5 text-[12px] text-ink-2 num">
                    <span className="font-semibold text-ink">{fmtTokens(m.usage.totalTokens)} tok</span>
                    <span>in {fmtTokens(m.usage.inputTokens)}</span>
                    <span>cache {fmtTokens(m.usage.cacheReadTokens)}</span>
                    <span>out {fmtTokens(m.usage.outputTokens)}</span>
                  </div>
                  {!m.killed && pressure.pct > 0 && (
                    <div className="h-1 w-full overflow-hidden rounded-full bg-track" aria-hidden="true">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          pressure.tone === "danger"
                            ? "bg-[var(--dot-red)]"
                            : pressure.tone === "warning"
                              ? "bg-[var(--dot-amber)]"
                              : "bg-blue",
                        )}
                        style={{ width: `${Math.max(4, pressure.pct)}%` }}
                      />
                    </div>
                  )}
                </div>

                {/* Line 4: Shimmering live activity or error detail */}
                {!m.killed && m.status === "working" && m.activity && (
                  <p className="text-[13px] text-info fleet-live-shimmer truncate">
                    {m.activityKind === "thinking" ? `Thinking: ${m.activity}` : m.activity}
                  </p>
                )}
                {m.failure && (
                  <p className="text-[12px] text-danger break-words">{m.failure.text}</p>
                )}

                {/* Expandable Worker Activity Peek */}
                {peeking && <ActivityPeek member={m} mode="roster" />}

                {nudgeMember === m.name && (
                  <InlineComposer
                    id={`roster-nudge-${m.name}`}
                    label={`Confirm message to ${m.name}`}
                    value={nudgeText}
                    onChange={setNudgeText}
                    onCancel={() => setNudgeMember(null)}
                    onSubmit={() => sendNudge(m)}
                    disabled={sending || nudgeText.trim().length > 4000}
                    showCounter
                  />
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
