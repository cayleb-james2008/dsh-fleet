import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BookMarked,
  CheckSquare,
  Cpu,
  Download,
  FileDiff,
  Filter,
  FolderGit2,
  GitMerge,
  GitPullRequest,
  Layers,
  LayoutGrid,
  Network,
  Plus,
  RotateCcw,
  Search,
  Terminal,
  X,
} from "lucide-react";
import { Badge, Dialog, Input, Kbd, cn } from "./ui";
import {
  isFailed,
  isVerified,
  statusText,
  type PlaybookTemplate,
  type RepoInfo,
  type Session,
  type StatusFilter,
  type TabId,
  type ViewMode,
} from "./api";

type CmdItem = {
  id: string;
  group: string;
  label: string;
  searchText: string;
  icon: ReactNode;
  shortcut?: string;
  badge?: { text: string; tone: "neutral" | "info" | "success" | "warning" | "danger" };
  onSelect: () => void;
};

export function CommandPalette({
  open,
  onOpenChange,
  sessions,
  selectedSession,
  playbooks,
  repos,
  engines,
  viewMode,
  multiSelect,
  onViewMode,
  onOpenSession,
  onOpenPrPreview,
  onSwitchTab,
  onNewSingle,
  onNewBatch,
  onApplyPlaybook,
  onOpenSettings,
  onToggleMultiSelect,
  onFocusSearch,
  onFilterStatus,
  onFilterRepo,
  onFilterEngine,
  onClearFilters,
  onDownloadPatch,
  onRetrySession,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sessions: Session[];
  selectedSession: Session | null;
  playbooks: PlaybookTemplate[];
  repos: RepoInfo[];
  engines: string[];
  viewMode: ViewMode;
  multiSelect: boolean;
  onViewMode: (v: ViewMode) => void;
  onOpenSession: (id: string, tab?: TabId) => void;
  onOpenPrPreview: (s: Session) => void;
  onSwitchTab: (tab: TabId) => void;
  onNewSingle: () => void;
  onNewBatch: () => void;
  onApplyPlaybook: (tpl: PlaybookTemplate) => void;
  onOpenSettings: () => void;
  onToggleMultiSelect: () => void;
  onFocusSearch: () => void;
  onFilterStatus: (status: StatusFilter) => void;
  onFilterRepo: (repo: string) => void;
  onFilterEngine: (engine: string) => void;
  onClearFilters: () => void;
  onDownloadPatch: (s: Session) => void;
  onRetrySession: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const act = (fn: () => void) => {
    onOpenChange(false);
    setTimeout(fn, 40);
  };

  const allItems = useMemo<CmdItem[]>(() => {
    const items: CmdItem[] = [
      {
        id: "act-new",
        group: "Orchestration",
        label: "New session",
        searchText: "new session dispatch single task goal",
        icon: <Plus className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
        shortcut: "N",
        onSelect: () => act(onNewSingle),
      },
      {
        id: "act-batch",
        group: "Orchestration",
        label: "Dispatch Batch DAG",
        searchText: "batch dispatch fan out parallel tasks dag depends on",
        icon: <Layers className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
        onSelect: () => act(onNewBatch),
      },
      {
        id: "act-view",
        group: "Orchestration",
        label: viewMode === "dag" ? "Switch to Workbench view" : "Switch to DAG Graph view",
        searchText: "view dag graph multi wave board workbench",
        icon: viewMode === "dag"
          ? <LayoutGrid className="size-4 text-[var(--icon)]" strokeWidth={1.5} />
          : <Network className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
        shortcut: "G",
        onSelect: () => act(() => onViewMode(viewMode === "dag" ? "board" : "dag")),
      },
      {
        id: "act-multi",
        group: "Orchestration",
        label: multiSelect ? "Exit multi-select mode" : "Select multiple sessions",
        searchText: "multi select bulk retry dismiss merge",
        icon: <CheckSquare className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
        onSelect: () => act(onToggleMultiSelect),
      },
      {
        id: "act-search",
        group: "Orchestration",
        label: "Focus session search",
        searchText: "focus search input",
        icon: <Search className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
        shortcut: "/",
        onSelect: () => act(onFocusSearch),
      },
      {
        id: "act-settings",
        group: "Orchestration",
        label: "Open Engines, Worktrees & Settings",
        searchText: "settings engines policy worktrees theme",
        icon: <Cpu className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
        onSelect: () => act(onOpenSettings),
      },
      {
        id: "act-clear",
        group: "Orchestration",
        label: "Clear all filters",
        searchText: "clear reset filters",
        icon: <X className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
        onSelect: () => act(onClearFilters),
      },
    ];

    for (const tpl of playbooks) {
      const count = tpl.tasks?.length ?? 1;
      items.push({
        id: `pb-${tpl.id}`,
        group: `Playbooks (${playbooks.length})`,
        label: tpl.name,
        searchText: `playbook template ${tpl.name} ${tpl.description} ${tpl.repo || ""}`,
        icon: <BookMarked className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
        shortcut: count > 1 ? `${count} tasks` : "Single",
        onSelect: () => act(() => onApplyPlaybook(tpl)),
      });
    }

    if (selectedSession) {
      const grp = `Current session (${selectedSession.id})`;
      items.push(
        {
          id: "cur-tr",
          group: grp,
          label: "View Transcript",
          searchText: "inspect transcript tab log lines",
          icon: <Terminal className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
          shortcut: "T",
          onSelect: () => act(() => onSwitchTab("tr")),
        },
        {
          id: "cur-df",
          group: grp,
          label: "View Diff (Unified / Split)",
          searchText: "inspect diff tab unified split side by side",
          icon: <FileDiff className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
          shortcut: "D",
          onSelect: () => act(() => onSwitchTab("df")),
        },
        {
          id: "cur-rc",
          group: grp,
          label: "View Verification Checks & Receipt",
          searchText: "inspect receipt tab check steps timeline",
          icon: <GitMerge className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
          shortcut: "R",
          onSelect: () => act(() => onSwitchTab("rc")),
        },
        {
          id: "cur-patch",
          group: grp,
          label: `Download .patch for ${selectedSession.branch || selectedSession.id}`,
          searchText: "download patch export diff",
          icon: <Download className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
          onSelect: () => act(() => onDownloadPatch(selectedSession)),
        },
      );
      if (selectedSession.branch) {
        items.push({
          id: "cur-pr",
          group: grp,
          label: `PR preview & Create PR for ${selectedSession.id}`,
          searchText: "pr preview create github pull request markdown",
          icon: <GitPullRequest className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
          onSelect: () => act(() => onOpenPrPreview(selectedSession)),
        });
      }
      if (selectedSession.status === "needs-you") {
        items.push({
          id: "cur-retry",
          group: grp,
          label: `Retry ${selectedSession.id}`,
          searchText: "retry selected session",
          icon: <RotateCcw className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
          onSelect: () => act(() => onRetrySession(selectedSession.id)),
        });
      }
    }

    const statusFilters: Array<[StatusFilter, string]> = [
      ["all", "Show all sessions"],
      ["needs-you", "Filter: Needs you"],
      ["working", "Filter: Working (active)"],
      ["queued", "Filter: Queued / Blocked"],
      ["done", "Filter: Done / Verified"],
    ];
    for (const [st, label] of statusFilters) {
      items.push({
        id: `st-${st}`,
        group: "Filter by status",
        label,
        searchText: label,
        icon: <Filter className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
        onSelect: () => act(() => onFilterStatus(st)),
      });
    }

    for (const s of sessions.slice(0, 40)) {
      const verified = isVerified(s);
      const failed = isFailed(s);
      items.push({
        id: `ses-${s.id}`,
        group: `Sessions (${sessions.length})`,
        label: s.task,
        searchText: `${s.id} ${s.task} ${s.project} ${s.branch || ""} ${s.engine || ""} ${s.status}`,
        icon: <Terminal className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
        badge: {
          text: verified ? (s.status === "merged" ? "merged" : "verified") : statusText(s),
          tone: verified ? "success" : failed ? "danger" : s.bucket === "needs-you" ? "info" : "neutral",
        },
        onSelect: () => act(() => onOpenSession(s.id, "tr")),
      });
    }

    for (const r of repos.slice(0, 8)) {
      items.push({
        id: `repo-${r.path}`,
        group: "Filter by repository or engine",
        label: `Repo: ${r.name}`,
        searchText: `repo repository ${r.name} ${r.path}`,
        icon: <FolderGit2 className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
        shortcut: r.branch || "git",
        onSelect: () => act(() => onFilterRepo(r.name)),
      });
    }
    for (const eng of engines) {
      items.push({
        id: `eng-${eng}`,
        group: "Filter by repository or engine",
        label: `Engine: ${eng}`,
        searchText: `engine agent ${eng}`,
        icon: <Cpu className="size-4 text-[var(--icon)]" strokeWidth={1.5} />,
        onSelect: () => act(() => onFilterEngine(eng)),
      });
    }
    return items;
  }, [
    engines,
    multiSelect,
    onApplyPlaybook,
    onClearFilters,
    onDownloadPatch,
    onFilterEngine,
    onFilterRepo,
    onFilterStatus,
    onFocusSearch,
    onNewBatch,
    onNewSingle,
    onOpenChange,
    onOpenPrPreview,
    onOpenSession,
    onOpenSettings,
    onRetrySession,
    onSwitchTab,
    onToggleMultiSelect,
    onViewMode,
    playbooks,
    repos,
    selectedSession,
    sessions,
    viewMode,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allItems;
    const words = q.split(/\s+/);
    return allItems.filter((it) => {
      const hay = `${it.label} ${it.searchText}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [allItems, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, Array<{ item: CmdItem; flatIdx: number }>>();
    filtered.forEach((item, flatIdx) => {
      const list = map.get(item.group) ?? [];
      list.push({ item, flatIdx });
      map.set(item.group, list);
    });
    return Array.from(map.entries());
  }, [filtered]);

  const clampedIdx = filtered.length === 0 ? -1 : Math.min(activeIdx, filtered.length - 1);

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title="Command palette"
      description="Jump to sessions, dispatch tasks, filter runs, or control the workspace."
      maxWidth="max-w-xl"
    >
      <div cmdk-root="" className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
          <Input
            ref={inputRef}
            cmdk-input=""
            type="search"
            aria-label="Search commands and sessions"
            placeholder="Jump to session, playbook, filter repo, or run action..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                if (filtered.length > 0) setActiveIdx((i) => (i + 1) % filtered.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (filtered.length > 0) setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
              } else if (e.key === "Enter" && clampedIdx >= 0) {
                e.preventDefault();
                filtered[clampedIdx]?.onSelect();
              }
            }}
            className="pl-9"
          />
        </div>

        <div className="max-h-[50dvh] overflow-y-auto space-y-3 pr-1">
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-[14px] text-[var(--ink-3)]">No matching commands or sessions.</p>
          ) : (
            grouped.map(([group, rows]) => (
              <div key={group} className="space-y-1">
                <p className="px-2 text-[12px] font-medium text-[var(--ink-3)]">{group}</p>
                {rows.map(({ item, flatIdx }) => {
                  const active = flatIdx === clampedIdx;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onMouseEnter={() => setActiveIdx(flatIdx)}
                      onClick={item.onSelect}
                      className={cn(
                        "w-full flex items-center gap-2.5 rounded-[var(--radius)] px-2.5 py-2 text-left text-[14px] cursor-pointer max-md:min-h-11",
                        active ? "bg-[var(--blue-soft)] text-[var(--ink)]" : "text-[var(--ink)] hover:bg-[var(--track)]",
                      )}
                    >
                      <span className="shrink-0" aria-hidden>{item.icon}</span>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.badge && <Badge tone={item.badge.tone}>{item.badge.text}</Badge>}
                      {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hairline)] pt-2.5 mono text-[12px] text-[var(--ink-3)]">
          <span>j/k sessions, t/d/r/g views, n new, / search</span>
          <span>Enter select, Esc close</span>
        </div>
      </div>
    </Dialog>
  );
}
