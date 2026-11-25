import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, FileCode2, Filter, Pin, PinOff, Search, X } from "lucide-react";
import { extractLocalFilePaths, openFileInAuxPane } from "../sidecar";
import type { BoardMessage, SwarmSnapshot } from "../types";
import { Badge, Button, Card, Input, cn, fmtClockTime, toast } from "../ui";

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
      <p className="text-[14px] text-[var(--ink)] whitespace-pre-wrap break-words leading-[1.48]">
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
                    ? "bg-[var(--blue-soft)] text-[var(--info-foreground)]"
                    : "bg-[var(--track)] text-[var(--ink)] hover:bg-[var(--hairline)]",
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
                className="inline rounded-[4px] bg-[var(--blue-soft)] px-1 text-[12px] font-medium text-[var(--info-foreground)] num cursor-pointer hover:underline"
              >
                {tok}
              </button>
            );
          }
          if (/^\[(?:done|verified|blocked)\]$/i.test(tok)) {
            const lower = tok.toLowerCase();
            const cls =
              lower === "[verified]"
                ? "bg-[var(--ok-soft)] text-[var(--success-foreground)]"
                : lower === "[blocked]"
                  ? "bg-[var(--bad-soft)] text-[var(--destructive-foreground)]"
                  : "bg-[var(--blue-soft)] text-[var(--info-foreground)]";
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
          className="text-[12px] font-medium text-[var(--info-foreground)] hover:underline cursor-pointer"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

export function BoardView({
  snap,
  highlightSeq,
  pinnedSeqs,
  onTogglePin,
  onClearHighlight,
}: {
  snap: SwarmSnapshot;
  highlightSeq: number | null;
  pinnedSeqs: number[];
  onTogglePin: (seq: number) => void;
  onClearHighlight: () => void;
}) {
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [showFilters, setShowFilters] = useState(false);
  const [follow, setFollow] = useState(true);
  const [visibleLimit, setVisibleLimit] = useState(80);

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return messages.filter((m) => {
      if (m.control) return false;
      if (unseenSet.has(m.seq)) return false;
      if (agentFilter !== "all" && m.agent !== agentFilter && !m.mentions.includes(agentFilter)) return false;
      if (q && !m.text.toLowerCase().includes(q) && !m.agent.toLowerCase().includes(q) && !`#${m.seq}`.includes(q)) {
        return false;
      }
      return true;
    });
  }, [messages, agentFilter, query, unseenSet]);

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

  const hasActiveFilter = query.trim().length > 0 || agentFilter !== "all";
  const pinnedSet = useMemo(() => new Set(pinnedSeqs), [pinnedSeqs]);
  const pinnedMessages = useMemo(
    () => messages.filter((m) => !m.control && pinnedSet.has(m.seq)),
    [messages, pinnedSet],
  );

  return (
    <div className="space-y-3">
      {pinnedMessages.length > 0 && (
        <Card className="p-2.5 space-y-1.5 bg-[var(--board)]" aria-label="Pinned board posts">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--ink)]">
              <Pin className="h-3.5 w-3.5 text-[var(--info-foreground)]" aria-hidden="true" />
              Pinned ({pinnedMessages.length})
            </span>
          </div>
          <ul className="divide-y divide-[var(--hairline)]">
            {pinnedMessages.map((pm) => (
              <li key={pm.seq} className="flex items-center justify-between gap-2 py-1.5 first:pt-0.5 last:pb-0">
                <button
                  type="button"
                  onClick={() => scrollToSeq(pm.seq)}
                  className="min-w-0 flex-1 text-left text-[12px] text-[var(--ink)] hover:underline cursor-pointer truncate"
                >
                  <span className="font-semibold num">#{pm.seq}</span>{" "}
                  <span className="font-medium">{pm.agent}:</span>{" "}
                  <span className="text-[var(--ink-2)]">{pm.text}</span>
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
      <div className="sticky top-0 z-10 -mx-1 px-1 py-1.5 bg-[var(--canvas)] space-y-2">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <Search
              className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-[var(--ink-3)]"
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
                className="absolute right-1.5 top-1.5 p-1 text-[var(--ink-3)] hover:text-[var(--ink)] cursor-pointer"
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
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--blue)]" aria-hidden="true" />
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

        {showFilters && (
          <Card className="p-2.5 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setAgentFilter("all")}
              className={cn(
                "rounded-[var(--radius-chip)] px-2 py-1 text-[12px] font-medium cursor-pointer transition",
                agentFilter === "all"
                  ? "bg-[var(--ink-button)] text-[var(--ink-button-fg)]"
                  : "bg-[var(--track)] text-[var(--ink-2)] hover:text-[var(--ink)]",
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
                  "rounded-[var(--radius-chip)] px-2 py-1 text-[12px] font-medium cursor-pointer transition",
                  agentFilter === m.name
                    ? "bg-[var(--ink-button)] text-[var(--ink-button-fg)]"
                    : "bg-[var(--track)] text-[var(--ink-2)] hover:text-[var(--ink)]",
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
        <Card className="p-4 text-center space-y-2 bg-[var(--board)]">
          <p className="text-[14px] text-[var(--ink-2)]">
            {messages.length === 0 ? "No messages posted to the board yet." : "No posts match your current filter."}
          </p>
          {hasActiveFilter && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery("");
                setAgentFilter("all");
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
                    <span className="text-[12px] font-semibold text-[var(--destructive-foreground)]">New</span>
                    <span className="h-px flex-1 bg-[var(--unread)] opacity-45" />
                  </div>
                )}

                <div
                  ref={(el) => {
                    if (el) rowRefs.current.set(m.seq, el);
                    else rowRefs.current.delete(m.seq);
                  }}
                  className={cn(
                    "rounded-[var(--radius-card)] border px-3 py-2 transition",
                    isHighlighted
                      ? "border-[var(--blue)] bg-[var(--blue-soft)]"
                      : mentionsMe
                        ? "border-[var(--hairline)] border-l-2 border-l-[var(--blue)] bg-[var(--surface)]"
                        : "border-[var(--hairline)] bg-[var(--surface)]",
                  )}
                >
                  {!grouped && (
                    <div className="flex items-center justify-between gap-2 pb-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[13px] font-semibold text-[var(--ink)] truncate">{m.agent}</span>
                        {m.channel && m.channel !== "main" && <Badge tone="violet">#{m.channel}</Badge>}
                        {m.all && <Badge tone="info">@all</Badge>}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 text-[12px] text-[var(--ink-3)] num">
                        <span>#{m.seq}</span>
                        <span>{fmtClockTime(m.ts, m.time)}</span>
                        <button
                          type="button"
                          aria-label={pinnedSet.has(m.seq) ? `Unpin #${m.seq}` : `Pin #${m.seq}`}
                          aria-pressed={pinnedSet.has(m.seq)}
                          onClick={() => onTogglePin(m.seq)}
                          className={cn(
                            "p-1 rounded-[4px] cursor-pointer transition",
                            pinnedSet.has(m.seq)
                              ? "text-[var(--info-foreground)] bg-[var(--blue-soft)]"
                              : "text-[var(--ink-3)] hover:text-[var(--ink)] hover:bg-[var(--track)]",
                          )}
                        >
                          <Pin className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  )}
                  <PostBody
                    text={m.text}
                    viewer={snap.member}
                    onClickSeq={scrollToSeq}
                    onFilterAgent={(name) => setAgentFilter(name)}
                  />
                  {(() => {
                    const paths = extractLocalFilePaths(m.text);
                    if (!paths.length) return null;
                    return (
                      <div className="flex flex-wrap gap-1.5 pt-1.5">
                        {paths.map((fp) => (
                          <button
                            key={fp}
                            type="button"
                            onClick={() => {
                              if (openFileInAuxPane(fp)) {
                                toast.success(`Opened ${fp.split("/").pop() || "file"}`);
                              } else {
                                navigator.clipboard.writeText(fp).then(() => toast.success("File path copied")).catch(() => {});
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-[var(--radius-chip)] bg-[var(--track)] px-2 py-0.5 text-[12px] text-[var(--ink-2)] hover:text-[var(--ink)] cursor-pointer max-w-full"
                          >
                            <FileCode2 className="h-3 w-3 shrink-0" aria-hidden="true" />
                            <span className="truncate mono">{fp.split("/").pop()}</span>
                          </button>
                        ))}
                      </div>
                    );
                  })()}
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
