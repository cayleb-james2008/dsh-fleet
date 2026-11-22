// Fleet v0.8.0: Parallel Coding-Agent War Room & Mission Control Board.
// Top Command Bar (Cmd+K, Search, Needs-you Inbox, New/Batch Session, Settings — NO top-bar theme toggle)
// -> Update Strip -> Scan Strip (Concurrency active/max_parallel + Live SSE status + Tremor Tracker)
// -> Hero Verified Receipt -> Filter & Multi-Select Bulk Strip -> Three-Lane Board + Split-Pane Inspector.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { Drawer } from "vaul";
import {
  Command as CommandIcon,
  Cpu,
  KeyRound,
  Plug,
  RefreshCw,
  RotateCcw,
  ScanLine,
  Search,
  Sun,
  Moon,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SlidingNumber } from "@/components/ui/sliding-number";
import { Tracker } from "@/components/Tracker/Tracker";
import { AvatarStack } from "@/components/kibo-ui/avatar-stack";
import { Pill, PillIndicator } from "@/components/kibo-ui/pill";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { cn } from "@/lib/utils";
import {
  computeLocalBudget,
  computeLocalMetrics,
  DEFAULT_PLAYBOOKS,
  downloadSessionPatch,
  fetchBoardMetrics,
  fetchMergeCheck,
  fetchPlaybooks,
  getJson,
  getWebEngine,
  isActivelyRunning,
  isFailed,
  isQueuedOrBlocked,
  isVerified,
  isWebEngineMode,
  normalizeConfig,
  normalizePolicy,
  normalizeRepos,
  normalizeSessions,
  postJson,
  statusText,
  supportsV050,
  supportsV060,
  supportsV070,
  VERSION_URL,
  type BoardMetrics,
  type PlaybookTemplate,
  type Policy,
  type RepoInfo,
  type RuntimeConfig,
  type Session,
  type StatusFilter,
  type TabId,
  type ViewMode,
  type WebEngineStatus,
} from "./api";
import { BoardFilterBulkBar, BoardMetricsStrip, HeroVerifiedReceipt, ThreeLaneBoard } from "./board";
import { DagWaveGraph } from "./dag-graph";
import { DetailBody } from "./detail";
import { NewSession, type ComposerMode } from "./composer";
import { CommandPalette } from "./palette";
import { PrPreviewModal } from "./pr-modal";
import { PolicyTesterSection } from "./settings-policy";
import { useFleetStream } from "./stream";
import { onThisMachine, resultLine as resultLineOf, UpdateStrip, useUpdate } from "./update";

type Theme = "dark" | "light";
const THEME_KEY = "fleet-theme";
const TEST_NOTE = "Custom script mode: an executable path runs in place of a detected coding CLI.";

const AVATAR_SKINS = [
  "bg-av-sky-bg text-av-sky-fg",
  "bg-av-violet-bg text-av-violet-fg",
  "bg-av-rose-bg text-av-rose-fg",
  "bg-av-grey-bg text-av-grey-fg",
];

function agentAvatarLabel(s: Session, idx: number): string {
  const raw = (s.engine || s.agent || "").trim();
  if (/opencode/i.test(raw)) return "OC";
  if (/claude/i.test(raw)) return "CL";
  if (/codex/i.test(raw)) return "CX";
  if (s.test_mode || !raw || /agent\.sh|custom/i.test(raw)) return `S${idx + 1}`;
  return raw.slice(0, 2).toUpperCase();
}

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function App() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [lastGood, setLastGood] = useState<Date | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [requestedTab, setRequestedTab] = useState<TabId>("tr");
  const [openSeq, setOpenSeq] = useState(0);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [repoFilter, setRepoFilter] = useState("");
  const [engineFilter, setEngineFilter] = useState("");
  const [multiSelect, setMultiSelect] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inboxOpenDesktop, setInboxOpenDesktop] = useState(false);
  const [inboxOpenMobile, setInboxOpenMobile] = useState(false);
  const [inbox, setInbox] = useState<Session[]>([]);
  const [inboxErr, setInboxErr] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [playbooks, setPlaybooks] = useState<PlaybookTemplate[]>(DEFAULT_PLAYBOOKS);
  const [serverMetrics, setServerMetrics] = useState<BoardMetrics | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("board");
  const [prSession, setPrSession] = useState<Session | null>(null);

  const wide = useMediaQuery("(min-width: 1100px)");
  const md = useMediaQuery("(min-width: 768px)");
  const closeOverlaysForUpdate = useCallback(() => {
    setSettingsOpen(false);
    setInboxOpenDesktop(false);
    setInboxOpenMobile(false);
    setPaletteOpen(false);
    setPrSession(null);
  }, []);
  const upd = useUpdate(closeOverlaysForUpdate);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerModeRef = useRef<ComposerMode>("single");
  const composerPlaybookRef = useRef<PlaybookTemplate | null>(null);
  const modalClosedAtRef = useRef(0);
  const webEngine = isWebEngineMode();
  const localHost = onThisMachine();
  const hasServerV050 = useMemo(
    () => supportsV050(upd.version, policy),
    [upd.version, policy],
  );
  const hasServerV060 = useMemo(
    () => supportsV060(upd.version, policy),
    [upd.version, policy],
  );
  const hasServerV070 = useMemo(
    () => supportsV070(upd.version, policy),
    [upd.version, policy],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* in-memory fallback */
    }
  }, [theme]);

  const refresh = useCallback(async () => {
    const [polRaw, listRaw, inbRaw] = await Promise.all([
      getJson<unknown>("/api/policy"),
      getJson<unknown>("/api/sessions"),
      getJson<unknown>("/api/inbox"),
    ]);
    const pol = normalizePolicy(polRaw);
    if (pol) setPolicy(pol);
    const inb = normalizeSessions(inbRaw);
    if (inb) setInbox(inb);
    const list = normalizeSessions(listRaw);
    if (list) {
      setSessions(list);
      setLastGood(new Date());
      setUnreachable(false);
    } else {
      setUnreachable(true);
    }
  }, []);

  const refreshConfig = useCallback(async () => {
    const [cfgRaw, reposRaw] = await Promise.all([
      getJson<unknown>("/api/config"),
      getJson<unknown>("/api/repos"),
    ]);
    const cfg = normalizeConfig(cfgRaw);
    if (cfg) setConfig(cfg);
    const repoList = normalizeRepos(reposRaw);
    if (repoList.length) setRepos(repoList);
  }, []);

  const refreshPlaybooks = useCallback(async () => {
    const list = await fetchPlaybooks(hasServerV060);
    setPlaybooks(list);
  }, [hasServerV060]);

  useEffect(() => {
    void refresh();
    void refreshConfig();
  }, [refresh, refreshConfig]);

  useEffect(() => {
    void refreshPlaybooks();
  }, [refreshPlaybooks]);

  useEffect(() => {
    if (!sessions || !hasServerV060) return;
    let alive = true;
    const mp = policy?.max_parallel ?? config?.max_parallel ?? 4;
    void fetchBoardMetrics(sessions, mp, true, policy).then((m) => {
      if (alive) setServerMetrics(m);
    });
    return () => {
      alive = false;
    };
  }, [sessions, hasServerV060, policy, config?.max_parallel]);

  useEffect(() => {
    if (settingsOpen) void refreshConfig();
  }, [settingsOpen, refreshConfig]);

  const { streamState } = useFleetStream({
    enabled: hasServerV050,
    onRefresh: refresh,
    onPatchSessions: (updater) => {
      setSessions((prev) => {
        const next = updater(prev);
        if (next) {
          setInbox(next.filter((s) => s.bucket === "needs-you"));
          setLastGood(new Date());
          setUnreachable(false);
        }
        return next;
      });
    },
  });

  const all = sessions ?? [];

  const distinctProjects = useMemo(
    () => Array.from(new Set(all.map((s) => s.project).filter(Boolean))).sort(),
    [all],
  );
  const distinctEngines = useMemo(
    () =>
      Array.from(
        new Set(
          all
            .map((s) => (s.test_mode ? "custom" : s.engine || s.agent || ""))
            .filter(Boolean),
        ),
      ).sort(),
    [all],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((s) => {
      if (statusFilter === "needs-you" && s.bucket !== "needs-you") return false;
      if (statusFilter === "working" && !isActivelyRunning(s)) return false;
      if (statusFilter === "queued" && !isQueuedOrBlocked(s)) return false;
      if (statusFilter === "done" && s.bucket !== "done") return false;
      if (repoFilter && s.project !== repoFilter) return false;
      if (engineFilter) {
        const eng = s.test_mode ? "custom" : s.engine || s.agent || "";
        if (eng !== engineFilter) return false;
      }
      if (!q) return true;
      return [s.task, s.project, s.branch, s.id, s.engine, s.agent].some((v) =>
        (v || "").toLowerCase().includes(q),
      );
    });
  }, [all, query, statusFilter, repoFilter, engineFilter]);

  // Lane-ordered list for j/k keyboard navigation (Needs you -> Working -> Done)
  const navOrdered = useMemo(() => {
    const needs = shown.filter((s) => s.bucket === "needs-you");
    const working = shown.filter((s) => s.bucket === "working");
    const done = shown.filter((s) => s.bucket === "done");
    return [...needs, ...working, ...done];
  }, [shown]);

  const current = selected ? all.find((s) => s.id === selected) ?? null : null;
  useEffect(() => {
    if (selected && sessions && !current) setSelected(null);
  }, [selected, sessions, current]);

  // Prune removed sessions from bulk selection automatically
  useEffect(() => {
    if (bulkSelected.size === 0) return;
    const valid = new Set(all.map((s) => s.id));
    let changed = false;
    const next = new Set<string>();
    for (const id of bulkSelected) {
      if (valid.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setBulkSelected(next);
  }, [all, bulkSelected]);

  const openSession = useCallback((id: string, tab: TabId = "tr") => {
    setSelected(id);
    setRequestedTab(tab);
    setOpenSeq((n) => n + 1);
  }, []);

  const closeDetail = useCallback(() => {
    const id = selected;
    setSelected(null);
    requestAnimationFrame(() => {
      (document.querySelector<HTMLElement>(`[data-open="${id}"]`) ?? document.getElementById("lane-needs-h"))?.focus();
    });
  }, [selected]);

  const triggerComposer = useCallback((mode: ComposerMode, playbook: PlaybookTemplate | null = null) => {
    composerModeRef.current = mode;
    composerPlaybookRef.current = playbook;
    const desktopBtn = document.querySelector<HTMLButtonElement>('[data-thing="new-session-desktop"]');
    const mobileBtn = document.querySelector<HTMLButtonElement>('[data-thing="new-session-mobile"]');
    const btn = desktopBtn && desktopBtn.offsetParent !== null ? desktopBtn : mobileBtn ?? desktopBtn;
    btn?.click();
  }, []);

  // Global keyboard shortcuts: Cmd+K/Ctrl+K palette, / search, n new session, j/k sessions, t/d/r tabs, Escape close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
        return;
      }

      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      const inEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        Boolean(active?.isContentEditable);
      const dialogOpen = Boolean(document.querySelector('[role="dialog"]'));

      if (
        e.key === "Escape" &&
        !e.defaultPrevented &&
        Date.now() - modalClosedAtRef.current > 150 &&
        selected &&
        !dialogOpen &&
        !paletteOpen &&
        !prSession &&
        !settingsOpen
      ) {
        closeDetail();
        return;
      }

      if (inEditable || dialogOpen || paletteOpen || Boolean(prSession) || settingsOpen || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }

      if (e.key === "n") {
        e.preventDefault();
        triggerComposer("single");
        return;
      }

      if (e.key === "g") {
        e.preventDefault();
        setViewMode((cur) => (cur === "board" ? "dag" : "board"));
        return;
      }

      if (e.key === "j" || e.key === "k") {
        if (navOrdered.length === 0) return;
        e.preventDefault();
        const curIdx = selected ? navOrdered.findIndex((s) => s.id === selected) : -1;
        const nextIdx =
          e.key === "j"
            ? curIdx < 0
              ? 0
              : (curIdx + 1) % navOrdered.length
            : curIdx <= 0
              ? navOrdered.length - 1
              : curIdx - 1;
        const target = navOrdered[nextIdx];
        if (target) openSession(target.id, requestedTab);
        return;
      }

      if (e.key === "t" || e.key === "d" || e.key === "r") {
        const nextTab: TabId = e.key === "t" ? "tr" : e.key === "d" ? "df" : "rc";
        if (selected) {
          e.preventDefault();
          setRequestedTab(nextTab);
        } else if (navOrdered.length > 0) {
          e.preventDefault();
          openSession(navOrdered[0].id, nextTab);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, requestedTab, navOrdered, paletteOpen, prSession, settingsOpen, closeDetail, openSession, triggerComposer]);

  const verifiedAll = all.filter(isVerified);
  const verifiedCount = verifiedAll.length;
  const latestVerified = verifiedAll[0] ?? null;
  const needsAll = all.filter((s) => s.bucket === "needs-you");
  const workingActive = all.filter(isActivelyRunning);
  const queuedCount = all.filter(isQueuedOrBlocked).length;
  const needsCount = needsAll.length;
  const workingCount = all.filter((s) => s.bucket === "working").length;
  const maxParallel = policy?.max_parallel ?? config?.max_parallel ?? 4;
  const liveMetrics = useMemo(() => {
    const local: BoardMetrics = {
      ...computeLocalMetrics(all, maxParallel),
      budget: computeLocalBudget(all, policy),
    };
    if (serverMetrics && hasServerV060) {
      return serverMetrics;
    }
    return local;
  }, [all, maxParallel, policy, serverMetrics, hasServerV060]);
  const testMode = !webEngine && (policy?.default_agent_engine === "custom" || all.some((s) => s.test_mode));
  const hasActiveFilters = Boolean(query.trim() || statusFilter !== "all" || repoFilter || engineFilter);

  const focusNeedsLane = () => {
    requestAnimationFrame(() => {
      const el = document.getElementById("lane-needs-h");
      el?.scrollIntoView({ block: "nearest" });
      el?.focus();
    });
  };

  const retry = async (id: string) => {
    const e = await postJson(`/api/sessions/${id}/retry`);
    setInboxErr((m) => ({ ...m, [id]: e || "" }));
    if (e) toast.error(e);
    else toast.success("Retrying the session");
    void refresh();
  };

  const dismiss = async (id: string) => {
    const e = await postJson(`/api/sessions/${id}/dismiss`);
    if (e) {
      toast.error(e);
    } else {
      toast.success("Dismissed. Its log stays on disk.");
      if (selected === id) setSelected(null);
    }
    void refresh();
    focusNeedsLane();
  };

  const bulkRetry = async (ids: string[]) => {
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    let okCount = 0;
    let failCount = 0;
    for (const id of ids) {
      const e = await postJson(`/api/sessions/${id}/retry`);
      if (e) failCount++;
      else okCount++;
    }
    setBulkBusy(false);
    if (okCount > 0) toast.success(`Retried ${okCount} ${okCount === 1 ? "session" : "sessions"}${failCount ? ` (${failCount} failed)` : ""}.`);
    else if (failCount > 0) toast.error(`Failed to retry ${failCount} ${failCount === 1 ? "session" : "sessions"}.`);
    setBulkSelected(new Set());
    void refresh();
  };

  const bulkDismiss = async (ids: string[]) => {
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    let okCount = 0;
    let failCount = 0;
    for (const id of ids) {
      const e = await postJson(`/api/sessions/${id}/dismiss`);
      if (e) failCount++;
      else {
        okCount++;
        if (selected === id) setSelected(null);
      }
    }
    setBulkBusy(false);
    if (okCount > 0) toast.success(`Dismissed ${okCount} ${okCount === 1 ? "session" : "sessions"}${failCount ? ` (${failCount} failed)` : ""}.`);
    else if (failCount > 0) toast.error(`Could not dismiss ${failCount} ${failCount === 1 ? "session" : "sessions"}.`);
    setBulkSelected(new Set());
    void refresh();
  };

  const bulkMerge = async (ids: string[]) => {
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    let mergedCount = 0;
    let skippedConflicts = 0;
    let failedCount = 0;

    for (const id of ids) {
      const s = all.find((x) => x.id === id);
      if (!s || !isVerified(s) || s.status !== "done") continue;
      if (hasServerV050) {
        const chk = await fetchMergeCheck(s, true);
        if (!chk.clean) {
          skippedConflicts++;
          continue;
        }
      }
      const err = await postJson(`/api/sessions/${s.id}/merge`, { strategy: "merge" });
      if (err) failedCount++;
      else mergedCount++;
    }

    setBulkBusy(false);
    if (mergedCount > 0) {
      const notes = [
        skippedConflicts ? `${skippedConflicts} conflicted skipped` : "",
        failedCount ? `${failedCount} refused` : "",
      ].filter(Boolean);
      toast.success(
        `Merged ${mergedCount} verified ${mergedCount === 1 ? "session" : "sessions"}${notes.length ? ` (${notes.join(", ")})` : ""}.`,
      );
    } else if (skippedConflicts > 0) {
      toast.warning(`Skipped ${skippedConflicts} conflicted ${skippedConflicts === 1 ? "session" : "sessions"}; nothing merged.`);
    } else if (failedCount > 0) {
      toast.error(`Merge refused for ${failedCount} ${failedCount === 1 ? "session" : "sessions"}.`);
    }
    setBulkSelected(new Set());
    void refresh();
  };

  const mergeFromHero = async (s: Session) => {
    try {
      const r = await fetch(`/api/sessions/${s.id}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: "merge" }),
      });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        toast.success(`Merged ${s.branch} into ${j.branch || s.merge_target || "the target branch"}.`);
      } else {
        const j = await r.json().catch(() => ({}));
        toast.error(j.error || "The merge was refused.");
        openSession(s.id, "rc");
      }
    } catch {
      toast.error("Could not reach Fleet. Is it running?");
    }
    void refresh();
  };

  const toggleBulkCard = (id: string) => {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearAllFilters = () => {
    setQuery("");
    setStatusFilter("all");
    setRepoFilter("");
    setEngineFilter("");
  };

  const openPrPreview = useCallback(
    (s: Session) => {
      if (!wide) setSelected(null);
      setPrSession(s);
    },
    [wide],
  );

  const detailBody = current && (
    <DetailBody
      s={current}
      allSessions={all}
      requestedTab={requestedTab}
      openSeq={openSeq}
      supportsServerV050={hasServerV050}
      onClose={closeDetail}
      onOpenSession={openSession}
      onOpenPrPreview={openPrPreview}
      onChanged={refresh}
      onDismissed={() => void dismiss(current.id)}
    />
  );

  const streamLabel =
    streamState === "browser"
      ? "Browser engine"
      : streamState === "sse"
        ? "SSE live"
        : "Polling";

  return (
    <TooltipProvider>
      <div className="flex min-h-dvh flex-col bg-canvas text-ink">
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline bg-surface px-4 py-2.5 md:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ScanLine className="size-5 shrink-0 text-ink" strokeWidth={1.5} aria-hidden />
            <h1 className="font-heading text-[20px] font-medium tracking-[-0.025em] text-ink">Fleet</h1>
            {upd.version && (
              <a
                href={`${VERSION_URL}${upd.version}`}
                target="_blank"
                rel="noopener"
                className="hidden min-h-8 items-center rounded-chip bg-track px-2 font-mono text-xs text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
              >
                v{upd.version}
              </a>
            )}
            {localHost && upd.snap?.mode !== "off" && !webEngine && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Check for updates"
                      disabled={upd.checking}
                      onClick={upd.check}
                      className="hidden md:inline-flex"
                    />
                  }
                >
                  <RefreshCw
                    className={cn("size-3.5 text-ink-2 motion-reduce:animate-none", upd.checking && "animate-spin")}
                    strokeWidth={1.5}
                    aria-hidden
                  />
                </TooltipTrigger>
                <TooltipPopup>Check for updates</TooltipPopup>
              </Tooltip>
            )}
            {testMode && (
              <Badge variant="warning" size="sm" title={TEST_NOTE} className="shrink-0">
                custom script
              </Badge>
            )}
            {upd.hidden && upd.snap?.available && upd.dismissed && (
              <Button id="show-update" size="sm" variant="outline" onClick={upd.show} className="max-md:min-h-11 max-md:px-3">
                Show update
              </Button>
            )}
          </div>

          <InputGroup className="order-last flex h-11 w-full md:order-none md:ml-auto md:h-9 md:w-52 lg:w-64">
            <InputGroupAddon>
              <Search className="size-4 text-icon" strokeWidth={1.5} aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              type="search"
              aria-label="Search sessions"
              placeholder="Search sessions"
              className="max-md:[&_input]:!h-11 max-md:!h-11"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <InputGroupAddon align="inline-end">
              <Kbd>/</Kbd>
            </InputGroupAddon>
          </InputGroup>

          <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 md:ml-0">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    id="cmdk-open"
                    aria-label="Command palette"
                    onClick={() => setPaletteOpen(true)}
                    className="h-9 gap-1.5 px-2.5 max-md:size-11 max-md:px-0"
                  />
                }
              >
                <CommandIcon className="size-4 text-icon" strokeWidth={1.5} aria-hidden />
                <Kbd className="hidden lg:inline-flex">K</Kbd>
              </TooltipTrigger>
              <TooltipPopup>Command palette (Cmd+K)</TooltipPopup>
            </Tooltip>

            <InboxPopover
              open={inboxOpenDesktop}
              onOpenChange={setInboxOpenDesktop}
              inbox={inbox}
              errs={inboxErr}
              bulkBusy={bulkBusy}
              onView={(id) => openSession(id, "tr")}
              onRetry={retry}
              onBulkRetryAll={() => void bulkRetry(inbox.map((x) => x.id))}
              onBulkDismissAll={() => void bulkDismiss(inbox.map((x) => x.id))}
              onGo={focusNeedsLane}
              side="bottom"
              className="hidden md:inline-flex"
            />
            <span data-answers-via="4" className="hidden md:inline-flex">
              <NewSession
                policy={policy}
                sessions={all}
                playbooks={playbooks}
                supportsServerV050={hasServerV050}
                supportsServerV060={hasServerV060}
                initialModeRef={composerModeRef}
                initialPlaybookRef={composerPlaybookRef}
                thing="new-session-desktop"
                onPlaybooksChanged={() => void refreshPlaybooks()}
                onHanded={(s) => {
                  setSessions((prev) => (prev ? [s, ...prev.filter((x) => x.id !== s.id)] : [s]));
                  openSession(s.id, "tr");
                  void refresh();
                }}
                onHandedBatch={(created) => {
                  setSessions((prev) => {
                    const existing = prev ?? [];
                    const newIds = new Set(created.map((c) => c.id));
                    return [...created, ...existing.filter((x) => !newIds.has(x.id))];
                  });
                  if (created[0]) openSession(created[0].id, "tr");
                  void refresh();
                }}
              />
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon"
                    id="settings-open"
                    className="max-md:size-11"
                    aria-label="Engines and settings"
                    onClick={() => {
                      setInboxOpenDesktop(false);
                      setInboxOpenMobile(false);
                      setSettingsOpen(true);
                    }}
                  />
                }
              >
                <Cpu className="size-4" strokeWidth={1.5} aria-hidden />
              </TooltipTrigger>
              <TooltipPopup>Engines and settings</TooltipPopup>
            </Tooltip>
          </div>
        </header>

        <UpdateStrip u={upd} />

        <section
          aria-label="Scan"
          className="grid grid-cols-2 border-b border-hairline bg-surface/60 md:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.7fr)]"
        >
          <Reading label="Sessions" value={sessions ? all.length : null} className="max-md:border-b max-md:border-hairline" />
          <Reading
            label="Needs you"
            value={sessions ? needsCount : null}
            tone={needsCount ? "bad" : undefined}
            answers="1"
            className="max-md:border-b max-md:border-r-0 max-md:border-hairline"
          />
          <div className="min-w-0 border-r border-hairline max-md:border-b" data-answers="2">
            <div className="flex items-start justify-between gap-2 pr-4">
              <Reading label="Working" value={sessions ? workingCount : null} bare />
              {sessions && (
                <span
                  data-testid="concurrency-indicator"
                  className="mt-3 shrink-0 rounded-chip bg-track px-2 py-0.5 font-mono text-xs tabular-nums text-ink-2"
                >
                  {workingActive.length} / {maxParallel} slots
                </span>
              )}
            </div>
            <div className="flex min-h-7 items-center gap-2 px-4 pb-3">
              {workingActive.length >= 1 ? (
                <>
                  <AvatarStack size={24}>
                    {workingActive.slice(0, 4).map((s, idx) => (
                      <Avatar key={s.id} className="size-6 ring-2 ring-surface" title={`${s.engine || s.agent || "agent"}: ${s.task}`}>
                        <AvatarFallback className={cn("font-mono text-xs font-medium", AVATAR_SKINS[idx % AVATAR_SKINS.length])}>
                          {agentAvatarLabel(s, idx)}
                        </AvatarFallback>
                      </Avatar>
                    ))}
                  </AvatarStack>
                  <span className="min-w-0 truncate text-xs text-ink-2">
                    {workingActive.length === 1
                      ? `running ${workingActive[0].test_mode ? "custom script" : workingActive[0].engine || workingActive[0].agent || "agent"}`
                      : `${workingActive.length} running`}
                    {queuedCount > 0 ? ` · ${queuedCount} queued` : ""}
                  </span>
                </>
              ) : (
                <span className="text-xs text-ink-3">
                  {sessions ? (queuedCount > 0 ? `${queuedCount} queued` : "idle") : ""}
                </span>
              )}
            </div>
          </div>
          <Reading
            label="Verified"
            value={sessions ? verifiedCount : null}
            tone={verifiedCount ? "good" : undefined}
            className="max-md:border-b max-md:border-r-0 max-md:border-hairline"
          />
          <div className="col-span-2 flex min-w-0 flex-col justify-center gap-2 px-4 py-3 md:col-span-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-ink-2">Recent sessions</p>
              <div className="flex items-center gap-1.5">
                {sessions && (
                  <Pill variant="secondary" className="px-2 py-0.5 font-mono text-xs" data-testid="stream-pill">
                    <PillIndicator
                      variant={streamState === "sse" || streamState === "browser" ? "success" : "info"}
                      pulse={workingActive.length > 0 && streamState === "sse"}
                    />
                    <span>{streamLabel}</span>
                  </Pill>
                )}
                {sessions && (
                  <span className="font-mono text-xs text-ink-3 tabular-nums">{Math.min(all.length, 32)} / 32</span>
                )}
              </div>
            </div>
            {all.length ? (
              <Tracker
                className="h-6"
                data={all.slice(0, 32).map((s) => ({
                  key: s.id,
                  color: isVerified(s)
                    ? "bg-dot-green"
                    : isFailed(s)
                      ? "bg-unread"
                      : s.bucket === "needs-you"
                        ? "bg-dot-clay"
                        : isQueuedOrBlocked(s)
                          ? "bg-dot-amber"
                          : s.bucket === "working"
                            ? "bg-ink-3"
                            : "bg-track",
                  tooltip: `${s.task}: ${statusText(s)}`,
                }))}
              />
            ) : (
              <div className="flex h-6 items-center rounded-control bg-track px-2.5 font-mono text-xs text-ink-3">
                {sessions ? "No session outcomes yet" : ""}
              </div>
            )}
          </div>
        </section>

        {sessions !== null && <BoardMetricsStrip metrics={liveMetrics} />}

        {unreachable && (
          <p role="status" className="border-b border-hairline bg-pill-pro-bg px-4 py-2 text-sm text-destructive-foreground md:px-6">
            {lastGood
              ? `Cannot reach Fleet. Showing the last list from ${lastGood.toLocaleTimeString()}. Retrying.`
              : "Cannot reach Fleet. Retrying."}
          </p>
        )}

        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 pb-28 md:pb-0">
            {sessions !== null && (
              <HeroVerifiedReceipt
                latest={latestVerified}
                needsTop={needsAll[0] ?? null}
                workingCount={workingCount}
                totalCount={all.length}
                onInspect={openSession}
                onMerge={mergeFromHero}
                onRetry={retry}
              />
            )}

            {sessions !== null && (
              <BoardFilterBulkBar
                viewMode={viewMode}
                statusFilter={statusFilter}
                repoFilter={repoFilter}
                engineFilter={engineFilter}
                repos={distinctProjects}
                engines={distinctEngines}
                hasActiveFilters={hasActiveFilters}
                multiSelect={multiSelect}
                selectedIds={bulkSelected}
                visibleSessions={shown}
                bulkBusy={bulkBusy}
                onViewMode={setViewMode}
                onStatusFilter={setStatusFilter}
                onRepoFilter={setRepoFilter}
                onEngineFilter={setEngineFilter}
                onClearFilters={clearAllFilters}
                onToggleMultiSelect={() => {
                  setMultiSelect((prev) => {
                    if (prev) setBulkSelected(new Set());
                    return !prev;
                  });
                }}
                onSelectVisible={() => setBulkSelected(new Set(shown.map((s) => s.id)))}
                onClearSelection={() => setBulkSelected(new Set())}
                onBulkRetry={bulkRetry}
                onBulkDismiss={bulkDismiss}
                onBulkMerge={bulkMerge}
              />
            )}

            {viewMode === "dag" && sessions !== null ? (
              <DagWaveGraph
                sessions={shown}
                selectedId={selected}
                onOpen={(id) => openSession(id, "tr")}
                onNewBatch={() => triggerComposer("batch", null)}
              />
            ) : (
              <ThreeLaneBoard
                sessions={sessions === null ? null : shown}
                unreachable={unreachable}
                selected={selected}
                bulkMode={multiSelect}
                bulkSelected={bulkSelected}
                latestHeroId={latestVerified?.id ?? null}
                onOpen={openSession}
                onToggleBulk={toggleBulkCard}
                onRetry={retry}
                onDismiss={dismiss}
              />
            )}

            {sessions !== null && all.length > 0 && shown.length === 0 && (
              <p role="status" className="px-4 py-4 text-sm text-ink-2 md:px-6">
                No session matches {query.trim() ? `“${query.trim()}”` : "the active filters"}.
              </p>
            )}
          </main>

          {wide && current && (
            <aside
              aria-label="Session inspector"
              className="sticky top-14 hidden h-[calc(100dvh-56px)] w-[480px] shrink-0 overflow-y-auto border-l border-hairline bg-surface p-6 xl:w-[540px] min-[1100px]:block"
            >
              {detailBody}
            </aside>
          )}
        </div>

        {!wide && (
          <Drawer.Root open={Boolean(current)} onOpenChange={(o) => { if (!o) closeDetail(); }}>
            <Drawer.Portal>
              <Drawer.Overlay className="fixed inset-0 z-40 bg-canvas/60" />
              <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-panel border-t border-hairline bg-surface text-ink outline-none">
                <Drawer.Handle className="mx-auto mt-3 !h-1 !w-10 !bg-track" />
                <Drawer.Title className="sr-only">{current?.task || "Session details"}</Drawer.Title>
                <div className="flex-1 overflow-y-auto p-4">{detailBody}</div>
              </Drawer.Content>
            </Drawer.Portal>
          </Drawer.Root>
        )}

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          sessions={all}
          selectedSession={current}
          playbooks={playbooks}
          repos={repos}
          engines={distinctEngines}
          viewMode={viewMode}
          multiSelect={multiSelect}
          onViewMode={setViewMode}
          onOpenSession={openSession}
          onOpenPrPreview={openPrPreview}
          onSwitchTab={(t) => {
            setRequestedTab(t);
            if (!selected && navOrdered[0]) openSession(navOrdered[0].id, t);
          }}
          onNewSingle={() => triggerComposer("single", null)}
          onNewBatch={() => triggerComposer("batch", null)}
          onApplyPlaybook={(tpl) =>
            triggerComposer((tpl.tasks?.length ?? 1) > 1 ? "batch" : "single", tpl)
          }
          onOpenSettings={() => setSettingsOpen(true)}
          onToggleMultiSelect={() => {
            setMultiSelect((prev) => {
              if (prev) setBulkSelected(new Set());
              return !prev;
            });
          }}
          onFocusSearch={() => searchRef.current?.focus()}
          onFilterStatus={setStatusFilter}
          onFilterRepo={setRepoFilter}
          onFilterEngine={setEngineFilter}
          onClearFilters={clearAllFilters}
          onDownloadPatch={(s) => {
            void downloadSessionPatch(s, hasServerV050).then((res) => {
              if (res.ok) toast.success(`Downloaded ${res.filename}`);
              else toast.error(res.error || "Could not download patch.");
            });
          }}
          onRetrySession={(id) => void retry(id)}
        />

        <Drawer.Root direction="right" open={settingsOpen} onOpenChange={setSettingsOpen}>
          <Drawer.Portal>
            <Drawer.Overlay className="fixed inset-0 z-40 bg-canvas/60" />
            <Drawer.Content
              id="settings"
              className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[460px] flex-col border-l border-hairline bg-surface text-ink outline-none"
            >
              <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
                <Drawer.Title className="font-heading text-xl font-medium text-ink">Engines and settings</Drawer.Title>
                <Drawer.Close asChild>
                  <Button variant="ghost" size="icon" className="max-md:size-11" aria-label="Close settings">
                    <X className="size-4" strokeWidth={1.5} aria-hidden />
                  </Button>
                </Drawer.Close>
              </div>
              <div className="flex-1 space-y-6 overflow-y-auto p-5">
                <section className="border-b border-hairline pb-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-medium text-ink">Appearance</h3>
                      <p className="text-xs text-ink-3">Light or dark theme, saved in this browser.</p>
                    </div>
                    <SegmentedControl aria-label="Theme" size="sm" id="themeBtn">
                      {(["light", "dark"] as const).map((t) => (
                        <SegmentedControlItem
                          key={t}
                          aria-pressed={theme === t}
                          data-checked={theme === t ? "" : undefined}
                          onClick={() => setTheme(t)}
                          aria-label={t === "light" ? "Light" : "Dark"}
                          className="gap-1.5 px-2.5 max-md:!h-11 max-md:!min-w-11"
                        >
                          {t === "light" ? (
                            <Sun className="size-4" strokeWidth={1.5} aria-hidden />
                          ) : (
                            <Moon className="size-4" strokeWidth={1.5} aria-hidden />
                          )}
                          <span>{t === "light" ? "Light" : "Dark"}</span>
                        </SegmentedControlItem>
                      ))}
                    </SegmentedControl>
                  </div>
                </section>

                <Drawer.Description className="text-sm leading-relaxed text-ink-2">
                  {policy
                    ? `Up to ${policy.max_parallel} sessions run in parallel. Any agent or check exceeding ${policy.timeout_secs}s returns to Needs you. Policy source: ${policy.source}.${policy.model ? ` OpenCode model: ${policy.model}.` : ""} ${policy.default_agent ? `Default agent: ${policy.default_agent_engine === "custom" ? "custom script" : policy.default_agent}.` : "No default agent is set."}`
                    : "Loading policy rules..."}
                </Drawer.Description>

                <section>
                  <h3 className="mb-2 text-sm font-medium text-ink">
                    {webEngine ? "Browser Worktree Engine" : "CLI engines detected on PATH"}
                  </h3>
                  <ul className="divide-y divide-hairline rounded-card border border-hairline bg-canvas">
                    {(policy?.agents ?? []).length === 0 && (
                      <li className="p-3 text-sm text-ink-2">No CLI agents detected on PATH.</li>
                    )}
                    {(policy?.agents ?? []).map((a) => (
                      <li key={a.name} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                        <div className="min-w-0">
                          <span className="block truncate font-mono text-ink">{a.name}</span>
                          {a.path && <span className="block truncate font-mono text-xs text-ink-3">{a.path}</span>}
                        </div>
                        <Pill variant={a.found ? "success" : "secondary"} className="shrink-0 px-2.5 py-0.5 text-xs">
                          <PillIndicator variant={a.found ? "success" : "warning"} />
                          <span>{a.found ? (webEngine ? "active" : "found on this machine") : "not installed"}</span>
                        </Pill>
                      </li>
                    ))}
                  </ul>
                  {testMode && <p className="mt-2 text-xs text-ink-3">{TEST_NOTE}</p>}
                </section>

                <PolicyTesterSection
                  policy={policy}
                  config={config}
                  repos={repos}
                  sessions={all}
                  metrics={liveMetrics}
                  settingsOpen={settingsOpen}
                  supportsServerV050={hasServerV050}
                  supportsServerV070={hasServerV070}
                  canPrune={localHost && !webEngine}
                  onPruned={refresh}
                />

                {localHost && !webEngine && (
                  <EngineConfigSection
                    policy={policy}
                    config={config}
                    onSaved={() => {
                      void refreshConfig();
                      void refresh();
                    }}
                  />
                )}

                {webEngine && (
                  <WebEngineSettingsSection
                    onChanged={() => {
                      void refreshConfig();
                      void refresh();
                    }}
                  />
                )}

                <section className="border-t border-hairline pt-5">
                  <h3 className="mb-2 text-sm font-medium text-ink">Version and updates</h3>
                  <div className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
                    {upd.version && <span className="font-mono text-ink">Fleet {upd.version}</span>}
                    {localHost && !webEngine ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="max-md:min-h-11 max-md:px-4"
                        onClick={upd.check}
                        disabled={upd.checking || upd.snap?.mode === "off"}
                      >
                        {upd.checking ? "Checking..." : "Check for updates"}
                      </Button>
                    ) : webEngine ? (
                      <span className="text-xs text-ink-2">
                        Running in-browser git worktree, DAG scheduler, and Blob Web Worker check engine.
                      </span>
                    ) : (
                      <span className="text-xs text-ink-2">To update, open Fleet on the computer it runs on.</span>
                    )}
                  </div>
                  {!webEngine && (
                    <p className="mt-2 text-sm text-ink-2 [overflow-wrap:anywhere]" role="status">
                      {upd.snap && !upd.live ? resultLineOf(upd.snap) : upd.live}
                    </p>
                  )}
                </section>
              </div>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>

        <nav
          aria-label="Board actions"
          className="fixed inset-x-0 bottom-0 z-30 flex gap-2 border-t border-hairline bg-surface px-4 pt-2 md:hidden"
          style={{ paddingBottom: "max(8px, env(safe-area-inset-bottom))" }}
        >
          <InboxPopover
            open={inboxOpenMobile}
            onOpenChange={setInboxOpenMobile}
            inbox={inbox}
            errs={inboxErr}
            bulkBusy={bulkBusy}
            onView={(id) => openSession(id, "tr")}
            onRetry={retry}
            onBulkRetryAll={() => void bulkRetry(inbox.map((x) => x.id))}
            onBulkDismissAll={() => void bulkDismiss(inbox.map((x) => x.id))}
            onGo={focusNeedsLane}
            side="top"
            className="h-11 flex-1 justify-center"
          />
          <span data-answers-via="4" className="flex flex-1">
            <NewSession
              policy={policy}
              sessions={all}
              playbooks={playbooks}
              supportsServerV050={hasServerV050}
              supportsServerV060={hasServerV060}
              initialModeRef={composerModeRef}
              initialPlaybookRef={composerPlaybookRef}
              thing="new-session-mobile"
              onPlaybooksChanged={() => void refreshPlaybooks()}
              onHanded={(s) => {
                setSessions((prev) => (prev ? [s, ...prev.filter((x) => x.id !== s.id)] : [s]));
                openSession(s.id, "tr");
                void refresh();
              }}
              onHandedBatch={(created) => {
                setSessions((prev) => {
                  const existing = prev ?? [];
                  const newIds = new Set(created.map((c) => c.id));
                  return [...created, ...existing.filter((x) => !newIds.has(x.id))];
                });
                if (created[0]) openSession(created[0].id, "tr");
                void refresh();
              }}
              className="h-11 flex-1 justify-center"
            />
          </span>
        </nav>

        <PrPreviewModal
          session={prSession}
          supportsServerV070={hasServerV070}
          onClose={() => {
            modalClosedAtRef.current = Date.now();
            setPrSession(null);
          }}
          onCreated={refresh}
        />

        <Toaster
          position={md ? "bottom-right" : "top-center"}
          theme={theme}
          style={
            {
              "--normal-bg": "var(--surface)",
              "--normal-text": "var(--ink)",
              "--normal-border": "var(--hairline)",
              "--border-radius": "10px",
              fontSize: "14px",
            } as React.CSSProperties
          }
        />
      </div>
    </TooltipProvider>
  );
}

function Reading({
  label,
  value,
  tone,
  bare,
  answers,
  className,
}: {
  label: string;
  value: number | null;
  tone?: "bad" | "good";
  bare?: boolean;
  answers?: string;
  className?: string;
}) {
  return (
    <div data-answers={answers} className={cn("px-4 py-3", !bare && "border-r border-hairline last:border-r-0", className)}>
      <p className="text-sm text-ink-2">{label}</p>
      <div
        className={cn(
          "mt-1 border-l-2 font-mono text-[26px] font-medium leading-none tabular-nums",
          tone === "bad"
            ? "border-unread pl-2 text-destructive-foreground"
            : tone === "good"
              ? "border-dot-green pl-2 text-ink"
              : "border-transparent pl-0 text-ink",
        )}
      >
        {value === null ? (
          <span className="block h-7 w-10 rounded-control bg-track" aria-label="not loaded yet" />
        ) : (
          <SlidingNumber value={value} />
        )}
      </div>
    </div>
  );
}

function EngineConfigSection({
  policy,
  config,
  onSaved,
}: {
  policy: Policy | null;
  config: RuntimeConfig | null;
  onSaved: () => void;
}) {
  const [defaultAgent, setDefaultAgent] = useState("");
  const [opencodeModel, setOpencodeModel] = useState("");
  const [claudeModel, setClaudeModel] = useState("");
  const [codexModel, setCodexModel] = useState("");
  const [maxParallelInput, setMaxParallelInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!config) return;
    setDefaultAgent(config.default_agent && !config.default_agent.includes("/") ? config.default_agent : "");
    setOpencodeModel(config.opencode_model ?? "");
    setClaudeModel(config.claude_model ?? "");
    setCodexModel(config.codex_model ?? "");
    setMaxParallelInput(config.max_parallel ? String(config.max_parallel) : "");
  }, [config]);

  const foundAgents = (policy?.agents ?? []).filter((a) => a.found).map((a) => a.name);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr("");
    const payload: Record<string, string | number | null> = {
      opencode_model: opencodeModel.trim() || null,
      claude_model: claudeModel.trim() || null,
      codex_model: codexModel.trim() || null,
    };
    if (defaultAgent) payload.default_agent = defaultAgent;
    const mp = Number.parseInt(maxParallelInput.trim(), 10);
    if (Number.isFinite(mp) && mp >= 1) payload.max_parallel_agents = mp;
    const error = await postJson("/api/config", payload);
    setSaving(false);
    if (error) {
      setErr(error);
      toast.error(error);
    } else {
      toast.success("Engine settings saved.");
      onSaved();
    }
  };

  return (
    <section className="border-t border-hairline pt-5">
      <h3 className="mb-1 text-sm font-medium text-ink">Engine and model routing</h3>
      <p className="mb-3 text-xs leading-relaxed text-ink-3">
        Saved to Fleet’s data folder and applied immediately to new runs. Leave a model blank to inherit FLEET_MODEL or policies.rn.
      </p>
      <form onSubmit={save} className="space-y-3">
        {foundAgents.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-ink-2">Default engine</p>
            <SegmentedControl aria-label="Default engine" size="sm">
              {foundAgents.map((name) => (
                <SegmentedControlItem
                  key={name}
                  aria-pressed={defaultAgent === name}
                  data-checked={defaultAgent === name ? "" : undefined}
                  onClick={() => setDefaultAgent(name)}
                  className="max-md:!min-h-11"
                >
                  {name}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </div>
        )}
        <div className="space-y-1.5">
          <label htmlFor="cfg-opencode-model" className="block text-xs font-medium text-ink-2">
            OpenCode model
          </label>
          <InputGroup>
            <InputGroupInput
              id="cfg-opencode-model"
              value={opencodeModel}
              onChange={(e) => setOpencodeModel(e.target.value)}
              placeholder={config?.effective_models?.opencode || policy?.model || "opencode/deepseek-v4.1-flash-free"}
              autoComplete="off"
              className="font-mono text-xs max-md:!h-11"
            />
          </InputGroup>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="cfg-claude-model" className="block text-xs font-medium text-ink-2">
            Claude model (optional)
          </label>
          <InputGroup>
            <InputGroupInput
              id="cfg-claude-model"
              value={claudeModel}
              onChange={(e) => setClaudeModel(e.target.value)}
              placeholder={config?.effective_models?.claude || "engine default"}
              autoComplete="off"
              className="font-mono text-xs max-md:!h-11"
            />
          </InputGroup>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="cfg-codex-model" className="block text-xs font-medium text-ink-2">
            Codex model (optional)
          </label>
          <InputGroup>
            <InputGroupInput
              id="cfg-codex-model"
              value={codexModel}
              onChange={(e) => setCodexModel(e.target.value)}
              placeholder={config?.effective_models?.codex || "engine default"}
              autoComplete="off"
              className="font-mono text-xs max-md:!h-11"
            />
          </InputGroup>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="cfg-max-parallel" className="block text-xs font-medium text-ink-2">
            Max parallel agents
          </label>
          <InputGroup>
            <InputGroupInput
              id="cfg-max-parallel"
              type="number"
              min={1}
              max={64}
              value={maxParallelInput}
              onChange={(e) => setMaxParallelInput(e.target.value)}
              placeholder={String(policy?.max_parallel ?? 4)}
              autoComplete="off"
              className="font-mono text-xs tabular-nums max-md:!h-11"
            />
          </InputGroup>
        </div>
        {err && (
          <p role="alert" className="text-xs text-destructive-foreground">
            {err}
          </p>
        )}
        <Button type="submit" size="sm" variant="outline" disabled={saving} className="max-md:min-h-11 max-md:px-4">
          {saving ? "Saving..." : "Save engine settings"}
        </Button>
      </form>
    </section>
  );
}

function WebEngineSettingsSection({ onChanged }: { onChanged: () => void }) {
  const handle = getWebEngine();
  const [status, setStatus] = useState<WebEngineStatus | null>(() => handle?.getStatus() ?? null);
  const [localUrl, setLocalUrl] = useState(status?.localUrl || "http://127.0.0.1:8471");
  const [byokUrl, setByokUrl] = useState(status?.byokBaseUrl || "https://api.openai.com/v1");
  const [byokModel, setByokModel] = useState(status?.byokModel || "gpt-4.1-mini");
  const [byokKey, setByokKey] = useState("");
  const [connBusy, setConnBusy] = useState(false);
  const [connMsg, setConnMsg] = useState("");

  if (!handle || !status) return null;

  const connectLocal = async (enable: boolean) => {
    setConnBusy(true);
    setConnMsg("");
    const res = await handle.setLocalConnection(localUrl.trim() || "http://127.0.0.1:8471", enable);
    setConnBusy(false);
    setStatus(handle.getStatus());
    if (res.ok) {
      toast.success(enable ? "Connected to local Fleet." : "Switched to Browser Worktree Engine.");
      onChanged();
    } else {
      setConnMsg(res.error || "Could not reach local Fleet.");
      toast.error(res.error || "Could not reach local Fleet.");
    }
  };

  const saveByok = (e: React.FormEvent) => {
    e.preventDefault();
    const next = handle.setByok({
      baseUrl: byokUrl.trim() || "https://api.openai.com/v1",
      model: byokModel.trim() || "gpt-4.1-mini",
      apiKey: byokKey.trim() || undefined,
    });
    setStatus(next);
    setByokKey("");
    toast.success(next.byokConfigured ? "BYOK agent saved in sessionStorage for this tab." : "BYOK endpoint settings updated.");
    onChanged();
  };

  const clearByok = () => {
    const next = handle.setByok({ baseUrl: byokUrl, model: byokModel, clearKey: true });
    setStatus(next);
    setByokKey("");
    toast.success("API key cleared from sessionStorage.");
    onChanged();
  };

  const resetRepo = async () => {
    await handle.resetWorkspace();
    toast.success("Browser git worktrees reset to clean main commits.");
    onChanged();
  };

  return (
    <>
      <section className="space-y-3 border-t border-hairline pt-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <Plug className="size-4 text-icon" strokeWidth={1.5} aria-hidden />
            <span>Connect to local Fleet</span>
          </h3>
          <Pill variant={status.mode === "local" ? "success" : "secondary"} className="px-2 py-0.5 text-xs">
            <PillIndicator variant={status.mode === "local" ? "success" : "info"} />
            <span>{status.mode === "local" ? "local binary" : "browser engine"}</span>
          </Pill>
        </div>
        <p className="text-xs leading-relaxed text-ink-3">
          Run real CLI agents on your machine with <span className="font-mono text-ink-2">fleet</span>, or keep running real git worktrees, DAG dependencies, and Blob Web Worker check pipelines directly in this browser.
        </p>
        <div className="space-y-1.5">
          <label htmlFor="local-fleet-url" className="block text-xs font-medium text-ink-2">
            Local Fleet address
          </label>
          <InputGroup>
            <InputGroupInput
              id="local-fleet-url"
              value={localUrl}
              onChange={(e) => setLocalUrl(e.target.value)}
              placeholder="http://127.0.0.1:8471"
              className="font-mono text-xs max-md:!h-11"
            />
          </InputGroup>
        </div>
        <div className="flex flex-wrap gap-2">
          {status.mode === "local" ? (
            <Button size="sm" variant="outline" disabled={connBusy} onClick={() => void connectLocal(false)} className="max-md:min-h-11 max-md:px-4">
              Use browser engine
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={connBusy} onClick={() => void connectLocal(true)} className="max-md:min-h-11 max-md:px-4">
              {connBusy ? "Connecting..." : "Connect to local Fleet"}
            </Button>
          )}
          <a
            href={localUrl.trim() || "http://127.0.0.1:8471"}
            target="_blank"
            rel="noopener"
            className="inline-flex h-8 items-center rounded-control border border-hairline px-3 text-xs font-medium text-ink-2 hover:bg-raised hover:text-ink max-md:min-h-11"
          >
            Open local UI
          </a>
        </div>
        {connMsg && (
          <p role="status" className="text-xs leading-relaxed text-destructive-foreground [overflow-wrap:anywhere]">
            {connMsg}
          </p>
        )}
      </section>

      <section className="space-y-3 border-t border-hairline pt-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <KeyRound className="size-4 text-icon" strokeWidth={1.5} aria-hidden />
            <span>BYOK coding agent (optional)</span>
          </h3>
          <Pill variant={status.byokConfigured ? "success" : "secondary"} className="px-2 py-0.5 text-xs">
            <PillIndicator variant={status.byokConfigured ? "success" : "info"} />
            <span>{status.byokConfigured ? "key in session" : "built-in patcher"}</span>
          </Pill>
        </div>
        <p className="text-xs leading-relaxed text-ink-3">
          Optionally connect any OpenAI-compatible API so dispatched tasks generate real file patches via your model. Keys stay strictly in sessionStorage and clear when you close this tab.
        </p>
        <form onSubmit={saveByok} className="space-y-2.5">
          <div className="space-y-1">
            <label htmlFor="byok-url" className="block text-xs font-medium text-ink-2">
              API base URL
            </label>
            <InputGroup>
              <InputGroupInput id="byok-url" value={byokUrl} onChange={(e) => setByokUrl(e.target.value)} className="font-mono text-xs max-md:!h-11" />
            </InputGroup>
          </div>
          <div className="space-y-1">
            <label htmlFor="byok-model" className="block text-xs font-medium text-ink-2">
              Model
            </label>
            <InputGroup>
              <InputGroupInput id="byok-model" value={byokModel} onChange={(e) => setByokModel(e.target.value)} className="font-mono text-xs max-md:!h-11" />
            </InputGroup>
          </div>
          <div className="space-y-1">
            <label htmlFor="byok-key" className="block text-xs font-medium text-ink-2">
              API key (sessionStorage only)
            </label>
            <InputGroup>
              <InputGroupInput
                id="byok-key"
                type="password"
                value={byokKey}
                onChange={(e) => setByokKey(e.target.value)}
                placeholder={status.byokConfigured ? "Key stored for this tab (enter new to replace)" : "sk-..."}
                autoComplete="off"
                className="font-mono text-xs max-md:!h-11"
              />
            </InputGroup>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="outline" className="max-md:min-h-11 max-md:px-4">
              Save BYOK settings
            </Button>
            {status.byokConfigured && (
              <Button type="button" size="sm" variant="ghost" onClick={clearByok} className="max-md:min-h-11 max-md:px-4">
                Clear key
              </Button>
            )}
          </div>
        </form>
      </section>

      <section className="border-t border-hairline pt-5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-ink">Browser git workspace</h3>
            <p className="text-xs text-ink-3">Stored locally in IndexedDB across reloads.</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void resetRepo()} className="shrink-0 max-md:min-h-11 max-md:px-4">
            <RotateCcw className="size-3.5" strokeWidth={1.5} aria-hidden />Reset
          </Button>
        </div>
      </section>
    </>
  );
}

function InboxPopover({
  open,
  onOpenChange,
  inbox,
  errs,
  bulkBusy,
  onView,
  onRetry,
  onBulkRetryAll,
  onBulkDismissAll,
  onGo,
  side,
  className,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  inbox: Session[];
  errs: Record<string, string>;
  bulkBusy: boolean;
  onView: (id: string) => void;
  onRetry: (id: string) => void;
  onBulkRetryAll: () => void;
  onBulkDismissAll: () => void;
  onGo: () => void;
  side: "top" | "bottom";
  className?: string;
}) {
  const n = inbox.length;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        aria-label={`Needs you, ${n}`}
        className={cn(
          "inline-flex h-9 cursor-pointer items-center gap-2 whitespace-nowrap rounded-control border px-3 text-sm font-medium outline-none transition-colors duration-(--dur-press) ease-(--ease-house) focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11",
          n ? "border-unread text-destructive-foreground hover:bg-pill-pro-bg" : "border-hairline text-ink hover:bg-raised",
          className,
        )}
      >
        <span>Needs you</span>
        <span
          className={cn(
            "rounded-chip px-1.5 py-0.5 font-mono text-xs tabular-nums",
            n ? "bg-pill-pro-bg text-destructive-foreground" : "bg-track text-ink-2",
          )}
        >
          {n}
        </span>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={side === "top" ? "center" : "end"}
        sideOffset={8}
        className="z-30 w-full max-w-[380px] rounded-dialog border border-hairline bg-surface p-0 text-ink shadow-lift"
      >
        <div className="p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-heading text-lg font-medium text-ink">Needs you</h2>
            {n > 0 && (
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={bulkBusy}
                  onClick={() => {
                    onOpenChange(false);
                    onBulkRetryAll();
                  }}
                  className="h-7 px-2 text-xs max-md:min-h-11"
                >
                  Retry all
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={bulkBusy}
                  onClick={() => {
                    onOpenChange(false);
                    onBulkDismissAll();
                  }}
                  className="h-7 px-2 text-xs max-md:min-h-11"
                >
                  Dismiss all
                </Button>
              </div>
            )}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">
            Sessions that need a person: a failed check, a refused merge, a stopped or timed-out run.
          </p>
        </div>
        <div className="max-h-[55dvh] overflow-y-auto border-t border-hairline">
          {n === 0 && (
            <p className="p-4 text-sm text-ink-2">
              Nothing needs you right now. Failed checks and stopped runs appear here with the reason.
            </p>
          )}
          {inbox.map((s) => (
            <div key={s.id} className="border-t border-hairline p-4 first:border-t-0">
              <p className="font-medium text-ink [overflow-wrap:anywhere]">{s.task}</p>
              <p
                className={cn(
                  "mt-1 text-sm leading-relaxed [overflow-wrap:anywhere]",
                  isFailed(s) ? "text-destructive-foreground" : "text-info-foreground",
                )}
              >
                {s.reason || "needs you"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="max-md:min-h-11 max-md:px-3.5"
                  onClick={() => {
                    onOpenChange(false);
                    onView(s.id);
                  }}
                >
                  View session
                </Button>
                <Button size="sm" className="max-md:min-h-11 max-md:px-3.5" onClick={() => onRetry(s.id)}>
                  Retry
                </Button>
              </div>
              {errs[s.id] && (
                <p role="alert" className="mt-2 text-sm text-destructive-foreground [overflow-wrap:anywhere]">
                  {errs[s.id]}
                </p>
              )}
            </div>
          ))}
        </div>
        <div className="border-t border-hairline p-3 text-right">
          <Button
            size="sm"
            variant="ghost"
            className="max-md:min-h-11 max-md:px-3.5"
            onClick={() => {
              onOpenChange(false);
              onGo();
            }}
          >
            Go to Needs you
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
