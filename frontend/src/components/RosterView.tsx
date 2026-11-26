import { useEffect, useMemo, useRef, useState } from "../hooks";
import { AlertTriangle, ChevronDown, ChevronUp, ClipboardCopy, Cpu, Eye, EyeOff, MessageSquare, Plus, Radio, Send, Trash2, X } from "../icons";
import { SwarmControlError, openWorkerConversation, sendSwarmControl } from "../sidecar";
import type { SwarmMember, SwarmSnapshot, SwarmWorkspaceMode } from "../types";
import { ActivityPeek, Badge, Button, Card, InlineComposer, Input, MemberActivityLine, Pill, StatusDot, Textarea, TokenBurnStrip, buildRecoverPrompt, canLiveNudge, cn, copyText, fmtTokens, hasControlChars, memberMeta, submitNudge, toast, useNowMs } from "../ui";

const ORDER: Record<SwarmMember["status"], number> = { working: 0, waiting: 1, killed: 2 };
const CONTEXT_BUDGET_TOKENS = 200_000;
const STALL_MS = 10 * 60 * 1000;
const WORKER_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL_SUGGESTIONS = ["gemini-3-pro", "gemini-3-flash", "claude-sonnet-4-6", "claude-opus-4-6"];

function pickAltModel(current: string): string {
  const cur = String(current || "").toLowerCase();
  if (cur.includes("pro")) return "gemini-3-flash";
  if (cur.includes("flash")) return "gemini-3-pro";
  return "gemini-3-pro";
}

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
  spawnNonce = 0,
  onJumpToBoardSeq,
  onRefresh,
}: {
  snap: SwarmSnapshot;
  spawnNonce?: number;
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

  // Spawn Worker drawer state
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [spawnName, setSpawnName] = useState("");
  const [spawnBrief, setSpawnBrief] = useState("");
  const [spawnWorkspace, setSpawnWorkspace] = useState<SwarmWorkspaceMode>("share");
  const [spawnChannel, setSpawnChannel] = useState("");
  const [spawning, setSpawning] = useState(false);
  const [spawnError, setSpawnError] = useState("");
  const spawnNameRef = useRef<HTMLInputElement>(null);

  // Switch Model drawer state
  const [switchMember, setSwitchMember] = useState<string | null>(null);
  const [switchModelVal, setSwitchModelVal] = useState("");
  const [switchReason, setSwitchReason] = useState("");
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");

  // Confirmation-gated Kill Worker state (+ 409 unmerged worktree warning)
  const [killMember, setKillMember] = useState<string | null>(null);
  const [killReason, setKillReason] = useState("");
  const [killing, setKilling] = useState(false);
  const [killError, setKillError] = useState("");
  const [kill409, setKill409] = useState<{ member: string; dirtyFiles: number; ahead: number; message: string } | null>(null);

  const spawnLockRef = useRef(false);
  const switchLockRef = useRef(false);
  const killLockRef = useRef(false);
  const nudgeLockRef = useRef(false);

  const nowMs = useNowMs();

  const members = snap.members || [];
  const liveTargets = members.filter((m) => !m.killed && m.conversation_id);
  const killedCount = members.filter((m) => m.killed).length;
  const canNudge = canLiveNudge(snap);
  const swarmConvId = snap.swarm || snap.conversationId || "";
  const activeChannels = (snap.channels || []).filter((c) => !c.archived);
  const hasCoordinator = members.some((m) => !m.killed && m.role === "coordinator" && Boolean(m.conversation_id));

  useEffect(() => {
    if (!spawnNonce) return;
    setSpawnOpen(true);
    requestAnimationFrame(() => spawnNameRef.current?.focus());
  }, [spawnNonce]);

  const cleanSpawnName = spawnName.trim().toLowerCase();
  const spawnNameValid =
    WORKER_NAME_RE.test(cleanSpawnName) &&
    cleanSpawnName !== "all" &&
    cleanSpawnName !== "coordinator" &&
    !members.some((m) => !m.killed && m.name === cleanSpawnName);
  const spawnBadChars = hasControlChars(spawnBrief) || hasControlChars(spawnName);
  const spawnReady =
    Boolean(swarmConvId) &&
    spawnNameValid &&
    Boolean(spawnBrief.trim()) &&
    spawnBrief.trim().length <= 4000 &&
    !spawnBadChars;

  const handleSpawnSubmit = async () => {
    if (spawnLockRef.current || !spawnReady) return;
    if (!canNudge) {
      await copyText(`Spawn @${cleanSpawnName} (${spawnWorkspace}): ${spawnBrief.trim()}`, `Copied spawn brief for @${cleanSpawnName}`);
      setSpawnOpen(false);
      return;
    }
    spawnLockRef.current = true;
    setSpawning(true);
    setSpawnError("");
    try {
      await sendSwarmControl({
        op: "spawn_worker",
        conversationId: swarmConvId,
        name: cleanSpawnName,
        brief: spawnBrief.trim(),
        workspaceMode: spawnWorkspace,
        ...(spawnChannel ? { channel: spawnChannel } : {}),
      });
      toast.success(`Requested spawn for @${cleanSpawnName}`);
      setSpawnName("");
      setSpawnBrief("");
      setSpawnChannel("");
      setSpawnOpen(false);
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Spawn worker failed";
      setSpawnError(msg);
      toast.error(msg);
    } finally {
      spawnLockRef.current = false;
      setSpawning(false);
    }
  };

  const openSwitchModel = (m: SwarmMember) => {
    setSwitchError("");
    if (switchMember === m.name) {
      setSwitchMember(null);
      return;
    }
    setSwitchMember(m.name);
    setSwitchModelVal(pickAltModel(m.model));
    setSwitchReason(
      m.failure?.kind === "quota"
        ? "Quota exhausted"
        : m.failure
          ? "Step error recovery"
          : "",
    );
  };

  const handleSwitchModelSubmit = async (memberName: string) => {
    const model = switchModelVal.trim();
    if (switchLockRef.current || !swarmConvId || !model || hasControlChars(model) || hasControlChars(switchReason)) return;
    switchLockRef.current = true;
    setSwitching(true);
    setSwitchError("");
    try {
      await sendSwarmControl({
        op: "switch_model",
        conversationId: swarmConvId,
        member: memberName,
        model,
        ...(switchReason.trim() ? { reason: switchReason.trim() } : {}),
      });
      toast.success(`Switched @${memberName} to ${model}`);
      setSwitchMember(null);
      setSwitchReason("");
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Switch model failed";
      setSwitchError(msg);
      toast.error(msg);
    } finally {
      switchLockRef.current = false;
      setSwitching(false);
    }
  };

  const openKillConfirm = (m: SwarmMember) => {
    setKillError("");
    if (killMember === m.name) {
      setKillMember(null);
      setKill409(null);
      return;
    }
    setKillMember(m.name);
    setKillReason("");
    setKill409(null);
  };

  const handleKillSubmit = async (memberName: string, forceUnmerged = false) => {
    if (killLockRef.current || !swarmConvId || hasControlChars(killReason)) return;
    killLockRef.current = true;
    setKilling(true);
    setKillError("");
    try {
      await sendSwarmControl({
        op: "kill_worker",
        conversationId: swarmConvId,
        member: memberName,
        forceUnmerged,
        ...(killReason.trim() ? { reason: killReason.trim() } : {}),
      });
      toast.success(`Killed @${memberName}`);
      setKillMember(null);
      setKillReason("");
      setKill409(null);
      onRefresh();
    } catch (err) {
      if (err instanceof SwarmControlError && err.status === 409) {
        setKill409({
          member: memberName,
          dirtyFiles: err.dirtyFiles ?? 0,
          ahead: err.ahead ?? 0,
          message: err.message,
        });
      } else {
        const msg = err instanceof Error ? err.message : "Kill worker failed";
        setKillError(msg);
        toast.error(msg);
      }
    } finally {
      killLockRef.current = false;
      setKilling(false);
    }
  };
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

  const handleBroadcastSubmit = async () => {
    if (nudgeLockRef.current || badBroadcast || broadcastConvs.length === 0) return;
    if (!canNudge) {
      void copyText(broadcastText.trim(), "Broadcast copied");
      setBroadcastOpen(false);
      return;
    }
    nudgeLockRef.current = true;
    try {
      await submitNudge(broadcastConvs, broadcastText, `Broadcast sent (${broadcastConvs.length})`, setSending, () => {
        setBroadcastOpen(false);
        setBroadcastText("@all ");
        onRefresh();
      });
    } finally {
      nudgeLockRef.current = false;
    }
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

  const sendNudge = async (member: SwarmMember) => {
    if (nudgeLockRef.current) return;
    nudgeLockRef.current = true;
    try {
      await submitNudge(member.conversation_id, nudgeText, `Message sent to ${member.name}`, setSending, () => {
        setNudgeMember(null);
        setNudgeText("");
        onRefresh();
      });
    } finally {
      nudgeLockRef.current = false;
    }
  };

  return (
    <div className="space-y-3">
      <div className="row flex-wrap gap-2">
        <div className="wrap">
          <h2 className="h2">
            Roster ({members.length - killedCount} active)
          </h2>
          {killedCount > 0 && <Badge tone="neutral">{killedCount} stopped</Badge>}
        </div>
        <div className="f1 flex-wrap">
          {swarmConvId && (
            <Button
              variant={spawnOpen ? "secondary" : "primary"}
              data-testid="toggle-spawn-worker"
              onClick={() => setSpawnOpen((v) => !v)}
            >
              <Plus />
              Spawn
            </Button>
          )}
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

      {spawnOpen && (
        <Card className="p-3 space-y-2 bg-board" data-testid="spawn-worker-drawer">
          <div className="row">
            <span className="text-[13px] font-semibold text-ink">Spawn worker</span>
            <Button variant="ghost" size="icon" aria-label="Close spawn worker drawer" onClick={() => setSpawnOpen(false)}>
              <X />
            </Button>
          </div>
          {canNudge && members.length > 0 && !hasCoordinator && (
            <p role="alert" className="rounded-chip border border-warn bg-warn-soft px-2 py-1 text-[12px] text-warn" data-testid="roster-missing-coordinator">
              No active coordinator in roster. Spawn directives may fail.
            </p>
          )}
          {spawnError && (
            <p role="alert" className="rounded-chip border border-danger bg-bad-soft px-2 py-1 text-[12px] text-danger" data-testid="spawn-worker-error">
              {spawnError}
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="space-y-1">
              <label htmlFor="spawn-worker-name" className="text-[12px] font-medium text-ink-2">Worker name</label>
              <Input
                ref={spawnNameRef}
                id="spawn-worker-name"
                data-testid="spawn-worker-name"
                placeholder="e.g. api-builder"
                value={spawnName}
                onChange={(e) => setSpawnName(e.target.value.toLowerCase())}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="spawn-worker-workspace" className="text-[12px] font-medium text-ink-2">Workspace</label>
              <select
                id="spawn-worker-workspace"
                data-testid="spawn-worker-workspace"
                value={spawnWorkspace}
                onChange={(e) => setSpawnWorkspace(e.target.value as SwarmWorkspaceMode)}
                className="h-8 w-full rounded-chip border border-hairline-s bg-surface px-2 text-[13px] text-ink cursor-pointer"
              >
                <option value="share">share (working copy)</option>
                <option value="inherit">inherit (shared)</option>
                <option value="branch">branch (isolated clone)</option>
              </select>
            </div>
          </div>

          {activeChannels.length > 0 && (
            <div className="space-y-1">
              <label htmlFor="spawn-worker-channel" className="text-[12px] font-medium text-ink-2">Channel (optional)</label>
              <select
                id="spawn-worker-channel"
                data-testid="spawn-worker-channel"
                value={spawnChannel}
                onChange={(e) => setSpawnChannel(e.target.value)}
                className="h-8 w-full rounded-chip border border-hairline-s bg-surface px-2 text-[13px] text-ink cursor-pointer"
              >
                <option value="">#main (default)</option>
                {activeChannels.map((ch) => (
                  <option key={ch.name} value={ch.name}>#{ch.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-1">
            <label htmlFor="spawn-worker-brief" className="text-[12px] font-medium text-ink-2">Assignment brief</label>
            <Textarea
              id="spawn-worker-brief"
              data-testid="spawn-worker-brief"
              rows={2}
              maxLength={4000}
              placeholder="What this worker owns and what done looks like"
              value={spawnBrief}
              onChange={(e) => setSpawnBrief(e.target.value)}
            />
          </div>

          {spawnName.trim() && !spawnNameValid && (
            <p className="text-[12px] text-danger">
              Use a unique lowercase name (letters, digits, hyphens, max 32).
            </p>
          )}
          {spawnBadChars && (
            <p className="text-[12px] text-danger">Control characters are not allowed.</p>
          )}

          <div className="row">
            <span className="t3 num">{spawnBrief.length}/4000</span>
            <div className="f1">
              <Button variant="ghost" onClick={() => setSpawnOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                data-testid="spawn-worker-submit"
                disabled={!spawnReady || spawning}
                onClick={handleSpawnSubmit}
              >
                {canNudge ? <Plus /> : <ClipboardCopy />}
                {spawning ? "Spawning..." : canNudge ? "Confirm & spawn" : "Copy brief"}
              </Button>
            </div>
          </div>
        </Card>
      )}

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
                  const canSwitchModel = Boolean(swarmConvId && canNudge && m.role !== "coordinator");
                  const canKill = Boolean(swarmConvId && canNudge && m.role !== "coordinator" && !m.narrator && !m.roleWorker);
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
                    {canSwitchModel && (
                      <Button
                        variant={m.failure ? "info" : "ghost"}
                        data-testid={`switch-model-btn-${m.name}`}
                        onClick={() => openSwitchModel(m)}
                      >
                        <Cpu />
                        Switch model
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
                    {canKill && (
                      <Button
                        variant="ghost"
                        data-testid={`kill-worker-btn-${m.name}`}
                        onClick={() => openKillConfirm(m)}
                        className="text-danger hover:bg-bad-soft"
                      >
                        <Trash2 />
                        Kill
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

                {/* Line 4: Bounded 1-line transcript activity peek or error detail */}
                <MemberActivityLine member={m} testId={`roster-activity-peek-${m.name}`} />
                {m.failure && (
                  <p className="text-[12px] text-danger break-words">{m.failure.text}</p>
                )}

                {/* Expandable Worker Activity Peek */}
                {peeking && <ActivityPeek member={m} mode="roster" />}

                {switchMember === m.name && (
                  <div className="pt-2 border-t border-hairline space-y-2" data-testid={`switch-model-drawer-${m.name}`}>
                    <div className="row">
                      <span className="text-[12px] font-semibold text-ink">Switch model for @{m.name}</span>
                      <Button variant="ghost" size="icon" aria-label={`Close switch model for ${m.name}`} onClick={() => setSwitchMember(null)}>
                        <X />
                      </Button>
                    </div>
                    {canNudge && members.length > 0 && !hasCoordinator && (
                      <p role="alert" className="rounded-chip border border-warn bg-warn-soft px-2 py-1 text-[12px] text-warn" data-testid="roster-missing-coordinator">
                        No active coordinator in roster. Switch directives may fail.
                      </p>
                    )}
                    {switchError && (
                      <p role="alert" className="rounded-chip border border-danger bg-bad-soft px-2 py-1 text-[12px] text-danger" data-testid="switch-model-error">
                        {switchError}
                      </p>
                    )}
                    <div className="wrap gap-1">
                      {MODEL_SUGGESTIONS.map((mdl) => (
                        <Pill
                          key={mdl}
                          active={switchModelVal === mdl}
                          onClick={() => setSwitchModelVal(mdl)}
                        >
                          {mdl}
                        </Pill>
                      ))}
                    </div>
                    <Input
                      aria-label={`Model for ${m.name}`}
                      data-testid={`switch-model-input-${m.name}`}
                      value={switchModelVal}
                      onChange={(e) => setSwitchModelVal(e.target.value)}
                      placeholder="Model identifier"
                    />
                    <Input
                      aria-label={`Switch reason for ${m.name}`}
                      data-testid={`switch-model-reason-${m.name}`}
                      value={switchReason}
                      onChange={(e) => setSwitchReason(e.target.value)}
                      placeholder="Reason (optional)"
                    />
                    <div className="row">
                      <span className="t3">Current: {m.model || "default"}</span>
                      <div className="f1">
                        <Button variant="ghost" onClick={() => setSwitchMember(null)}>Cancel</Button>
                        <Button
                          variant="primary"
                          data-testid={`switch-model-submit-${m.name}`}
                          disabled={switching || !switchModelVal.trim() || hasControlChars(switchModelVal) || hasControlChars(switchReason)}
                          onClick={() => handleSwitchModelSubmit(m.name)}
                        >
                          <Cpu />
                          {switching ? "Switching..." : "Confirm switch"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {killMember === m.name && (
                  <div className="pt-2 border-t border-hairline space-y-2" data-testid={`kill-worker-confirm-${m.name}`}>
                    <p className="text-[12px] text-ink">
                      Permanently stop @{m.name} and clean up its workspace.
                    </p>
                    {canNudge && members.length > 0 && !hasCoordinator && (
                      <p role="alert" className="rounded-chip border border-warn bg-warn-soft px-2 py-1 text-[12px] text-warn" data-testid="roster-missing-coordinator">
                        No active coordinator in roster. Kill directives may fail.
                      </p>
                    )}
                    {killError && (
                      <p role="alert" className="rounded-chip border border-danger bg-bad-soft px-2 py-1 text-[12px] text-danger" data-testid="kill-worker-error">
                        {killError}
                      </p>
                    )}
                    <Input
                      aria-label={`Kill reason for ${m.name}`}
                      data-testid={`kill-worker-reason-${m.name}`}
                      value={killReason}
                      onChange={(e) => setKillReason(e.target.value)}
                      placeholder="Reason (optional)"
                    />
                    {kill409 && kill409.member === m.name && (
                      <div
                        className="rounded-chip border border-danger bg-bad-soft p-2 space-y-2 text-[12px]"
                        data-testid={`kill-worker-409-${m.name}`}
                      >
                        <div className="flex items-start gap-1.5 text-danger">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                          <span className="font-medium">
                            Unmerged worktree warning: {kill409.dirtyFiles} dirty files, {kill409.ahead} commits ahead.
                          </span>
                        </div>
                        <div className="f1 justify-end">
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setKillMember(null);
                              setKill409(null);
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            variant="danger"
                            data-testid={`kill-worker-force-${m.name}`}
                            disabled={killing}
                            onClick={() => handleKillSubmit(m.name, true)}
                          >
                            <Trash2 />
                            {killing ? "Forcing..." : "Force kill anyway"}
                          </Button>
                        </div>
                      </div>
                    )}
                    {(!kill409 || kill409.member !== m.name) && (
                      <div className="f1 justify-end">
                        <Button variant="ghost" onClick={() => setKillMember(null)}>Cancel</Button>
                        <Button
                          variant="danger"
                          data-testid={`kill-worker-submit-${m.name}`}
                          disabled={killing || hasControlChars(killReason)}
                          onClick={() => handleKillSubmit(m.name, false)}
                        >
                          <Trash2 />
                          {killing ? "Killing..." : "Confirm kill"}
                        </Button>
                      </div>
                    )}
                  </div>
                )}

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
