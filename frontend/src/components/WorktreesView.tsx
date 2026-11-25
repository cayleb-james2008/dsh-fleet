import { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, FileCode2, FolderGit2, GitBranch, RefreshCw } from "../icons";
import { fetchWorktreeDiff, openFileInAuxPane } from "../sidecar";
import type { WorktreeDiffPayload, WorktreesPayload } from "../types";
import { Badge, Button, Card, Input, copyText, fmtTimeAgo, toast } from "../ui";

const FILE_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  "??": "neutral",
  A: "success",
  M: "warning",
  D: "danger",
  R: "warning",
};

export function WorktreesView({
  workspaceUris,
  payload,
  loading,
  manualRoots,
  onAddManualRoot,
  onRefresh,
}: {
  workspaceUris: string[];
  payload: WorktreesPayload | null;
  loading: boolean;
  manualRoots: string[];
  onAddManualRoot: (root: string) => void;
  onRefresh: () => void;
}) {
  const [rootInput, setRootInput] = useState("");
  const [openDiffKey, setOpenDiffKey] = useState<string | null>(null);
  const [diffByKey, setDiffByKey] = useState<Record<string, WorktreeDiffPayload>>({});
  const [diffLoadingKey, setDiffLoadingKey] = useState<string | null>(null);
  const worktrees = payload?.worktrees || [];
  const allRoots = [...new Set([...workspaceUris, ...manualRoots])];

  const handleToggleDiff = async (root: string, worktree: string, file: string) => {
    const key = `${worktree}::${file}`;
    if (openDiffKey === key) {
      setOpenDiffKey(null);
      return;
    }
    setOpenDiffKey(key);
    if (diffByKey[key]) return;
    setDiffLoadingKey(key);
    try {
      const res = await fetchWorktreeDiff(root, worktree, file);
      setDiffByKey((prev) => ({ ...prev, [key]: res }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load diff");
      setOpenDiffKey(null);
    } finally {
      setDiffLoadingKey((cur) => (cur === key ? null : cur));
    }
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const val = rootInput.trim();
    if (!val) return;
    onAddManualRoot(val);
    setRootInput("");
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-ink">
          Git worktrees ({worktrees.length})
        </h2>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "motion-safe:animate-spin" : ""}`} aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {workspaceUris.length === 0 && (
        <form onSubmit={handleAdd} className="flex items-center gap-1.5">
          <Input
            aria-label="Workspace repository path"
            placeholder="/path/to/repo"
            value={rootInput}
            onChange={(e) => setRootInput(e.target.value)}
          />
          <Button type="submit" variant="secondary" size="sm">
            Inspect
          </Button>
        </form>
      )}

      {allRoots.length === 0 ? (
        <Card className="p-4 space-y-1.5 bg-board">
          <p className="text-[14px] font-medium text-ink">No open workspace folder</p>
          <p className="text-[13px] text-ink-2">
            Open a repository folder in Antigravity or enter a local repository path above to inspect worker worktrees.
          </p>
        </Card>
      ) : worktrees.length === 0 ? (
        <Card className="p-4 bg-board">
          <p className="text-[14px] text-ink-2">
            {loading ? "Inspecting workspace worktrees..." : "No git worktrees detected for the current workspace roots."}
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {worktrees.map((wt) => (
            <Card key={wt.id} className="p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <GitBranch className="h-3.5 w-3.5 text-info shrink-0" aria-hidden="true" />
                    <span className="text-[14px] font-semibold text-ink break-all">{wt.branch}</span>
                    {wt.isMain && <Badge tone="neutral">main</Badge>}
                    <Badge tone={wt.clean ? "success" : "warning"}>
                      {wt.clean
                        ? "clean"
                        : `${wt.dirtyFiles + wt.stagedFiles + wt.untrackedFiles} changed`}
                    </Badge>
                  </div>
                  <p
                    className="text-[12px] text-ink-3 mono truncate"
                    title={wt.path.replace(/^\/home\/[^/]+\//, "~/")}
                  >
                    <FolderGit2 className="inline h-3 w-3 mr-1 align-text-bottom" aria-hidden="true" />
                    {wt.path.replace(/^\/home\/[^/]+\//, "~/")}
                  </p>
                </div>

                {wt.uri && window.sidecar?.ui?.toggleAuxPane && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openFileInAuxPane(wt.uri)}
                    className="shrink-0"
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    Open
                  </Button>
                )}
              </div>

              {(wt.lastCommitSubject || wt.lastCommitSha) && (
                <div className="flex items-center justify-between gap-2 rounded-chip bg-board px-2.5 py-1.5 text-[12px] text-ink-2">
                  <span className="truncate">{wt.lastCommitSubject || "No commits yet"}</span>
                  <span className="shrink-0 mono num text-ink-3 flex items-center gap-2">
                    <span>{wt.lastCommitSha}</span>
                    <span>{wt.lastCommitAt ? fmtTimeAgo(wt.lastCommitAt) : "n/a"}</span>
                  </span>
                </div>
              )}

              {wt.files && wt.files.length > 0 && (
                <ul
                  aria-label={`Changed files in ${wt.branch}`}
                  className="divide-y divide-hairline rounded-chip border border-hairline bg-board px-2.5 py-1"
                >
                  {wt.files.map((f) => {
                    const canOpenAux = Boolean(f.uri && window.sidecar?.ui?.toggleAuxPane);
                    const handleOpenFile = async () => {
                      if (canOpenAux && openFileInAuxPane(f.uri)) {
                        toast.success(`Opened ${f.path.split("/").pop() || f.path}`);
                        return;
                      }
                      await copyText(f.path, `Copied ${f.path}`);
                    };
                    const key = `${wt.path}::${f.path}`;
                    const diffOpen = openDiffKey === key;
                    const diffEntry = diffByKey[key];
                    const diffBusy = diffLoadingKey === key;
                    return (
                      <li key={f.path} className="py-1.5 first:pt-1 last:pb-1 space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0 flex-1">
                            <Badge tone={FILE_TONE[f.state] || "neutral"} className="mono px-1.5 py-0 text-[12px]">
                              {f.state}
                            </Badge>
                            <span className="text-[12px] text-ink mono truncate" title={f.path}>
                              {f.path}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Diff peek ${f.path}`}
                              aria-expanded={diffOpen}
                              onClick={() => handleToggleDiff(wt.root, wt.path, f.path)}
                              className="h-7 px-2"
                            >
                              {diffOpen ? (
                                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                              )}
                              <span>Diff</span>
                            </Button>
                            {f.uri && (
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Open file ${f.path}`}
                                onClick={handleOpenFile}
                                className="h-7 px-2"
                              >
                                <FileCode2 className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>Open</span>
                              </Button>
                            )}
                          </div>
                        </div>
                        {diffOpen && (
                          <div className="rounded-chip border border-hairline bg-canvas p-2 space-y-1">
                            {diffBusy ? (
                              <p className="text-[12px] text-ink-2">Loading diff hunk...</p>
                            ) : diffEntry ? (
                              <>
                                <div className="flex flex-wrap items-center justify-between gap-1 text-[12px] text-ink-2">
                                  <span className="mono num">
                                    +{diffEntry.added} / -{diffEntry.removed}
                                    {diffEntry.untracked ? " (untracked)" : ""}
                                  </span>
                                  {diffEntry.truncated && <Badge tone="warning">truncated 8 KB</Badge>}
                                </div>
                                <pre className="max-h-48 overflow-y-auto overflow-x-auto text-[12px] leading-[1.45] mono">
                                  {(diffEntry.diff || "(empty diff)").split("\n").map((line, i) => (
                                    <div
                                      key={i}
                                      className={
                                        line.startsWith("+") && !line.startsWith("+++")
                                          ? "text-ok"
                                          : line.startsWith("-") && !line.startsWith("---")
                                            ? "text-danger"
                                            : line.startsWith("@@")
                                              ? "text-info"
                                              : "text-ink-2"
                                      }
                                    >
                                      {line || " "}
                                    </div>
                                  ))}
                                </pre>
                              </>
                            ) : null}
                          </div>
                        )}
                      </li>
                    );
                  })}
                  {wt.filesTruncated && (
                    <li className="py-1 text-[12px] text-ink-3">
                      Showing first {wt.files.length} changed files
                    </li>
                  )}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
