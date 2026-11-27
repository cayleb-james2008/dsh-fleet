import { useEffect, useRef, useState } from "../hooks";
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
  Send,
  X,
} from "../icons";
import { fetchWorktreeDiff, openFileInAuxPane, runWorktreeAction, sendSwarmControl } from "../sidecar";
import type {
  OperatorCommand,
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
import {
  Badge,
  Button,
  Card,
  Input,
  cn,
  copyText,
  fmtTimeAgo,
  hasControlChars,
  maskHome,
  notifyDispatch,
  openOrCopyPath,
  toDispatchedOp,
  toast,
} from "../ui";
import type { BadgeTone } from "../ui";

const DIFF_PAGE_BYTES = 32768;

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
  squash_merge: "Squash Merge",
  merge_commit: "Merge Commit",
  remove_worktree: "Remove Clean",
};

const ACTION_BUSY_LABEL: Record<WorktreeActionName, string> = {
  dry_run_merge: "Checking...",
  ff_merge: "FF Merging...",
  rebase: "Rebasing...",
  squash_merge: "Squashing...",
  merge_commit: "Merging...",
  remove_worktree: "Removing...",
};

const REFRESHING_ACTIONS = new Set<WorktreeActionName>([
  "ff_merge",
  "rebase",
  "squash_merge",
  "merge_commit",
  "remove_worktree",
]);

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

function collisionTargets(c: WorktreeCollision): string[] {
  if (Array.isArray(c.branches) && c.branches.length > 0) {
    return c.branches.map((b) => String(b || "").trim()).filter(Boolean);
  }
  return (c.worktrees || [])
    .map((w) => (typeof w === "string" ? maskHome(w) : w.branch || maskHome(w.path || w.id || "")))
    .map((s) => String(s || "").trim())
    .filter(Boolean);
}

function actionRecoveryHint(res: WorktreeActionPayload): string {
  if (res.ok) return "";
  if (res.aborted) return "Working tree restored cleanly after abort. Resolve conflicts before retrying.";
  switch (res.status) {
    case "not_ff":
      return "Branch has diverged from base. Run Rebase first, or use Squash Merge / Merge Commit.";
    case "dirty":
      return "Commit or stash uncommitted changes in this worktree before retrying.";
    case "wrong_branch":
      return "Switch the primary worktree back to the base branch before merging.";
    case "unmerged":
      return "Worktree has unmerged commits or uncommitted edits.";
    case "conflict":
      return "Inspect conflicting hunks below or route recovery to the worktree owner.";
    default:
      return "";
  }
}

function resolveOwnerInfo(
  wt: WorktreeInfo,
  members?: SwarmMember[],
): { member: string; status?: string; workspaceMode?: string } | null {
  if (wt.swarmOwner?.member) {
    return {
      member: wt.swarmOwner.member,
      status: wt.swarmOwner.status,
      workspaceMode: wt.swarmOwner.workspaceMode,
    };
  }
  if (!members || members.length === 0) return null;
  const maskedWt = maskHome(wt.path);
  const hit = members.find((m) => {
    if (!m.workspace) return false;
    return m.workspace === wt.path || maskHome(m.workspace) === maskedWt;
  });
  if (!hit) return null;
  return {
    member: hit.name,
    status: hit.status,
    workspaceMode: hit.workspace_mode,
  };
}

function buildConflictDirective(owner: string, wt: WorktreeInfo, files: string[]): string {
  const base = wt.baseBranch || "main";
  const shown = files.slice(0, 12).join(", ");
  const extra = files.length > 12 ? ` (+${files.length - 12} more)` : "";
  return `@${owner} Resolve merge conflict on ${wt.branch} vs ${base} in ${maskHome(wt.path)}: ${shown}${extra}. Inspect conflict hunks, rebase onto ${base}, and post [done] when clean.`;
}

const diffLineCls = (l: string) =>
  l[0] === "+" && !l.startsWith("+++")
    ? "text-ok"
    : l[0] === "-" && !l.startsWith("---")
      ? "text-danger"
      : l.startsWith("@@") || l.startsWith("<<<<<<<") || l.startsWith("=======") || l.startsWith(">>>>>>>")
        ? "text-info"
        : "text-ink-2";

function DiffHunkBox({
  diffEntry,
  busy,
  loadingMore,
  error,
  mode,
  branch,
  onLoadMore,
  onRetry,
}: {
  diffEntry?: WorktreeDiffPayload;
  busy: boolean;
  loadingMore: boolean;
  error?: string;
  mode: WorktreeDiffMode;
  branch: string;
  onLoadMore: () => void;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-chip border border-hairline bg-canvas p-2 space-y-1.5 min-w-0">
      {busy ? (
        <p className="text-[12px] text-ink-2">Loading...</p>
      ) : error && !diffEntry ? (
        <div role="alert" data-testid={`wt-diff-error-${branch}`} className="space-y-1.5 text-[12px] text-danger">
          <p className="break-words">{maskHome(error)}</p>
          {onRetry && (
            <Button
              variant="outline"
              data-testid={`wt-diff-retry-${branch}`}
              onClick={onRetry}
              className="h-7 px-2 text-[12px]"
            >
              <RefreshCw />
              Retry
            </Button>
          )}
        </div>
      ) : diffEntry ? (
        <>
          <div className="row flex-wrap gap-1 text-[12px] text-ink-2">
            <span className="mono num">
              +{diffEntry.added} / -{diffEntry.removed}
              {diffEntry.untracked ? " (untracked)" : ""}
              {mode === "branch" ? " (branch)" : mode === "conflict" ? " (conflict)" : ""}
              {typeof diffEntry.totalBytes === "number" && diffEntry.totalBytes > 0
                ? ` · ${Math.max(1, Math.round(diffEntry.totalBytes / 1024))} KiB`
                : ""}
            </span>
            {diffEntry.hasMore ? (
              <Badge tone="warning">More available</Badge>
            ) : diffEntry.truncated ? (
              <Badge tone="warning">Truncated</Badge>
            ) : null}
          </div>
          <pre className="max-h-48 max-w-full overflow-auto text-[12px] leading-snug mono">
            {(diffEntry.diff || "(empty diff)").split("\n").map((line, i) => (
              <div key={i} className={diffLineCls(line)}>
                {line || " "}
              </div>
            ))}
          </pre>
          {error && (
            <p role="alert" data-testid={`wt-diff-error-${branch}`} className="text-[12px] text-danger break-words">
              {maskHome(error)}
            </p>
          )}
          {diffEntry.hasMore && (
            <div className="pt-1">
              <Button
                variant="outline"
                disabled={loadingMore}
                data-testid={`wt-diff-load-more-${branch}`}
                onClick={onLoadMore}
                className="h-7 px-2 text-[12px]"
              >
                {loadingMore ? "Loading..." : error ? "Retry next 32 KiB" : "Load next 32 KiB"}
              </Button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function ConflictFilesList({
  wt,
  files,
  testId,
  ariaLabel,
  targetOwner,
  sendingConflict,
  openDiffKey,
  diffByKey,
  diffErrorByKey,
  diffLoadingKey,
  diffLoadingMoreKey,
  onToggleConflictDiff,
  onRetryConflictDiff,
  onLoadMoreConflictDiff,
  onSendConflict,
}: {
  wt: WorktreeInfo;
  files: string[];
  testId: string;
  ariaLabel: string;
  targetOwner: string;
  sendingConflict: boolean;
  openDiffKey: string | null;
  diffByKey: Record<string, WorktreeDiffPayload>;
  diffErrorByKey: Record<string, string>;
  diffLoadingKey: string | null;
  diffLoadingMoreKey: string | null;
  onToggleConflictDiff: (file: string) => void;
  onRetryConflictDiff: (file: string) => void;
  onLoadMoreConflictDiff: (file: string) => void;
  onSendConflict: () => void;
}) {
  return (
    <div className="space-y-1.5 min-w-0">
      <ul
        data-testid={testId}
        aria-label={ariaLabel}
        className="divide-y divide-hairline rounded-chip border border-hairline bg-surface px-2 py-1 text-[12px] text-ink"
      >
        {files.map((cf) => {
          const key = `${wt.path}::conflict::${cf}`;
          const diffOpen = openDiffKey === key;
          const diffEntry = diffByKey[key];
          const diffErr = diffErrorByKey[key];
          const diffBusy = diffLoadingKey === key;
          const loadingMore = diffLoadingMoreKey === key;
          return (
            <li key={cf} className="py-1 space-y-1 min-w-0">
              <div className="row flex-wrap gap-1.5 min-w-0">
                <span className="mono break-all min-w-0 flex-1">{cf}</span>
                <Button
                  variant="ghost"
                  aria-label={`Conflict diff ${cf}`}
                  aria-expanded={diffOpen}
                  data-testid={`wt-conflict-diff-btn-${wt.branch}-${cf}`}
                  onClick={() => onToggleConflictDiff(cf)}
                  className="h-7 px-2 shrink-0 text-ink"
                >
                  {diffOpen ? <ChevronUp /> : <ChevronDown />}
                  Conflict diff
                </Button>
              </div>
              {diffOpen && (
                <DiffHunkBox
                  diffEntry={diffEntry}
                  busy={diffBusy}
                  loadingMore={loadingMore}
                  error={diffErr}
                  mode="conflict"
                  branch={wt.branch}
                  onLoadMore={() => onLoadMoreConflictDiff(cf)}
                  onRetry={() => onRetryConflictDiff(cf)}
                />
              )}
            </li>
          );
        })}
      </ul>
      <div className="wrap gap-1.5">
        <Button
          variant="outline"
          disabled={sendingConflict}
          data-testid={`wt-send-conflict-${wt.branch}`}
          onClick={onSendConflict}
          className="h-7 px-2 text-[12px] text-ink"
        >
          <Send />
          {sendingConflict ? "Sending..." : `Send conflict to @${targetOwner}`}
        </Button>
      </div>
    </div>
  );
}

export function WorktreesView({
  workspaceUris,
  swarmRoots = [],
  conversationId = "",
  canPostControl = false,
  payload,
  loading,
  error,
  manualRoots,
  members,
  onAddManualRoot,
  onRefresh,
  onSwarmRefresh,
  onOpDispatched,
}: {
  workspaceUris: string[];
  swarmRoots?: string[];
  conversationId?: string;
  canPostControl?: boolean;
  payload: WorktreesPayload | null;
  loading: boolean;
  error?: string;
  manualRoots: string[];
  members?: SwarmMember[];
  onAddManualRoot: (root: string) => void;
  onRefresh: () => void;
  onSwarmRefresh?: () => void;
  onOpDispatched?: (op: OperatorCommand) => void;
}) {
  const [rootInput, setRootInput] = useState("");
  const [openDiffKey, setOpenDiffKey] = useState<string | null>(null);
  const [diffByKey, setDiffByKey] = useState<Record<string, WorktreeDiffPayload>>({});
  const [diffErrorByKey, setDiffErrorByKey] = useState<Record<string, string>>({});
  const [diffLoadingKey, setDiffLoadingKey] = useState<string | null>(null);
  const [diffLoadingMoreKey, setDiffLoadingMoreKey] = useState<string | null>(null);
  const [diffModeByWt, setDiffModeByWt] = useState<Record<string, WorktreeDiffMode>>({});
  const [confirmAction, setConfirmAction] = useState<{ wtPath: string; action: WorktreeActionName } | null>(null);
  const [confirmCommitMsg, setConfirmCommitMsg] = useState("");
  const [busyActionKey, setBusyActionKey] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ wtPath: string; action: WorktreeActionName } | null>(null);
  const [actionResultByWt, setActionResultByWt] = useState<Record<string, WorktreeActionPayload>>({});
  const [sendingConflictWt, setSendingConflictWt] = useState<string | null>(null);
  const actionLockRef = useRef(false);
  const conflictPostLockRef = useRef(false);
  const diffAbortRef = useRef<AbortController | null>(null);
  const diffEpochRef = useRef(0);
  const actionAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const worktrees = payload?.worktrees || [];
  const collisions = payload?.collisions || [];
  const rootErrors = (payload?.roots || []).filter((r) => Boolean(r.error));
  const allRoots = [...new Set([...workspaceUris, ...swarmRoots, ...manualRoots])];

  const clearDiffCache = () => {
    diffEpochRef.current += 1;
    diffAbortRef.current?.abort();
    diffAbortRef.current = null;
    setDiffByKey({});
    setDiffErrorByKey({});
    setOpenDiffKey(null);
    setDiffLoadingKey(null);
    setDiffLoadingMoreKey(null);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      diffAbortRef.current?.abort();
      actionAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    clearDiffCache();
  }, [payload]);

  useEffect(() => {
    clearDiffCache();
    actionAbortRef.current?.abort();
    actionAbortRef.current = null;
    actionLockRef.current = false;
    setBusyActionKey(null);
    setPendingAction(null);
    setConfirmAction(null);
    setConfirmCommitMsg("");
    setActionResultByWt({});
  }, [conversationId]);

  const handleRefreshClick = () => {
    clearDiffCache();
    onRefresh();
  };

  const getDiffMode = (wtPath: string): WorktreeDiffMode => diffModeByWt[wtPath] || "working";

  const handleSetDiffMode = (wtPath: string, mode: WorktreeDiffMode) => {
    setDiffModeByWt((prev) => ({ ...prev, [wtPath]: mode }));
    setOpenDiffKey((cur) => {
      if (cur && cur.startsWith(`${wtPath}::`)) {
        diffAbortRef.current?.abort();
        return null;
      }
      return cur;
    });
  };

  const handleToggleDiff = async (
    root: string,
    worktree: string,
    file: string,
    mode: WorktreeDiffMode,
    targetBranch?: string,
    forceRetry = false,
  ) => {
    const key = `${worktree}::${mode}::${file}`;
    if (!forceRetry && openDiffKey === key) {
      diffAbortRef.current?.abort();
      diffAbortRef.current = null;
      setOpenDiffKey(null);
      return;
    }
    setOpenDiffKey(key);
    if (!forceRetry && diffByKey[key] && !diffErrorByKey[key]) return;
    diffAbortRef.current?.abort();
    const ac = new AbortController();
    diffAbortRef.current = ac;
    const reqEpoch = diffEpochRef.current;
    setDiffErrorByKey((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setDiffLoadingKey(key);
    try {
      const res = await fetchWorktreeDiff(root, worktree, file, mode, {
        targetBranch: mode === "conflict" ? targetBranch : undefined,
        offset: 0,
        maxBytes: DIFF_PAGE_BYTES,
        signal: ac.signal,
      });
      if (!mountedRef.current || ac.signal.aborted || diffEpochRef.current !== reqEpoch) return;
      setDiffByKey((prev) => ({ ...prev, [key]: res }));
    } catch (err) {
      if (!mountedRef.current || ac.signal.aborted || diffEpochRef.current !== reqEpoch) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : "Failed to load diff";
      setDiffErrorByKey((prev) => ({ ...prev, [key]: msg }));
      toast.error(msg);
    } finally {
      if (diffAbortRef.current === ac) diffAbortRef.current = null;
      if (mountedRef.current) {
        setDiffLoadingKey((cur) => (cur === key ? null : cur));
      }
    }
  };

  const handleLoadMoreDiff = async (
    root: string,
    worktree: string,
    file: string,
    mode: WorktreeDiffMode,
    targetBranch?: string,
  ) => {
    const key = `${worktree}::${mode}::${file}`;
    const existing = diffByKey[key];
    if (!existing || !existing.hasMore || diffLoadingMoreKey === key || diffLoadingKey === key) return;
    const nextOffset =
      typeof existing.nextOffset === "number" && existing.nextOffset > 0
        ? existing.nextOffset
        : new TextEncoder().encode(existing.diff || "").length;
    diffAbortRef.current?.abort();
    const ac = new AbortController();
    diffAbortRef.current = ac;
    const reqEpoch = diffEpochRef.current;
    setDiffErrorByKey((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setDiffLoadingMoreKey(key);
    try {
      const res = await fetchWorktreeDiff(root, worktree, file, mode, {
        targetBranch: mode === "conflict" ? targetBranch : undefined,
        offset: nextOffset,
        maxBytes: DIFF_PAGE_BYTES,
        signal: ac.signal,
      });
      if (!mountedRef.current || ac.signal.aborted || diffEpochRef.current !== reqEpoch) return;
      setDiffByKey((prev) => {
        const cur = prev[key] || existing;
        const left = cur.diff || "";
        const right = res.diff || "";
        const mergedDiff = left && right ? `${left.endsWith("\n") ? left : `${left}\n`}${right}` : `${left}${right}`;
        return {
          ...prev,
          [key]: {
            ...res,
            diff: mergedDiff,
            added: (cur.added || 0) + (res.added || 0),
            removed: (cur.removed || 0) + (res.removed || 0),
            hasMore: Boolean(res.hasMore),
            nextOffset: res.nextOffset ?? null,
            totalBytes: res.totalBytes ?? cur.totalBytes,
            truncated: Boolean(res.truncated && res.hasMore),
          },
        };
      });
    } catch (err) {
      if (!mountedRef.current || ac.signal.aborted || diffEpochRef.current !== reqEpoch) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : "Failed to load next diff chunk";
      setDiffErrorByKey((prev) => ({ ...prev, [key]: msg }));
      toast.error(msg);
    } finally {
      if (diffAbortRef.current === ac) diffAbortRef.current = null;
      if (mountedRef.current) {
        setDiffLoadingMoreKey((cur) => (cur === key ? null : cur));
      }
    }
  };

  const executeWorktreeAction = async (wt: WorktreeInfo, action: WorktreeActionName, commitMessage = "") => {
    if (actionLockRef.current) return;
    if (hasControlChars(commitMessage)) {
      toast.error("Control characters are not allowed in commit message.");
      return;
    }
    const key = `${wt.path}::${action}`;
    actionAbortRef.current?.abort();
    const ac = new AbortController();
    actionAbortRef.current = ac;
    actionLockRef.current = true;
    setBusyActionKey(key);
    setPendingAction({ wtPath: wt.path, action });
    setConfirmAction(null);
    setConfirmCommitMsg("");
    try {
      const cleanMsg = commitMessage.trim();
      const res = await runWorktreeAction(action, wt.path, wt.baseBranch || "main", wt.root, {
        ...(cleanMsg ? { commitMessage: cleanMsg } : {}),
        signal: ac.signal,
      });
      if (!mountedRef.current || ac.signal.aborted) return;
      clearDiffCache();
      setActionResultByWt((prev) => ({ ...prev, [wt.path]: res }));
      if (res.ok) {
        toast.success(maskHome(res.message || `${ACTION_LABEL[action]} succeeded on ${wt.branch}`));
        if (REFRESHING_ACTIONS.has(action)) {
          onRefresh();
        }
      } else {
        toast.error(maskHome(res.message || `${ACTION_LABEL[action]} reported conflicts`));
      }
    } catch (err) {
      if (!mountedRef.current) return;
      clearDiffCache();
      const wasAborted = ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError");
      const message = wasAborted
        ? `${ACTION_LABEL[action]} request cancelled.`
        : err instanceof Error
          ? err.message
          : "Worktree action failed";
      setActionResultByWt((prev) => ({
        ...prev,
        [wt.path]: {
          ok: false,
          action,
          status: wasAborted ? "aborted" : "error",
          ...(wasAborted ? { aborted: true } : {}),
          message,
        },
      }));
      if (wasAborted) {
        toast.message(maskHome(message));
      } else {
        toast.error(maskHome(message));
      }
    } finally {
      if (actionAbortRef.current === ac) actionAbortRef.current = null;
      actionLockRef.current = false;
      if (mountedRef.current) {
        setBusyActionKey((cur) => (cur === key ? null : cur));
        setPendingAction((cur) => (cur?.wtPath === wt.path && cur.action === action ? null : cur));
      }
    }
  };

  const handleSendConflictToOwner = async (wt: WorktreeInfo, owner: string, conflictFiles: string[]) => {
    if (conflictPostLockRef.current || !conflictFiles.length) return;
    const directive = buildConflictDirective(owner, wt, conflictFiles);
    if (!conversationId || !canPostControl) {
      await copyText(directive, `Copied conflict directive for @${owner}`);
      return;
    }
    conflictPostLockRef.current = true;
    setSendingConflictWt(wt.path);
    try {
      const res = await sendSwarmControl({
        op: "board_post",
        conversationId,
        text: directive,
      });
      notifyDispatch(res, `conflict directive to @${owner}`);
      const dispatched = toDispatchedOp(res, "board_post", owner);
      if (dispatched) onOpDispatched?.(dispatched);
      onSwarmRefresh?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send conflict directive");
    } finally {
      conflictPostLockRef.current = false;
      setSendingConflictWt((cur) => (cur === wt.path ? null : cur));
    }
  };

  const handleActionClick = (wt: WorktreeInfo, action: WorktreeActionName) => {
    if (action === "dry_run_merge") {
      void executeWorktreeAction(wt, action);
      return;
    }
    setConfirmCommitMsg("");
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
    <div className="space-y-3 min-w-0">
      <div className="row flex-wrap gap-2">
        <h2 className="h2">Git worktrees ({worktrees.length})</h2>
        <Button onClick={handleRefreshClick} disabled={loading}>
          <RefreshCw className={loading ? "motion-safe:animate-spin" : ""} />
          Refresh
        </Button>
      </div>

      {workspaceUris.length === 0 && (
        <form onSubmit={handleAdd} className="f1 min-w-0">
          <Input
            aria-label="Workspace repository path"
            placeholder="/path/to/repo"
            value={rootInput}
            onChange={(e) => setRootInput(e.target.value)}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="secondary" className="shrink-0">
            Inspect
          </Button>
        </form>
      )}

      {(error || rootErrors.length > 0) && (
        <Card role="alert" data-testid="worktrees-error-banner" className="border-danger bg-bad-soft p-2.5 space-y-2 text-[12px] text-danger">
          <div className="space-y-1">
            {error && <p className="font-medium break-words">{maskHome(error)}</p>}
            {rootErrors.map((r) => (
              <p key={r.path} className="break-words">
                {maskHome(r.path)}: {maskHome(r.error)}
              </p>
            ))}
          </div>
          <Button variant="outline" data-testid="worktrees-retry-btn" disabled={loading} onClick={handleRefreshClick} className="h-7 px-2">
            <RefreshCw className={loading ? "motion-safe:animate-spin" : ""} />
            Retry
          </Button>
        </Card>
      )}

      {collisions.length > 0 && (
        <Card
          data-testid="worktree-collisions-banner"
          className="border-warn bg-warn-soft p-3 space-y-2"
        >
          <div className="row flex-wrap gap-1.5">
            <div className="f1 min-w-0">
              <AlertTriangle className="h-4 w-4 text-warn shrink-0" />
              <span className="h2">File collisions ({collisions.length})</span>
            </div>
            <span className="t3">Shared paths across active branches</span>
          </div>
          <ul aria-label="Worktree file collisions" className="divide-y divide-hairline rounded-chip border border-hairline bg-surface px-2 py-1">
            {collisions.map((c) => {
              const kind = c.kind || "mixed";
              const targets = collisionTargets(c);
              return (
                <li
                  key={c.file}
                  data-testid={`wt-collision-${c.file}`}
                  className="py-1.5 space-y-1 min-w-0"
                >
                  <div className="flex items-start justify-between gap-1.5 flex-wrap min-w-0">
                    <span className="text-[12px] font-medium text-ink mono break-all min-w-0 flex-1">{c.file}</span>
                    <Badge tone={COLLISION_TONE[kind] || "warning"} className="shrink-0">{kind}</Badge>
                  </div>
                  {targets.length > 0 && (
                    <div className="wrap gap-1 min-w-0" data-testid={`wt-collision-targets-${c.file}`}>
                      <span className="t3 shrink-0">Touched by:</span>
                      {targets.map((target, idx) => (
                        <Badge key={`${target}-${idx}`} tone="neutral" className="max-w-full truncate">
                          {target}
                        </Badge>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {worktrees.length === 0 ? (
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
            const owner = resolveOwnerInfo(wt, members);
            const ownerBadgeText = owner ? [`@${owner.member}`, owner.status, owner.workspaceMode].filter(Boolean).join(" · ") : "";
            const targetOwner = owner?.member || "coordinator";
            const diffMode = getDiffMode(wt.path);
            const activeFiles = diffMode === "branch" ? branchFiles : workingFiles;
            const activeTruncated = diffMode === "branch" ? wt.branchFilesTruncated : wt.filesTruncated;
            const commits = Array.isArray(wt.commits) ? wt.commits.slice(0, 5) : [];
            const actionRes = actionResultByWt[wt.path];
            const actionConflicts = actionRes?.conflicts || actionRes?.conflictFiles || [];
            const presetConflicts = Array.isArray(wt.conflictFiles) ? wt.conflictFiles : [];
            const confirmingHere = confirmAction?.wtPath === wt.path ? confirmAction.action : null;
            const isCommitAction = confirmingHere === "squash_merge" || confirmingHere === "merge_commit";
            const isBusyHere = Boolean(busyActionKey && busyActionKey.startsWith(`${wt.path}::`));
            const canToggleDiffMode = !wt.isMain || branchFiles.length > 0 || workingFiles.length > 0;
            const sendingConflictHere = sendingConflictWt === wt.path;

            return (
              <Card key={wt.id} data-testid={`wt-card-${wt.branch}`} className="p-3 space-y-2">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="basis-60 min-w-0 flex-1 space-y-1">
                    <div className="wrap">
                      <GitBranch className="h-3.5 w-3.5 text-info shrink-0" />
                      <span className="h2 break-all">{wt.branch}</span>
                      {wt.isMain && <Badge tone="neutral">main</Badge>}
                      {owner && (
                        <Badge
                          tone={owner.status === "working" ? "info" : "violet"}
                          data-testid={`wt-owner-${wt.branch}`}
                          className="max-w-full truncate"
                        >
                          {ownerBadgeText}
                        </Badge>
                      )}
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
                        <Badge tone={behind > 0 ? "warning" : "info"} className="num max-w-full truncate">
                          +{ahead} / -{behind} vs {wt.baseBranch || "main"}
                        </Badge>
                      )}
                    </div>
                    <p className="t3 mono truncate" title={maskHome(wt.path)}>
                      <FolderGit2 className="inline h-3 w-3 mr-1 align-text-bottom" />
                      {maskHome(wt.path)}
                    </p>
                  </div>

                  <div className="wrap gap-1.5 shrink-0 max-w-full">
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
                  <div className="space-y-1.5 min-w-0" data-testid={`wt-actions-${wt.branch}`}>
                    <div className="wrap gap-1.5">
                      {(
                        [
                          ["dry_run_merge", "secondary", `wt-action-dry-run-${wt.branch}`, false, undefined],
                          ["ff_merge", "outline", `wt-action-ff-merge-${wt.branch}`, !wt.clean, "Working tree must be clean before FF merge"],
                          ["rebase", "outline", `wt-action-rebase-${wt.branch}`, false, undefined],
                          ["squash_merge", "outline", `wt-action-squash-merge-${wt.branch}`, !wt.clean, "Working tree must be clean before squash merge"],
                          ["merge_commit", "outline", `wt-action-merge-commit-${wt.branch}`, !wt.clean, "Working tree must be clean before merge commit"],
                          ["remove_worktree", "danger", `wt-action-remove-${wt.branch}`, !wt.clean, "Working tree must be clean before removal"],
                        ] as const
                      ).map(([act, variant, testId, dirtyDisabled, disabledReason]) => {
                        const isThisBusy = busyActionKey === `${wt.path}::${act}`;
                        return (
                          <Button
                            key={act}
                            variant={variant}
                            disabled={isBusyHere || dirtyDisabled}
                            title={dirtyDisabled ? disabledReason : undefined}
                            data-testid={testId}
                            onClick={() => handleActionClick(wt, act)}
                          >
                            {isThisBusy ? ACTION_BUSY_LABEL[act] : ACTION_LABEL[act]}
                          </Button>
                        );
                      })}
                    </div>

                    {isBusyHere && pendingAction?.wtPath === wt.path && (
                      <div
                        role="status"
                        data-testid={`wt-action-pending-${wt.branch}`}
                        className="row flex-wrap gap-2 rounded-chip border border-hairline bg-board px-2 py-1.5 text-[12px]"
                      >
                        <div className="f1 min-w-0 text-ink-2">
                          <RefreshCw className="h-3.5 w-3.5 text-info motion-safe:animate-spin shrink-0" />
                          <span className="truncate">Running {ACTION_LABEL[pendingAction.action]}...</span>
                        </div>
                        <Button
                          variant="outline"
                          data-testid={`wt-action-abort-${wt.branch}`}
                          onClick={() => actionAbortRef.current?.abort()}
                          className="h-7 px-2 shrink-0"
                        >
                          <X />
                          Abort
                        </Button>
                      </div>
                    )}

                    {confirmingHere && (
                      <div
                        data-testid={`wt-confirm-${wt.branch}`}
                        className="space-y-1.5 rounded-chip border border-hairline bg-board px-2 py-1.5 text-[12px]"
                      >
                        <div className="row flex-wrap gap-2">
                          <span className="text-ink min-w-0 break-words">
                            Confirm {ACTION_LABEL[confirmingHere]} on <span className="mono font-medium">{wt.branch}</span>?
                          </span>
                          <div className="wrap gap-1.5 shrink-0">
                            <Button
                              variant="ghost"
                              onClick={() => {
                                setConfirmAction(null);
                                setConfirmCommitMsg("");
                              }}
                            >
                              Cancel
                            </Button>
                            <Button
                              variant={confirmingHere === "remove_worktree" ? "danger" : "primary"}
                              disabled={isBusyHere || hasControlChars(confirmCommitMsg)}
                              data-testid={`wt-confirm-submit-${wt.branch}`}
                              onClick={() => void executeWorktreeAction(wt, confirmingHere, isCommitAction ? confirmCommitMsg : "")}
                            >
                              Confirm {ACTION_LABEL[confirmingHere]}
                            </Button>
                          </div>
                        </div>
                        {isCommitAction && (
                          <Input
                            aria-label={`Commit message for ${wt.branch}`}
                            data-testid={`wt-confirm-msg-${wt.branch}`}
                            placeholder={`Optional commit message for ${wt.branch}`}
                            value={confirmCommitMsg}
                            onChange={(e) => setConfirmCommitMsg(e.target.value)}
                          />
                        )}
                      </div>
                    )}

                    {actionRes && (() => {
                      const hint = actionRecoveryHint(actionRes);
                      const canRetryFailed =
                        !actionRes.ok && (actionRes.status === "error" || actionRes.status === "aborted");
                      const retryAct = actionRes.action as WorktreeActionName;
                      return (
                        <div
                          role={actionRes.ok ? "status" : "alert"}
                          data-testid={`wt-action-result-${wt.branch}`}
                          className={cn(
                            "rounded-chip border px-2 py-1.5 space-y-1.5 text-[12px] min-w-0",
                            actionRes.ok ? "border-ok bg-ok-soft text-ink" : "border-danger bg-bad-soft text-danger",
                          )}
                        >
                          <div className="flex items-start justify-between gap-1.5 flex-wrap">
                            <div className="flex items-start gap-1.5 min-w-0 flex-1">
                              {!actionRes.ok && <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-danger" />}
                              <span className="font-medium break-words min-w-0">
                                {maskHome(actionRes.message || actionRes.status || "Action complete")}
                              </span>
                            </div>
                            <div className="f1 shrink-0">
                              {actionRes.aborted && <Badge tone="warning">aborted</Badge>}
                              {actionRes.status && <Badge tone={actionRes.ok ? "success" : "danger"}>{actionRes.status}</Badge>}
                              <button
                                type="button"
                                aria-label={`Dismiss ${wt.branch} action result`}
                                data-testid={`wt-action-dismiss-${wt.branch}`}
                                onClick={() =>
                                  setActionResultByWt((prev) => {
                                    const next = { ...prev };
                                    delete next[wt.path];
                                    return next;
                                  })
                                }
                                className="rounded p-0.5 text-ink-3 hover:text-ink cursor-pointer"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                          {hint && <p className="text-ink-2 break-words">{hint}</p>}
                          {canRetryFailed && ACTION_LABEL[retryAct] && (
                            <div>
                              <Button
                                variant="outline"
                                disabled={isBusyHere}
                                data-testid={`wt-action-retry-${wt.branch}`}
                                onClick={() => handleActionClick(wt, retryAct)}
                                className="h-7 px-2 text-[12px]"
                              >
                                <RefreshCw />
                                Retry {ACTION_LABEL[retryAct]}
                              </Button>
                            </div>
                          )}
                          {actionConflicts.length > 0 && (
                            <ConflictFilesList
                              wt={wt}
                              files={actionConflicts}
                              testId={`wt-action-conflicts-${wt.branch}`}
                              ariaLabel={`Conflicting files in ${wt.branch}`}
                              targetOwner={targetOwner}
                              sendingConflict={sendingConflictHere}
                              openDiffKey={openDiffKey}
                              diffByKey={diffByKey}
                              diffErrorByKey={diffErrorByKey}
                              diffLoadingKey={diffLoadingKey}
                              diffLoadingMoreKey={diffLoadingMoreKey}
                              onToggleConflictDiff={(cf) =>
                                void handleToggleDiff(wt.root, wt.path, cf, "conflict", wt.baseBranch || "main")
                              }
                              onRetryConflictDiff={(cf) =>
                                void handleToggleDiff(wt.root, wt.path, cf, "conflict", wt.baseBranch || "main", true)
                              }
                              onLoadMoreConflictDiff={(cf) =>
                                void handleLoadMoreDiff(wt.root, wt.path, cf, "conflict", wt.baseBranch || "main")
                              }
                              onSendConflict={() => void handleSendConflictToOwner(wt, targetOwner, actionConflicts)}
                            />
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {presetConflicts.length > 0 && !actionRes && (
                  <div
                    data-testid={`wt-conflicts-${wt.branch}`}
                    className="rounded-chip border border-danger bg-bad-soft px-2 py-1.5 text-[12px] space-y-1.5"
                  >
                    <p className="font-medium text-danger">Predicted merge conflicts ({presetConflicts.length})</p>
                    <ConflictFilesList
                      wt={wt}
                      files={presetConflicts}
                      testId={`wt-preset-conflicts-${wt.branch}`}
                      ariaLabel={`Predicted conflicting files in ${wt.branch}`}
                      targetOwner={targetOwner}
                      sendingConflict={sendingConflictHere}
                      openDiffKey={openDiffKey}
                      diffByKey={diffByKey}
                      diffErrorByKey={diffErrorByKey}
                      diffLoadingKey={diffLoadingKey}
                      diffLoadingMoreKey={diffLoadingMoreKey}
                      onToggleConflictDiff={(cf) =>
                        void handleToggleDiff(wt.root, wt.path, cf, "conflict", wt.baseBranch || "main")
                      }
                      onRetryConflictDiff={(cf) =>
                        void handleToggleDiff(wt.root, wt.path, cf, "conflict", wt.baseBranch || "main", true)
                      }
                      onLoadMoreConflictDiff={(cf) =>
                        void handleLoadMoreDiff(wt.root, wt.path, cf, "conflict", wt.baseBranch || "main")
                      }
                      onSendConflict={() => void handleSendConflictToOwner(wt, targetOwner, presetConflicts)}
                    />
                  </div>
                )}

                {commits.length > 0 ? (
                  <ul
                    aria-label={`Recent commits in ${wt.branch}`}
                    data-testid={`wt-commits-${wt.branch}`}
                    className="divide-y divide-hairline rounded-chip bg-board px-2 py-1 text-[12px] text-ink-2"
                  >
                    {commits.map((c) => (
                      <li key={c.sha} className="row py-1 first:pt-0.5 last:pb-0.5 gap-2 min-w-0">
                        <span className="truncate text-ink min-w-0 flex-1">{c.subject || "No commit message"}</span>
                        <span className="shrink-0 mono num text-ink-3 flex items-center gap-2">
                          <span>{c.sha}</span>
                          <span>{c.authorTime || (c.at ? fmtTimeAgo(c.at) : "")}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (wt.lastCommitSubject || wt.lastCommitSha) ? (
                  <div className="row rounded-chip bg-board px-2 py-1 text-[12px] text-ink-2 min-w-0">
                    <span className="truncate min-w-0 flex-1">{wt.lastCommitSubject || "No commits yet"}</span>
                    <span className="shrink-0 mono num text-ink-3 flex items-center gap-2">
                      <span>{wt.lastCommitSha}</span>
                      <span>{wt.lastCommitAt ? fmtTimeAgo(wt.lastCommitAt) : "n/a"}</span>
                    </span>
                  </div>
                ) : null}

                {canToggleDiffMode && (
                  <div className="space-y-1.5 min-w-0">
                    <div className="row flex-wrap gap-1.5">
                      <div
                        role="tablist"
                        aria-label={`Diff mode for ${wt.branch}`}
                        className="inline-flex flex-wrap max-w-full rounded-chip border border-hairline bg-track p-0.5"
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
                          const diffErr = diffErrorByKey[key];
                          const diffBusy = diffLoadingKey === key;
                          const loadingMore = diffLoadingMoreKey === key;

                          return (
                            <li key={`${diffMode}-${f.path}`} className="py-1 space-y-1 min-w-0">
                              <div className="row flex-wrap gap-1.5 min-w-0">
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
                                    onClick={() => handleToggleDiff(wt.root, wt.path, f.path, diffMode, wt.baseBranch || "main")}
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
                                <DiffHunkBox
                                  diffEntry={diffEntry}
                                  busy={diffBusy}
                                  loadingMore={loadingMore}
                                  error={diffErr}
                                  mode={diffMode}
                                  branch={wt.branch}
                                  onLoadMore={() =>
                                    void handleLoadMoreDiff(wt.root, wt.path, f.path, diffMode, wt.baseBranch || "main")
                                  }
                                  onRetry={() =>
                                    void handleToggleDiff(wt.root, wt.path, f.path, diffMode, wt.baseBranch || "main", true)
                                  }
                                />
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
