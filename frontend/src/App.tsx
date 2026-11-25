import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import {
  Command as CommandIcon,
  Cpu,
  GitMerge,
  KeyRound,
  LayoutGrid,
  Moon,
  Network,
  PanelLeft,
  PanelRight,
  Plug,
  RefreshCw,
  RotateCcw,
  ScanLine,
  Sparkles,
  Sun,
} from "lucide-react";
import { enter, glide } from "./motion";
import {
  Badge,
  Button,
  Drawer,
  Input,
  Kbd,
  PopoverPanel,
  SegmentedControl,
  ToastRegion,
  cn,
  toast,
} from "./ui";
import {
  batchMergeVerifiedWave,
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
  isVerified,
  isWebEngineMode,
  normalizeConfig,
  normalizePolicy,
  normalizeRepos,
  normalizeSessions,
  postJson,
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
import { BoardMetricsStrip, GoalLaunchpad, RightInspectorRail, SessionInboxRail } from "./board";
import { DagWaveGraph } from "./dag-graph";
import { DetailBody } from "./detail";
import { useMergeCheck } from "./diff";
import { NewSession, type ComposerMode } from "./composer";
import { CommandPalette } from "./palette";
import { PrPreviewModal } from "./pr-modal";
import { PolicyTesterSection } from "./settings-policy";
import { useFleetStream } from "./stream";
import { onThisMachine, resultLine as resultLineOf, UpdateStrip, useUpdate } from "./update";

type Theme = "dark" | "light";
type MobilePane = "inbox" | "workspace" | "inspector";
const THEME_KEY = "fleet-theme";
const TEST_NOTE = "Custom script mode: an executable path runs in place of a detected coding CLI.";

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : true,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export function App() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [lastGood, setLastGood] = useState<Date | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [launchpadOpen, setLaunchpadOpen] = useState(false);
  const [requestedTab, setRequestedTab] = useState<TabId>("tr");
  const [openSeq, setOpenSeq] = useState(0);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [mobilePane, setMobilePane] = useState<MobilePane>("inbox");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [repoFilter, setRepoFilter] = useState("");
  const [engineFilter, setEngineFilter] = useState("");
  const [multiSelect, setMultiSelect] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [waveMergeBusy, setWaveMergeBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inboxOpenDesktop, setInboxOpenDesktop] = useState(false);
  const [inbox, setInbox] = useState<Session[]>([]);
  const [inboxErr, setInboxErr] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [playbooks, setPlaybooks] = useState<PlaybookTemplate[]>(DEFAULT_PLAYBOOKS);
  const [serverMetrics, setServerMetrics] = useState<BoardMetrics | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("board");
  const [prSession, setPrSession] = useState<Session | null>(null);
  const [composerSignal, setComposerSignal] = useState(0);

  const md = useMedia("(min-width: 768px)");
  const xl = useMedia("(min-width: 1180px)");
  const initialAutoPickedRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerModeRef = useRef<ComposerMode>("single");
  const composerPlaybookRef = useRef<PlaybookTemplate | null>(null);
  const modalClosedAtRef = useRef(0);

  const closeOverlaysForUpdate = useCallback(() => {
    setSettingsOpen(false);
    setInboxOpenDesktop(false);
    setPaletteOpen(false);
    setPrSession(null);
  }, []);

  const upd = useUpdate(closeOverlaysForUpdate);
  const webEngine = isWebEngineMode();
  const localHost = onThisMachine();
  const hasServerV050 = useMemo(() => supportsV050(upd.version, policy), [upd.version, policy]);
  const hasServerV060 = useMemo(() => supportsV060(upd.version, policy), [upd.version, policy]);
  const hasServerV070 = useMemo(() => supportsV070(upd.version, policy), [upd.version, policy]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.world = "codex";
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
        }
        return next;
      });
    },
  });

  const all = sessions ?? [];
  const hasRunning = useMemo(() => all.some(isActivelyRunning), [all]);
  const verifiedDoneSessions = useMemo(
    () => all.filter((s) => s.status === "done" && isVerified(s)),
    [all],
  );

  useEffect(() => {
    if (!hasRunning) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasRunning]);

  // Auto-open the top active/needs-you/verified run on first load so desktop opens directly into work.
  useEffect(() => {
    if (initialAutoPickedRef.current || !sessions || sessions.length === 0) return;
    initialAutoPickedRef.current = true;
    if (!selected) {
      const top =
        sessions.find((s) => s.bucket === "needs-you") ??
        sessions.find(isActivelyRunning) ??
        sessions.find(isVerified) ??
        sessions[0];
      if (top) setSelected(top.id);
    }
  }, [sessions, selected]);

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
      if (statusFilter === "queued" && (s.bucket !== "working" || isActivelyRunning(s))) return false;
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

  const { mergeCheck, checkingMerge, recheckMerge } = useMergeCheck(current, hasServerV050);

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
    setLaunchpadOpen(false);
    setViewMode("board");
    setRequestedTab(tab);
    setOpenSeq((n) => n + 1);
    setMobilePane("workspace");
  }, []);

  const closeDetail = useCallback(() => {
    const id = selected;
    setSelected(null);
    setLaunchpadOpen(true);
    setMobilePane("inbox");
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-open="${id}"]`)?.focus();
    });
  }, [selected]);

  const triggerComposer = useCallback((mode: ComposerMode, playbook: PlaybookTemplate | null = null) => {
    composerModeRef.current = mode;
    composerPlaybookRef.current = playbook;
    setComposerSignal((n) => n + 1);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setRightOpen((prev) => !prev);
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
        !dialogOpen &&
        !paletteOpen &&
        !prSession &&
        !settingsOpen &&
        inboxOpenDesktop
      ) {
        setInboxOpenDesktop(false);
        return;
      }

      if (inEditable || dialogOpen || paletteOpen || Boolean(prSession) || settingsOpen || e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }

      if (e.key === "/") {
        e.preventDefault();
        if (leftOpen && md) {
          searchRef.current?.focus();
        } else {
          if (!leftOpen) setLeftOpen(true);
          if (!md) setMobilePane("inbox");
          setTimeout(() => searchRef.current?.focus(), 20);
        }
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
          setLaunchpadOpen(false);
          setViewMode("board");
          setRequestedTab(nextTab);
        } else if (navOrdered.length > 0) {
          e.preventDefault();
          openSession(navOrdered[0].id, nextTab);
        }
        return;
      }
      if (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4") {
        e.preventDefault();
        const map: Record<string, StatusFilter> = {
          "1": "all",
          "2": "needs-you",
          "3": "working",
          "4": "done",
        };
        setStatusFilter(map[e.key]);
        if (!leftOpen && md) setLeftOpen(true);
        if (!md) setMobilePane("inbox");
        return;
      }
      if (e.key === "[" || e.key === "]") {
        if (inbox.length === 0) return;
        e.preventDefault();
        const curIdx = selected ? inbox.findIndex((s) => s.id === selected) : -1;
        const nextIdx =
          e.key === "]"
            ? curIdx < 0
              ? 0
              : (curIdx + 1) % inbox.length
            : curIdx <= 0
              ? inbox.length - 1
              : curIdx - 1;
        const target = inbox[nextIdx];
        if (target) openSession(target.id, requestedTab);
        return;
      }
      if (e.key === "y") {
        const target =
          (current && current.status === "needs-you" ? current : null) ??
          inbox[0] ??
          null;
        if (target) {
          e.preventDefault();
          void retry(target.id);
        }
        return;
      }
      if (e.key === "x") {
        const target =
          (current && current.status === "needs-you" ? current : null) ??
          inbox[0] ??
          null;
        if (target) {
          e.preventDefault();
          void dismiss(target.id);
        }
        return;
      }
      if (e.key === "s" && current && current.status !== "merged") {
        e.preventDefault();
        setLaunchpadOpen(false);
        setViewMode("board");
        setTimeout(() => document.getElementById("steerText")?.focus(), 20);
        return;
      }
      if (e.key === "m" && current && current.status === "done" && isVerified(current)) {
        e.preventDefault();
        void quickMergeSingle(current);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    selected,
    current,
    inbox,
    requestedTab,
    navOrdered,
    paletteOpen,
    prSession,
    settingsOpen,
    inboxOpenDesktop,
    leftOpen,
    md,
    openSession,
    triggerComposer,
  ]);

  const maxParallel = policy?.max_parallel ?? config?.max_parallel ?? 4;
  const liveMetrics = useMemo(() => {
    const local: BoardMetrics = {
      ...computeLocalMetrics(all, maxParallel),
      budget: computeLocalBudget(all, policy),
    };
    return serverMetrics && hasServerV060 ? serverMetrics : local;
  }, [all, maxParallel, policy, serverMetrics, hasServerV060]);

  const testMode = !webEngine && (policy?.default_agent_engine === "custom" || all.some((s) => s.test_mode));

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

  const quickMergeSingle = async (s: Session) => {
    if (hasServerV050) {
      const chk = await fetchMergeCheck(s, true);
      if (!chk.clean) {
        toast.error(`Cannot merge ${s.id}: conflict in ${chk.conflicting_files.join(", ") || "target branch"}.`);
        return;
      }
    }
    const err = await postJson(`/api/sessions/${s.id}/merge`, { strategy: s.merge_strategy || "merge" });
    if (err) toast.error(err);
    else toast.success(`Merged ${s.branch || s.id}.`);
    void refresh();
  };

  const handleBatchMergeWave = async () => {
    if (waveMergeBusy || verifiedDoneSessions.length === 0) return;
    setWaveMergeBusy(true);
    const supportsBatchMerge = Boolean(policy?.features?.batch_merge) || webEngine;
    const preflight = await batchMergeVerifiedWave(
      { strategy: "merge", dry_run: true },
      all,
      supportsBatchMerge,
    );
    if (!preflight.ok) {
      setWaveMergeBusy(false);
      toast.error(preflight.error || "Batch merge preflight failed.");
      return;
    }
    if (preflight.total === 0) {
      setWaveMergeBusy(false);
      toast.info("No verified done sessions ready to merge.");
      return;
    }
    if (preflight.clean_count === 0) {
      setWaveMergeBusy(false);
      const firstConflict = preflight.results.find((r) => !r.clean || !r.can_apply);
      const files = firstConflict?.conflicting_files?.join(", ");
      toast.warning(
        `Preflight blocked: ${preflight.conflict_count} verified ${preflight.conflict_count === 1 ? "session has" : "sessions have"} conflicts${files ? ` (${files})` : ""}.`,
      );
      return;
    }

    const res = await batchMergeVerifiedWave(
      { strategy: "merge", dry_run: false },
      all,
      supportsBatchMerge,
    );
    setWaveMergeBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Batch merge failed.");
      return;
    }
    if (res.merged_count > 0) {
      const notes = [
        res.skipped_count > 0 ? `${res.skipped_count} conflicted skipped` : "",
        res.failed_count > 0 ? `${res.failed_count} failed` : "",
      ].filter(Boolean);
      toast.success(
        `Wave merged ${res.merged_count} verified ${res.merged_count === 1 ? "session" : "sessions"}${notes.length ? ` (${notes.join(", ")})` : ""}.`,
      );
    } else {
      toast.warning(`No sessions merged (${res.skipped_count} skipped, ${res.failed_count} failed).`);
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

  const streamLabel = streamState === "browser" ? "Browser engine" : streamState === "sse" ? "SSE live" : "Polling";

  const showWorkspaceInCenter = viewMode === "board";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--canvas)] text-[var(--ink)]">
      {/* Slim 44px single top chrome */}
      <header className="h-11 shrink-0 flex items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--surface)] px-3 md:px-4">
        <div className="flex min-w-0 items-center gap-2">
          {md && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Toggle inbox rail"
              aria-pressed={leftOpen}
              onClick={() => setLeftOpen((v) => !v)}
            >
              <PanelLeft className="size-4" strokeWidth={1.5} />
            </Button>
          )}
          <ScanLine className="size-4 shrink-0 text-[var(--blue)]" strokeWidth={1.75} aria-hidden />
          <h1 className="text-[16px] font-semibold tracking-tight text-[var(--ink)]">Fleet</h1>
          {upd.version && (
            <a
              href={`${VERSION_URL}${upd.version}`}
              target="_blank"
              rel="noopener"
              className="hidden sm:inline-flex items-center rounded-[var(--radius-chip)] bg-[var(--track)] px-2 h-6 mono text-[12px] text-[var(--ink-2)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
            >
              v{upd.version}
            </a>
          )}
          {localHost && upd.snap?.mode !== "off" && !webEngine && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Check for updates"
              disabled={upd.checking}
              onClick={upd.check}
              className="hidden lg:inline-flex"
            >
              <RefreshCw className={cn("size-3.5 text-[var(--ink-2)]", upd.checking && "animate-spin")} strokeWidth={1.5} />
            </Button>
          )}
          {testMode && <Badge tone="warning" className="max-sm:hidden">custom script</Badge>}
          {upd.hidden && upd.snap?.available && upd.dismissed && (
            <Button id="show-update" size="sm" variant="outline" onClick={upd.show}>
              Show update
            </Button>
          )}
        </div>

        <div className="hidden md:flex items-center gap-1.5">
          <div className="inline-flex items-center gap-0.5 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--track)] p-0.5">
            <button
              type="button"
              data-testid="view-toggle-board"
              aria-pressed={viewMode === "board" && !launchpadOpen}
              onClick={() => {
                setViewMode("board");
                setLaunchpadOpen(false);
              }}
              className={cn(
                "relative inline-flex items-center gap-1.5 rounded-[var(--radius-segment)] px-2.5 h-8 text-[13px] font-medium cursor-pointer transition motion-safe:active:scale-[0.97]",
                viewMode === "board" && !launchpadOpen
                  ? "text-[var(--ink)]"
                  : "text-[var(--ink-2)] hover:text-[var(--ink)]",
              )}
            >
              {viewMode === "board" && !launchpadOpen && (
                <m.span
                  layoutId="fleet-view-pill"
                  transition={glide}
                  aria-hidden="true"
                  className="absolute inset-0 rounded-[var(--radius-segment)] bg-[var(--raised)] border border-[var(--hairline)] shadow-[var(--elev-raised)]"
                />
              )}
              <LayoutGrid className="relative z-10 size-3.5" strokeWidth={1.5} aria-hidden />
              <span className="relative z-10">Workbench</span>
            </button>
            <button
              type="button"
              data-testid="view-toggle-dag"
              aria-pressed={viewMode === "dag"}
              onClick={() => setViewMode("dag")}
              className={cn(
                "relative inline-flex items-center gap-1.5 rounded-[var(--radius-segment)] px-2.5 h-8 text-[13px] font-medium cursor-pointer transition motion-safe:active:scale-[0.97]",
                viewMode === "dag" ? "text-[var(--ink)]" : "text-[var(--ink-2)] hover:text-[var(--ink)]",
              )}
            >
              {viewMode === "dag" && (
                <m.span
                  layoutId="fleet-view-pill"
                  transition={glide}
                  aria-hidden="true"
                  className="absolute inset-0 rounded-[var(--radius-segment)] bg-[var(--raised)] border border-[var(--hairline)] shadow-[var(--elev-raised)]"
                />
              )}
              <Network className="relative z-10 size-3.5" strokeWidth={1.5} aria-hidden />
              <span className="relative z-10">DAG</span>
            </button>
          </div>

          <Button
            type="button"
            variant={launchpadOpen && viewMode === "board" ? "secondary" : "ghost"}
            size="sm"
            data-testid="open-launchpad"
            onClick={() => {
              setViewMode("board");
              setLaunchpadOpen((v) => !v);
            }}
          >
            <Sparkles className="size-3.5 text-[var(--blue)]" strokeWidth={1.5} aria-hidden />
            <span>Plan goal</span>
          </Button>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {verifiedDoneSessions.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="batch-merge-wave-btn"
              disabled={waveMergeBusy}
              onClick={() => void handleBatchMergeWave()}
              className="hidden lg:inline-flex"
            >
              <GitMerge className="size-3.5 text-[var(--success-foreground)]" strokeWidth={1.5} aria-hidden />
              <span>
                {waveMergeBusy ? "Merging..." : `Merge wave (${verifiedDoneSessions.length})`}
              </span>
            </Button>
          )}
          <div className="hidden md:inline-flex">
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
              onGo={() => {
                setStatusFilter("needs-you");
                setLeftOpen(true);
              }}
            />
          </div>

          <Button
            variant="outline"
            size="sm"
            id="cmdk-open"
            aria-label="Command palette"
            onClick={() => setPaletteOpen(true)}
            className="hidden sm:inline-flex"
          >
            <CommandIcon className="size-3.5 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
            <Kbd>K</Kbd>
          </Button>

          {md && (
            <NewSession
              policy={policy}
              sessions={all}
              playbooks={playbooks}
              supportsServerV050={hasServerV050}
              supportsServerV060={hasServerV060}
              initialModeRef={composerModeRef}
              initialPlaybookRef={composerPlaybookRef}
              openSignal={composerSignal}
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
              className="h-8 px-3 text-[13px]"
            />
          )}

          {xl && viewMode === "board" && current && !launchpadOpen && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Toggle inspector rail"
              aria-pressed={rightOpen}
              onClick={() => setRightOpen((v) => !v)}
            >
              <PanelRight className="size-4" strokeWidth={1.5} />
            </Button>
          )}

          <Button
            variant="outline"
            size="icon"
            id="settings-open"
            aria-label="Engines and settings"
            onClick={() => {
              setInboxOpenDesktop(false);
              setSettingsOpen(true);
            }}
          >
            <Cpu className="size-4" strokeWidth={1.5} aria-hidden />
          </Button>
        </div>
      </header>

      <UpdateStrip u={upd} />

      {unreachable && sessions !== null && (
        <p role="status" className="border-b border-[var(--hairline)] border-l-2 border-l-[var(--unread)] bg-[var(--surface)] px-4 py-2 text-[13px] text-[var(--ink)]">
          {lastGood
            ? `Cannot reach Fleet. Showing the last list from ${lastGood.toLocaleTimeString()}. Retrying.`
            : "Cannot reach Fleet. Retrying."}
        </p>
      )}

      {/* 3-pane Desktop Workbench (or tabbed mobile panes on <768px) */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {(md ? leftOpen : mobilePane === "inbox") && (
          <div className={cn("flex flex-col h-full min-h-0 shrink-0 overflow-hidden", md ? "w-[292px] border-r border-[var(--hairline)]" : "w-full pb-16")}>
            <SessionInboxRail
              sessions={sessions === null ? null : shown}
              allSessions={all}
              unreachable={unreachable}
              selectedId={selected}
              statusFilter={statusFilter}
              repoFilter={repoFilter}
              repos={distinctProjects}
              query={query}
              multiSelect={multiSelect}
              bulkSelected={bulkSelected}
              bulkBusy={bulkBusy}
              nowMs={nowMs}
              onQuery={setQuery}
              onStatusFilter={setStatusFilter}
              onRepoFilter={setRepoFilter}
              onClearFilters={clearAllFilters}
              onToggleMultiSelect={() =>
                setMultiSelect((prev) => {
                  if (prev) setBulkSelected(new Set());
                  return !prev;
                })
              }
              onToggleBulk={toggleBulkCard}
              onSelectVisible={() => setBulkSelected(new Set(shown.map((s) => s.id)))}
              onClearSelection={() => setBulkSelected(new Set())}
              onBulkRetry={bulkRetry}
              onBulkDismiss={bulkDismiss}
              onBulkMerge={bulkMerge}
              onOpen={openSession}
              onRetry={(id) => void retry(id)}
              onDismiss={(id) => void dismiss(id)}
              searchInputRef={searchRef}
            />
          </div>
        )}

        {(md || mobilePane === "workspace") && (
          <main className={cn("flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-[var(--surface)]", !md && "pb-16")}>
            <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-5 flex flex-col">
              {viewMode === "dag" ? (
                <DagWaveGraph
                  sessions={shown}
                  selectedId={selected}
                  waveMergeableCount={verifiedDoneSessions.length}
                  waveMergeBusy={waveMergeBusy}
                  onBatchMergeWave={() => void handleBatchMergeWave()}
                  onOpen={(id) => openSession(id, "tr")}
                  onNewBatch={() => triggerComposer("batch", null)}
                />
              ) : launchpadOpen || !current ? (
                <GoalLaunchpad
                  repos={repos}
                  playbooks={playbooks}
                  policy={policy}
                  supportsServerV050={hasServerV050}
                  onDispatched={(created) => {
                    setSessions((prev) => {
                      const existing = prev ?? [];
                      const newIds = new Set(created.map((c) => c.id));
                      return [...created, ...existing.filter((x) => !newIds.has(x.id))];
                    });
                    if (created[0]) openSession(created[0].id, "tr");
                    void refresh();
                  }}
                  onApplyPlaybook={(tpl) =>
                    triggerComposer((tpl.tasks?.length ?? 1) > 1 ? "batch" : "single", tpl)
                  }
                />
              ) : (
                <DetailBody
                  s={current}
                  allSessions={all}
                  requestedTab={requestedTab}
                  openSeq={openSeq}
                  supportsServerV050={hasServerV050}
                  mergeCheck={mergeCheck}
                  checkingMerge={checkingMerge}
                  nowMs={nowMs}
                  onRecheckMerge={recheckMerge}
                  onTabChange={setRequestedTab}
                  onClose={closeDetail}
                  onOpenSession={openSession}
                  onOpenPrPreview={(s) => setPrSession(s)}
                  onChanged={refresh}
                  onDismissed={() => void dismiss(current.id)}
                />
              )}
            </div>
          </main>
        )}

        <AnimatePresence initial={false}>
          {((xl && rightOpen && showWorkspaceInCenter && Boolean(current) && !launchpadOpen) ||
            (!md && mobilePane === "inspector")) && (
            <m.div
              key="right-inspector"
              initial={{ opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 6 }}
              transition={enter}
              className={cn("flex flex-col h-full min-h-0 shrink-0 overflow-hidden", md ? "w-[300px] border-l border-[var(--hairline)]" : "w-full pb-16")}
            >
              <RightInspectorRail
                session={current}
                mergeCheck={mergeCheck}
                checkingMerge={checkingMerge}
                supportsServerV050={hasServerV050}
                nowMs={nowMs}
                timeoutSecs={policy?.timeout_secs}
                onRecheckMerge={recheckMerge}
                onOpenTab={(tab) => {
                  if (current) openSession(current.id, tab);
                }}
              />
            </m.div>
          )}
        </AnimatePresence>
      </div>

      {md && (
        <BoardMetricsStrip
          metrics={liveMetrics}
          streamLabel={streamLabel}
          reachable={!unreachable}
        />
      )}

      {/* Mobile bottom navigation bar */}
      {!md && (
        <nav
          aria-label="Workbench panes"
          className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-1.5 border-t border-[var(--hairline)] bg-[var(--surface)] px-2 py-1.5"
          style={{ paddingBottom: "max(6px, env(safe-area-inset-bottom))" }}
        >
          <Button
            type="button"
            variant={mobilePane === "inbox" ? "primary" : "ghost"}
            size="sm"
            onClick={() => setMobilePane("inbox")}
            className="flex-1"
          >
            Inbox ({all.length})
          </Button>
          <Button
            type="button"
            variant={mobilePane === "workspace" ? "primary" : "ghost"}
            size="sm"
            onClick={() => setMobilePane("workspace")}
            className="flex-1"
          >
            Workspace
          </Button>
          <Button
            type="button"
            variant={mobilePane === "inspector" ? "primary" : "ghost"}
            size="sm"
            onClick={() => setMobilePane("inspector")}
            className="flex-1"
          >
            Inspector
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            aria-label="New session"
            onClick={() => triggerComposer("single", null)}
          >
            New
          </Button>
        </nav>
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
        onOpenPrPreview={(s) => setPrSession(s)}
        onSwitchTab={(t) => {
          setLaunchpadOpen(false);
          setViewMode("board");
          setRequestedTab(t);
          if (!selected && navOrdered[0]) openSession(navOrdered[0].id, t);
        }}
        onNewSingle={() => triggerComposer("single", null)}
        onNewBatch={() => triggerComposer("batch", null)}
        onApplyPlaybook={(tpl) =>
          triggerComposer((tpl.tasks?.length ?? 1) > 1 ? "batch" : "single", tpl)
        }
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleMultiSelect={() =>
          setMultiSelect((prev) => {
            if (prev) setBulkSelected(new Set());
            return !prev;
          })
        }
        onFocusSearch={() => {
          setLeftOpen(true);
          if (!md) setMobilePane("inbox");
          setTimeout(() => searchRef.current?.focus(), 20);
        }}
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
        onBatchMergeWave={() => void handleBatchMergeWave()}
        verifiedDoneCount={verifiedDoneSessions.length}
      />

      {/* #67: Light/Dark theme switcher lives EXCLUSIVELY inside Settings */}
      <Drawer
        id="settings"
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Engines and settings"
        closeLabel="Close settings"
      >
        <div className="space-y-6">
          <section className="border-b border-[var(--hairline)] pb-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-[14px] font-semibold text-[var(--ink)]">Appearance</h3>
                <p className="text-[12px] text-[var(--ink-3)]">Light or dark theme, saved in this browser.</p>
              </div>
              <div id="themeBtn" role="group" aria-label="Theme" className="inline-flex items-center gap-0.5 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--track)] p-0.5">
                {(["light", "dark"] as const).map((t) => {
                  const active = theme === t;
                  return (
                    <Button
                      key={t}
                      type="button"
                      size="sm"
                      variant={active ? "primary" : "ghost"}
                      aria-pressed={active}
                      aria-label={t === "light" ? "Light" : "Dark"}
                      onClick={() => setTheme(t)}
                    >
                      {t === "light" ? (
                        <Sun className="size-4" strokeWidth={1.5} aria-hidden />
                      ) : (
                        <Moon className="size-4" strokeWidth={1.5} aria-hidden />
                      )}
                      <span>{t === "light" ? "Light" : "Dark"}</span>
                    </Button>
                  );
                })}
              </div>
            </div>
          </section>

          <p className="text-[13px] leading-relaxed text-[var(--ink-2)]">
            {policy
              ? `Up to ${policy.max_parallel} sessions run in parallel. Any agent or check exceeding ${policy.timeout_secs}s returns to Needs you. Policy source: ${policy.source}.${policy.model ? ` OpenCode model: ${policy.model}.` : ""} ${policy.default_agent ? `Default agent: ${policy.default_agent_engine === "custom" ? "custom script" : policy.default_agent}.` : "No default agent is set."}`
              : "Loading policy rules..."}
          </p>

          <section>
            <h3 className="mb-2 text-[14px] font-semibold text-[var(--ink)]">
              {webEngine ? "Browser Worktree Engine" : "CLI engines detected on PATH"}
            </h3>
            <ul className="divide-y divide-[var(--hairline)] rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)]">
              {(policy?.agents ?? []).length === 0 && (
                <li className="p-3 text-[13px] text-[var(--ink-2)]">No CLI agents detected on PATH.</li>
              )}
              {(policy?.agents ?? []).map((a) => (
                <li key={a.name} className="flex items-center justify-between gap-3 px-3 py-2.5 text-[13px]">
                  <div className="min-w-0">
                    <span className="block truncate mono text-[var(--ink)]">{a.name}</span>
                    {a.path && <span className="block truncate mono text-[12px] text-[var(--ink-3)]">{a.path}</span>}
                  </div>
                  <Badge tone={a.found ? "success" : "warning"}>
                    {a.found ? (webEngine ? "active" : "found on this machine") : "not installed"}
                  </Badge>
                </li>
              ))}
            </ul>
            {testMode && <p className="mt-2 text-[12px] text-[var(--ink-3)]">{TEST_NOTE}</p>}
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

          <section className="border-t border-[var(--hairline)] pt-5">
            <h3 className="mb-2 text-[14px] font-semibold text-[var(--ink)]">Version and updates</h3>
            <div className="flex flex-wrap items-center gap-3 text-[13px] text-[var(--ink-2)]">
              {upd.version && <span className="mono text-[var(--ink)]">Fleet {upd.version}</span>}
              {localHost && !webEngine ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={upd.check}
                  disabled={upd.checking || upd.snap?.mode === "off"}
                >
                  {upd.checking ? "Checking..." : "Check for updates"}
                </Button>
              ) : webEngine ? (
                <span className="text-[12px] text-[var(--ink-2)]">
                  Running in-browser git worktree, DAG scheduler, and Blob Web Worker check engine.
                </span>
              ) : (
                <span className="text-[12px] text-[var(--ink-2)]">To update, open Fleet on the computer it runs on.</span>
              )}
            </div>
            {!webEngine && (
              <p className="mt-2 text-[13px] text-[var(--ink-2)] [overflow-wrap:anywhere]" role="status">
                {upd.snap && !upd.live ? resultLineOf(upd.snap) : upd.live}
              </p>
            )}
          </section>
        </div>
      </Drawer>

      <PrPreviewModal
        session={prSession}
        supportsServerV070={hasServerV070}
        onClose={() => {
          modalClosedAtRef.current = Date.now();
          setPrSession(null);
        }}
        onCreated={refresh}
      />

      <ToastRegion theme={theme} />
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
    <section className="border-t border-[var(--hairline)] pt-5">
      <h3 className="mb-1 text-[14px] font-semibold text-[var(--ink)]">Engine and model routing</h3>
      <p className="mb-3 text-[12px] leading-relaxed text-[var(--ink-3)]">
        Saved to Fleet data folder and applied immediately to new runs. Leave a model blank to inherit policies.rn.
      </p>
      <form onSubmit={save} className="space-y-3">
        {foundAgents.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[12px] font-medium text-[var(--ink-2)]">Default engine</p>
            <SegmentedControl
              label="Default engine"
              value={defaultAgent}
              onChange={setDefaultAgent}
              options={foundAgents.map((name) => ({ value: name, label: name }))}
            />
          </div>
        )}
        <div className="space-y-1">
          <label htmlFor="cfg-opencode-model" className="block text-[12px] font-medium text-[var(--ink-2)]">
            OpenCode model
          </label>
          <Input
            id="cfg-opencode-model"
            value={opencodeModel}
            onChange={(e) => setOpencodeModel(e.target.value)}
            placeholder={config?.effective_models?.opencode || policy?.model || "opencode/deepseek-v4.1-flash-free"}
            autoComplete="off"
            className="mono text-[13px]"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="cfg-claude-model" className="block text-[12px] font-medium text-[var(--ink-2)]">
            Claude model (optional)
          </label>
          <Input
            id="cfg-claude-model"
            value={claudeModel}
            onChange={(e) => setClaudeModel(e.target.value)}
            placeholder={config?.effective_models?.claude || "engine default"}
            autoComplete="off"
            className="mono text-[13px]"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="cfg-codex-model" className="block text-[12px] font-medium text-[var(--ink-2)]">
            Codex model (optional)
          </label>
          <Input
            id="cfg-codex-model"
            value={codexModel}
            onChange={(e) => setCodexModel(e.target.value)}
            placeholder={config?.effective_models?.codex || "engine default"}
            autoComplete="off"
            className="mono text-[13px]"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="cfg-max-parallel" className="block text-[12px] font-medium text-[var(--ink-2)]">
            Max parallel agents
          </label>
          <Input
            id="cfg-max-parallel"
            type="number"
            min={1}
            max={64}
            value={maxParallelInput}
            onChange={(e) => setMaxParallelInput(e.target.value)}
            placeholder={String(policy?.max_parallel ?? 4)}
            autoComplete="off"
            className="mono text-[13px]"
          />
        </div>
        {err && (
          <p role="alert" className="text-[13px] text-[var(--destructive-foreground)]">
            {err}
          </p>
        )}
        <Button type="submit" size="sm" variant="outline" disabled={saving}>
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
      <section className="space-y-3 border-t border-[var(--hairline)] pt-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ink)]">
            <Plug className="size-4 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
            <span>Connect to local Fleet</span>
          </h3>
          <Badge tone={status.mode === "local" ? "success" : "neutral"}>
            {status.mode === "local" ? "local binary" : "browser engine"}
          </Badge>
        </div>
        <p className="text-[12px] leading-relaxed text-[var(--ink-3)]">
          Connect to a running local Fleet daemon or run git worktrees and Blob Web Worker checks directly in this browser.
        </p>
        <div className="space-y-1">
          <label htmlFor="local-fleet-url" className="block text-[12px] font-medium text-[var(--ink-2)]">
            Local Fleet address
          </label>
          <Input
            id="local-fleet-url"
            value={localUrl}
            onChange={(e) => setLocalUrl(e.target.value)}
            placeholder="http://127.0.0.1:8471"
            className="mono text-[13px]"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {status.mode === "local" ? (
            <Button size="sm" variant="outline" disabled={connBusy} onClick={() => void connectLocal(false)}>
              Use browser engine
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={connBusy} onClick={() => void connectLocal(true)}>
              {connBusy ? "Connecting..." : "Connect to local Fleet"}
            </Button>
          )}
          <a
            href={localUrl.trim() || "http://127.0.0.1:8471"}
            target="_blank"
            rel="noopener"
            className="inline-flex h-8 items-center rounded-[var(--radius-chip)] border border-[var(--hairline-s)] px-3 text-[13px] font-medium text-[var(--ink-2)] hover:bg-[var(--board)] hover:text-[var(--ink)]"
          >
            Open local UI
          </a>
        </div>
        {connMsg && (
          <p role="status" className="text-[12px] leading-relaxed text-[var(--destructive-foreground)] [overflow-wrap:anywhere]">
            {connMsg}
          </p>
        )}
      </section>

      <section className="space-y-3 border-t border-[var(--hairline)] pt-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ink)]">
            <KeyRound className="size-4 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
            <span>BYOK coding agent (optional)</span>
          </h3>
          <Badge tone={status.byokConfigured ? "success" : "neutral"}>
            {status.byokConfigured ? "key in session" : "built-in patcher"}
          </Badge>
        </div>
        <p className="text-[12px] leading-relaxed text-[var(--ink-3)]">
          Optionally connect an OpenAI-compatible API. Keys stay strictly in sessionStorage for this tab.
        </p>
        <form onSubmit={saveByok} className="space-y-2.5">
          <div className="space-y-1">
            <label htmlFor="byok-url" className="block text-[12px] font-medium text-[var(--ink-2)]">
              API base URL
            </label>
            <Input id="byok-url" value={byokUrl} onChange={(e) => setByokUrl(e.target.value)} className="mono text-[13px]" />
          </div>
          <div className="space-y-1">
            <label htmlFor="byok-model" className="block text-[12px] font-medium text-[var(--ink-2)]">
              Model
            </label>
            <Input id="byok-model" value={byokModel} onChange={(e) => setByokModel(e.target.value)} className="mono text-[13px]" />
          </div>
          <div className="space-y-1">
            <label htmlFor="byok-key" className="block text-[12px] font-medium text-[var(--ink-2)]">
              API key (sessionStorage only)
            </label>
            <Input
              id="byok-key"
              type="password"
              value={byokKey}
              onChange={(e) => setByokKey(e.target.value)}
              placeholder={status.byokConfigured ? "Key stored for this tab (enter new to replace)" : "sk-..."}
              autoComplete="off"
              className="mono text-[13px]"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="outline">
              Save BYOK settings
            </Button>
            {status.byokConfigured && (
              <Button type="button" size="sm" variant="ghost" onClick={clearByok}>
                Clear key
              </Button>
            )}
          </div>
        </form>
      </section>

      <section className="border-t border-[var(--hairline)] pt-5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-[var(--ink)]">Browser git workspace</h3>
            <p className="text-[12px] text-[var(--ink-3)]">Stored locally in IndexedDB across reloads.</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void resetRepo()}>
            <RotateCcw className="size-3.5" strokeWidth={1.5} aria-hidden />
            <span>Reset</span>
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
}) {
  const n = inbox.length;
  return (
    <PopoverPanel
      open={open}
      onClose={() => onOpenChange(false)}
      align="end"
      side="bottom"
      className="w-[360px] p-0"
      trigger={
        <Button
          type="button"
          size="sm"
          variant={n > 0 ? "danger" : "outline"}
          aria-label={`Needs you, ${n}`}
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          <span>Needs you</span>
          <span className="mono">{n}</span>
        </Button>
      }
    >
      <div className="p-3.5 border-b border-[var(--hairline)]">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-[var(--ink)]">Needs you</h2>
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
              >
                Dismiss all
              </Button>
            </div>
          )}
        </div>
        <p className="mt-1 text-[12px] text-[var(--ink-2)]">
          Runs paused on a failed check, conflict, or manual steer.
        </p>
      </div>
      <div className="max-h-[50dvh] overflow-y-auto divide-y divide-[var(--hairline)]">
        {n === 0 && (
          <p className="p-4 text-[13px] text-[var(--ink-2)]">
            Nothing needs you right now. Failed checks and stopped runs appear here.
          </p>
        )}
        {inbox.map((s) => (
          <div key={s.id} className="p-3.5 space-y-2">
            <p className="text-[14px] font-medium text-[var(--ink)] [overflow-wrap:anywhere]">{s.task}</p>
            <p
              className={cn(
                "text-[12px] [overflow-wrap:anywhere]",
                isFailed(s) ? "text-[var(--destructive-foreground)]" : "text-[var(--info-foreground)]",
              )}
            >
              {s.reason || "needs you"}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                  onView(s.id);
                }}
              >
                View session
              </Button>
              <Button size="sm" variant="primary" onClick={() => onRetry(s.id)}>
                Retry
              </Button>
            </div>
            {errs[s.id] && (
              <p role="alert" className="text-[12px] text-[var(--destructive-foreground)]">
                {errs[s.id]}
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="border-t border-[var(--hairline)] p-2 text-right">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onOpenChange(false);
            onGo();
          }}
        >
          Go to Needs you
        </Button>
      </div>
    </PopoverPanel>
  );
}
