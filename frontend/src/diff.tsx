// Unified & Side-by-Side Diff Viewer with per-file collapsible headers, +add/-del stats,
// Pre-Merge Conflict Badge (/api/sessions/:id/merge-check), Merge Strategy selector, and Download .patch.
import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  Download,
  FileDiff,
  GitMerge,
  RefreshCw,
  Rows3,
} from "lucide-react";
import { Button, Badge, Expandable, SegmentedControl, cn, toast } from "./ui";
import {
  downloadSessionPatch,
  fetchMergeCheck,
  type MergeCheckResult,
  type MergeStrategy,
  type Session,
} from "./api";

export type DiffLineEntry = {
  kind: "hunk" | "add" | "del" | "ctx";
  text: string;
  oldNum: number | null;
  newNum: number | null;
};

export type ParsedDiffFile = {
  id: string;
  path: string;
  status: "modified" | "added" | "deleted";
  addCount: number;
  delCount: number;
  lines: DiffLineEntry[];
};

export type SideBySideRow = {
  kind: "hunk" | "pair";
  hunkText?: string;
  left?: { num: number | null; text: string; kind: "del" | "ctx" | "empty" };
  right?: { num: number | null; text: string; kind: "add" | "ctx" | "empty" };
};

export function parseDiffFiles(raw?: string): ParsedDiffFile[] {
  if (!raw || !raw.trim()) return [];
  const allLines = raw.split("\n");
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;

  const ensureCurrent = (fallbackPath = "changes.patch") => {
    if (!current) {
      current = {
        id: `file-${files.length}`,
        path: fallbackPath,
        status: "modified",
        addCount: 0,
        delCount: 0,
        lines: [],
      };
      files.push(current);
    }
    return current;
  };

  for (const line of allLines) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const path = m ? m[2] : line.slice("diff --git ".length).trim() || `file-${files.length + 1}`;
      current = {
        id: `file-${files.length}-${path}`,
        path,
        status: "modified",
        addCount: 0,
        delCount: 0,
        lines: [],
      };
      files.push(current);
      oldLine = 0;
      newLine = 0;
      continue;
    }
    if (line.startsWith("new file mode")) {
      ensureCurrent().status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      ensureCurrent().status = "deleted";
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (line.startsWith("+++ b/")) {
        const cur = ensureCurrent();
        if (!cur.path || cur.path === "changes.patch") cur.path = line.slice("+++ b/".length);
      }
      continue;
    }
    if (line.startsWith("@@")) {
      const cur = ensureCurrent();
      const m = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
      if (m) {
        oldLine = Number.parseInt(m[1], 10);
        newLine = Number.parseInt(m[2], 10);
      }
      cur.lines.push({ kind: "hunk", text: line, oldNum: null, newNum: null });
      continue;
    }
    if (line.startsWith("+")) {
      const cur = ensureCurrent();
      cur.addCount++;
      cur.lines.push({ kind: "add", text: line.slice(1), oldNum: null, newNum: newLine++ });
      continue;
    }
    if (line.startsWith("-")) {
      const cur = ensureCurrent();
      cur.delCount++;
      cur.lines.push({ kind: "del", text: line.slice(1), oldNum: oldLine++, newNum: null });
      continue;
    }
    if (current) {
      const body = line.startsWith(" ") ? line.slice(1) : line;
      current.lines.push({ kind: "ctx", text: body, oldNum: oldLine++, newNum: newLine++ });
    }
  }

  return files;
}

export function buildSideBySideRows(lines: DiffLineEntry[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "hunk") {
      rows.push({ kind: "hunk", hunkText: line.text });
      i++;
      continue;
    }
    if (line.kind === "ctx") {
      rows.push({
        kind: "pair",
        left: { num: line.oldNum, text: line.text, kind: "ctx" },
        right: { num: line.newNum, text: line.text, kind: "ctx" },
      });
      i++;
      continue;
    }
    const dels: DiffLineEntry[] = [];
    const adds: DiffLineEntry[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    const maxLen = Math.max(dels.length, adds.length);
    for (let k = 0; k < maxLen; k++) {
      const d = dels[k];
      const a = adds[k];
      rows.push({
        kind: "pair",
        left: d
          ? { num: d.oldNum, text: d.text, kind: "del" }
          : { num: null, text: "", kind: "empty" },
        right: a
          ? { num: a.newNum, text: a.text, kind: "add" }
          : { num: null, text: "", kind: "empty" },
      });
    }
  }
  return rows;
}

export const MERGE_STRATEGIES: { id: MergeStrategy; label: string; short: string }[] = [
  { id: "merge", label: "Merge commit", short: "Merge" },
  { id: "squash", label: "Squash", short: "Squash" },
  { id: "ff", label: "Fast-forward", short: "Fast-forward" },
];

export function MergeStrategyControl({
  value,
  onChange,
  disabled,
}: {
  value: MergeStrategy;
  onChange: (v: MergeStrategy) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1 text-xs font-medium text-ink-2">
        <GitMerge className="size-3.5 text-icon" strokeWidth={1.5} aria-hidden />
        <span>Merge strategy</span>
      </span>
      <SegmentedControl
        label="Merge strategy"
        value={value}
        onChange={(v) => {
          if (!disabled) onChange(v);
        }}
        options={MERGE_STRATEGIES.map((st) => ({ value: st.id, label: st.label }))}
      />
    </div>
  );
}

export function RichDiffViewer({
  session,
  supportsServerV050,
  mergeCheck,
  checkingMerge,
  onRecheckMerge,
}: {
  session: Session;
  supportsServerV050: boolean;
  mergeCheck: MergeCheckResult | null;
  checkingMerge: boolean;
  onRecheckMerge: () => void;
}) {
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedLines, setExpandedLines] = useState<Record<string, boolean>>({});
  const [visibleFilesLimit, setVisibleFilesLimit] = useState(20);
  const [downloading, setDownloading] = useState(false);

  const files = useMemo(() => parseDiffFiles(session.diff), [session.diff]);
  const totals = useMemo(
    () =>
      files.reduce(
        (acc, f) => ({ add: acc.add + f.addCount, del: acc.del + f.delCount }),
        { add: 0, del: 0 },
      ),
    [files],
  );

  useEffect(() => {
    const initialCollapsed: Record<string, boolean> = {};
    if (files.length > 12) {
      for (let i = 6; i < files.length; i++) initialCollapsed[files[i].id] = true;
    }
    setCollapsed(initialCollapsed);
    setExpandedLines({});
    setVisibleFilesLimit(20);
  }, [session.id, files]);

  const allCollapsed = files.length > 0 && files.every((f) => collapsed[f.id]);

  const toggleAll = () => {
    if (allCollapsed) {
      setCollapsed({});
    } else {
      const next: Record<string, boolean> = {};
      for (const f of files) next[f.id] = true;
      setCollapsed(next);
    }
  };

  const handleDownloadPatch = async () => {
    if (downloading) return;
    setDownloading(true);
    const res = await downloadSessionPatch(session, supportsServerV050);
    setDownloading(false);
    if (res.ok) {
      toast.success(`Downloaded ${res.filename}`);
    } else {
      toast.error(res.error || "Could not export patch.");
    }
  };

  const conflictCount = mergeCheck?.conflicting_files.length ?? 0;

  return (
    <div className="space-y-3" data-testid="rich-diff-viewer">
      <div className="flex flex-wrap items-center gap-2 rounded-card border border-hairline bg-canvas p-2.5">
        <div className="flex flex-wrap items-center gap-1.5 text-xs font-mono tabular-nums">
          <span className="inline-flex items-center gap-1 text-ink-2">
            <FileDiff className="size-3.5 text-icon" strokeWidth={1.5} aria-hidden />
            <span>{files.length} {files.length === 1 ? "file" : "files"}</span>
          </span>
          <span className="rounded-chip bg-diff-add-bg px-1.5 py-0.5 font-medium text-diff-add-fg">+{totals.add}</span>
          <span className="rounded-chip bg-diff-del-bg px-1.5 py-0.5 font-medium text-diff-del-fg">−{totals.del}</span>
        </div>

        {session.status !== "merged" && (
          <div className="flex flex-wrap items-center gap-1.5">
            {mergeCheck ? (
              <Badge
                tone={mergeCheck.clean ? "success" : "danger"}
                className="mono"
                data-testid="merge-check-badge"
              >
                <span>
                  {mergeCheck.clean
                    ? "Clean merge"
                    : `${conflictCount || 1} ${conflictCount === 1 ? "conflict" : "conflicts"}`}
                </span>
              </Badge>
            ) : (
              <Badge tone="neutral" className="mono">
                <span>{checkingMerge ? "Checking merge..." : "Merge check ready"}</span>
              </Badge>
            )}
            {mergeCheck && (mergeCheck.commits_ahead > 0 || mergeCheck.commits_behind > 0) && (
              <span className="rounded-[var(--radius-chip)] bg-[var(--track)] px-2 py-0.5 mono text-[12px] text-[var(--ink-2)]">
                +{mergeCheck.commits_ahead} / -{mergeCheck.commits_behind}
              </span>
            )}
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Re-run pre-merge conflict check"
              disabled={checkingMerge}
              onClick={onRecheckMerge}
            >
              <RefreshCw
                className={cn("size-3.5 text-[var(--ink-2)] motion-reduce:animate-none", checkingMerge && "animate-spin")}
                strokeWidth={1.5}
                aria-hidden
              />
            </Button>
          </div>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SegmentedControl
            label="Diff view mode"
            value={mode}
            onChange={(m) => setMode(m)}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Split" },
            ]}
          />

          {files.length > 1 && (
            <Button type="button" size="sm" variant="outline" onClick={toggleAll}>
              {allCollapsed ? "Expand files" : "Collapse files"}
            </Button>
          )}

          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={downloading || files.length === 0}
            onClick={handleDownloadPatch}
          >
            <Download className="size-3.5" strokeWidth={1.5} aria-hidden />
            <span>.patch</span>
          </Button>
        </div>
      </div>

      {mergeCheck && !mergeCheck.clean && mergeCheck.conflicting_files.length > 0 && (
        <div role="status" className="rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--bad-soft)] p-2.5 text-[var(--destructive-foreground)]">
          <Expandable
            triggerLabel={`Pre-merge dry-run found ${mergeCheck.conflicting_files.length} conflicting ${mergeCheck.conflicting_files.length === 1 ? "file" : "files"} against ${session.merge_target || "base"}`}
            openLabel="Hide conflicting files"
            className="border-0 bg-transparent"
          >
            <ul className="space-y-1 pt-1 mono text-[12px] text-[var(--ink)]">
              {mergeCheck.conflicting_files.map((file) => (
                <li key={file} className="break-all">{file}</li>
              ))}
            </ul>
          </Expandable>
        </div>
      )}

      {files.length === 0 ? (
        <pre className="min-h-24 rounded-card border border-hairline bg-canvas p-3 font-mono text-xs leading-relaxed text-ink-2">
          No changes on this branch yet.
        </pre>
      ) : (
        <div className="max-h-[48vh] space-y-2.5 overflow-y-auto pr-0.5">
          {files.slice(0, visibleFilesLimit).map((file) => {
            const isCollapsed = Boolean(collapsed[file.id]);
            const showAllLines = Boolean(expandedLines[file.id]);
            const LINE_WINDOW = 250;
            const visibleUnified = showAllLines ? file.lines : file.lines.slice(0, LINE_WINDOW);
            const splitRows = mode === "split" && !isCollapsed ? buildSideBySideRows(file.lines) : null;
            const visibleSplit = splitRows ? (showAllLines ? splitRows : splitRows.slice(0, LINE_WINDOW)) : null;
            return (
              <div key={file.id} className="overflow-hidden rounded-card border border-hairline bg-canvas">
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  aria-label={`Toggle diff for ${file.path}`}
                  onClick={() => setCollapsed((prev) => ({ ...prev, [file.id]: !prev[file.id] }))}
                  className="flex w-full cursor-pointer items-center gap-2 border-b border-hairline bg-board px-3 py-2 text-left font-mono text-xs text-ink outline-none transition hover:bg-raised focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-md:min-h-11"
                >
                  {isCollapsed ? (
                    <ChevronRight className="size-3.5 shrink-0 text-icon" strokeWidth={1.5} aria-hidden />
                  ) : (
                    <ChevronDown className="size-3.5 shrink-0 text-icon" strokeWidth={1.5} aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium">{file.path}</span>
                  {file.status !== "modified" && (
                    <span className="shrink-0 rounded-chip bg-track px-1.5 py-0.5 text-ink-2">{file.status}</span>
                  )}
                  <span className="shrink-0 rounded-chip bg-diff-add-bg px-1.5 py-0.5 tabular-nums text-diff-add-fg">
                    +{file.addCount}
                  </span>
                  <span className="shrink-0 rounded-chip bg-diff-del-bg px-1.5 py-0.5 tabular-nums text-diff-del-fg">
                    −{file.delCount}
                  </span>
                </button>

                {!isCollapsed && mode === "unified" && (
                  <div className="overflow-x-auto font-mono text-xs leading-relaxed">
                    <div className="min-w-full py-1">
                      {visibleUnified.map((line, idx) => (
                        <div
                          key={idx}
                          className={cn(
                            "flex whitespace-pre px-2 py-0.5",
                            line.kind === "hunk" && "bg-track/60 text-ink-3",
                            line.kind === "add" && "bg-diff-add-bg text-diff-add-fg",
                            line.kind === "del" && "bg-diff-del-bg text-diff-del-fg",
                            line.kind === "ctx" && "text-ink-2",
                          )}
                        >
                          <span className="w-8 shrink-0 select-none pr-1.5 text-right tabular-nums text-ink-3">
                            {line.oldNum ?? ""}
                          </span>
                          <span className="w-8 shrink-0 select-none pr-2 text-right tabular-nums text-ink-3">
                            {line.newNum ?? ""}
                          </span>
                          <span className="w-4 shrink-0 select-none text-center">
                            {line.kind === "add" ? "+" : line.kind === "del" ? "−" : line.kind === "hunk" ? "" : " "}
                          </span>
                          <span className="min-w-0 flex-1 whitespace-pre">{line.text || " "}</span>
                        </div>
                      ))}
                      {!showAllLines && file.lines.length > LINE_WINDOW && (
                        <div className="border-t border-hairline px-3 py-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setExpandedLines((prev) => ({ ...prev, [file.id]: true }))}
                          >
                            Show all {file.lines.length} lines (+{file.lines.length - LINE_WINDOW} hidden)
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {!isCollapsed && mode === "split" && visibleSplit && (
                  <div className="overflow-x-auto font-mono text-xs leading-relaxed" data-testid="diff-split-grid">
                    <div className="min-w-[460px] divide-y divide-hairline/40 py-1">
                      {visibleSplit.map((row, idx) =>
                        row.kind === "hunk" ? (
                          <div key={idx} className="bg-track/60 px-3 py-0.5 text-ink-3">
                            {row.hunkText}
                          </div>
                        ) : (
                          <div key={idx} className="grid grid-cols-2 divide-x divide-hairline">
                            <div
                              className={cn(
                                "flex min-w-0 overflow-hidden px-2 py-0.5",
                                row.left?.kind === "del" && "bg-diff-del-bg text-diff-del-fg",
                                row.left?.kind === "ctx" && "text-ink-2",
                                row.left?.kind === "empty" && "bg-board/50 text-ink-3",
                              )}
                            >
                              <span className="w-7 shrink-0 select-none pr-1.5 text-right tabular-nums text-ink-3">
                                {row.left?.num ?? ""}
                              </span>
                              <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
                                {row.left?.text || " "}
                              </span>
                            </div>
                            <div
                              className={cn(
                                "flex min-w-0 overflow-hidden px-2 py-0.5",
                                row.right?.kind === "add" && "bg-diff-add-bg text-diff-add-fg",
                                row.right?.kind === "ctx" && "text-ink-2",
                                row.right?.kind === "empty" && "bg-board/50 text-ink-3",
                              )}
                            >
                              <span className="w-7 shrink-0 select-none pr-1.5 text-right tabular-nums text-ink-3">
                                {row.right?.num ?? ""}
                              </span>
                              <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
                                {row.right?.text || " "}
                              </span>
                            </div>
                          </div>
                        ),
                      )}
                      {!showAllLines && splitRows && splitRows.length > LINE_WINDOW && (
                        <div className="border-t border-hairline px-3 py-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setExpandedLines((prev) => ({ ...prev, [file.id]: true }))}
                          >
                            Show all {splitRows.length} rows (+{splitRows.length - LINE_WINDOW} hidden)
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {files.length > visibleFilesLimit && (
            <div className="flex justify-center pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setVisibleFilesLimit((n) => n + 20)}
              >
                Load next {Math.min(20, files.length - visibleFilesLimit)} files ({files.length - visibleFilesLimit} remaining)
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function useMergeCheck(session: Session | null, supportsServerV050: boolean) {
  const [result, setResult] = useState<MergeCheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  const run = async (target: Session) => {
    setChecking(true);
    const res = await fetchMergeCheck(target, supportsServerV050);
    setResult(res);
    setChecking(false);
  };

  useEffect(() => {
    setResult(null);
    if (!session || session.status === "merged") return;
    if (session.status === "done" || Boolean(session.diff && session.diff.trim())) {
      let alive = true;
      setChecking(true);
      fetchMergeCheck(session, supportsServerV050).then((res) => {
        if (!alive) return;
        setResult(res);
        setChecking(false);
      });
      return () => {
        alive = false;
      };
    }
  }, [session?.id, session?.status, session?.diff, supportsServerV050]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    mergeCheck: result,
    checkingMerge: checking,
    recheckMerge: () => {
      if (session) void run(session);
    },
  };
}
