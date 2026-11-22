// Virtualized Searchable Transcript Viewer — smoothly renders 50,000+ log lines at 60fps
// with instant substring search, match jumping, "Jump to first error", and auto-follow tail.
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ChevronDown, ChevronUp, Filter, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

const ROW_H = 22;
const OVERSCAN = 24;
const ERROR_RE = /\b(error|err:|failed|failure|panic|exception|traceback|assertionerror|fatal|conflict|timed out|exit\s+[1-9]\d*|exit code\s+[1-9]\d*)\b/i;

const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

function renderHighlightedLine(line: string, query: string) {
  if (!query) return line || " ";
  const lower = line.toLowerCase();
  const q = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let idx = lower.indexOf(q, cursor);
  let k = 0;
  while (idx !== -1 && k < 24) {
    if (idx > cursor) parts.push(line.slice(cursor, idx));
    parts.push(
      <mark key={k++} className="rounded-[3px] bg-pill-warn-bg px-0.5 text-ink">
        {line.slice(idx, idx + q.length)}
      </mark>,
    );
    cursor = idx + q.length;
    idx = lower.indexOf(q, cursor);
  }
  if (cursor < line.length) parts.push(line.slice(cursor));
  return parts.length ? parts : line || " ";
}

export function VirtualizedTranscript({
  sessionId,
  lines,
  totalHint,
  isRunning,
  supportsServerV050,
}: {
  sessionId: string;
  lines: string[];
  totalHint?: number | null;
  isRunning: boolean;
  supportsServerV050?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [matchesOnly, setMatchesOnly] = useState(false);
  const [followTail, setFollowTail] = useState(isRunning);
  const [activeMatchCursor, setActiveMatchCursor] = useState(0);
  const [activeErrorCursor, setActiveErrorCursor] = useState(0);
  const [highlightedLineNo, setHighlightedLineNo] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(340);
  const [fullLines, setFullLines] = useState<string[] | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSearch("");
    setMatchesOnly(false);
    setFollowTail(isRunning);
    setActiveMatchCursor(0);
    setActiveErrorCursor(0);
    setHighlightedLineNo(null);
    setScrollTop(0);
    setFullLines(null);
    setLoadingFull(false);
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeLines = fullLines && fullLines.length >= lines.length ? fullLines : lines;

  const loadFullTranscript = async () => {
    if (loadingFull || !supportsServerV050) return;
    setLoadingFull(true);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/transcript?offset=0&limit=60000`, {
        cache: "no-store",
      });
      if (r.ok) {
        const raw = (await r.json()) as unknown;
        const arr = Array.isArray(raw)
          ? raw
          : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).lines)
            ? ((raw as Record<string, unknown>).lines as unknown[])
            : null;
        if (arr) {
          setFullLines(
            arr.map((x) => {
              if (typeof x === "string") return x;
              if (x && typeof x === "object" && "text" in x) {
                return String((x as { text?: unknown }).text ?? "");
              }
              return String(x ?? "");
            }),
          );
        }
      }
    } catch {
      /* keep in-memory lines */
    }
    setLoadingFull(false);
  };

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.height > 0) setViewHeight(entry.contentRect.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const q = search.trim().toLowerCase();

  const errorIndices = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < activeLines.length; i++) {
      if (ERROR_RE.test(activeLines[i])) out.push(i);
    }
    return out;
  }, [activeLines]);

  const matchIndices = useMemo(() => {
    if (!q) return [];
    const out: number[] = [];
    for (let i = 0; i < activeLines.length; i++) {
      if (activeLines[i].toLowerCase().includes(q)) out.push(i);
    }
    return out;
  }, [activeLines, q]);

  const rows = useMemo(() => {
    if (matchesOnly && q) {
      return matchIndices.map((origIdx) => ({ origIdx, text: activeLines[origIdx] }));
    }
    return activeLines.map((text, origIdx) => ({ origIdx, text }));
  }, [activeLines, matchIndices, matchesOnly, q]);

  const errorSet = useMemo(() => new Set(errorIndices), [errorIndices]);

  // Auto-follow live tail while running
  useEffect(() => {
    if (!followTail || !viewportRef.current || rows.length === 0) return;
    const el = viewportRef.current;
    const maxScroll = Math.max(0, rows.length * ROW_H - el.clientHeight);
    el.scrollTop = maxScroll;
    setScrollTop(maxScroll);
  }, [rows.length, followTail]);

  const scrollToRow = (rowIndex: number, origIdx: number) => {
    const el = viewportRef.current;
    setFollowTail(false);
    setHighlightedLineNo(origIdx);
    if (!el) return;
    const target = Math.max(0, rowIndex * ROW_H - Math.floor(el.clientHeight / 3));
    el.scrollTop = target;
    setScrollTop(target);
  };

  const jumpToError = () => {
    if (errorIndices.length === 0) return;
    const nextIdx = activeErrorCursor % errorIndices.length;
    const origIdx = errorIndices[nextIdx];
    setActiveErrorCursor((nextIdx + 1) % errorIndices.length);
    if (matchesOnly && q) {
      setMatchesOnly(false);
      setTimeout(() => scrollToRow(origIdx, origIdx), 0);
    } else {
      scrollToRow(origIdx, origIdx);
    }
  };

  const stepMatch = (delta: number) => {
    if (matchIndices.length === 0) return;
    const nextCursor = (activeMatchCursor + delta + matchIndices.length) % matchIndices.length;
    setActiveMatchCursor(nextCursor);
    const origIdx = matchIndices[nextCursor];
    const rowIndex = matchesOnly ? nextCursor : origIdx;
    scrollToRow(rowIndex, origIdx);
  };

  const totalHeight = Math.max(rows.length * ROW_H, ROW_H);
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const endIdx = Math.min(rows.length, Math.ceil((scrollTop + viewHeight) / ROW_H) + OVERSCAN);
  const visibleSlice = rows.slice(startIdx, endIdx);
  const displayTotal = typeof totalHint === "number" && totalHint > activeLines.length ? totalHint : activeLines.length;
  const canLoadMore = Boolean(supportsServerV050 && displayTotal > activeLines.length);

  return (
    <div className="space-y-2.5" data-testid="virtualized-transcript">
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="min-w-[160px] flex-1">
          <InputGroupAddon>
            <Search className="size-3.5 text-icon" strokeWidth={1.5} aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Filter transcript"
            placeholder="Search transcript lines"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setActiveMatchCursor(0);
            }}
            className="text-xs max-md:!h-11"
          />
          {search && (
            <InputGroupAddon align="inline-end">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Clear transcript search"
                onClick={() => {
                  setSearch("");
                  setMatchesOnly(false);
                }}
                className="size-7 max-md:size-11"
              >
                <X className="size-3.5" strokeWidth={1.5} aria-hidden />
              </Button>
            </InputGroupAddon>
          )}
        </InputGroup>

        {q && (
          <div className="flex items-center gap-1">
            <span className="rounded-chip bg-track px-2 py-1 font-mono text-xs tabular-nums text-ink-2">
              {matchIndices.length > 0
                ? `${(activeMatchCursor % matchIndices.length) + 1}/${matchIndices.length}`
                : "0 matches"}
            </span>
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="Previous transcript match"
              disabled={matchIndices.length === 0}
              onClick={() => stepMatch(-1)}
              className="max-md:size-11"
            >
              <ChevronUp className="size-3.5" strokeWidth={1.5} aria-hidden />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="Next transcript match"
              disabled={matchIndices.length === 0}
              onClick={() => stepMatch(1)}
              className="max-md:size-11"
            >
              <ChevronDown className="size-3.5" strokeWidth={1.5} aria-hidden />
            </Button>
            <Button
              type="button"
              size="sm"
              variant={matchesOnly ? "default" : "outline"}
              aria-pressed={matchesOnly}
              onClick={() => setMatchesOnly((v) => !v)}
              className="max-md:min-h-11 max-md:px-3"
            >
              <Filter className="size-3.5" strokeWidth={1.5} aria-hidden />
              <span>Matches</span>
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
        <span className="font-mono tabular-nums">
          {plural(displayTotal, "line")}
          {matchesOnly && q ? ` · showing ${rows.length.toLocaleString()}` : ""}
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant={errorIndices.length > 0 ? "destructive-outline" : "outline"}
            disabled={errorIndices.length === 0}
            onClick={jumpToError}
            className="h-7 px-2.5 text-xs max-md:min-h-11 max-md:px-3"
          >
            <AlertTriangle className="size-3.5" strokeWidth={1.5} aria-hidden />
            <span>
              {errorIndices.length > 0
                ? `Jump to first error (${errorIndices.length})`
                : "No errors detected"}
            </span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant={followTail ? "default" : "outline"}
            aria-pressed={followTail}
            onClick={() => {
              const next = !followTail;
              setFollowTail(next);
              if (next && viewportRef.current) {
                const bottom = Math.max(0, rows.length * ROW_H - viewportRef.current.clientHeight);
                viewportRef.current.scrollTop = bottom;
                setScrollTop(bottom);
              }
            }}
            className="h-7 px-2.5 text-xs max-md:min-h-11 max-md:px-3"
          >
            <ArrowDown className="size-3.5" strokeWidth={1.5} aria-hidden />
            <span>Follow</span>
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="min-h-24 rounded-card border border-hairline bg-canvas p-3 font-mono text-xs leading-relaxed text-ink-2">
          {activeLines.length === 0 ? "No output yet." : `No transcript lines match "${search.trim()}".`}
        </div>
      ) : (
        <div
          ref={viewportRef}
          role="log"
          aria-label="Session transcript output"
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            setScrollTop(el.scrollTop);
            const nearBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) <= ROW_H * 2;
            if (!nearBottom && followTail) setFollowTail(false);
          }}
          className="h-[44vh] min-h-[180px] max-h-[460px] overflow-auto rounded-card border border-hairline bg-canvas font-mono text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="relative min-w-full" style={{ height: `${totalHeight}px` }}>
            {visibleSlice.map((row, offset) => {
              const idx = startIdx + offset;
              const isErr = errorSet.has(row.origIdx);
              const isJumpTarget = highlightedLineNo === row.origIdx;
              return (
                <div
                  key={row.origIdx}
                  data-line={row.origIdx + 1}
                  style={{
                    position: "absolute",
                    top: `${idx * ROW_H}px`,
                    left: 0,
                    right: 0,
                    height: `${ROW_H}px`,
                  }}
                  className={cn(
                    "flex items-center gap-2.5 whitespace-pre px-3 leading-[22px]",
                    isJumpTarget
                      ? "bg-blue-soft text-ink font-medium"
                      : isErr
                        ? "bg-diff-del-bg/65 text-diff-del-fg"
                        : "text-ink",
                  )}
                >
                  <span className="w-11 shrink-0 select-none text-right tabular-nums text-ink-3">
                    {row.origIdx + 1}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre">
                    {renderHighlightedLine(row.text, q)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(activeLines.length >= 2000 || canLoadMore) && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
          <span>
            Virtualized viewport active ({activeLines.length.toLocaleString()} of {displayTotal.toLocaleString()} lines loaded; full archive at logs/{sessionId}.log).
          </span>
          {canLoadMore && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loadingFull}
              onClick={() => void loadFullTranscript()}
              className="h-7 px-2.5 text-xs max-md:min-h-11"
            >
              {loadingFull ? "Loading..." : `Load all ${displayTotal.toLocaleString()} lines`}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
