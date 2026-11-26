import { useMemo, useState } from "../hooks";
import { ChevronDown, ChevronUp, ClipboardCopy, Cpu, Eye, EyeOff, MessageSquare, Radio, Send } from "../icons";
import { openWorkerConversation } from "../sidecar";
import type { SwarmMember, SwarmSnapshot } from "../types";
import { ActivityPeek, Badge, Button, Card, InlineComposer, Pill, StatusDot, TokenBurnStrip, buildRecoverPrompt, canLiveNudge, cn, copyText, fmtTokens, hasControlChars, memberMeta, submitNudge, useNowMs } from "../ui";

const ORDER: Record<SwarmMember["status"], number> = { working: 0, waiting: 1, killed: 2 };
const CONTEXT_BUDGET_TOKENS = 200_000;
const STALL_MS = 10 * 60 * 1000;

function contextPressure(m: SwarmMember): { pct: number; tone: "neutral" | "info" | "warning" | "danger"; label: string } {
  const ctx = m.lastContextTokens || m.usage.inputTokens + m.usage.cacheReadTokens;
  const pct = Math.min(100, Math.round((ctx / CONTEXT_BUDGET_TOKENS) * 100));
  if (m.failure?.kind === "quota") return { pct, tone: "danger", label: "Quota" };
  if (m.failure) return { pct, tone: "danger", label: "Error" };
  if (m.status === "working" && m.transcriptMtime && Date.now() - m.transcriptMtime > STALL_MS) {
    return { pct, tone: "warning", label: "Stalled" };
  }
  if (ctx > 0) return { pct, tone: ctx >= 140_000 ? "danger" : ctx >= 90_000 ? "warning" : "info", label: `${pct}% ctx` };
  return { pct: 0, tone: "neutral", label: "Idle" };
}

export function RosterView({
  snap,
  onJumpToBoardSeq,
  onRefresh,
}: {
  snap: SwarmSnapshot;
  onJumpToBoardSeq?: (seq: number, agent?: string) => void;
  onRefresh: () => void;
}) {
  const [showKilled, setShowKilled] = useState(false);
  const [peekMember, setPeekMember] = useState<string | null>(null);
  const [nudgeMember, setNudgeMember] = useState<string | null>(null);
  const [nudgeText, setNudgeText] = useState("");
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastTargets, setBroadcastTargets] = useState<string[]>([]);
  const [broadcastText, setBroadcastText] = useState("@all ");
  const [sending, setSending] = useState(false);
  const nowMs = useNowMs();

  const members = snap.members || [];
  const liveTargets = members.filter((m) => !m.killed && m.conversation_id);
  const killedCount = members.filter((m) => m.killed).length;
  const canNudge = canLiveNudge(snap);
  const broadcastSet = new Set(broadcastTargets);
  const broadcastConvs = liveTargets.filter((m) => broadcastSet.has(m.name)).map((m) => m.conversation_id);

  const setBroadcastSelection = (names: string[], forceAll = false) => {
    setBroadcastTargets(names);
    const prefix = forceAll || (names.length === liveTargets.length && names.length > 1)
      ? "@all "
      : names.map((n) => `@${n}`).join(" ") + (names.length ? " " : "");
    setBroadcastText((cur) => `${prefix}${cur.replace(/^(?:@[a-z0-9_-]+\s*)+/i, "")}`);
  };

  const applyBroadcastPreset = (mode: "all" | "working" | "waiting") => {
    const names = liveTargets.filter((m) => mode === "all" || m.status === mode).map((m) => m.name);
    setBroadcastSelection(names, mode === "all");
  };

  const toggleBroadcastName = (name: string) => {
    setBroadcastSelection(
      broadcastTargets.includes(name) ? broadcastTargets.filter((x) => x !== name) : [...broadcastTargets, name],
    );
  };

  const badBroadcast = hasControlChars(broadcastText) || broadcastText.trim().length > 4000;

  const handleBroadcastSubmit = () => {
    if (badBroadcast || broadcastConvs.length === 0) return;
    if (!canNudge) {
      void copyText(broadcastText.trim(), "Broadcast copied");
      setBroadcastOpen(false);
      return;
    }
    return submitNudge(broadcastConvs, broadcastText, `Broadcast sent (${broadcastConvs.length})`, setSending, () => {
      setBroadcastOpen(false);
      setBroadcastText("@all ");
      onRefresh();
    });
  };

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

  const sendNudge = (member: SwarmMember) =>
    submitNudge(member.conversation_id, nudgeText, `Message sent to ${member.name}`, setSending, () => {
      setNudgeMember(null);
      setNudgeText("");
      onRefresh();
    });

  return (
    <div className="space-y-3">
      <div className="row flex-wrap gap-2">
        <div className="wrap">
          <h2 className="h2">
            Roster ({members.length - killedCount} active)
          </h2>
          {killedCount > 0 && <Badge tone="neutral">{killedCount} stopped</Badge>}
        </div>
        <div className="f1">
          {liveTargets.length > 0 && (
            <Button
              variant={broadcastOpen ? "secondary" : "outline"}
              data-testid="toggle-broadcast"
              onClick={() => {
                if (!broadcastOpen) applyBroadcastPreset("all");
                setBroadcastOpen((v) => !v);
              }}
            >
              <Radio />
              Broadcast
            </Button>
          )}
          {killedCount > 0 && (
            <Button variant="ghost" onClick={() => setShowKilled((v) => !v)}>
              {showKilled ? <EyeOff /> : <Eye />}
              {showKilled ? "Hide killed" : `Show killed (${killedCount})`}
            </Button>
          )}
        </div>
      </div>

      {broadcastOpen && (
        <Card className="p-3 space-y-2 bg-board" data-testid="broadcast-composer">
          <div className="wrap gap-1">
            {(["all", "working", "waiting"] as const).map((mode) => (
              <Pill
                key={mode}
                onClick={() => applyBroadcastPreset(mode)}
                className="bg-surface border border-hairline text-ink hover:bg-track"
              >
                {mode === "all" ? `@all (${liveTargets.length})` : mode}
              </Pill>
            ))}
            {liveTargets.map((m) => {
              const on = broadcastTargets.includes(m.name);
              return (
                <Pill
                  key={m.name}
                  active={on}
                  aria-pressed={on}
                  onClick={() => toggleBroadcastName(m.name)}
                >
                  @{m.name}
                </Pill>
              );
            })}
          </div>
          {hasControlChars(broadcastText) && (
            <p className="text-[12px] text-danger">Control characters are not allowed.</p>
          )}
          <InlineComposer
            id="roster-broadcast-msg"
            label={`Confirm broadcast (${broadcastConvs.length} selected)`}
            value={broadcastText}
            onChange={setBroadcastText}
            onCancel={() => setBroadcastOpen(false)}
            onSubmit={handleBroadcastSubmit}
            submitLabel={canNudge ? (sending ? "Sending..." : `Send (${broadcastConvs.length})`) : "Copy broadcast"}
            copyOnly={!canNudge}
            disabled={sending || badBroadcast || broadcastConvs.length === 0}
            showCounter
            className="border-t-0 pt-0"
          />
        </Card>
      )}

      <TokenBurnStrip snap={snap} />

      {sorted.length === 0 ? (
        <Card className="p-4 text-[14px] text-ink-2 bg-board">No workers yet.</Card>
      ) : (
        <div className="space-y-2">
          {sorted.map((m) => {
            const isYou = snap.member === m.name;
            const { elapsed, isStalled } = memberMeta(m, nowMs);
            const dotState = m.failure ? "danger" : isStalled ? "warn" : m.status;
            const baseStatus = m.killed ? "Killed"
              : m.failure ? `Paused (${m.failure.kind})`
              : m.status === "working" ? "Working"
              : m.wake_mode ? `Waiting (${m.wake_mode})` : "Waiting";
            const statusText = !m.killed && elapsed ? `${baseStatus} ${elapsed}` : baseStatus;
            const peeking = peekMember === m.name;
            const tools = m.recentTools || [];
            const pressure = contextPressure(m);
            const askPrompt = `@${m.name} Status & blockers?`;
            const wrapPrompt = `@${m.name} Wrap up, verify, and post [done].`;

            return (
              <Card key={m.name} className={cn("p-3 space-y-2", m.killed && "opacity-65")}>
                <div className="row">
                  <div className="wrap gap-1 min-w-0">
                    <StatusDot state={dotState} />
                    <span className={cn("h2 truncate", m.killed && "line-through")}>{m.name}</span>
                    {isYou && <Badge tone="info">you</Badge>}
                    {m.role && m.role !== "worker" && <Badge tone="neutral">{m.role}</Badge>}
                    {m.workspace_mode && m.workspace_mode !== "inherit" && <Badge tone="violet">{m.workspace_mode}</Badge>}
                  </div>

                  <div className="f1 shrink-0">
                    {(tools.length > 0 || m.thinkingHeading) && (
                      <Button variant={peeking ? "secondary" : "ghost"} aria-label={`Peek activity for ${m.name}`} aria-expanded={peeking} onClick={() => setPeekMember(peeking ? null : m.name)}>
                        {peeking ? <ChevronUp /> : <ChevronDown />}
                        Peek
                      </Button>
                    )}
                    {m.conversation_id && window.sidecar?.ui?.toggleConversation && (
                      <Button aria-label={`Open ${m.name} chat`} onClick={() => openWorkerConversation(m.conversation_id)}>
                        <MessageSquare />
                        Chat
                      </Button>
                    )}
                    {!m.killed && canNudge && m.conversation_id && (
                      <Button variant="ghost" size="icon" aria-label={`Nudge ${m.name}`} onClick={() => { setNudgeMember(nudgeMember === m.name ? null : m.name); setNudgeText(`@${m.name} `); }}>
                        <Send />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="wrap gap-1 text-[12px] text-ink-2">
                  <Badge tone={m.status === "working" ? "success" : "neutral"}>{statusText}</Badge>
                  {isStalled && <Badge tone="danger">stalled</Badge>}
                  {!m.killed && <Badge tone={pressure.tone}>{pressure.label}</Badge>}
                  <Badge>{m.steps} steps</Badge>
                  <Badge>{m.posts} posts</Badge>
                  {m.unread > 0 && <Badge tone="danger">{m.unread} unread</Badge>}
                  {m.model && <span className="inline-flex items-center gap-1 text-ink-3 px-1"><Cpu className="h-3 w-3" />{m.model}</span>}
                </div>

                {!m.killed && m.conversation_id && (() => {
                  const act = (p: string, msg: string) =>
                    canNudge ? (setNudgeMember(m.name), setNudgeText(p)) : void copyText(p, msg);
                  return (
                  <div className="wrap gap-1">
                    {(isStalled || Boolean(m.failure) || (m.status === "waiting" && m.unread > 0)) && (
                      <Button
                        variant={isStalled || m.failure ? "danger" : "info"}
                        data-testid={`roster-recover-${m.name}`}
                        onClick={() => act(buildRecoverPrompt(m), `Copied recovery prompt for ${m.name}`)}
                      >
                        {!canNudge && <ClipboardCopy />}
                        Recover
                      </Button>
                    )}
                    <Button variant={canNudge ? "outline" : "ghost"} onClick={() => act(askPrompt, `Copied status check for ${m.name}`)}>
                      {!canNudge && <ClipboardCopy />}
                      Ask status
                    </Button>
                    {canNudge && <Button variant="ghost" onClick={() => act(wrapPrompt, "")}>Wrap up</Button>}
                    {m.posts > 0 && onJumpToBoardSeq && (
                      <Button variant="ghost" data-testid={`roster-board-${m.name}`} onClick={() => onJumpToBoardSeq(m.lastPostSeq || 0, m.name)} className="num">
                        Board ({m.posts})
                      </Button>
                    )}
                  </div>
                  );
                })()}

                {/* Line 3: Token telemetry & Context saturation bar */}
                <div className="rounded-chip bg-board px-2 py-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-2 num">
                    <span className="font-semibold text-ink">{fmtTokens(m.usage.totalTokens)} tok</span>
                    {([["in", m.usage.inputTokens], ["cache", m.usage.cacheReadTokens], ["out", m.usage.outputTokens]] as const).map(([k, v]) => (
                      <span key={k}>{k} {fmtTokens(v)}</span>
                    ))}
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
