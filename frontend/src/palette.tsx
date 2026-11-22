// Global Command Palette (Cmd+K / Ctrl+K) powered by House Frontend Command (cmdk + Radix Dialog).
import {
  CheckSquare,
  Cpu,
  Download,
  FileDiff,
  Filter,
  FolderGit2,
  GitMerge,
  Layers,
  Plus,
  RotateCcw,
  Search,
  Terminal,
  X,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import {
  isFailed,
  isVerified,
  statusText,
  type RepoInfo,
  type Session,
  type StatusFilter,
  type TabId,
} from "./api";

export function CommandPalette({
  open,
  onOpenChange,
  sessions,
  selectedSession,
  repos,
  engines,
  multiSelect,
  onOpenSession,
  onSwitchTab,
  onNewSingle,
  onNewBatch,
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
  repos: RepoInfo[];
  engines: string[];
  multiSelect: boolean;
  onOpenSession: (id: string, tab?: TabId) => void;
  onSwitchTab: (tab: TabId) => void;
  onNewSingle: () => void;
  onNewBatch: () => void;
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
  const act = (fn: () => void) => {
    onOpenChange(false);
    setTimeout(fn, 60);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Fleet Command Palette"
      description="Jump to sessions, dispatch tasks, filter the board, or control the inspector."
    >
      <CommandInput placeholder="Jump to session, dispatch batch, filter repo, or run action..." />
      <CommandList>
        <CommandEmpty>No matching commands or sessions.</CommandEmpty>

        <CommandGroup heading="Orchestration actions">
          <CommandItem value="New session dispatch single task" onSelect={() => act(onNewSingle)}>
            <Plus className="text-icon" strokeWidth={1.5} aria-hidden />
            <span>New session</span>
            <CommandShortcut>N</CommandShortcut>
          </CommandItem>
          <CommandItem value="Batch dispatch fan out parallel tasks dag depends on" onSelect={() => act(onNewBatch)}>
            <Layers className="text-icon" strokeWidth={1.5} aria-hidden />
            <span>Batch fan-out dispatch</span>
            <CommandShortcut>DAG</CommandShortcut>
          </CommandItem>
          <CommandItem value="Focus board search sessions" onSelect={() => act(onFocusSearch)}>
            <Search className="text-icon" strokeWidth={1.5} aria-hidden />
            <span>Focus search bar</span>
            <CommandShortcut>/</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="Toggle multi select bulk inbox board actions"
            onSelect={() => act(onToggleMultiSelect)}
          >
            <CheckSquare className="text-icon" strokeWidth={1.5} aria-hidden />
            <span>{multiSelect ? "Exit multi-select mode" : "Enable multi-select bulk actions"}</span>
          </CommandItem>
          <CommandItem value="Engines and settings policy tester light dark theme" onSelect={() => act(onOpenSettings)}>
            <Cpu className="text-icon" strokeWidth={1.5} aria-hidden />
            <span>Open Engines &amp; settings (Policy Tester · Theme)</span>
          </CommandItem>
          <CommandItem value="Clear all filters reset search" onSelect={() => act(onClearFilters)}>
            <X className="text-icon" strokeWidth={1.5} aria-hidden />
            <span>Clear all board filters</span>
          </CommandItem>
        </CommandGroup>

        {selectedSession && (
          <>
            <CommandSeparator />
            <CommandGroup heading={`Current session · ${selectedSession.id}`}>
              <CommandItem value="Inspect transcript tab log lines" onSelect={() => act(() => onSwitchTab("tr"))}>
                <Terminal className="text-icon" strokeWidth={1.5} aria-hidden />
                <span>View Transcript</span>
                <CommandShortcut>T</CommandShortcut>
              </CommandItem>
              <CommandItem value="Inspect diff tab unified split side by side" onSelect={() => act(() => onSwitchTab("df"))}>
                <FileDiff className="text-icon" strokeWidth={1.5} aria-hidden />
                <span>View Diff (Unified / Split)</span>
                <CommandShortcut>D</CommandShortcut>
              </CommandItem>
              <CommandItem value="Inspect receipt tab check steps timeline" onSelect={() => act(() => onSwitchTab("rc"))}>
                <GitMerge className="text-icon" strokeWidth={1.5} aria-hidden />
                <span>View Receipt timeline</span>
                <CommandShortcut>R</CommandShortcut>
              </CommandItem>
              <CommandItem value="Download patch file export diff" onSelect={() => act(() => onDownloadPatch(selectedSession))}>
                <Download className="text-icon" strokeWidth={1.5} aria-hidden />
                <span>Download .patch for {selectedSession.branch || selectedSession.id}</span>
              </CommandItem>
              {selectedSession.status === "needs-you" && (
                <CommandItem value="Retry selected session" onSelect={() => act(() => onRetrySession(selectedSession.id))}>
                  <RotateCcw className="text-icon" strokeWidth={1.5} aria-hidden />
                  <span>Retry {selectedSession.id}</span>
                </CommandItem>
              )}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="Filter by status">
          {(
            [
              ["all", "Show all sessions"],
              ["needs-you", "Filter: Needs you"],
              ["working", "Filter: Working (active)"],
              ["queued", "Filter: Queued / Blocked"],
              ["done", "Filter: Done / Verified"],
            ] as const
          ).map(([st, label]) => (
            <CommandItem key={st} value={label} onSelect={() => act(() => onFilterStatus(st))}>
              <Filter className="text-icon" strokeWidth={1.5} aria-hidden />
              <span>{label}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        {sessions.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={`Sessions (${sessions.length})`}>
              {sessions.slice(0, 40).map((s) => {
                const verified = isVerified(s);
                const failed = isFailed(s);
                return (
                  <CommandItem
                    key={s.id}
                    value={`${s.id} ${s.task} ${s.project} ${s.branch || ""} ${s.engine || ""} ${s.status}`}
                    onSelect={() => act(() => onOpenSession(s.id, "tr"))}
                  >
                    <span className="min-w-0 flex-1 truncate">{s.task}</span>
                    <span className="hidden shrink-0 font-mono text-xs text-ink-3 sm:inline">{s.project}</span>
                    <Badge
                      variant={verified ? "success" : failed ? "error" : s.bucket === "needs-you" ? "info" : "secondary"}
                      size="sm"
                      className="shrink-0"
                    >
                      {verified ? (s.status === "merged" ? "merged" : "verified") : statusText(s)}
                    </Badge>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}

        {(repos.length > 0 || engines.length > 0) && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Filter by repository or engine">
              {repos.slice(0, 8).map((r) => (
                <CommandItem
                  key={`repo-${r.path}`}
                  value={`repo repository ${r.name} ${r.path}`}
                  onSelect={() => act(() => onFilterRepo(r.name))}
                >
                  <FolderGit2 className="text-icon" strokeWidth={1.5} aria-hidden />
                  <span>Repo: {r.name}</span>
                  <CommandShortcut>{r.branch || "git"}</CommandShortcut>
                </CommandItem>
              ))}
              {engines.map((eng) => (
                <CommandItem
                  key={`eng-${eng}`}
                  value={`engine agent ${eng}`}
                  onSelect={() => act(() => onFilterEngine(eng))}
                >
                  <Cpu className="text-icon" strokeWidth={1.5} aria-hidden />
                  <span>Engine: {eng}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline bg-canvas px-3.5 py-2 font-mono text-xs text-ink-3">
        <span>j/k sessions · t/d/r tabs · n new · / search</span>
        <span>Enter select · Esc close</span>
      </div>
    </CommandDialog>
  );
}
