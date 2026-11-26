import { useState } from "../hooks";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  ExternalLink,
  FileCode2,
  FolderGit2,
  GitBranch,
  RefreshCw,
} from "../icons";
import { fetchWorktreeDiff, openFileInAuxPane, runWorktreeAction } from "../sidecar";
import type {
  SwarmMember,
  WorktreeActionName,
  WorktreeActionPayload,
  WorktreeChangedFile,
  WorktreeCollision,
  WorktreeDiffMode,
  WorktreeDiffPayload,
  WorktreeInfo,
  WorktreeMergeability,
  WorktreesPayload,
} from "../types";
import { Badge, Button, Card, Input, cn, copyText, fmtTimeAgo, maskHome, openOrCopyPath, toast } from "../ui";
import type { BadgeTone } from "../ui";

const LAND_META: Record<NonNullable<WorktreeInfo["landStatus"]>, { tone: BadgeTone; label: string; btn: string }> = {
  main: { tone: "neutral", label: "main", btn: "" },
  ready: { tone: "success", label: "Ready to land", btn: "Copy merge" },
  rebase: { tone: "warning", label: "Needs rebase", btn: "Copy rebase" },
  dirty: { tone: "warning", label: "Uncommitted edits", btn: "Copy status" },
  merged: { tone: "neutral", label: "Landed / clean", btn: "Copy cleanup" },
};

const MERGEABILITY_META: Record<WorktreeMergeability, { tone: BadgeTone; label: string }> = {
  clean: { tone: "success", label: "Merge clean" },
  ff: { tone: "success", label: "FF ready" },
  clean_merge: { tone: "success", label: "Merge clean" },
  up_to_date: { tone: "neutral", label: "Up to date" },
  conflict: { tone: "danger", label: "Merge conflict" },
  dirty: { tone: "warning", label: "Dirty tree" },
  detached: { tone: "warning", label: "Detached HEAD" },
  main: { tone: "neutral", label: "Base branch" },
  unknown: { tone: "neutral", label: "Merge unknown" },
};

const COLLISION_TONE: Record<NonNullable<WorktreeCollision["kind"]>, BadgeTone> = {
  working: "warning",
  branch: "info",
  mixed: "danger",
};

const FILE_TONE: Record<string, BadgeTone> = {
  "??": "neutral",
  A: "success",
  M: "warning",
  D: "danger",
  R: "warning",
};

const ACTION_LABEL: Record<WorktreeActionName, string> = {
  dry_run_merge: "Dry-Run Merge",
  ff_merge: "FF Merge",
  rebase: "Rebase",
  remove_worktree: "Remove Clean",
};

function safeLandCommand(wt: WorktreeInfo): string {
  const base = wt.baseBranch || "main";
  const path = maskHome(wt.path);
  if (wt.landStatus === "ready") return `git merge --ff-only ${wt.branch} && git worktree remove ${path}`;
  if (wt.landStatus === "rebase") return `git -C ${path} rebase ${base}`;
  if (wt.landStatus === "dirty") return `git -C ${path} status -s`;
  return `git worktree remove ${path} && git branch -d ${wt.branch}`;
}

function normalizeChangedFiles(entries: WorktreeInfo["branchFiles"] | WorktreeInfo["files"], wt: WorktreeInfo): WorktreeChangedFile[] {
  if (!Array.isArray(entries)) return [];
  const out: WorktreeChangedFile[] = [];
  for (const item of entries) {
    if (typeof item === "string") {
      const p = item.trim();
      if (!p) continue;
      out.push({
        path: p,
        state: "M",
        uri: wt.uri ? `${wt.uri.replace(/\/$/, "")}/${p}` : "",
      });
    } else if (item && typeof item === "object" && item.path) {
      out.push({
        path: item.path,
        state: item.state || "M",
        uri: item.uri || (wt.uri ? `${wt.uri.replace(/\/$/, "")}/${item.path}` : ""),
        added: item.added,
        removed: item.removed,
      });
    }
  }
  return out;
}

function collisionTargetsLabel(c: WorktreeCollision): string {
  if (Array.isArray(c.branches) && c.branches.length > 0) {
    return c.branches.join(", ");
  }
  return (c.worktrees || [])
    .map((w) => (typeof w === "string" ? maskHome(w) : w.branch || maskHome(w.path || w.id || "")))
    .filter(Boolean)
    .join(", ");
}

function ownerForWorktree(wt: WorktreeInfo, members?: SwarmMember[]): SwarmMember | undefined {
  if (!members || members.length === 0) return undefined;
  const maskedWt = maskHome(wt.path);
  return members.find((m) => {
    if (!m.workspace) return false;
    return m.workspace === wt.path || maskHome(m.workspace) === maskedWt;
  });
}

const diffLineCls = (l: string) =>
  l[0] === "+" && !l.startsWith("+++")
    ? "text-ok"
    : l[0] === "-" && !l.startsWith("---")
      ? "text-danger"
      : l.startsWith("@@")
        ? "text-info"
        : "text-ink-2";

export function WorktreesView({
  workspaceUris,
  payload,
  loading,
  manualRoots,
  members,
  onAddManualRoot,
  onRefresh,
}: {
  workspaceUris: string[];
  payload: WorktreesPayload | null;
  loading: boolean;
  manualRoots: string[];
  members?: SwarmMember[];
  onAddManualRoot: (root: string) => void;
  onRefresh: () => void;
}) {
  const [rootInput, setRootInput] = useState("");
  const [openDiffKey, setOpenDiffKey] = useState<string | null>(null);
  const [diffByKey, setDiffByKey] = useState<Record<string, WorktreeDiffPayload>>({});
  const [diffLoadingKey, setDiffLoadingKey] = useState<string | null>(null);
  const [diffModeByWt, setDiffModeByWt] = useState<Record<string, WorktreeDiffMode>>({});
  const [confirmAction, setConfirmAction] = useState<{ wtPath: string; action: WorktreeActionName } | null>(null);
  const [busyActionKey, setBusyActionKey] = useState<string | null>(null);
  const [actionResultByWt, setActionResultByWt] = useState<Record<string, WorktreeActionPayload>>({});

  const worktrees = payload?.worktrees || [];
  const collisions = payload?.collisions || [];
  const allRoots = [...new Set([...workspaceUris, ...manualRoots])];

  const getDiffMode = (wtPath: string): WorktreeDiffMode => diffModeByWt[wtPath] || "working";

  const handleSetDiffMode = (wtPath: string, mode: WorktreeDiffMode) => {
    setDiffModeByWt((prev) => ({ ...prev, [wtPath]: mode }));
    setOpenDiffKey((cur) => (cur && cur.startsWith(`${wtPath}::`) ? null : cur));
  };

  const handleToggleDiff = async (root: string, worktree: string, file: string, mode: WorktreeDiffMode) => {
    const key = `${worktree}::${mode}::${file}`;
    if (openDiffKey === key) {
      setOpenDiffKey(null);
      return;
    }
    setOpenDiffKey(key);
    if (diffByKey[key]) return;
    setDiffLoadingKey(key);
    try {
      const res = await fetchWorktreeDiff(root, worktree, file, mode);
      setDiffByKey((prev) => ({ ...prev, [key]: res }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load diff");
      setOpenDiffKey(null);
    } finally {
      setDiffLoadingKey((cur) => (cur === key ? null : cur));
    }
  };

  const executeWorktreeAction = async (wt: WorktreeInfo, action: WorktreeActionName) => {
    const key = `${wt.path}::${action}`;
    setBusyActionKey(key);
    setConfirmAction(null);
    try {
      const res = await runWorktreeAction(action, wt.path, wt.baseBranch || "main", wt.root);
      setActionResultByWt((prev) => ({ ...prev, [wt.path]: res }));
      if (res.ok) {
        toast.success(maskHome(res.message || `${ACTION_LABEL[action]} succeeded on ${wt.branch}`));
        if (action === "ff_merge" || action === "rebase" || action === "remove_worktree") {
          onRefresh();
        }
      } else {
        toast.error(maskHome(res.message || `${ACTION_LABEL[action]} reported conflicts`));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Worktree action failed";
      setActionResultByWt((prev) => ({
        ...prev,
        [wt.path]: { ok: false, action, status: "error", message },
      }));
      toast.error(maskHome(message));
    } finally {
      setBusyActionKey((cur) => (cur === key ? null : cur));
    }
  };

  const handleActionClick = (wt: WorktreeInfo, action: WorktreeActionName) => {
    if (action === "dry_run_merge") {
      void executeWorktreeAction(wt, action);
      return;
    }
    setConfirmAction((cur) =>
      cur && cur.wtPath === wt.path && cur.action === action ? null : { wtPath: wt.path, action },
    );
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
      <div className="row">
        <h2 className="h2">Git worktrees ({worktrees.length})</h2>
        <Button onClick={onRefresh} disabled={loading}>
          <RefreshCw className={loading ? "motion-safe:animate-spin" : ""} />
          Refresh
        </Button>
      </div>

      {workspaceUris.length === 0 && (
        <form onSubmit={handleAdd} className="f1">
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

      {collisions.length > 0 && (
        <Card
          data-testid="worktree-collisions-banner"
          className="border-warn bg-warn-soft p-3 space-y-2"
        >
          <div className="row flex-wrap">
            <div className="f1 min-w-0">
              <AlertTriangle className="h-4 w-4 text-warn shrink-0" />
              <span className="h2">File collisions ({collisions.length})</span>
            </div>
            <span className="t3">Shared paths across active branches</span>
          </div>
          <ul aria-label="Worktree file collisions" className="divide-y divide-hairline rounded-chip border border-hairline bg-surface px-2 py-1">
            {collisions.map((c) => {
              const kind = c.kind || "mixed";
              const targets = collisionTargetsLabel(c);
              return (
                <li
                  key={c.file}
                  data-testid={`wt-collision-${c.file}`}
                  className="py-1.5 space-y-0.5 min-w-0"
                >
                  <div className="row flex-wrap gap-1.5">
                    <span className="text-[12px] font-medium text-ink mono break-all">{c.file}</span>
                    <Badge tone={COLLISION_TONE[kind] || "warning"}>{kind}</Badge>
                  </div>
                  {targets && (
                    <p className="t3 break-all">Touched by: {targets}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
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
          {worktrees.map((wt) => {
            const st = wt.landStatus && wt.landStatus !== "main" ? LAND_META[wt.landStatus] : null;
            const mergeMeta = wt.mergeability ? MERGEABILITY_META[wt.mergeability] : null;
            const ahead = wt.ahead || 0;
            const behind = wt.behind || 0;
            const workingFiles = normalizeChangedFiles(wt.files, wt);
            const branchFiles = normalizeChangedFiles(wt.branchFiles, wt);
            const dirtyCount = wt.dirtyFiles + wt.stagedFiles + wt.untrackedFiles;
            const owner = ownerForWorktree(wt, members);
            const diffMode = getDiffMode(wt.path);
            const activeFiles = diffMode === "branch" ? branchFiles : workingFiles;
            const activeTruncated = diffMode === "branch" ? wt.branchFilesTruncated : wt.filesTruncated;
            const commits = Array.isArray(wt.commits) ? wt.commits.slice(0, 5) : [];
            const actionRes = actionResultByWt[wt.path];
            const actionConflicts = actionRes?.conflicts || actionRes?.conflictFiles || [];
            const presetConflicts = Array.isArray(wt.conflictFiles) ? wt.conflictFiles : [];
            const confirmingHere = confirmAction?.wtPath === wt.path ? confirmAction.action : null;
            const isBusyHere = Boolean(busyActionKey && busyActionKey.startsWith(`${wt.path}::`));
            const canToggleDiffMode = !wt.isMain || branchFiles.length > 0 || workingFiles.length > 0;

            return (
              <Card key={wt.id} data-testid={`wt-card-${wt.branch}`} className="p-3 space-y-2">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="wrap">
                      <GitBranch className="h-3.5 w-3.5 text-info shrink-0" />
                      <span className="h2 break-all">{wt.branch}</span>
                      {wt.isMain && <Badge tone="neutral">main</Badge>}
                      {owner && <Badge tone="violet">@{owner.name}</Badge>}
                      <Badge tone={wt.clean ? "success" : "warning"}>
                        {wt.clean ? "clean" : `${dirtyCount} changed`}
                      </Badge>
                      {!wt.isMain && branchFiles.length > 0 && (
                        <Badge tone="info" className="num" data-testid={`wt-branch-files-count-${wt.branch}`}>
                          {branchFiles.length} branch {branchFiles.length === 1 ? "file" : "files"}
                        </Badge>
                      )}
                      {mergeMeta && (
                        <Badge tone={mergeMeta.tone} data-testid={`wt-mergeability-${wt.branch}`}>
                          {mergeMeta.label}
                        </Badge>
                      )}
                      {st && (
                        <Badge tone={st.tone} data-testid={`wt-land-status-${wt.branch}`}>
                          {st.label}
                        </Badge>
                      )}
                      {!wt.isMain && (ahead > 0 || behind > 0) && (
                        <Badge tone={behind > 0 ? "warning" : "info"} className="num">
                          +{ahead} / -{behind} vs {wt.baseBranch || "main"}
                        </Badge>
                      )}
                    </div>
                    <p className="t3 mono truncate" title={maskHome(wt.path)}>
                      <FolderGit2 className="inline h-3 w-3 mr-1 align-text-bottom" />
                      {maskHome(wt.path)}
                    </p>
                  </div>

                  <div className="f1 shrink-0">
                    {st && (
                      <Button
                        variant={wt.landStatus === "ready" ? "primary" : "outline"}
                        data-testid={`wt-land-cmd-${wt.branch}`}
                        onClick={() => void copyText(safeLandCommand(wt), `Copied command for ${wt.branch}`)}
                      >
                        <ClipboardCopy />
                        {st.btn}
                      </Button>
                    )}
                    {wt.uri && window.sidecar?.ui?.toggleAuxPane && (
                      <Button onClick={() => openFileInAuxPane(wt.uri)} className="shrink-0">
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open
                      </Button>
                    )}
                  </div>
                </div>

                {!wt.isMain && (
                  <div className="space-y-1.5" data-testid={`wt-actions-${wt.branch}`}>
                    <div className="wrap gap-1.5">
                      <Button
                        variant="secondary"
                        disabled={isBusyHere}
                        data-testid={`wt-action-dry-run-${wt.branch}`}
                        onClick={() => handleActionClick(wt, "dry_run_merge")}
                      >
                        {busyActionKey === `${wt.path}::dry_run_merge` ? "Checking..." : "Dry-Run Merge"}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={isBusyHere || !wt.clean}
                        title={!wt.clean ? "Working tree must be clean before FF merge" : undefined}
                        data-testid={`wt-action-ff-merge-${wt.branch}`}
                        onClick={() => handleActionClick(wt, "ff_merge")}
                      >
                        FF Merge
                      </Button>
                      <Button
                        variant="outline"
                        disabled={isBusyHere}
                        data-testid={`wt-action-rebase-${wt.branch}`}
                        onClick={() => handleActionClick(wt, "rebase")}
                      >
                        Rebase
                      </Button>
                      <Button
                        variant="danger"
                        disabled={isBusyHere || !wt.clean}
                        title={!wt.clean ? "Working tree must be clean before removal" : undefined}
                        data-testid={`wt-action-remove-${wt.branch}`}
                        onClick={() => handleActionClick(wt, "remove_worktree")}
                      >
                        Remove Clean
                      </Button>
                    </div>

                    {confirmingHere && (
                      <div
                        data-testid={`wt-confirm-${wt.branch}`}
                        className="row flex-wrap gap-2 rounded-chip border border-hairline bg-board px-2 py-1.5 text-[12px]"
                      >
                        <span className="text-ink">
                          Confirm {ACTION_LABEL[confirmingHere]} on <span className="mono font-medium">{wt.branch}</span>?
                        </span>
                        <div className="f1 shrink-0">
                          <Button variant="ghost" onClick={() => setConfirmAction(null)}>
                            Cancel
                          </Button>
                          <Button
                            variant={confirmingHere === "remove_worktree" ? "danger" : "primary"}
                            disabled={isBusyHere}
                            data-testid={`wt-confirm-submit-${wt.branch}`}
                            onClick={() => void executeWorktreeAction(wt, confirmingHere)}
                          >
                            Confirm {ACTION_LABEL[confirmingHere]}
                          </Button>
                        </div>
                      </div>
                    )}

                    {actionRes && (
                      <div
                        data-testid={`wt-action-result-${wt.branch}`}
                        className={cn(
                          "rounded-chip border px-2 py-1.5 space-y-1 text-[12px]",
                          actionRes.ok ? "border-ok bg-ok-soft text-ink" : "border-danger bg-bad-soft text-danger",
                        )}
                      >
                        <div className="row flex-wrap gap-1.5">
                          <span className="font-medium break-words">{maskHome(actionRes.message || actionRes.status || "Action complete")}</span>
                          {actionRes.status && <Badge tone={actionRes.ok ? "success" : "danger"}>{actionRes.status}</Badge>}
                        </div>
                        {actionConflicts.length > 0 && (
                          <ul
                            data-testid={`wt-action-conflicts-${wt.branch}`}
                            aria-label={`Conflicting files in ${wt.branch}`}
                            className="list-disc pl-4 mono text-[12px] text-ink space-y-0.5"
                          >
                            {actionConflicts.map((cf) => (
                              <li key={cf} className="break-all">{cf}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {presetConflicts.length > 0 && !actionRes && (
                  <div
                    data-testid={`wt-conflicts-${wt.branch}`}
                    className="rounded-chip border border-danger bg-bad-soft px-2 py-1.5 text-[12px] space-y-1"
                  >
                    <p className="font-medium text-danger">Predicted merge conflicts ({presetConflicts.length})</p>
                    <ul className="list-disc pl-4 mono text-ink space-y-0.5">
                      {presetConflicts.map((cf) => (
                        <li key={cf} className="break-all">{cf}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {commits.length > 0 ? (
                  <ul
                    aria-label={`Recent commits in ${wt.branch}`}
                    data-testid={`wt-commits-${wt.branch}`}
                    className="divide-y divide-hairline rounded-chip bg-board px-2 py-1 text-[12px] text-ink-2"
                  >
                    {commits.map((c) => (
                      <li key={c.sha} className="row py-1 first:pt-0.5 last:pb-0.5 gap-2">
                        <span className="truncate text-ink">{c.subject || "No commit message"}</span>
                        <span className="shrink-0 mono num text-ink-3 flex items-center gap-2">
                          <span>{c.sha}</span>
                          <span>{c.authorTime || (c.at ? fmtTimeAgo(c.at) : "")}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (wt.lastCommitSubject || wt.lastCommitSha) ? (
                  <div className="row rounded-chip bg-board px-2 py-1 text-[12px] text-ink-2">
                    <span className="truncate">{wt.lastCommitSubject || "No commits yet"}</span>
                    <span className="shrink-0 mono num text-ink-3 flex items-center gap-2">
                      <span>{wt.lastCommitSha}</span>
                      <span>{wt.lastCommitAt ? fmtTimeAgo(wt.lastCommitAt) : "n/a"}</span>
                    </span>
                  </div>
                ) : null}

                {canToggleDiffMode && (
                  <div className="space-y-1.5">
                    <div className="row flex-wrap gap-1.5">
                      <div
                        role="tablist"
                        aria-label={`Diff mode for ${wt.branch}`}
                        className="inline-flex rounded-chip border border-hairline bg-track p-0.5"
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={diffMode === "working"}
                          data-testid={`wt-diff-mode-working-${wt.branch}`}
                          onClick={() => handleSetDiffMode(wt.path, "working")}
                          className={cn(
                            "h-6 px-2 text-[12px] font-medium rounded-chip cursor-pointer transition num",
                            diffMode === "working"
                              ? "bg-[var(--raised)] text-ink shadow-[var(--elev-raised)]"
                              : "text-ink-2 hover:text-ink",
                          )}
                        >
                          Working Changes ({workingFiles.length})
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={diffMode === "branch"}
                          data-testid={`wt-diff-mode-branch-${wt.branch}`}
                          onClick={() => handleSetDiffMode(wt.path, "branch")}
                          className={cn(
                            "h-6 px-2 text-[12px] font-medium rounded-chip cursor-pointer transition num",
                            diffMode === "branch"
                              ? "bg-[var(--raised)] text-ink shadow-[var(--elev-raised)]"
                              : "text-ink-2 hover:text-ink",
                          )}
                        >
                          Branch Diff ({branchFiles.length})
                        </button>
                      </div>
                    </div>

                    {activeFiles.length > 0 ? (
                      <ul
                        aria-label={`${diffMode === "branch" ? "Branch" : "Changed"} files in ${wt.branch}`}
                        className="divide-y divide-hairline rounded-chip border border-hairline bg-board px-2 py-1"
                      >
                        {activeFiles.map((f) => {
                          const key = `${wt.path}::${diffMode}::${f.path}`;
                          const diffOpen = openDiffKey === key;
                          const diffEntry = diffByKey[key];
                          const diffBusy = diffLoadingKey === key;

                          return (
                            <li key={`${diffMode}-${f.path}`} className="py-1 space-y-1">
                              <div className="row flex-wrap">
                                <div className="f1 min-w-0 flex-1">
                                  <Badge tone={FILE_TONE[f.state] || "neutral"} className="mono px-1 py-0">
                                    {f.state}
                                  </Badge>
                                  <span className="text-[12px] text-ink mono truncate" title={f.path}>
                                    {f.path}
                                  </span>
                                  {(typeof f.added === "number" || typeof f.removed === "number") && (
                                    <span className="t3 mono num shrink-0">
                                      +{f.added || 0}/-{f.removed || 0}
                                    </span>
                                  )}
                                </div>
                                <div className="f1 shrink-0">
                                  <Button
                                    variant="ghost"
                                    aria-label={`Diff peek ${f.path}`}
                                    aria-expanded={diffOpen}
                                    onClick={() => handleToggleDiff(wt.root, wt.path, f.path, diffMode)}
                                    className="h-7 px-2"
                                  >
                                    {diffOpen ? <ChevronUp /> : <ChevronDown />}
                                    Diff
                                  </Button>
                                  {f.uri && (
                                    <Button
                                      variant="ghost"
                                      aria-label={`Open file ${f.path}`}
                                      onClick={() => openOrCopyPath(f.uri, f.path)}
                                      className="h-7 px-2"
                                    >
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
                                        <span className="mono num">
                                          +{diffEntry.added} / -{diffEntry.removed}
                                          {diffEntry.untracked ? " (untracked)" : ""}
                                          {diffMode === "branch" ? " (branch)" : ""}
                                        </span>
                                        {diffEntry.truncated && <Badge tone="warning">8 KB cap</Badge>}
                                      </div>
                                      <pre className="max-h-48 overflow-auto text-[12px] leading-snug mono">
                                        {(diffEntry.diff || "(empty diff)").split("\n").map((line, i) => (
                                          <div key={i} className={diffLineCls(line)}>
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
                        {activeTruncated && <li className="py-1 t3">{activeFiles.length} files shown</li>}
                      </ul>
                    ) : (
                      !wt.isMain && (
                        <p className="t3 px-1">
                          {diffMode === "branch" ? "No committed branch changes ahead of base." : "No uncommitted working changes."}
                        </p>
                      )
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
