import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ClipboardCopy, Filter, Pin, PinOff, Reply, Search, X } from "../icons";
import { extractLocalFilePaths, openFileInAuxPane, parseScreenshotLines, sendConfirmedNudge } from "../sidecar";
import type { BoardMessage, SwarmSnapshot } from "../types";
import { Badge, Button, Card, InlineComposer, Input, MediaPathChips, cn, copyText, fmtClockTime, toast } from "../ui";

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
    <div className="space-y-1.5">
      <p className="text-[14px] text-ink whitespace-pre-wrap break-words leading-[1.48]">
        {tokens.map((tok, i) => {
          if (/^@[a-z0-9_-]+$/i.test(tok)) {
            const name = tok.slice(1);
            const isViewer = viewer && name.toLowerCase() === viewer.toLowerCase();
            return (
              <button
                key={i}
                type="button"
                onClick={() => (name.toLowerCase() !== "all" ? onFilterAgent(name) : undefined)}
                className={cn(
                  "inline rounded-[4px] px-1 font-medium cursor-pointer transition",
                  isViewer
                    ? "bg-blue-soft text-info"
                    : "bg-track text-ink hover:bg-hairline",
                )}
              >
                {tok}
              </button>
            );
          }
          if (/^#[0-9]+$/.test(tok)) {
            const seq = Number(tok.slice(1));
            return (
              <button
                key={i}
                type="button"
                onClick={() => onClickSeq(seq)}
                className="inline rounded-[4px] bg-blue-soft px-1 text-[12px] font-medium text-info num cursor-pointer hover:underline"
              >
                {tok}
              </button>
            );
          }
          if (/^\[(?:done|verified|blocked)\]$/i.test(tok)) {
            const lower = tok.toLowerCase();
            const cls =
              lower === "[verified]"
                ? "bg-ok-soft text-ok"
                : lower === "[blocked]"
                  ? "bg-bad-soft text-danger"
                  : "bg-blue-soft text-info";
            return (
              <span key={i} className={cn("inline-block rounded-[4px] px-1.5 text-[12px] font-semibold", cls)}>
                {tok}
              </span>
            );
          }
          return <span key={i}>{tok}</span>;
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
  onQuickFilterChange,
  onCopyWaveDigest,
  onTogglePin,
  onClearHighlight,
  onRefresh,
}: {
  snap: SwarmSnapshot;
  highlightSeq: number | null;
  pinnedSeqs: number[];
  quickFilter?: BoardQuickFilter;
  onQuickFilterChange?: (f: BoardQuickFilter) => void;
  onCopyWaveDigest?: () => void;
  onTogglePin: (seq: number) => void;
  onClearHighlight: () => void;
  onRefresh?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<string>("all");
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

  const quickCounts = useMemo(() => {
    let all = 0;
    let needs_reply = 0;
    let done = 0;
    let blocked = 0;
    for (const m of messages) {
      if (m.control || unseenSet.has(m.seq)) continue;
      all++;
      if (m.text.includes("?") || (snap.member && m.mentions.includes(snap.member))) needs_reply++;
      if (/\[(done|verified)\]/i.test(m.text)) done++;
      if (/\[blocked\]/i.test(m.text)) blocked++;
    }
    return { all, needs_reply, done, blocked };
  }, [messages, unseenSet, snap.member]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return messages.filter((m) => {
      if (m.control) return false;
      if (unseenSet.has(m.seq)) return false;
      if (quickFilter === "needs_reply" && !m.text.includes("?") && !(snap.member && m.mentions.includes(snap.member))) {
        return false;
      }
      if (quickFilter === "done" && !/\[(done|verified)\]/i.test(m.text)) return false;
      if (quickFilter === "blocked" && !/\[blocked\]/i.test(m.text)) return false;
      if (agentFilter !== "all" && m.agent !== agentFilter && !m.mentions.includes(agentFilter)) return false;
      if (q && !m.text.toLowerCase().includes(q) && !m.agent.toLowerCase().includes(q) && !`#${m.seq}`.includes(q)) {
        return false;
      }
      return true;
    });
  }, [messages, agentFilter, query, unseenSet, quickFilter, snap.member]);

  const firstNewSeq = useMemo(() => {
    if (!viewerMember) return null;
    const hit = filtered.find((m) => m.seq > lastReadSeq && m.agent !== viewerMember.name);
    return hit ? hit.seq : null;
  }, [filtered, viewerMember, lastReadSeq]);

  const hiddenCount = Math.max(0, filtered.length - visibleLimit);
  const visible = useMemo(
    () => (hiddenCount > 0 ? filtered.slice(hiddenCount) : filtered),
    [filtered, hiddenCount],
  );

  const scrollToSeq = (seq: number) => {
    setFollow(false);
    const idx = filtered.findIndex((m) => m.seq === seq);
    if (idx >= 0 && idx < filtered.length - visibleLimit) {
      setVisibleLimit(filtered.length - idx + 20);
      requestAnimationFrame(() => {
        rowRefs.current.get(seq)?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      return;
    }
    const el = rowRefs.current.get(seq);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  useEffect(() => {
    if (highlightSeq) {
      scrollToSeq(highlightSeq);
      const t = setTimeout(onClearHighlight, 2600);
      return () => clearTimeout(t);
    }
  }, [highlightSeq, onClearHighlight]);

  useEffect(() => {
    if (follow && !highlightSeq) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [filtered.length, follow, highlightSeq]);

  const canNudge = Boolean(snap.capabilities?.canSendMessage || window.sidecar?.agent?.sendMessage);
  const memberByName = useMemo(() => new Map(members.map((m) => [m.name, m])), [members]);

  const openQuoteReply = (m: BoardMessage) => {
    setReplyTarget((cur) => (cur?.seq === m.seq ? null : m));
    setReplyDraft(`@${m.agent} Re #${m.seq}: `);
  };

  const handleSendQuoteReply = async () => {
    if (!replyTarget || !replyDraft.trim()) return;
    const convId = memberByName.get(replyTarget.agent)?.conversation_id || "";
    if (!canNudge || !convId) {
      await copyText(replyDraft.trim(), `Copied reply to #${replyTarget.seq}`);
      setReplyTarget(null);
      setReplyDraft("");
      return;
    }
    setSending(true);
    try {
      await sendConfirmedNudge(convId, replyDraft.trim());
      toast.success(`Sent reply to @${replyTarget.agent} (#${replyTarget.seq})`);
      setReplyTarget(null);
      setReplyDraft("");
      onRefresh?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send reply");
    } finally {
      setSending(false);
    }
  };

  const hasActiveFilter = query.trim().length > 0 || agentFilter !== "all" || quickFilter !== "all";
  const pinnedSet = useMemo(() => new Set(pinnedSeqs), [pinnedSeqs]);
  const pinnedMessages = useMemo(
    () => messages.filter((m) => !m.control && pinnedSet.has(m.seq)),
    [messages, pinnedSet],
  );

  return (
    <div className="space-y-3">
      {pinnedMessages.length > 0 && (
        <Card className="p-2.5 space-y-1.5 bg-board" aria-label="Pinned board posts">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-ink">
              <Pin className="h-3.5 w-3.5 text-info" aria-hidden="true" />
              Pinned ({pinnedMessages.length})
            </span>
          </div>
          <ul className="divide-y divide-hairline">
            {pinnedMessages.map((pm) => (
              <li key={pm.seq} className="flex items-center justify-between gap-2 py-1.5 first:pt-0.5 last:pb-0">
                <button
                  type="button"
                  onClick={() => scrollToSeq(pm.seq)}
                  className="min-w-0 flex-1 text-left text-[12px] text-ink hover:underline cursor-pointer truncate"
                >
                  <span className="font-semibold num">#{pm.seq}</span>{" "}
                  <span className="font-medium">{pm.agent}:</span>{" "}
                  <span className="text-ink-2">{parseScreenshotLines(pm.text).cleanText || pm.text.replace(/\/home\/[^/\s]+\//g, "~/")}</span>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Unpin #${pm.seq}`}
                  onClick={() => onTogglePin(pm.seq)}
                  className="shrink-0"
                >
                  <PinOff className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {/* Pinned Search & Filter Bar */}
      <div className="sticky top-0 z-10 -mx-1 px-1 py-1.5 bg-canvas space-y-2">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <Search
              className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-ink-3"
              aria-hidden="true"
            />
            <Input
              aria-label="Search board messages"
              placeholder="Search #seq, @agent, or text..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8 pr-7"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear board search"
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1.5 p-1 text-ink-3 hover:text-ink cursor-pointer"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
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
            <Filter className="h-4 w-4" aria-hidden="true" />
            {hasActiveFilter && (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-blue" aria-hidden="true" />
            )}
          </Button>

          <Button
            variant={follow ? "primary" : "outline"}
            size="sm"
            onClick={() => {
              setFollow((f) => !f);
              if (!follow) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
            }}
          >
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
            {follow ? "Following" : "Latest"}
          </Button>
        </div>

        {/* Quick-filter strip + 1-click Wave Digest */}
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Board quick filters">
            {(
              [
                ["all", "All", quickCounts.all],
                ["needs_reply", "Needs reply", quickCounts.needs_reply],
                ["done", "[done]", quickCounts.done],
                ["blocked", "[blocked]", quickCounts.blocked],
              ] as const
            ).map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                aria-pressed={quickFilter === id}
                onClick={() => onQuickFilterChange?.(id)}
                className={cn(
                  "rounded-chip px-2 py-0.5 text-[12px] font-medium cursor-pointer transition num",
                  quickFilter === id
                    ? "bg-[var(--ink-button)] text-[var(--ink-button-fg)]"
                    : "bg-track text-ink-2 hover:text-ink",
                )}
              >
                {label} ({count})
              </button>
            ))}
          </div>
          {onCopyWaveDigest && (
            <Button variant="ghost" size="sm" onClick={onCopyWaveDigest} className="h-7 px-2">
              <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
              Wave digest
            </Button>
          )}
        </div>

        {showFilters && (
          <Card className="p-2.5 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setAgentFilter("all")}
              className={cn(
                "rounded-chip px-2 py-1 text-[12px] font-medium cursor-pointer transition",
                agentFilter === "all"
                  ? "bg-[var(--ink-button)] text-[var(--ink-button-fg)]"
                  : "bg-track text-ink-2 hover:text-ink",
              )}
            >
              All ({messages.filter((m) => !m.control).length})
            </button>
            {members.map((m) => (
              <button
                key={m.name}
                type="button"
                onClick={() => setAgentFilter(m.name === agentFilter ? "all" : m.name)}
                className={cn(
                  "rounded-chip px-2 py-1 text-[12px] font-medium cursor-pointer transition",
                  agentFilter === m.name
                    ? "bg-[var(--ink-button)] text-[var(--ink-button-fg)]"
                    : "bg-track text-ink-2 hover:text-ink",
                )}
              >
                {m.name}
              </button>
            ))}
          </Card>
        )}
      </div>

      {/* Feed */}
      {filtered.length === 0 ? (
        <Card className="p-4 text-center space-y-2 bg-board">
          <p className="text-[14px] text-ink-2">
            {messages.length === 0 ? "No messages posted to the board yet." : "No posts match your current filter."}
          </p>
          {hasActiveFilter && (
            <Button
              variant="outline"
              size="sm"
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
              <Button
                variant="outline"
                size="sm"
                onClick={() => setVisibleLimit((n) => n + 120)}
                className="num"
              >
                Show older posts ({hiddenCount} earlier)
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
                  <div className="flex items-center gap-2 py-1.5" role="separator">
                    <span className="h-px flex-1 bg-[var(--unread)] opacity-45" />
                    <span className="text-[12px] font-semibold text-danger">New</span>
                    <span className="h-px flex-1 bg-[var(--unread)] opacity-45" />
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
                    <div className="flex items-center justify-between gap-2 pb-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[13px] font-semibold text-ink truncate">{m.agent}</span>
                        {m.channel && m.channel !== "main" && <Badge tone="violet">#{m.channel}</Badge>}
                        {m.all && <Badge tone="info">@all</Badge>}
                      </div>
                      <div className="flex items-center gap-1 shrink-0 text-[12px] text-ink-3 num">
                        <button
                          type="button"
                          aria-label={`Quote reply to #${m.seq}`}
                          onClick={() => openQuoteReply(m)}
                          className="rounded-[4px] px-1 py-0.5 hover:bg-track hover:text-ink cursor-pointer transition"
                        >
                          #{m.seq}
                        </button>
                        <span>{fmtClockTime(m.ts, m.time)}</span>
                        <button
                          type="button"
                          aria-label={`Reply to #${m.seq}`}
                          onClick={() => openQuoteReply(m)}
                          className={cn(
                            "p-1 rounded-[4px] cursor-pointer transition",
                            replyTarget?.seq === m.seq
                              ? "text-info bg-blue-soft"
                              : "text-ink-3 hover:text-ink hover:bg-track",
                          )}
                        >
                          <Reply className="h-3 w-3" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label={pinnedSet.has(m.seq) ? `Unpin #${m.seq}` : `Pin #${m.seq}`}
                          aria-pressed={pinnedSet.has(m.seq)}
                          onClick={() => onTogglePin(m.seq)}
                          className={cn(
                            "p-1 rounded-[4px] cursor-pointer transition",
                            pinnedSet.has(m.seq)
                              ? "text-info bg-blue-soft"
                              : "text-ink-3 hover:text-ink hover:bg-track",
                          )}
                        >
                          <Pin className="h-3 w-3" aria-hidden="true" />
                        </button>
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
                        <MediaPathChips
                          compact
                          shots={shots}
                          paths={paths}
                          onOpen={(target, fallback) => {
                            if (openFileInAuxPane(target)) {
                              toast.success(`Opened ${target.split("/").pop() || "file"}`);
                            } else if (fallback) {
                              void copyText(fallback, target === fallback ? "File path copied" : "Screenshot label copied");
                            }
                          }}
                        />
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
