import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ClipboardCopy,
  Command as CommandIcon,
  GitBranch,
  Inbox,
  Network,
  RefreshCw,
  Rocket,
  Search,
  Settings,
  Users,
} from "./icons";
import { BoardView, type BoardQuickFilter } from "./components/BoardView";
import { CommandPalette } from "./components/CommandPalette";
import { GraphView } from "./components/GraphView";
import { RosterView } from "./components/RosterView";
import { TriageView } from "./components/TriageView";
import { WorktreesView } from "./components/WorktreesView";
import {
  applyTheme,
  fetchSwarmSnapshot,
  fetchSwarms,
  fetchWorktrees,
  inferThemeFromCssColor,
  isEmbeddedHost,
  openWorkerConversation,
  readStoredTheme,
  startSwarmPreset,
} from "./sidecar";
import type { SwarmSnapshot, SwarmSummary, TabId, ThemeMode, WorktreesPayload } from "./types";
import {
  Badge,
  Button,
  Card,
  FleetToaster,
  Modal,
  SegmentControl,
  StatusDot,
  cn,
  copyText,
  fmtTokens,
  formatSwarmDigest,
  toast,
} from "./ui";

const SWARM_PRESETS = [
  {
    id: "feature-verifier",
    title: "Feature + Verifier",
    summary: "Worktree + cold verifier",
    prompt: "/fleet Build on isolated worktree, add tests, hand off @verifier [done].",
  },
  {
    id: "audit-harden",
    title: "Audit & Harden",
    summary: "Tests, security & UI audit",
    prompt: "/fleet Audit tests, security boundaries, and UI craft with cold verification.",
  },
  {
    id: "multi-lane",
    title: "Multi-Lane Ship",
    summary: "Parallel lanes + monitor",
    prompt: "/fleet Shard across worktrees with monitor, gates, and plan.json.",
  },
];

const TABS: Array<{ id: TabId; label: string; Icon: typeof Inbox }> = [
  { id: "triage", label: "Triage", Icon: Inbox },
  { id: "board", label: "Board", Icon: Activity },
  { id: "roster", label: "Roster", Icon: Users },
  { id: "graph", label: "Graph", Icon: Network },
  { id: "worktrees", label: "Git", Icon: GitBranch },
];

export function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme());
  const [hostSynced, setHostSynced] = useState(false);
  const [tab, setTab] = useState<TabId>("triage");
  const [pollMs, setPollMs] = useState<"2000" | "5000" | "0">("2000");

  const [selectedSwarmId, setSelectedSwarmId] = useState<string | null>(() => {
    const q = new URLSearchParams(window.location.search).get("conversationId");
    return q || window.sidecar?.conversationId || null;
  });
  const [swarms, setSwarms] = useState<SwarmSummary[]>([]);
  const [snap, setSnap] = useState<SwarmSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const etagRef = useRef<string>("");

  const [workspaceUris, setWorkspaceUris] = useState<string[]>([]);
  const [manualRoots, setManualRoots] = useState<string[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreesPayload | null>(null);
  const [wtLoading, setWtLoading] = useState(false);

  const [highlightSeq, setHighlightSeq] = useState<number | null>(null);
  const [boardQuickFilter, setBoardQuickFilter] = useState<BoardQuickFilter>("all");
  const [selectedTriageIdx, setSelectedTriageIdx] = useState(0);
  const [triageReplyNonce, setTriageReplyNonce] = useState(0);
  const [sseConnected, setSseConnected] = useState(false);
  const [pinnedMap, setPinnedMap] = useState<Record<string, number[]>>(() => {
    try {
      const raw = localStorage.getItem("fleet-pinned-v1");
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const embedded = isEmbeddedHost();

  useEffect(() => {
    applyTheme(theme, !hostSynced);
  }, [theme, hostSynced]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "theme-change") return;
      const vars = event.data?.payload?.cssVariables;
      if (!vars || typeof vars !== "object") return;
      const bg = vars["--background"] || vars["--vscode-editor-background"] || vars["--surface"];
      const detected = inferThemeFromCssColor(String(bg || ""));
      if (detected) {
        setHostSynced(true);
        setTheme(detected);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    let active = true;
    const onUris = (uris: unknown) => active && Array.isArray(uris) && setWorkspaceUris(uris);
    window.sidecar?.getWorkspaceUris?.().then(onUris);
    const unsub = window.sidecar?.onWorkspaceChange?.(onUris);
    return () => {
      active = false;
      unsub?.();
    };
  }, []);

  const refreshSwarm = useCallback(
    async (force = false) => {
      try {
        if (force) etagRef.current = "";
        const [data, listData] = await Promise.all([
          fetchSwarmSnapshot(selectedSwarmId, force ? "" : etagRef.current),
          fetchSwarms().catch(() => null),
        ]);
        if (listData?.swarms) setSwarms(listData.swarms);
        if (data && !data.unchanged) {
          etagRef.current = data.etag || "";
          setSnap(data);
        }
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load swarm");
      } finally {
        setLoading(false);
      }
    },
    [selectedSwarmId],
  );

  useEffect(() => {
    etagRef.current = "";
    refreshSwarm(true);
  }, [refreshSwarm]);

  useEffect(() => {
    const ms = Number(pollMs);
    if (!ms) return;
    const effectiveMs = sseConnected ? Math.max(ms, 15000) : ms;
    const id = setInterval(() => {
      if (!document.hidden) refreshSwarm(false);
    }, effectiveMs);
    return () => clearInterval(id);
  }, [pollMs, sseConnected, refreshSwarm]);

  // Live SSE push stream when running on standalone HTTP server (graceful poll fallback inside SidecarApp).
  const refreshRef = useRef(refreshSwarm);
  refreshRef.current = refreshSwarm;
  const canSse = Boolean(snap?.capabilities?.sseStream);
  const activeConvId = selectedSwarmId || snap?.swarm || "";
  useEffect(() => {
    if (!canSse || pollMs === "0" || !activeConvId || typeof EventSource === "undefined") {
      setSseConnected(false);
      return;
    }
    const q = `?conversationId=${encodeURIComponent(activeConvId)}`;
    const es = new EventSource(`/api/swarm/stream${q}`);
    es.onopen = () => setSseConnected(true);
    es.addEventListener("swarm", (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data || "{}");
        if (d?.etag && d.etag !== etagRef.current) {
          refreshRef.current(false);
        }
      } catch {
        refreshRef.current(false);
      }
    });
    es.onerror = () => {
      setSseConnected(false);
    };
    return () => {
      setSseConnected(false);
      es.close();
    };
  }, [canSse, pollMs, activeConvId]);

  const allRoots = useMemo(
    () => [...new Set([...workspaceUris, ...manualRoots])],
    [workspaceUris, manualRoots],
  );

  const refreshWorktrees = useCallback(async () => {
    if (allRoots.length === 0) {
      setWorktrees(null);
      return;
    }
    setWtLoading(true);
    try {
      const res = await fetchWorktrees(allRoots);
      setWorktrees(res);
    } catch {
      // keep stale result cleanly
    } finally {
      setWtLoading(false);
    }
  }, [allRoots]);

  useEffect(() => {
    refreshWorktrees();
  }, [refreshWorktrees]);

  const members = snap?.members || [];
  const activeCount = members.filter((m) => !m.killed && m.status === "working").length;
  const waitingCount = members.filter((m) => !m.killed && m.status === "waiting").length;
  const triageCount = snap?.triage?.length || 0;
  const hasSwarm = Boolean(snap?.swarm);

  const activeSwarmKey = snap?.swarm || selectedSwarmId || "default";
  const pinnedSeqs = pinnedMap[activeSwarmKey] || [];
  const triageItems = snap?.triage || [];

  useEffect(() => {
    setSelectedTriageIdx((idx) => (triageItems.length ? Math.min(idx, triageItems.length - 1) : 0));
  }, [triageItems.length, activeSwarmKey]);

  const handleTogglePin = useCallback(
    (seq: number) => {
      setPinnedMap((prev) => {
        const cur = prev[activeSwarmKey] || [];
        const nextList = cur.includes(seq) ? cur.filter((x) => x !== seq) : [...cur, seq].sort((a, b) => a - b);
        const next = { ...prev, [activeSwarmKey]: nextList };
        try {
          localStorage.setItem("fleet-pinned-v1", JSON.stringify(next));
        } catch {}
        return next;
      });
    },
    [activeSwarmKey],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || paletteOpen || settingsOpen) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) {
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (shortcutsOpen) return;
      if (e.key >= "1" && e.key <= "5") {
        const nextTab = TABS[Number(e.key) - 1];
        if (nextTab) {
          e.preventDefault();
          setTab(nextTab.id);
        }
        return;
      }
      if (e.key === "f" && tab === "board") {
        e.preventDefault();
        const order: BoardQuickFilter[] = ["all", "needs_reply", "done", "blocked"];
        setBoardQuickFilter((cur) => order[(order.indexOf(cur) + 1) % order.length]);
        return;
      }
      if (tab !== "triage" || triageItems.length === 0) return;
      if (e.key === "j") {
        e.preventDefault();
        setSelectedTriageIdx((i) => Math.min(triageItems.length - 1, i + 1));
      } else if (e.key === "k") {
        e.preventDefault();
        setSelectedTriageIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "r") {
        e.preventDefault();
        setTriageReplyNonce((n) => n + 1);
      } else if (e.key === "o" || (e.key === "Enter" && !target?.closest("button,a,select,input,textarea"))) {
        const item = triageItems[selectedTriageIdx];
        if (!item?.conversationId) return;
        e.preventDefault();
        if (!openWorkerConversation(item.conversationId)) {
          toast.message(`Worker @${item.member} chat link unavailable standalone`);
        }
      } else if (e.key === "p") {
        const item = triageItems[selectedTriageIdx];
        if (!item || item.seq <= 0) return;
        e.preventDefault();
        const wasPinned = pinnedSeqs.includes(item.seq);
        handleTogglePin(item.seq);
        toast.success(wasPinned ? `Unpinned #${item.seq}` : `Pinned #${item.seq}`);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tab, triageItems, selectedTriageIdx, paletteOpen, settingsOpen, shortcutsOpen, pinnedSeqs, handleTogglePin]);

  const handleSelectSwarm = (id: string) => {
    etagRef.current = "";
    setSelectedSwarmId(id);
  };

  const handleCopyDigest = () => {
    if (snap?.swarm) void copyText(formatSwarmDigest(snap, pinnedSeqs, worktrees), "Wave digest copied");
  };

  const handleTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
    const next =
      e.key === "ArrowRight" ? (idx + 1) % TABS.length
      : e.key === "ArrowLeft" ? (idx - 1 + TABS.length) % TABS.length
      : e.key === "Home" ? 0
      : e.key === "End" ? TABS.length - 1
      : -1;
    if (next >= 0) {
      e.preventDefault();
      setTab(TABS[next].id);
    }
  };

  const handleLaunchPreset = async (preset: (typeof SWARM_PRESETS)[number]) => {
    try {
      const started = await startSwarmPreset(preset.prompt, preset.title);
      if (started) {
        toast.success(`Started "${preset.title}" swarm`);
        setTimeout(() => refreshSwarm(true), 400);
        return;
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to launch swarm");
      return;
    }
    try {
      await navigator.clipboard.writeText(preset.prompt);
      toast.success(`Copied "${preset.title}" /fleet prompt`);
    } catch {
      toast.message(preset.prompt);
    }
  };

  const tabCounts: Partial<Record<TabId, number>> = {
    triage: triageCount,
    board: snap?.head || 0,
    roster: activeCount,
    worktrees: worktrees?.worktrees?.length || 0,
  };

  return (
    <div className="min-h-screen bg-canvas text-ink flex flex-col">
      <FleetToaster theme={theme} />

      {/* Sticky Compact Sidecar Header */}
      <header className="sticky top-0 z-20 border-b border-hairline bg-surface">
        <div className="mx-auto w-full max-w-[960px] px-3 pt-2.5">
          {/* Row 1: Brand + Swarm Switcher + Controls */}
          <div className="flex items-center justify-between gap-2 pb-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                aria-hidden="true"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-chip bg-[var(--ink-button)] text-[var(--ink-button-fg)]"
              >
                <Rocket className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                {swarms.length > 1 ? (
                  <div className="flex items-center gap-1.5 min-w-0">
                    <h1 className="sr-only">{snap?.title || "Fleet"}</h1>
                    <select
                      aria-label="Active swarm"
                      value={snap?.swarm || selectedSwarmId || ""}
                      onChange={(e) => handleSelectSwarm(e.target.value)}
                      className="h-7 max-w-[165px] min-[380px]:max-w-[190px] sm:max-w-[320px] truncate rounded-chip border border-[var(--input)] bg-board px-2 text-[14px] font-semibold text-ink cursor-pointer"
                    >
                      {swarms.map((sw) => (
                        <option key={sw.id} value={sw.id}>
                          {sw.title || sw.id} ({sw.activeCount}/{sw.memberCount})
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <h1 className="text-[15px] font-semibold text-ink truncate">
                    {snap?.title || "Fleet"}
                  </h1>
                )}
              </div>
            </div>

            <div className="flex items-center gap-0.5 shrink-0">
              {hasSwarm && (
                <Button variant="ghost" size="icon" aria-label="Copy swarm digest" onClick={handleCopyDigest}>
                  <ClipboardCopy className="h-4 w-4" />
                </Button>
              )}
              <Button variant="ghost" size="icon" aria-label="Open command palette" onClick={() => setPaletteOpen(true)}>
                <Search className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Refresh swarm"
                onClick={() => {
                  refreshSwarm(true);
                  refreshWorktrees();
                }}
              >
                <RefreshCw className={cn("h-4 w-4", loading && "motion-safe:animate-spin")} />
              </Button>
              <Button variant="ghost" size="icon" aria-label="Open settings" onClick={() => setSettingsOpen(true)}>
                <Settings className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Row 2: Compact Status Telemetry (balanced padding on 380px tok pill) */}
          {hasSwarm && (
            <div className="flex flex-wrap items-center justify-between gap-2 pb-2 text-[12px] text-ink-2">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <StatusDot state={activeCount > 0 ? "working" : waitingCount > 0 ? "waiting" : "killed"} />
                <span className="num">{activeCount} working</span>
                <span className="num">{waitingCount} waiting</span>
                <span className="num text-ink-3">#{snap?.head || 0}</span>
              </div>
              <div className="flex items-center gap-1.5">
                {sseConnected && <Badge tone="success">Live</Badge>}
                {snap?.member && <Badge tone="neutral">you: {snap.member}</Badge>}
                <span className="inline-flex items-center rounded-chip bg-board px-2 py-0.5 num font-medium text-ink-2">
                  {fmtTokens(snap?.usage?.totalTokens)} tok
                </span>
              </div>
            </div>
          )}

          {/* Row 3: Zero-Clip 340px–380px Underline Tabs */}
          <nav aria-label="Primary views" className="-mb-px">
            <div
              role="tablist"
              aria-label="Fleet views"
              className="flex items-center justify-between sm:justify-start sm:gap-2 w-full"
            >
              {TABS.map(({ id, label, Icon }, idx) => {
                const selected = tab === id;
                const count = tabCounts[id];
                return (
                  <button
                    key={id}
                    id={`tab-${id}`}
                    role="tab"
                    type="button"
                    aria-selected={selected}
                    aria-controls={`panel-${id}`}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setTab(id)}
                    onKeyDown={(e) => handleTabKeyDown(e, idx)}
                    className={cn(
                      "relative inline-flex items-center justify-center gap-1 whitespace-nowrap px-1.5 sm:px-2.5 py-2 text-[12px] sm:text-[13px] font-medium cursor-pointer transition shrink-0",
                      selected ? "text-ink" : "text-ink-2 hover:text-ink",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 hidden min-[440px]:inline-block" />
                    <span>{label}</span>
                    {typeof count === "number" && count > 0 && (
                      <span
                        className={cn(
                          "rounded-full px-1.5 text-[12px] leading-4 num",
                          id === "triage"
                            ? "bg-bad-soft text-danger"
                            : "bg-track text-ink-2",
                        )}
                      >
                        {count}
                      </span>
                    )}
                    {selected && (
                      <span
                        aria-hidden="true"
                        className="absolute inset-x-0.5 bottom-0 h-[2px] rounded-full bg-blue"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 mx-auto w-full max-w-[960px] px-3 py-3">
        {error && (
          <Card className="mb-3 border-danger bg-bad-soft p-3 text-[13px] text-danger">
            {error}
          </Card>
        )}

        {tab === "worktrees" ? (
          <div id="panel-worktrees" role="tabpanel" aria-labelledby="tab-worktrees">
            <WorktreesView
              workspaceUris={workspaceUris}
              payload={worktrees}
              loading={wtLoading}
              manualRoots={manualRoots}
              onAddManualRoot={(r) => setManualRoots((prev) => (prev.includes(r) ? prev : [...prev, r]))}
              onRefresh={refreshWorktrees}
            />
          </div>
        ) : !hasSwarm ? (
          <div className="space-y-4">
            <div className="space-y-2.5">
              <h2 className="text-[16px] font-semibold text-ink">Launch an Antigravity swarm</h2>
              <p className="text-[14px] text-ink-2">
                No active swarm yet. Launch a preset or open a recent swarm below.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                {SWARM_PRESETS.map((preset) => (
                  <Card key={preset.id} className="p-3 flex flex-col justify-between gap-2.5">
                    <div className="space-y-1">
                      <p className="text-[14px] font-semibold text-ink">{preset.title}</p>
                      <p className="text-[13px] text-ink-2">{preset.summary}</p>
                    </div>
                    <Button variant="primary" onClick={() => handleLaunchPreset(preset)}>
                      {window.sidecar?.agent?.startConversation ? (
                        <>
                          <Rocket className="h-3.5 w-3.5" />
                          Launch swarm
                        </>
                      ) : (
                        <>
                          <ClipboardCopy className="h-3.5 w-3.5" />
                          Copy /fleet prompt
                        </>
                      )}
                    </Button>
                  </Card>
                ))}
              </div>
            </div>

            {swarms.length > 0 && (
              <section aria-labelledby="recent-swarms-heading" className="space-y-2">
                <h2 id="recent-swarms-heading" className="text-[14px] font-semibold text-ink">
                  Recent swarms ({swarms.length})
                </h2>
                <div className="space-y-2">
                  {swarms.map((sw) => (
                    <Card key={sw.id} className="p-3 flex items-center justify-between gap-2">
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-[14px] font-semibold text-ink truncate">{sw.title || sw.id}</p>
                        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-2 num">
                          <span>{sw.activeCount} active</span>
                          <span>{sw.memberCount} members</span>
                          <span>#{sw.head}</span>
                          <span>{fmtTokens(sw.totalTokens)} tok</span>
                        </div>
                      </div>
                      <Button onClick={() => handleSelectSwarm(sw.id)}>
                        Open
                      </Button>
                    </Card>
                  ))}
                </div>
              </section>
            )}
          </div>
        ) : (
          <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {tab === "triage" && (
              <TriageView
                snap={snap!}
                pinnedSeqs={pinnedSeqs}
                selectedIdx={selectedTriageIdx}
                replyNonce={triageReplyNonce}
                onSelectIdx={setSelectedTriageIdx}
                onTogglePin={handleTogglePin}
                onJumpToBoardSeq={(seq) => {
                  setHighlightSeq(seq);
                  setTab("board");
                }}
                onRefresh={() => refreshSwarm(true)}
              />
            )}
            {tab === "board" && (
              <BoardView
                snap={snap!}
                highlightSeq={highlightSeq}
                pinnedSeqs={pinnedSeqs}
                quickFilter={boardQuickFilter}
                onQuickFilterChange={setBoardQuickFilter}
                onCopyWaveDigest={handleCopyDigest}
                onTogglePin={handleTogglePin}
                onClearHighlight={() => setHighlightSeq(null)}
                onRefresh={() => refreshSwarm(true)}
              />
            )}
            {tab === "roster" && <RosterView snap={snap!} onRefresh={() => refreshSwarm(true)} />}
            {tab === "graph" && <GraphView snap={snap!} />}
          </div>
        )}
      </main>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        snap={snap}
        swarms={swarms}
        onSelectTab={setTab}
        onSelectSwarm={handleSelectSwarm}
        onCopyDigest={handleCopyDigest}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
      />

      {/* Keyboard Shortcuts Cheatsheet (?) */}
      <Modal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} title="Keyboard shortcuts">
        <dl className="divide-y divide-hairline text-[13px]">
          {[
            ["j / k", "Move triage"],
            ["o / Enter", "Open chat"],
            ["p", "Pin #seq"],
            ["r", "Reply / nudge"],
            ["f", "Cycle filters"],
            ["1 - 5", "Switch tab"],
            ["Ctrl/Cmd+K", "Command palette"],
            ["?", "Shortcuts"],
          ].map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
              <dt className="text-ink-2">{desc}</dt>
              <dd className="rounded-chip border border-hairline bg-board px-1.5 py-0.5 text-[12px] text-ink mono shrink-0">
                {key}
              </dd>
            </div>
          ))}
        </dl>
      </Modal>

      {/* Settings Dialog (Guardrail #67: Theme switch lives strictly inside Settings) */}
      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Settings">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-medium text-ink">Appearance</span>
              {embedded && hostSynced && <Badge tone="info">Synced to Antigravity</Badge>}
            </div>
            <SegmentControl
              label="Appearance theme"
              value={theme}
              onChange={(next) => {
                setHostSynced(false);
                setTheme(next);
              }}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </div>

          <div className="space-y-1.5">
            <span className="block text-[13px] font-medium text-ink">Poll cadence</span>
            <SegmentControl
              label="Poll cadence"
              value={pollMs}
              onChange={setPollMs}
              options={[
                { value: "2000", label: "2s" },
                { value: "5000", label: "5s" },
                { value: "0", label: "Paused" },
              ]}
            />
          </div>

          <div className="rounded-card bg-board p-3 text-[12px] text-ink-2 space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-ink">
              <CommandIcon className="h-3.5 w-3.5" />
              <span>Fleet Antigravity Plugin v1.9.0</span>
            </div>
            <p>Local swarm boards &amp; transcripts on loopback. Zero external telemetry.</p>
          </div>
        </div>
      </Modal>
    </div>
  );
}
