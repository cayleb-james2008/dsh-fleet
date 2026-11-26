import { useState } from "../hooks";
import { ChevronDown, ChevronUp, ExternalLink, FileCode2, FolderGit2, GitBranch, RefreshCw } from "../icons";
import { fetchWorktreeDiff, openFileInAuxPane } from "../sidecar";
import type { WorktreeDiffPayload, WorktreesPayload } from "../types";
import { Badge, Button, Card, Input, fmtTimeAgo, maskHome, openOrCopyPath, toast } from "../ui";

const FILE_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  "??": "neutral",
  A: "success",
  M: "warning",
  D: "danger",
  R: "warning",
};

const diffLineCls = (l: string) =>
  l[0] === "+" && !l.startsWith("+++") ? "text-ok" : l[0] === "-" && !l.startsWith("---") ? "text-danger" : l.startsWith("@@") ? "text-info" : "text-ink-2";

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

  const diffLineCls = (l: string) =>
    l[0] === "+" && !l.startsWith("+++") ? "text-ok" : l[0] === "-" && !l.startsWith("---") ? "text-danger" : l.startsWith("@@") ? "text-info" : "text-ink-2";

  return (
    <div className="space-y-3">
      <div className="row">
        <h2 className="text-[14px] font-semibold text-ink">Git worktrees ({worktrees.length})</h2>
        <Button onClick={onRefresh} disabled={loading}>
          <RefreshCw className={loading ? "motion-safe:animate-spin" : ""} />
          Refresh
        </Button>
      </div>

      {workspaceUris.length === 0 && (
        <form onSubmit={handleAdd} className="flex items-center gap-1">
          <Input
            aria-label="Workspace repository path"
            placeholder="/path/to/repo"
            value={rootInput}
            onChange={(e) => setRootInput(e.target.value)}
          />
          <Button type="submit" variant="secondary">
            Inspect
          </Button>
        </form>
      )}

      {allRoots.length === 0 || worktrees.length === 0 ? (
        <Card className="p-4 space-y-1 bg-board">
          <p className="text-[14px] font-medium text-ink">
            {allRoots.length === 0 ? "No open workspace folder" : loading ? "Inspecting worktrees..." : "No git worktrees detected."}
          </p>
          {allRoots.length === 0 && (
            <p className="text-[13px] text-ink-2">Open a workspace folder or enter a local repository path above.</p>
          )}
        </Card>
      ) : (
        <div className="space-y-2">
          {worktrees.map((wt) => (
            <Card key={wt.id} className="p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 space-y-1">
                  <div className="wrap">
                    <GitBranch className="h-3.5 w-3.5 text-info shrink-0" />
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
                    title={maskHome(wt.path)}
                  >
                    <FolderGit2 className="inline h-3 w-3 mr-1 align-text-bottom" />
                    {maskHome(wt.path)}
                  </p>
                </div>

                {wt.uri && window.sidecar?.ui?.toggleAuxPane && (
                  <Button
                    onClick={() => openFileInAuxPane(wt.uri)}
                    className="shrink-0"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open
                  </Button>
                )}
              </div>

              {(wt.lastCommitSubject || wt.lastCommitSha) && (
                <div className="row rounded-chip bg-board px-2 py-1 text-[12px] text-ink-2">
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
                  className="divide-y divide-hairline rounded-chip border border-hairline bg-board px-2 py-1"
                >
                  {wt.files.map((f) => {
                    const key = `${wt.path}::${f.path}`;
                    const diffOpen = openDiffKey === key;
                    const diffEntry = diffByKey[key];
                    const diffBusy = diffLoadingKey === key;

                    return (
                      <li key={f.path} className="py-1 space-y-1">
                        <div className="row flex-wrap">
                          <div className="flex items-center gap-1 min-w-0 flex-1">
                            <Badge tone={FILE_TONE[f.state] || "neutral"} className="mono px-1 py-0">{f.state}</Badge>
                            <span className="text-[12px] text-ink mono truncate" title={f.path}>{f.path}</span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button variant="ghost" aria-label={`Diff peek ${f.path}`} aria-expanded={diffOpen} onClick={() => handleToggleDiff(wt.root, wt.path, f.path)} className="h-7 px-2">
                              {diffOpen ? <ChevronUp /> : <ChevronDown />}
                              Diff
                            </Button>
                            {f.uri && (
                              <Button variant="ghost" aria-label={`Open file ${f.path}`} onClick={() => openOrCopyPath(f.uri, f.path)} className="h-7 px-2">
                                <FileCode2 />
                                Open
                              </Button>
                            )}
                          </div>
                        </div>
                        {diffOpen && (
                          <div className="rounded-chip border border-hairline bg-canvas p-2 space-y-1">
                            {diffBusy ? (
                              <p className="text-[12px] text-ink-2">Loading...</p>
                            ) : diffEntry ? (
                              <>
                                <div className="row flex-wrap gap-1 text-[12px] text-ink-2">
                                  <span className="mono num">+{diffEntry.added} / -{diffEntry.removed}{diffEntry.untracked ? " (untracked)" : ""}</span>
                                  {diffEntry.truncated && <Badge tone="warning">8 KB cap</Badge>}
                                </div>
                                <pre className="max-h-48 overflow-auto text-[12px] leading-snug mono">
                                  {(diffEntry.diff || "(empty diff)").split("\n").map((line, i) => (
                                    <div key={i} className={diffLineCls(line)}>{line || " "}</div>
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
                      {wt.files.length} files shown
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
