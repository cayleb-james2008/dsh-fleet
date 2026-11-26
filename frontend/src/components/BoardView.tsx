import { useEffect, useMemo, useRef, useState } from "../hooks";
import { ArrowDown, ClipboardCopy, Filter, Hash, Pin, Plus, Reply, Search, Send, X } from "../icons";
import { prefersReducedMotion } from "../motion";
import { extractLocalFilePaths, parseScreenshotLines, sendSwarmControl } from "../sidecar";
import type { BoardMessage, SwarmSnapshot } from "../types";
import { Badge, Button, Card, InlineComposer, Input, MediaPathChips, Pill, PinnedList, Textarea, canLiveNudge, cn, copyText, downloadTextFile, fmtClockTime, formatFilteredBoardExport, hasControlChars, openOrCopyPath, submitNudge, toast } from "../ui";

function PostBody({
  text,
  viewer,
  onClickSeq,
  onFilterAgent,
}: {
  text: string;
  viewer: string | null;
  onClickSeq: (seq: number) => void;
  onFilterAgent: (agent: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const needsFold = text.length > 480 || text.split("\n").length > 8;
  const visibleText = needsFold && !expanded ? `${text.slice(0, 420).trimEnd()}…` : text;

  const tokens = visibleText.split(/(@[a-z0-9_-]+|#[0-9]+\b|\[(?:done|verified|blocked)\])/gi);

  return (
    <div className="space-y-1">
      <p className="text-[14px] text-ink whitespace-pre-wrap break-words leading-snug">
        {tokens.map((tok, i) => {
          if (i % 2 === 0 || !tok) return tok;
          if (tok[0] === "@") {
            const name = tok.slice(1);
            const isViewer = viewer && name.toLowerCase() === viewer.toLowerCase();
            return (
              <button
                key={i}
                type="button"
                onClick={() => (name.toLowerCase() !== "all" ? onFilterAgent(name) : undefined)}
                className={cn("inline rounded-chip px-1 font-medium cursor-pointer", isViewer ? "bg-blue-soft text-info" : "bg-track text-ink hover:bg-hairline")}
              >
                {tok}
              </button>
            );
          }
          if (tok[0] === "#") {
            return (
              <button key={i} type="button" onClick={() => onClickSeq(Number(tok.slice(1)))} className="inline rounded-chip bg-blue-soft px-1 text-[12px] font-medium text-info num cursor-pointer hover:underline">
                {tok}
              </button>
            );
          }
          const lo = tok.toLowerCase();
          return (
            <span key={i} className={cn("inline-block rounded-chip px-1 text-[12px] font-semibold", lo === "[verified]" ? "bg-ok-soft text-ok" : lo === "[blocked]" ? "bg-bad-soft text-danger" : "bg-blue-soft text-info")}>
              {tok}
            </span>
          );
        })}
      </p>
      {needsFold && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-[12px] font-medium text-info hover:underline cursor-pointer"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

export type BoardQuickFilter = "all" | "needs_reply" | "done" | "blocked";

export function BoardView({
  snap,
  highlightSeq,
  pinnedSeqs,
  quickFilter = "all",
  agentFilter: controlledAgentFilter,
  composeNonce = 0,
  onQuickFilterChange,
  onAgentFilterChange,
  onCopyWaveDigest,
  onTogglePin,
  onClearHighlight,
  onRefresh,
}: {
  snap: SwarmSnapshot;
  highlightSeq: number | null;
  pinnedSeqs: number[];
  quickFilter?: BoardQuickFilter;
  agentFilter?: string;
  composeNonce?: number;
  onQuickFilterChange?: (f: BoardQuickFilter) => void;
  onAgentFilterChange?: (a: string) => void;
  onCopyWaveDigest?: () => void;
  onTogglePin: (seq: number) => void;
  onClearHighlight: () => void;
  onRefresh?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [localAgentFilter, setLocalAgentFilter] = useState<string>("all");
  const agentFilter = controlledAgentFilter ?? localAgentFilter;
  const setAgentFilter = (next: string) => {
    setLocalAgentFilter(next);
    onAgentFilterChange?.(next);
  };
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [showFilters, setShowFilters] = useState(false);
  const [follow, setFollow] = useState(true);
  const [visibleLimit, setVisibleLimit] = useState(80);
  const [localHighlightSeq, setLocalHighlightSeq] = useState<number | null>(null);
  const [highlightNonce, setHighlightNonce] = useState(0);
  const [pendingScrollSeq, setPendingScrollSeq] = useState<number | null>(null);
  const [replyTarget, setReplyTarget] = useState<BoardMessage | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [sending, setSending] = useState(false);

  // Sticky Board / Channel Composer state
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerChannel, setComposerChannel] = useState("main");
  const [composerReplySeq, setComposerReplySeq] = useState("");
  const [composerText, setComposerText] = useState("");
  const [composerConfirm, setComposerConfirm] = useState(false);
  const [composerSending, setComposerSending] = useState(false);
  const [composerError, setComposerError] = useState("");

  // Channel Manager drawer state (channel_op)
  const [channelMgrOpen, setChannelMgrOpen] = useState(false);
  const [channelOpAction, setChannelOpAction] = useState<"create" | "archive" | "subscribe" | "unsubscribe">("create");
  const [channelOpName, setChannelOpName] = useState("");
  const [channelOpTopic, setChannelOpTopic] = useState("");
  const [channelOpMember, setChannelOpMember] = useState("");
  const [channelOpSending, setChannelOpSending] = useState(false);
  const [channelOpError, setChannelOpError] = useState("");

  const bottomRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const replyLockRef = useRef(false);
  const composerLockRef = useRef(false);
  const channelOpLockRef = useRef(false);

  const messages = snap.messages || [];
  const members = snap.members || [];
  const replyRefs = snap.replyRefs || {};
  const unseenSet = useMemo(() => new Set(snap.unseen || []), [snap.unseen]);
  const viewerMember = useMemo(
    () => (snap.member ? members.find((m) => m.name === snap.member) || null : null),
    [members, snap.member],
  );
  const lastReadSeq = viewerMember?.last_read_seq ?? 0;

  const channelsMeta = useMemo(() => {
    const byName = new Map<string, { name: string; topic: string; archived: boolean; count: number }>();
    byName.set("main", { name: "main", topic: "Primary swarm board", archived: false, count: 0 });
    for (const ch of snap.channels || []) {
      if (!ch?.name) continue;
      byName.set(ch.name, { name: ch.name, topic: ch.topic || "", archived: Boolean(ch.archived), count: 0 });
    }
    let totalCount = 0;
    for (const m of messages) {
      if (m.control || unseenSet.has(m.seq)) continue;
      totalCount++;
      const chName = m.channel || "main";
      const existing = byName.get(chName);
      if (existing) {
        existing.count += 1;
      } else {
        byName.set(chName, { name: chName, topic: "", archived: false, count: 1 });
      }
    }
    return { totalCount, list: [...byName.values()] };
  }, [snap.channels, messages, unseenSet]);

  const activeChannels = useMemo(
    () => channelsMeta.list.filter((c) => !c.archived),
    [channelsMeta.list],
  );

  useEffect(() => {
    if (!composeNonce) return;
    setComposerOpen(true);
    if (channelFilter !== "all" && activeChannels.some((c) => c.name === channelFilter)) {
      setComposerChannel(channelFilter);
    }
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }, [composeNonce]);

  useEffect(() => {
    if (channelFilter !== "all" && !channelsMeta.list.some((c) => c.name === channelFilter)) {
      setChannelFilter("all");
    } else if (channelFilter !== "all" && activeChannels.some((c) => c.name === channelFilter)) {
      setComposerChannel(channelFilter);
    }
  }, [channelFilter, channelsMeta.list, activeChannels]);

  useEffect(() => {
    if (composerChannel !== "main" && !activeChannels.some((c) => c.name === composerChannel)) {
      setComposerChannel("main");
    }
  }, [composerChannel, activeChannels]);

  const isNeedsReply = (m: BoardMessage) => m.text.includes("?") || Boolean(snap.member && m.mentions.includes(snap.member));

  const quickCounts = useMemo(() => {
    let all = 0, needs_reply = 0, done = 0, blocked = 0;
    for (const m of messages) {
      if (m.control || unseenSet.has(m.seq)) continue;
      const msgCh = m.channel || "main";
      if (channelFilter !== "all" && msgCh !== channelFilter) continue;
      all++;
      if (isNeedsReply(m)) needs_reply++;
      if (/\[(done|verified)\]/i.test(m.text)) done++;
      if (/\[blocked\]/i.test(m.text)) blocked++;
    }
    return { all, needs_reply, done, blocked };
  }, [messages, unseenSet, snap.member, channelFilter]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return messages.filter((m) => {
      if (m.control || unseenSet.has(m.seq)) return false;
      const msgCh = m.channel || "main";
      if (channelFilter !== "all" && msgCh !== channelFilter) return false;
      if (quickFilter === "needs_reply" && !isNeedsReply(m)) return false;
      if (quickFilter === "done" && !/\[(done|verified)\]/i.test(m.text)) return false;
      if (quickFilter === "blocked" && !/\[blocked\]/i.test(m.text)) return false;
      if (agentFilter !== "all" && m.agent !== agentFilter && !m.mentions.includes(agentFilter)) return false;
      if (q && !m.text.toLowerCase().includes(q) && !m.agent.toLowerCase().includes(q) && !`#${m.seq}`.includes(q)) return false;
      return true;
    });
  }, [messages, agentFilter, query, unseenSet, quickFilter, snap.member, channelFilter]);

  const firstNewSeq = useMemo(() => {
    if (!viewerMember) return null;
    const hit = filtered.find((m) => m.seq > lastReadSeq && m.agent !== viewerMember.name);
    return hit ? hit.seq : null;
  }, [filtered, viewerMember, lastReadSeq]);

  const hiddenCount = Math.max(0, filtered.length - visibleLimit);
  const visible = hiddenCount > 0 ? filtered.slice(hiddenCount) : filtered;

  const scrollToSeq = (seq: number) => {
    const publicMsgs = messages.filter((m) => !m.control && !unseenSet.has(m.seq));
    const exists = seq > 0 && publicMsgs.some((m) => m.seq === seq);
    if (!exists) {
      if (seq > 0) toast.message(`Post #${seq} is not visible on this board`);
      return;
    }
    setFollow(false);
    setLocalHighlightSeq(seq);
    setHighlightNonce((n) => n + 1);
    setPendingScrollSeq(seq);
    const inFiltered = filtered.some((m) => m.seq === seq);
    if (!inFiltered) {
      setChannelFilter("all");
      setAgentFilter("all");
      onQuickFilterChange?.("all");
      setQuery("");
      const fullIdx = publicMsgs.findIndex((m) => m.seq === seq);
      if (fullIdx >= 0 && fullIdx < publicMsgs.length - visibleLimit) {
        setVisibleLimit(publicMsgs.length - fullIdx + 20);
      }
      return;
    }
    const idx = filtered.findIndex((m) => m.seq === seq);
    if (idx >= 0 && idx < filtered.length - visibleLimit) {
      setVisibleLimit(filtered.length - idx + 20);
    }
  };

  useEffect(() => {
    if (!pendingScrollSeq) return;
    const el = rowRefs.current.get(pendingScrollSeq);
    if (!el) return;
    el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
    setPendingScrollSeq(null);
  }, [pendingScrollSeq, visible]);

  useEffect(() => {
    if (!localHighlightSeq) return;
    const t = setTimeout(() => setLocalHighlightSeq(null), 2400);
    return () => clearTimeout(t);
  }, [localHighlightSeq, highlightNonce]);

  useEffect(() => {
    if (!highlightSeq) return;
    scrollToSeq(highlightSeq);
    const t = setTimeout(onClearHighlight, 2600);
    return () => clearTimeout(t);
  }, [highlightSeq, onClearHighlight]);

  useEffect(() => {
    if (follow && !highlightSeq && !localHighlightSeq && !pendingScrollSeq) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [filtered.length, follow, highlightSeq, localHighlightSeq, pendingScrollSeq]);

  const canNudge = canLiveNudge(snap);
  const swarmConvId = snap.swarm || snap.conversationId || "";
  const memberByName = new Map(members.map((m) => [m.name, m]));
  const hasCoordinator = members.some((m) => !m.killed && m.role === "coordinator" && Boolean(m.conversation_id));

  const openQuoteReply = (m: BoardMessage) => {
    setReplyTarget((cur) => (cur?.seq === m.seq ? null : m));
    setReplyDraft(`@${m.agent} Re #${m.seq}: `);
  };

  const handleSendQuoteReply = async () => {
    if (replyLockRef.current || !replyTarget || !replyDraft.trim()) return;
    const convId = memberByName.get(replyTarget.agent)?.conversation_id || "";
    const clear = () => { setReplyTarget(null); setReplyDraft(""); };
    if (!canNudge || !convId) {
      await copyText(replyDraft.trim(), `Copied reply to #${replyTarget.seq}`);
      return clear();
    }
    replyLockRef.current = true;
    try {
      await submitNudge(convId, replyDraft, `Sent reply to @${replyTarget.agent} (#${replyTarget.seq})`, setSending, () => {
        clear();
        onRefresh?.();
      });
    } finally {
      replyLockRef.current = false;
    }
  };

  const composerBadChars = hasControlChars(composerText);
  const composerReplyNum = composerReplySeq.trim() ? Number(composerReplySeq.trim()) : 0;
  const composerReplyValid = !composerReplySeq.trim() || (Number.isInteger(composerReplyNum) && composerReplyNum > 0);
  const canPostControl = Boolean(swarmConvId && canNudge);

  const handleBoardPostSubmit = async () => {
    if (composerLockRef.current) return;
    const cleanText = composerText.trim();
    if (!cleanText || cleanText.length > 4000 || composerBadChars || !composerReplyValid) return;
    if (!canPostControl) {
      const prefix = composerChannel !== "main" ? `@#${composerChannel} ` : "";
      const cite = composerReplyNum > 0 ? `Re #${composerReplyNum}: ` : "";
      await copyText(`${prefix}${cite}${cleanText}`, `Copied post for #${composerChannel}`);
      setComposerConfirm(false);
      setComposerOpen(false);
      return;
    }
    composerLockRef.current = true;
    setComposerSending(true);
    setComposerError("");
    try {
      await sendSwarmControl({
        op: "board_post",
        conversationId: swarmConvId,
        channel: composerChannel,
        text: cleanText,
        ...(composerReplyNum > 0 ? { replyToSeq: composerReplyNum } : {}),
      });
      toast.success(`Posted to #${composerChannel}`);
      setComposerText("");
      setComposerReplySeq("");
      setComposerConfirm(false);
      setComposerOpen(false);
      onRefresh?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Board post failed";
      setComposerError(msg);
      toast.error(msg);
    } finally {
      composerLockRef.current = false;
      setComposerSending(false);
    }
  };

  const channelNameValid = /^[a-z][a-z0-9-]{0,23}$/.test(channelOpName.trim()) && !["main", "all", "here"].includes(channelOpName.trim());
  const channelOpReady =
    Boolean(swarmConvId) &&
    channelNameValid &&
    !hasControlChars(channelOpTopic) &&
    ((channelOpAction !== "subscribe" && channelOpAction !== "unsubscribe") || Boolean(channelOpMember.trim()));

  const handleChannelOpSubmit = async () => {
    if (channelOpLockRef.current || !channelOpReady) return;
    channelOpLockRef.current = true;
    setChannelOpSending(true);
    setChannelOpError("");
    try {
      await sendSwarmControl({
        op: "channel_op",
        conversationId: swarmConvId,
        action: channelOpAction,
        channel: channelOpName.trim(),
        ...(channelOpAction === "create" && channelOpTopic.trim() ? { topic: channelOpTopic.trim() } : {}),
        ...(channelOpMember.trim() ? { member: channelOpMember.trim() } : {}),
      });
      toast.success(`Channel ${channelOpAction}: #${channelOpName.trim()}`);
      setChannelOpName("");
      setChannelOpTopic("");
      setChannelMgrOpen(false);
      onRefresh?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Channel action failed";
      setChannelOpError(msg);
      toast.error(msg);
    } finally {
      channelOpLockRef.current = false;
      setChannelOpSending(false);
    }
  };

  const hasActiveFilter = query.trim().length > 0 || agentFilter !== "all" || quickFilter !== "all" || channelFilter !== "all";
  const pinnedSet = new Set(pinnedSeqs);
  const pinnedMessages = messages.filter((m) => !m.control && pinnedSet.has(m.seq));

  return (
    <div className="space-y-3">
      {pinnedMessages.length > 0 && (
        <Card className="p-2 space-y-1 bg-board" aria-label="Pinned board posts">
          <div className="f1 text-[12px] font-semibold text-ink">
            <Pin className="text-info" />
            Pinned ({pinnedMessages.length})
          </div>
          <PinnedList messages={pinnedMessages} onJump={scrollToSeq} onUnpin={onTogglePin} compact />
        </Card>
      )}
      {/* Pinned Search & Filter Bar */}
      <div className="sticky top-0 z-10 -mx-1 px-1 py-1 bg-canvas space-y-2">
        <div className="f1">
          <div className="relative flex-1 min-w-0">
            <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-ink-3" />
            <Input
              aria-label="Search board messages"
              placeholder="Search #seq, @agent, text..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8 pr-7"
            />
            {query && (
              <button type="button" aria-label="Clear board search" onClick={() => setQuery("")} className="absolute right-1 top-1 p-1 text-ink-3 hover:text-ink cursor-pointer">
                <X />
              </button>
            )}
          </div>

          <Button
            variant={showFilters || hasActiveFilter ? "secondary" : "outline"}
            size="icon"
            aria-label="Toggle board filters"
            aria-expanded={showFilters}
            onClick={() => setShowFilters((s) => !s)}
            className="relative"
          >
            <Filter className="h-4 w-4" />
            {hasActiveFilter && (
              <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-blue" aria-hidden="true" />
            )}
          </Button>

          <Button
            variant={follow ? "primary" : "outline"}
            onClick={() => {
              setFollow((f) => !f);
              if (!follow) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
            }}
          >
            <ArrowDown />
            {follow ? "Following" : "Latest"}
          </Button>
        </div>

        {/* Channel Filter Tabs */}
        <div className="row flex-wrap gap-1" data-testid="board-channel-tabs">
          <div className="wrap gap-1" role="group" aria-label="Board channels">
            <Pill
              active={channelFilter === "all"}
              aria-pressed={channelFilter === "all"}
              data-testid="channel-tab-all"
              onClick={() => setChannelFilter("all")}
            >
              All channels
            </Pill>
            {channelsMeta.list.map((ch) => {
              const active = channelFilter === ch.name;
              return (
                <Pill
                  key={ch.name}
                  active={active}
                  aria-pressed={active}
                  data-testid={`channel-tab-${ch.name}`}
                  title={ch.topic || undefined}
                  onClick={() => setChannelFilter(active ? "all" : ch.name)}
                  className={cn("num inline-flex items-center gap-1", ch.archived && !active && "opacity-60")}
                >
                  <span>#{ch.name}</span>
                  <span>({ch.count})</span>
                  {ch.archived && <span>archived</span>}
                </Pill>
              );
            })}
          </div>
          {canPostControl && (
            <Button
              variant={channelMgrOpen ? "secondary" : "ghost"}
              data-testid="toggle-channel-manager"
              onClick={() => setChannelMgrOpen((v) => !v)}
              className="h-7 px-2"
            >
              <Hash className="h-3 w-3" />
              Channels
            </Button>
          )}
        </div>

        {channelMgrOpen && canPostControl && (
          <Card className="p-2.5 space-y-2 bg-board" data-testid="channel-manager-drawer">
            <div className="row">
              <span className="text-[12px] font-semibold text-ink">Channel controls</span>
              <Button variant="ghost" size="icon" aria-label="Close channel controls" onClick={() => setChannelMgrOpen(false)}>
                <X />
              </Button>
            </div>
            {members.length > 0 && !hasCoordinator && (
              <p role="alert" className="rounded-chip border border-warn bg-warn-soft px-2 py-1 text-[12px] text-warn" data-testid="board-missing-coordinator">
                No active coordinator in roster. Channel directives may fail.
              </p>
            )}
            {channelOpError && (
              <p role="alert" className="rounded-chip border border-danger bg-bad-soft px-2 py-1 text-[12px] text-danger" data-testid="channel-op-error">
                {channelOpError}
              </p>
            )}
            <div className="wrap gap-1" role="group" aria-label="Channel action">
              {(["create", "archive", "subscribe", "unsubscribe"] as const).map((act) => (
                <Pill
                  key={act}
                  active={channelOpAction === act}
                  data-testid={`channel-op-${act}`}
                  onClick={() => {
                    setChannelOpAction(act);
                    setChannelOpError("");
                  }}
                >
                  {act}
                </Pill>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              <Input
                aria-label="Channel name"
                data-testid="channel-op-name"
                placeholder="channel-name (lowercase)"
                value={channelOpName}
                onChange={(e) => {
                  setChannelOpName(e.target.value.toLowerCase());
                  setChannelOpError("");
                }}
              />
              {channelOpAction === "create" && (
                <Input
                  aria-label="Channel topic"
                  data-testid="channel-op-topic"
                  placeholder="Topic (optional)"
                  value={channelOpTopic}
                  onChange={(e) => setChannelOpTopic(e.target.value)}
                />
              )}
              {(channelOpAction === "subscribe" || channelOpAction === "unsubscribe") && (
                <select
                  aria-label="Channel member"
                  data-testid="channel-op-member"
                  value={channelOpMember}
                  onChange={(e) => setChannelOpMember(e.target.value)}
                  className="h-8 rounded-chip border border-hairline-s bg-surface px-2 text-[12px] text-ink"
                >
                  <option value="">Select worker…</option>
                  {members.filter((m) => !m.killed).map((m) => (
                    <option key={m.name} value={m.name}>@{m.name}</option>
                  ))}
                </select>
              )}
            </div>
            <div className="row">
              <span className="t3">
                {channelOpName && !channelNameValid ? "Lowercase letters, digits, hyphens (max 24)" : ""}
              </span>
              <Button
                variant="primary"
                data-testid="channel-op-submit"
                disabled={!channelOpReady || channelOpSending}
                onClick={handleChannelOpSubmit}
              >
                {channelOpSending ? "Applying…" : `Confirm ${channelOpAction}`}
              </Button>
            </div>
          </Card>
        )}

        {/* Quick-filter strip + 1-click Wave Digest */}
        <div className="row flex-wrap gap-1">
          <div className="wrap gap-1" role="group" aria-label="Board quick filters">
            {(
              [
                ["all", "All", quickCounts.all],
                ["needs_reply", "Needs reply", quickCounts.needs_reply],
                ["done", "[done]", quickCounts.done],
                ["blocked", "[blocked]", quickCounts.blocked],
              ] as const
            ).map(([id, label, count]) => (
              <Pill
                key={id}
                active={quickFilter === id}
                aria-pressed={quickFilter === id}
                onClick={() => onQuickFilterChange?.(id)}
                className="num"
              >
                {label} ({count})
              </Pill>
            ))}
          </div>
          <div className="f1">
            {([
              ["md", "text/markdown;charset=utf-8", "Markdown", "export-board-md"],
              ["json", "application/json;charset=utf-8", "JSON", "export-board-json"],
            ] as const).map(([ext, mime, label, tid]) => (
              <Button
                key={ext}
                variant="ghost"
                data-testid={tid}
                aria-label={`Export filtered board ${label}`}
                onClick={() =>
                  downloadTextFile(
                    `fleet-board-${quickFilter}.${ext}`,
                    formatFilteredBoardExport(snap, filtered, { quickFilter, agentFilter, query }, ext),
                    mime,
                    `Exported ${filtered.length} posts (.${ext})`,
                  )
                }
                className="h-7 px-2"
              >
                .{ext}
              </Button>
            ))}
            {onCopyWaveDigest && (
              <Button variant="ghost" onClick={onCopyWaveDigest} className="h-7 px-2">
                <ClipboardCopy />
                Wave digest
              </Button>
            )}
          </div>
        </div>

        {(showFilters || agentFilter !== "all") && (
          <Card className="p-2 wrap">
            {["all", ...members.map((m) => m.name)].map((name) => {
              const active = agentFilter === name;
              return (
                <Pill
                  key={name}
                  active={active}
                  onClick={() => setAgentFilter(name === "all" || active ? "all" : name)}
                  className="py-1"
                >
                  {name === "all" ? `All (${messages.filter((m) => !m.control).length})` : name}
                </Pill>
              );
            })}
          </Card>
        )}
      </div>

      {/* Feed */}
      {filtered.length === 0 ? (
        (() => {
          const activeChannelMeta =
            channelFilter !== "all" ? channelsMeta.list.find((c) => c.name === channelFilter) : undefined;
          const isEmptyChannel =
            Boolean(activeChannelMeta) && !query.trim() && agentFilter === "all" && quickFilter === "all";
          if (isEmptyChannel && activeChannelMeta) {
            return (
              <Card className="p-4 text-center space-y-2 bg-board" data-testid="board-empty-channel">
                <p className="text-[14px] font-medium text-ink">
                  No posts in #{activeChannelMeta.name} yet.
                </p>
                {activeChannelMeta.topic && (
                  <p className="text-[12px] text-ink-2 break-words">{activeChannelMeta.topic}</p>
                )}
                {activeChannelMeta.archived && (
                  <p className="text-[12px] text-ink-3">This channel is archived.</p>
                )}
                <div className="wrap justify-center gap-2 pt-1">
                  {!activeChannelMeta.archived && (
                    <Button
                      variant="primary"
                      data-testid="board-empty-channel-post"
                      onClick={() => {
                        setComposerChannel(activeChannelMeta.name);
                        setComposerOpen(true);
                        requestAnimationFrame(() => composerInputRef.current?.focus());
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Post to #{activeChannelMeta.name}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    data-testid="board-empty-channel-all"
                    onClick={() => setChannelFilter("all")}
                  >
                    All channels
                  </Button>
                </div>
              </Card>
            );
          }
          return (
            <Card className="p-4 text-center space-y-2 bg-board">
              <p className="text-[14px] text-ink-2">
                {messages.length === 0 ? "No posts yet." : "No matching posts."}
              </p>
              {hasActiveFilter && (
                <Button
                  onClick={() => {
                    setQuery("");
                    setAgentFilter("all");
                    setChannelFilter("all");
                    onQuickFilterChange?.("all");
                  }}
                >
                  Clear filters
                </Button>
              )}
            </Card>
          );
        })()
      ) : (
        <div className="space-y-2">
          {hiddenCount > 0 && (
            <div className="flex justify-center">
              <Button onClick={() => setVisibleLimit((n) => n + 120)} className="num">
                Show {hiddenCount} earlier
              </Button>
            </div>
          )}
          {visible.map((m: BoardMessage, idx) => {
            const prev = idx > 0 ? visible[idx - 1] : null;
            const grouped =
              prev &&
              prev.agent === m.agent &&
              m.ts &&
              prev.ts &&
              Math.abs(m.ts - prev.ts) < 10 * 60 * 1000 &&
              m.seq !== firstNewSeq;
            const mentionsMe = Boolean(snap.member && m.mentions.includes(snap.member));
            const isHighlighted = highlightSeq === m.seq || localHighlightSeq === m.seq;
            const childReplies = (replyRefs[m.seq] || []).filter((s) => s > 0 && s !== m.seq);

            return (
              <div key={m.seq}>
                {m.seq === firstNewSeq && (
                  <div className="flex items-center gap-2 py-1" role="separator">
                    <span className="h-px flex-1 bg-[var(--dot-red)] opacity-45" />
                    <span className="text-[12px] font-semibold text-danger">New</span>
                    <span className="h-px flex-1 bg-[var(--dot-red)] opacity-45" />
                  </div>
                )}

                <div
                  ref={(el) => {
                    if (el) rowRefs.current.set(m.seq, el);
                    else rowRefs.current.delete(m.seq);
                  }}
                  data-seq={m.seq}
                  data-highlighted={isHighlighted ? "true" : undefined}
                  className={cn(
                    "rounded-card border px-3 py-2 transition",
                    isHighlighted
                      ? "border-blue bg-blue-soft ring-1 ring-blue"
                      : mentionsMe
                        ? "border-hairline border-l-2 border-l-blue bg-surface"
                        : "border-hairline bg-surface",
                  )}
                >
                  {!grouped && (
                    <div className="row pb-1">
                      <div className="f1 min-w-0">
                        <span className="text-[13px] font-semibold text-ink truncate">{m.agent}</span>
                        {m.channel && m.channel !== "main" && <Badge tone="violet">#{m.channel}</Badge>}
                        {m.all && <Badge tone="info">@all</Badge>}
                      </div>
                      <div className="f1 shrink-0 t3 num">
                        <button
                          type="button"
                          aria-label={`Quote reply to #${m.seq}`}
                          onClick={() => openQuoteReply(m)}
                          className="rounded-chip px-1 hover:bg-track hover:text-ink cursor-pointer transition"
                        >
                          #{m.seq}
                        </button>
                        <span>{fmtClockTime(m.ts, m.time)}</span>
                        {([
                          [`Reply to #${m.seq}`, () => openQuoteReply(m), replyTarget?.seq === m.seq, <Reply className="h-3 w-3" />, undefined],
                          [pinnedSet.has(m.seq) ? `Unpin #${m.seq}` : `Pin #${m.seq}`, () => onTogglePin(m.seq), pinnedSet.has(m.seq), <Pin className="h-3 w-3" />, pinnedSet.has(m.seq)],
                        ] as const).map(([lbl, fn, on, icon, pressed]) => (
                          <button
                            key={lbl}
                            type="button"
                            aria-label={lbl}
                            aria-pressed={pressed}
                            onClick={fn}
                            className={cn("p-1 rounded-chip cursor-pointer transition", on ? "text-info bg-blue-soft" : "text-ink-3 hover:text-ink hover:bg-track")}
                          >
                            {icon}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {(() => {
                    const { cleanText, shots } = parseScreenshotLines(m.text);
                    const paths = extractLocalFilePaths(cleanText);
                    return (
                      <>
                        {cleanText && (
                          <PostBody
                            text={cleanText}
                            viewer={snap.member}
                            onClickSeq={scrollToSeq}
                            onFilterAgent={(name) => setAgentFilter(name)}
                          />
                        )}
                        <MediaPathChips compact shots={shots} paths={paths} onOpen={openOrCopyPath} />
                      </>
                    );
                  })()}
                  {childReplies.length > 0 && (
                    <div className="wrap gap-1 pt-1 text-[12px]" data-testid={`board-reply-refs-${m.seq}`}>
                      <span className="text-ink-3">Replies:</span>
                      {childReplies.map((childSeq) => (
                        <button
                          key={childSeq}
                          type="button"
                          onClick={() => scrollToSeq(childSeq)}
                          className="inline-flex items-center rounded-chip bg-blue-soft px-1.5 py-0.5 text-[12px] font-medium text-info num cursor-pointer hover:underline"
                        >
                          #{childSeq}
                        </button>
                      ))}
                    </div>
                  )}
                  {replyTarget?.seq === m.seq && (
                    <InlineComposer
                      id={`board-reply-${m.seq}`}
                      label={`Quote reply to #${m.seq} (@${m.agent})`}
                      value={replyDraft}
                      onChange={setReplyDraft}
                      onCancel={() => setReplyTarget(null)}
                      onSubmit={handleSendQuoteReply}
                      disabled={sending}
                      copyOnly={!(canNudge && memberByName.get(m.agent)?.conversation_id)}
                      submitLabel={
                        canNudge && memberByName.get(m.agent)?.conversation_id
                          ? sending
                            ? "Sending..."
                            : "Confirm & send"
                          : "Copy reply"
                      }
                      className="mt-2"
                    />
                  )}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      )}

      {/* Sticky Board / Channel Composer */}
      <div
        className="sticky bottom-0 z-10 -mx-1 px-1 pt-2 pb-1 bg-canvas border-t border-hairline"
        data-testid="board-composer"
      >
        {!composerOpen ? (
          <div className="row gap-2">
            <Button
              variant="outline"
              data-testid="board-composer-open"
              onClick={() => setComposerOpen(true)}
              className="flex-1 justify-start text-ink-2"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Post to #{composerChannel}…</span>
            </Button>
          </div>
        ) : (
          <Card className="p-2.5 space-y-2 bg-surface shadow-[var(--elev-raised)]" data-testid="board-composer-form">
            <div className="row flex-wrap gap-1.5">
              <div className="f1 min-w-0">
                <label htmlFor="board-composer-channel" className="text-[12px] font-medium text-ink-2 shrink-0">
                  Channel
                </label>
                <select
                  id="board-composer-channel"
                  aria-label="Target channel"
                  data-testid="board-composer-channel"
                  value={composerChannel}
                  onChange={(e) => {
                    setComposerChannel(e.target.value);
                    setComposerConfirm(false);
                  }}
                  className="h-7 rounded-chip border border-hairline-s bg-board px-2 text-[12px] text-ink cursor-pointer"
                >
                  {activeChannels.map((ch) => (
                    <option key={ch.name} value={ch.name}>#{ch.name}</option>
                  ))}
                </select>
              </div>

              <div className="f1">
                <label htmlFor="board-composer-reply" className="text-[12px] text-ink-3 shrink-0">
                  Reply #
                </label>
                <Input
                  id="board-composer-reply"
                  aria-label="Optional reply sequence number"
                  data-testid="board-composer-reply-seq"
                  type="number"
                  min={1}
                  placeholder="seq"
                  value={composerReplySeq}
                  onChange={(e) => {
                    setComposerReplySeq(e.target.value);
                    setComposerConfirm(false);
                  }}
                  className="h-7 w-[72px] px-2 text-[12px] num"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close board composer"
                  data-testid="board-composer-close"
                  onClick={() => {
                    setComposerOpen(false);
                    setComposerConfirm(false);
                  }}
                >
                  <X />
                </Button>
              </div>
            </div>

            <Textarea
              ref={composerInputRef}
              aria-label="Board post message"
              data-testid="board-composer-input"
              rows={2}
              maxLength={4000}
              placeholder={`Message #${composerChannel} (use @name to wake a worker)`}
              value={composerText}
              onChange={(e) => {
                setComposerText(e.target.value);
                setComposerConfirm(false);
                setComposerError("");
              }}
            />

            {canPostControl && members.length > 0 && !hasCoordinator && (
              <p role="alert" className="rounded-chip border border-warn bg-warn-soft px-2 py-1 text-[12px] text-warn" data-testid="board-missing-coordinator">
                No active coordinator in roster. Control posts may fail.
              </p>
            )}

            {composerError && (
              <p role="alert" className="rounded-chip border border-danger bg-bad-soft px-2 py-1 text-[12px] text-danger" data-testid="board-composer-error">
                {composerError}
              </p>
            )}

            {(composerBadChars || !composerReplyValid) && (
              <p className="text-[12px] text-danger">
                {composerBadChars ? "Control characters are not allowed." : "Reply sequence must be a positive number."}
              </p>
            )}

            {composerConfirm ? (
              <div className="row flex-wrap gap-2 rounded-chip bg-board px-2 py-1.5" data-testid="board-composer-confirm-bar">
                <span className="text-[12px] text-ink">
                  Post to #{composerChannel}{composerReplyNum > 0 ? ` citing #${composerReplyNum}` : ""}?
                </span>
                <div className="f1">
                  <Button variant="ghost" onClick={() => setComposerConfirm(false)}>Edit</Button>
                  <Button
                    variant="primary"
                    data-testid="board-composer-submit"
                    disabled={composerSending || !composerText.trim() || composerBadChars || !composerReplyValid}
                    onClick={handleBoardPostSubmit}
                  >
                    {canPostControl ? <Send /> : <ClipboardCopy />}
                    {composerSending ? "Sending..." : canPostControl ? "Confirm & send" : "Copy post"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="row">
                <span className="t3 num">{composerText.length}/4000</span>
                <div className="f1">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setComposerOpen(false);
                      setComposerConfirm(false);
                    }}
                  >
                    Dismiss
                  </Button>
                  <Button
                    variant="primary"
                    data-testid="board-composer-stage"
                    disabled={!composerText.trim() || composerBadChars || !composerReplyValid}
                    onClick={() => setComposerConfirm(true)}
                  >
                    <Send />
                    Review post
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
