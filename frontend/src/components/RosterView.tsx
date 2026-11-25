import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Cpu, Eye, EyeOff, MessageSquare, Send } from "lucide-react";
import { openWorkerConversation, sendConfirmedNudge } from "../sidecar";
import type { SwarmMember, SwarmSnapshot } from "../types";
import { Badge, Button, Card, StatusDot, Textarea, cn, fmtTokens, toast } from "../ui";

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
          <h2 className="text-[14px] font-semibold text-[var(--ink)]">
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
        <Card className="p-4 text-[14px] text-[var(--ink-2)] bg-[var(--board)]">No workers registered on this swarm.</Card>
      ) : (
        <div className="space-y-2">
          {sorted.map((m) => {
            const isYou = snap.member === m.name;
            const dotState = m.failure ? "danger" : m.status;
            const statusText = m.killed
              ? "Killed"
              : m.failure
                ? `Paused (${m.failure.kind})`
                : m.status === "working"
                  ? "Working"
                  : m.wake_mode
                    ? `Waiting (${m.wake_mode})`
                    : "Waiting";
            const peeking = peekMember === m.name;
            const tools = m.recentTools || [];
            const pressure = contextPressure(m);

            return (
              <Card key={m.name} className={cn("p-3 space-y-2", m.killed && "opacity-65")}>
                {/* Line 1: Identity & Actions */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                    <StatusDot state={dotState} />
                    <span className={cn("text-[14px] font-semibold text-[var(--ink)] truncate", m.killed && "line-through")}>
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
                <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--ink-2)]">
                  <Badge tone={m.status === "working" ? "success" : "neutral"}>{statusText}</Badge>
                  {!m.killed && <Badge tone={pressure.tone} className="num">{pressure.label}</Badge>}
                  <Badge tone="neutral" className="num">{m.steps} steps</Badge>
                  <Badge tone="neutral" className="num">{m.posts} posts</Badge>
                  {m.unread > 0 && (
                    <Badge tone="danger" className="num">{m.unread} unread</Badge>
                  )}
                  {m.model && (
                    <span className="inline-flex items-center gap-1 text-[var(--ink-3)] px-1">
                      <Cpu className="h-3 w-3" aria-hidden="true" />
                      {m.model}
                    </span>
                  )}
                </div>

                {/* Line 3: Token telemetry & Context saturation bar */}
                <div className="rounded-[var(--radius-chip)] bg-[var(--board)] px-2.5 py-1.5 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2.5 text-[12px] text-[var(--ink-2)] num">
                    <span className="font-semibold text-[var(--ink)]">{fmtTokens(m.usage.totalTokens)} tok</span>
                    <span>in {fmtTokens(m.usage.inputTokens)}</span>
                    <span>cache {fmtTokens(m.usage.cacheReadTokens)}</span>
                    <span>out {fmtTokens(m.usage.outputTokens)}</span>
                  </div>
                  {!m.killed && pressure.pct > 0 && (
                    <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--track)]" aria-hidden="true">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          pressure.tone === "danger"
                            ? "bg-[var(--dot-red)]"
                            : pressure.tone === "warning"
                              ? "bg-[var(--dot-amber)]"
                              : "bg-[var(--blue)]",
                        )}
                        style={{ width: `${Math.max(4, pressure.pct)}%` }}
                      />
                    </div>
                  )}
                </div>

                {/* Line 4: Shimmering live activity or error detail */}
                {!m.killed && m.status === "working" && m.activity && (
                  <p className="text-[13px] text-[var(--info-foreground)] fleet-live-shimmer truncate">
                    {m.activityKind === "thinking" ? `Thinking: ${m.activity}` : m.activity}
                  </p>
                )}
                {m.failure && (
                  <p className="text-[12px] text-[var(--destructive-foreground)] break-words">{m.failure.text}</p>
                )}

                {/* Expandable Worker Activity Peek */}
                {peeking && (
                  <div className="rounded-[var(--radius-chip)] bg-[var(--board)] px-2.5 py-2 space-y-1.5 text-[12px]">
                    <p className="font-semibold text-[var(--ink)]">Recent worker activity</p>
                    {m.thinkingHeading && (
                      <p className="text-[var(--ink-2)] truncate">Thought: {m.thinkingHeading}</p>
                    )}
                    {tools.length > 0 ? (
                      <ul className="divide-y divide-[var(--hairline)]" aria-label={`Last tool calls for ${m.name}`}>
                        {tools.map((tc, i) => (
                          <li key={i} className="flex items-center justify-between gap-2 py-1 first:pt-0 last:pb-0">
                            <span className="text-[var(--ink)] truncate">{tc.summary}</span>
                            <span className="text-[var(--ink-3)] shrink-0 mono">{tc.name}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[var(--ink-3)]">No recent tool calls recorded.</p>
                    )}
                  </div>
                )}

                {nudgeMember === m.name && (
                  <div className="pt-2 border-t border-[var(--hairline)] space-y-2">
                    <label htmlFor={`roster-nudge-${m.name}`} className="block text-[12px] font-medium text-[var(--ink-2)]">
                      Confirm message to {m.name}
                    </label>
                    <Textarea
                      id={`roster-nudge-${m.name}`}
                      rows={2}
                      value={nudgeText}
                      onChange={(e) => setNudgeText(e.target.value)}
                    />
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setNudgeMember(null)}>
                        Cancel
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={sending || !nudgeText.trim()}
                        onClick={() => sendNudge(m)}
                      >
                        Send
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
