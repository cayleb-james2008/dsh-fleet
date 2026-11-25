import { useState } from "react";
import { ExternalLink, FolderGit2, GitBranch, RefreshCw } from "lucide-react";
import { openFileInAuxPane } from "../sidecar";
import type { WorktreesPayload } from "../types";
import { Badge, Button, Card, Input, fmtTimeAgo } from "../ui";

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
  const worktrees = payload?.worktrees || [];
  const allRoots = [...new Set([...workspaceUris, ...manualRoots])];

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
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--ink-2)]">
          Git Worktrees ({worktrees.length})
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
        <Card className="p-4 space-y-1.5 bg-[var(--board)]">
          <p className="text-[14px] font-medium text-[var(--ink)]">No open workspace folder</p>
          <p className="text-[13px] text-[var(--ink-2)]">
            Open a repository folder in Antigravity or enter a local repository path above to inspect worker worktrees.
          </p>
        </Card>
      ) : worktrees.length === 0 ? (
        <Card className="p-4 bg-[var(--board)]">
          <p className="text-[14px] text-[var(--ink-2)]">
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
                    <GitBranch className="h-3.5 w-3.5 text-[var(--info-foreground)] shrink-0" aria-hidden="true" />
                    <span className="text-[14px] font-semibold text-[var(--ink)] break-all">{wt.branch}</span>
                    {wt.isMain && <Badge tone="neutral">main</Badge>}
                    <Badge tone={wt.clean ? "success" : "warning"}>
                      {wt.clean
                        ? "clean"
                        : `${wt.dirtyFiles + wt.stagedFiles + wt.untrackedFiles} changed`}
                    </Badge>
                  </div>
                  <p className="text-[12px] text-[var(--ink-3)] mono truncate" title={wt.path}>
                    <FolderGit2 className="inline h-3 w-3 mr-1 align-text-bottom" aria-hidden="true" />
                    {wt.path}
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
                <div className="flex items-center justify-between gap-2 rounded-[var(--radius-chip)] bg-[var(--board)] px-2.5 py-1.5 text-[12px] text-[var(--ink-2)]">
                  <span className="truncate">{wt.lastCommitSubject || "No commits yet"}</span>
                  <span className="shrink-0 mono num text-[var(--ink-3)]">
                    {wt.lastCommitSha} · {wt.lastCommitAt ? fmtTimeAgo(wt.lastCommitAt) : "n/a"}
                  </span>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
