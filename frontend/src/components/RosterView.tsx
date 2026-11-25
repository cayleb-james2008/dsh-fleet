import { useMemo, useState } from "react";
import { Cpu, Eye, EyeOff, MessageSquare, Send } from "lucide-react";
import { openWorkerConversation, sendConfirmedNudge } from "../sidecar";
import type { SwarmMember, SwarmSnapshot } from "../types";
import { Badge, Button, Card, StatusDot, Textarea, cn, fmtTokens, toast } from "../ui";

const ORDER: Record<SwarmMember["status"], number> = { working: 0, waiting: 1, killed: 2 };

export function RosterView({
  snap,
  onRefresh,
}: {
  snap: SwarmSnapshot;
  onRefresh: () => void;
}) {
  const [showKilled, setShowKilled] = useState(false);
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
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--ink-2)]">
          Roster ({members.length - killedCount} active{killedCount ? ` · ${killedCount} stopped` : ""})
        </h2>
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
              ? "killed"
              : m.failure
                ? `paused (${m.failure.kind})`
                : m.status === "working"
                  ? "working"
                  : m.wake_mode
                    ? `waiting (${m.wake_mode})`
                    : "waiting";

            return (
              <Card key={m.name} className={cn("p-3 space-y-2", m.killed && "opacity-65")}>
                {/* Line 1: Identity & Chat */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
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

                {/* Line 2: Status, Steps, Posts, Unread, Model */}
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-[var(--ink-2)]">
                  <span>{statusText}</span>
                  <span aria-hidden="true">·</span>
                  <span className="num">{m.steps} steps</span>
                  <span aria-hidden="true">·</span>
                  <span className="num">{m.posts} posts</span>
                  {m.unread > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-semibold text-[var(--destructive-foreground)] num">{m.unread} unread</span>
                    </>
                  )}
                  {m.model && (
                    <span className="inline-flex items-center gap-1 text-[var(--ink-3)]">
                      <Cpu className="h-3 w-3" aria-hidden="true" />
                      {m.model}
                    </span>
                  )}
                </div>

                {/* Line 3: Token telemetry */}
                <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-chip)] bg-[var(--board)] px-2.5 py-1 text-[12px] text-[var(--ink-2)] num">
                  <span className="font-medium text-[var(--ink)]">{fmtTokens(m.usage.totalTokens)} tok</span>
                  <span>in {fmtTokens(m.usage.inputTokens)}</span>
                  <span>cache {fmtTokens(m.usage.cacheReadTokens)}</span>
                  <span>out {fmtTokens(m.usage.outputTokens)}</span>
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
