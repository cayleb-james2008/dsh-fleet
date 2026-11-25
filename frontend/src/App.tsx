import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { m } from "motion/react";
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
} from "lucide-react";
import { BoardView } from "./components/BoardView";
import { CommandPalette } from "./components/CommandPalette";
import { GraphView } from "./components/GraphView";
import { RosterView } from "./components/RosterView";
import { TriageView } from "./components/TriageView";
import { WorktreesView } from "./components/WorktreesView";
import { glide } from "./motion";
import {
  applyTheme,
  fetchSwarmSnapshot,
  fetchSwarms,
  fetchWorktrees,
  inferThemeFromCssColor,
  isEmbeddedHost,
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
  fmtTokens,
  formatSwarmDigest,
  toast,
} from "./ui";

const SWARM_PRESETS = [
  {
    id: "feature-verifier",
    title: "Feature + Verifier",
    summary: "Isolated worktree builder + cold verifier gate",
    prompt:
      "/fleet Implement the scoped feature on an isolated git worktree (`workspace: \"share\"`), write targeted tests, and hand off `@verifier [done]` for cold verification before finishing.",
  },
  {
    id: "audit-harden",
    title: "Audit & Harden",
    summary: "Security, edge-case, and UI craft review lane",
    prompt:
      "/fleet Run a parallel audit across tests, security boundaries, and frontend craft with cold verification reports and zero unverified claims.",
  },
  {
    id: "multi-lane",
    title: "Multi-Lane Ship",
    summary: "Sharded parallel builders + monitor + verifier",
    prompt:
      "/fleet Split work across isolated worktree lanes with explicit file ownership, add a stall monitor, verify end-to-end builds, and publish `plan.json`.",
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
    window.sidecar?.getWorkspaceUris?.().then((uris) => {
      if (active && Array.isArray(uris)) setWorkspaceUris(uris);
    });
    const unsub = window.sidecar?.onWorkspaceChange?.((uris) => {
      if (active && Array.isArray(uris)) setWorkspaceUris(uris);
    });
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

  const handleSelectSwarm = (id: string) => {
    etagRef.current = "";
    setSelectedSwarmId(id);
  };

  const handleCopyDigest = async () => {
    if (!snap?.swarm) return;
    const md = formatSwarmDigest(snap);
    try {
      await navigator.clipboard.writeText(md);
      toast.success("Swarm digest copied");
    } catch {
      toast.error("Clipboard unavailable");
    }
  };

  const handleTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setTab(TABS[(idx + 1) % TABS.length].id);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setTab(TABS[(idx - 1 + TABS.length) % TABS.length].id);
    } else if (e.key === "Home") {
      e.preventDefault();
      setTab(TABS[0].id);
    } else if (e.key === "End") {
      e.preventDefault();
      setTab(TABS[TABS.length - 1].id);
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
    <div className="min-h-screen bg-[var(--canvas)] text-[var(--ink)] flex flex-col">
      <FleetToaster theme={theme} />

      {/* Sticky Compact Sidecar Header */}
      <header className="sticky top-0 z-20 border-b border-[var(--hairline)] bg-[var(--surface)]">
        <div className="mx-auto w-full max-w-[960px] px-3 pt-2.5">
          {/* Row 1: Brand + Swarm Switcher + Controls */}
          <div className="flex items-center justify-between gap-2 pb-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                aria-hidden="true"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-chip)] bg-[var(--ink-button)] text-[var(--ink-button-fg)]"
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
                      className="h-7 max-w-[165px] min-[380px]:max-w-[190px] sm:max-w-[320px] truncate rounded-[var(--radius-chip)] border border-[var(--input)] bg-[var(--board)] px-2 text-[14px] font-semibold text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--ring)] cursor-pointer"
                    >
                      {swarms.map((sw) => (
                        <option key={sw.id} value={sw.id}>
                          {sw.title || sw.id} ({sw.activeCount}/{sw.memberCount})
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <h1 className="text-[15px] font-semibold text-[var(--ink)] truncate">
                    {snap?.title || "Fleet"}
                  </h1>
                )}
              </div>
            </div>

            <div className="flex items-center gap-0.5 shrink-0">
              {hasSwarm && (
                <span
                  className="hidden sm:inline-flex items-center rounded-[var(--radius-chip)] bg-[var(--board)] px-2 py-1 text-[12px] font-medium text-[var(--ink-2)] num mr-0.5"
                  title="Total tokens across swarm transcripts"
                >
                  {fmtTokens(snap?.usage?.totalTokens)} tok
                </span>
              )}
              {hasSwarm && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Copy swarm digest"
                  title="Copy Markdown swarm digest"
                  onClick={handleCopyDigest}
                >
                  <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label="Open command palette"
                title="Command palette (Cmd/Ctrl+K)"
                onClick={() => setPaletteOpen(true)}
              >
                <Search className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Refresh swarm"
                title="Refresh"
                onClick={() => {
                  refreshSwarm(true);
                  refreshWorktrees();
                }}
              >
                <RefreshCw className={cn("h-4 w-4", loading && "motion-safe:animate-spin")} aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Open settings"
                title="Settings"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          {/* Row 2: Compact Status Telemetry (balanced padding on 380px tok pill) */}
          {hasSwarm && (
            <div className="flex flex-wrap items-center justify-between gap-2 pb-2 text-[12px] text-[var(--ink-2)]">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <StatusDot state={activeCount > 0 ? "working" : waitingCount > 0 ? "waiting" : "killed"} />
                <span className="num">{activeCount} working</span>
                <span className="num">{waitingCount} waiting</span>
                <span className="num text-[var(--ink-3)]">#{snap?.head || 0}</span>
              </div>
              <div className="flex items-center gap-1.5">
                {sseConnected && <Badge tone="success">Live</Badge>}
                {snap?.member && <Badge tone="neutral">you: {snap.member}</Badge>}
                <span className="sm:hidden inline-flex items-center rounded-[var(--radius-chip)] bg-[var(--board)] px-2 py-0.5 num font-medium text-[var(--ink-2)]">
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
                      "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--ring)]",
                      selected ? "text-[var(--ink)]" : "text-[var(--ink-2)] hover:text-[var(--ink)]",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 hidden min-[440px]:inline-block" aria-hidden="true" />
                    <span>{label}</span>
                    {typeof count === "number" && count > 0 && (
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.2 text-[12px] leading-4 num",
                          id === "triage"
                            ? "bg-[var(--bad-soft)] text-[var(--destructive-foreground)]"
                            : "bg-[var(--track)] text-[var(--ink-2)]",
                        )}
                      >
                        {count}
                      </span>
                    )}
                    {selected && (
                      <m.span
                        layoutId="fleet-tab-underline"
                        transition={glide}
                        className="absolute inset-x-0.5 bottom-0 h-[2px] rounded-full bg-[var(--blue)]"
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
      <main className="flex-1 mx-auto w-full max-w-[960px] px-3 py-3.5">
        {error && (
          <Card className="mb-3 border-[var(--destructive-foreground)] bg-[var(--bad-soft)] p-3 text-[13px] text-[var(--destructive-foreground)]">
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
              <h2 className="text-[16px] font-semibold text-[var(--ink)]">Launch an Antigravity swarm</h2>
              <p className="text-[14px] text-[var(--ink-2)]">
                No active swarm is attached to this conversation yet. Start a coordinated swarm with one click or inspect any recent swarm below.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                {SWARM_PRESETS.map((preset) => (
                  <Card key={preset.id} className="p-3 flex flex-col justify-between gap-2.5">
                    <div className="space-y-1">
                      <p className="text-[14px] font-semibold text-[var(--ink)]">{preset.title}</p>
                      <p className="text-[13px] text-[var(--ink-2)]">{preset.summary}</p>
                    </div>
                    <Button variant="primary" size="sm" onClick={() => handleLaunchPreset(preset)}>
                      {window.sidecar?.agent?.startConversation ? (
                        <>
                          <Rocket className="h-3.5 w-3.5" aria-hidden="true" />
                          Launch swarm
                        </>
                      ) : (
                        <>
                          <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
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
                <h2 id="recent-swarms-heading" className="text-[14px] font-semibold text-[var(--ink)]">
                  Recent swarms ({swarms.length})
                </h2>
                <div className="space-y-2">
                  {swarms.map((sw) => (
                    <Card key={sw.id} className="p-3 flex items-center justify-between gap-2">
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-[14px] font-semibold text-[var(--ink)] truncate">{sw.title || sw.id}</p>
                        <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--ink-2)] num">
                          <span>{sw.activeCount} active</span>
                          <span>{sw.memberCount} members</span>
                          <span>#{sw.head}</span>
                          <span>{fmtTokens(sw.totalTokens)} tok</span>
                        </div>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => handleSelectSwarm(sw.id)}>
                        Open
                      </Button>
                    </Card>
                  ))}
                </div>
              </section>
            )}
          </div>
        ) : (
          <>
            {tab === "triage" && (
              <div id="panel-triage" role="tabpanel" aria-labelledby="tab-triage">
                <TriageView
                  snap={snap!}
                  pinnedSeqs={pinnedSeqs}
                  onTogglePin={handleTogglePin}
                  onJumpToBoardSeq={(seq) => {
                    setHighlightSeq(seq);
                    setTab("board");
                  }}
                  onRefresh={() => refreshSwarm(true)}
                />
              </div>
            )}
            {tab === "board" && (
              <div id="panel-board" role="tabpanel" aria-labelledby="tab-board">
                <BoardView
                  snap={snap!}
                  highlightSeq={highlightSeq}
                  pinnedSeqs={pinnedSeqs}
                  onTogglePin={handleTogglePin}
                  onClearHighlight={() => setHighlightSeq(null)}
                />
              </div>
            )}
            {tab === "roster" && (
              <div id="panel-roster" role="tabpanel" aria-labelledby="tab-roster">
                <RosterView snap={snap!} onRefresh={() => refreshSwarm(true)} />
              </div>
            )}
            {tab === "graph" && (
              <div id="panel-graph" role="tabpanel" aria-labelledby="tab-graph">
                <GraphView snap={snap!} />
              </div>
            )}
          </>
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
      />

      {/* Settings Dialog (Guardrail #67: Theme switch lives strictly inside Settings) */}
      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Settings">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-medium text-[var(--ink)]">Appearance</span>
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
            <span className="block text-[13px] font-medium text-[var(--ink)]">Live Poll Cadence</span>
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

          <div className="rounded-[var(--radius-card)] bg-[var(--board)] p-3 text-[12px] text-[var(--ink-2)] space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-[var(--ink)]">
              <CommandIcon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Fleet Antigravity Plugin v1.3.0</span>
            </div>
            <p>
              Reads Antigravity native swarm boards and transcripts locally on loopback with zero external telemetry.
            </p>
          </div>
        </div>
      </Modal>
    </div>
  );
}
