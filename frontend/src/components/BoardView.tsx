import { useEffect, useMemo, useRef, useState } from "../hooks";
import { ArrowDown, ClipboardCopy, Filter, Pin, Reply, Search, X } from "../icons";
import { extractLocalFilePaths, parseScreenshotLines } from "../sidecar";
import type { BoardMessage, SwarmSnapshot } from "../types";
import { Badge, Button, Card, InlineComposer, Input, MediaPathChips, Pill, PinnedList, canLiveNudge, cn, copyText, downloadTextFile, fmtClockTime, formatFilteredBoardExport, openOrCopyPath, submitNudge } from "../ui";

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
  const [showFilters, setShowFilters] = useState(false);
  const [follow, setFollow] = useState(true);
  const [visibleLimit, setVisibleLimit] = useState(80);
  const [replyTarget, setReplyTarget] = useState<BoardMessage | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [sending, setSending] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const messages = snap.messages || [];
  const members = snap.members || [];
  const unseenSet = useMemo(() => new Set(snap.unseen || []), [snap.unseen]);
  const viewerMember = useMemo(
    () => (snap.member ? members.find((m) => m.name === snap.member) || null : null),
    [members, snap.member],
  );
  const lastReadSeq = viewerMember?.last_read_seq ?? 0;

  const isNeedsReply = (m: BoardMessage) => m.text.includes("?") || Boolean(snap.member && m.mentions.includes(snap.member));

  const quickCounts = useMemo(() => {
    let all = 0, needs_reply = 0, done = 0, blocked = 0;
    for (const m of messages) {
      if (m.control || unseenSet.has(m.seq)) continue;
      all++;
      if (isNeedsReply(m)) needs_reply++;
      if (/\[(done|verified)\]/i.test(m.text)) done++;
      if (/\[blocked\]/i.test(m.text)) blocked++;
    }
    return { all, needs_reply, done, blocked };
  }, [messages, unseenSet, snap.member]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return messages.filter((m) => {
      if (m.control || unseenSet.has(m.seq)) return false;
      if (quickFilter === "needs_reply" && !isNeedsReply(m)) return false;
      if (quickFilter === "done" && !/\[(done|verified)\]/i.test(m.text)) return false;
      if (quickFilter === "blocked" && !/\[blocked\]/i.test(m.text)) return false;
      if (agentFilter !== "all" && m.agent !== agentFilter && !m.mentions.includes(agentFilter)) return false;
      if (q && !m.text.toLowerCase().includes(q) && !m.agent.toLowerCase().includes(q) && !`#${m.seq}`.includes(q)) return false;
      return true;
    });
  }, [messages, agentFilter, query, unseenSet, quickFilter, snap.member]);

  const firstNewSeq = useMemo(() => {
    if (!viewerMember) return null;
    const hit = filtered.find((m) => m.seq > lastReadSeq && m.agent !== viewerMember.name);
    return hit ? hit.seq : null;
  }, [filtered, viewerMember, lastReadSeq]);

  const hiddenCount = Math.max(0, filtered.length - visibleLimit);
  const visible = hiddenCount > 0 ? filtered.slice(hiddenCount) : filtered;

  const scrollToSeq = (seq: number) => {
    setFollow(false);
    const idx = filtered.findIndex((m) => m.seq === seq);
    if (idx >= 0 && idx < filtered.length - visibleLimit) {
      setVisibleLimit(filtered.length - idx + 20);
      requestAnimationFrame(() => rowRefs.current.get(seq)?.scrollIntoView({ behavior: "smooth", block: "center" }));
      return;
    }
    rowRefs.current.get(seq)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  useEffect(() => {
    if (!highlightSeq) return;
    scrollToSeq(highlightSeq);
    const t = setTimeout(onClearHighlight, 2600);
    return () => clearTimeout(t);
  }, [highlightSeq, onClearHighlight]);

  useEffect(() => {
    if (follow && !highlightSeq) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [filtered.length, follow, highlightSeq]);

  const canNudge = canLiveNudge(snap);
  const memberByName = new Map(members.map((m) => [m.name, m]));

  const openQuoteReply = (m: BoardMessage) => {
    setReplyTarget((cur) => (cur?.seq === m.seq ? null : m));
    setReplyDraft(`@${m.agent} Re #${m.seq}: `);
  };

  const handleSendQuoteReply = async () => {
    if (!replyTarget || !replyDraft.trim()) return;
    const convId = memberByName.get(replyTarget.agent)?.conversation_id || "";
    const clear = () => { setReplyTarget(null); setReplyDraft(""); };
    if (!canNudge || !convId) {
      await copyText(replyDraft.trim(), `Copied reply to #${replyTarget.seq}`);
      return clear();
    }
    await submitNudge(convId, replyDraft, `Sent reply to @${replyTarget.agent} (#${replyTarget.seq})`, setSending, () => {
      clear();
      onRefresh?.();
    });
  };

  const hasActiveFilter = query.trim().length > 0 || agentFilter !== "all" || quickFilter !== "all";
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
        <Card className="p-4 text-center space-y-2 bg-board">
          <p className="text-[14px] text-ink-2">
            {messages.length === 0 ? "No posts yet." : "No matching posts."}
          </p>
          {hasActiveFilter && (
            <Button
              onClick={() => {
                setQuery("");
                setAgentFilter("all");
                onQuickFilterChange?.("all");
              }}
            >
              Clear filters
            </Button>
          )}
        </Card>
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
            const isHighlighted = highlightSeq === m.seq;

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
                  className={cn(
                    "rounded-card border px-3 py-2 transition",
                    isHighlighted
                      ? "border-blue bg-blue-soft"
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
    </div>
  );
}
