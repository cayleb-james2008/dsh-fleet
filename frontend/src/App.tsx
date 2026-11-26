import { useCallback, useEffect, useRef, useState } from "./hooks";
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
  ["feature-verifier", "Feature and verifier", "Isolated worktree + verifier check", "/fleet Build on worktree, test, @verifier [done]."],
  ["audit-harden", "Audit and harden", "Run tests and security checks", "/fleet Audit tests, security, UI craft."],
  ["multi-lane", "Parallel lanes", "Shard worktrees with a monitor", "/fleet Shard worktrees with monitor + plan.json."],
].map(([id, title, summary, prompt]) => ({ id, title, summary, prompt }));

const TABS: Array<{ id: TabId; label: string; Icon: typeof Inbox }> = [
  ["triage", "Triage", Inbox],
  ["board", "Board", Activity],
  ["roster", "Roster", Users],
  ["graph", "Graph", Network],
  ["worktrees", "Git", GitBranch],
].map(([id, label, Icon]) => ({ id: id as TabId, label: label as string, Icon: Icon as typeof Inbox }));

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
  const [boardAgentFilter, setBoardAgentFilter] = useState<string>("all");
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

  const allRoots = [...new Set([...workspaceUris, ...manualRoots])];
  const allRootsKey = allRoots.join("\0");

  const refreshWorktrees = useCallback(async () => {
    if (!allRootsKey) { setWorktrees(null); return; }
    setWtLoading(true);
    try { setWorktrees(await fetchWorktrees(allRootsKey.split("\0"))); } catch {} finally { setWtLoading(false); }
  }, [allRootsKey]);

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
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target?.isContentEditable) return;
      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (shortcutsOpen) return;
      if (e.key >= "1" && e.key <= "5") {
        const nextTab = TABS[Number(e.key) - 1];
        if (nextTab) { e.preventDefault(); setTab(nextTab.id); }
        return;
      }
      if (e.key === "f" && tab === "board") {
        e.preventDefault();
        const order: BoardQuickFilter[] = ["all", "needs_reply", "done", "blocked"];
        setBoardQuickFilter((cur) => order[(order.indexOf(cur) + 1) % order.length]);
        return;
      }
      if (tab !== "triage" || triageItems.length === 0) return;
      const item = triageItems[selectedTriageIdx];
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        setSelectedTriageIdx((i) => Math.max(0, Math.min(triageItems.length - 1, i + (e.key === "j" ? 1 : -1))));
      } else if (e.key === "r") {
        e.preventDefault();
        setTriageReplyNonce((n) => n + 1);
      } else if (e.key === "o" || (e.key === "Enter" && !target?.closest("button,a,select,input,textarea"))) {
        if (!item?.conversationId) return;
        e.preventDefault();
        if (!openWorkerConversation(item.conversationId)) toast.message(`@${item.member} chat unavailable standalone`);
      } else if (e.key === "p" && item && item.seq > 0) {
        e.preventDefault();
        const was = pinnedSeqs.includes(item.seq);
        handleTogglePin(item.seq);
        toast.success(`${was ? "Unpinned" : "Pinned"} #${item.seq}`);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tab, triageItems, selectedTriageIdx, paletteOpen, settingsOpen, shortcutsOpen, pinnedSeqs, handleTogglePin]);

  const handleSelectSwarm = (id: string) => {
    etagRef.current = "";
    setSelectedSwarmId(id);
    setHighlightSeq(null);
    setBoardAgentFilter("all");
  };

  const handleJumpToBoard = (seq: number, agent = "all") => {
    setHighlightSeq(seq > 0 ? seq : null);
    setBoardAgentFilter(agent || "all");
    if (agent && agent !== "all") setBoardQuickFilter("all");
    setTab("board");
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
      if (await startSwarmPreset(preset.prompt, preset.title)) {
        toast.success(`Started "${preset.title}"`);
        setTimeout(() => refreshSwarm(true), 400);
        return;
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Launch failed");
      return;
    }
    void copyText(preset.prompt, `Copied "${preset.title}" prompt`);
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
        <div className="mx-auto w-full max-w-[960px] px-3 pt-2">
          {/* Row 1: Brand + Swarm Switcher + Controls */}
          <div className="row pb-2">
            <div className="flex items-center gap-2 min-w-0">
              <span aria-hidden="true" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-chip bg-[var(--ink-button)] text-[var(--ink-button-fg)]">
                <Rocket className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                {swarms.length > 1 ? (
                  <>
                    <h1 className="sr-only">{snap?.title || "Fleet"}</h1>
                    <select
                      aria-label="Active swarm"
                      value={snap?.swarm || selectedSwarmId || ""}
                      onChange={(e) => handleSelectSwarm(e.target.value)}
                      className="h-7 max-w-[165px] min-[380px]:max-w-[190px] sm:max-w-[320px] truncate rounded-chip border border-[var(--edge)] bg-board px-2 h2 cursor-pointer"
                    >
                      {swarms.map((sw) => (
                        <option key={sw.id} value={sw.id}>{sw.title || sw.id} ({sw.activeCount}/{sw.memberCount})</option>
                      ))}
                    </select>
                  </>
                ) : (
                  <h1 className="h2 truncate">{snap?.title || "Fleet"}</h1>
                )}
              </div>
            </div>

            <div className="f1 shrink-0">
              {([
                ...(hasSwarm ? [["Copy swarm digest", ClipboardCopy, handleCopyDigest, false] as const] : []),
                ["Open command palette", Search, () => setPaletteOpen(true), false] as const,
                ["Refresh swarm", RefreshCw, () => { refreshSwarm(true); refreshWorktrees(); }, loading] as const,
                ["Open settings", Settings, () => setSettingsOpen(true), false] as const,
              ]).map(([label, Icon, fn, spin]) => (
                <Button key={label} variant="ghost" size="icon" aria-label={label} onClick={fn}>
                  <Icon className={cn("h-4 w-4", spin && "motion-safe:animate-spin")} />
                </Button>
              ))}
            </div>
          </div>

          {hasSwarm && (
            <div className="wrap justify-between gap-2 pb-2 text-[12px] text-ink-2">
              <div className="wrap gap-2 min-w-0 num">
                <StatusDot state={activeCount > 0 ? "working" : waitingCount > 0 ? "waiting" : "killed"} />
                {activeCount} working · {waitingCount} waiting <span className="text-ink-3">#{snap?.head || 0}</span>
              </div>
              <div className="f1">
                {sseConnected && <Badge tone="success">Live</Badge>}
                {snap?.member && <Badge>you: {snap.member}</Badge>}
                <span className="inline-flex items-center rounded-chip bg-board px-2 py-1 num font-medium text-ink-2">{fmtTokens(snap?.usage?.totalTokens)} tok</span>
              </div>
            </div>
          )}

          {/* Row 3: Zero-Clip 340px–380px Underline Tabs */}
          <nav aria-label="Primary views" className="-mb-px">
            <div role="tablist" aria-label="Fleet views" className="flex items-center justify-between sm:justify-start sm:gap-2 w-full">
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
                    className={cn("relative inline-flex items-center justify-center gap-1 whitespace-nowrap px-2 py-2 text-[12px] sm:text-[13px] font-medium cursor-pointer transition shrink-0", selected ? "text-ink" : "text-ink-2 hover:text-ink")}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 hidden min-[440px]:inline-block" />
                    {label}
                    {typeof count === "number" && count > 0 && (
                      <span className={cn("rounded-full px-2 text-[12px] leading-4 num", id === "triage" ? "bg-bad-soft text-danger" : "bg-track text-ink-2")}>{count}</span>
                    )}
                    {selected && <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-blue" />}
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
            <div className="space-y-2">
              <h2 className="text-[16px] font-semibold text-ink">Start a swarm</h2>
              <p className="text-[14px] text-ink-2">Pick a preset or open a recent swarm.</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                {SWARM_PRESETS.map((p) => (
                  <Card key={p.id} className="p-3 flex flex-col justify-between gap-2">
                    <div>
                      <p className="h2">{p.title}</p>
                      <p className="text-[13px] text-ink-2">{p.summary}</p>
                    </div>
                    <Button variant="primary" onClick={() => handleLaunchPreset(p)}>
                      {window.sidecar?.agent?.startConversation ? <><Rocket />Launch swarm</> : <><ClipboardCopy />Copy /fleet prompt</>}
                    </Button>
                  </Card>
                ))}
              </div>
            </div>

            {swarms.length > 0 && (
              <section aria-labelledby="recent-swarms-heading" className="space-y-2">
                <h2 id="recent-swarms-heading" className="h2">Recent swarms ({swarms.length})</h2>
                <div className="space-y-2">
                  {swarms.map((sw) => (
                    <Card key={sw.id} className="p-3 row">
                      <div className="min-w-0">
                        <p className="h2 truncate">{sw.title || sw.id}</p>
                        <div className="wrap gap-2 text-[12px] text-ink-2 num">
                          <span>{sw.activeCount} active</span><span>{sw.memberCount} members</span><span>#{sw.head}</span><span>{fmtTokens(sw.totalTokens)} tok</span>
                        </div>
                      </div>
                      <Button onClick={() => handleSelectSwarm(sw.id)}>Open</Button>
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
                onJumpToBoardSeq={handleJumpToBoard}
                onRefresh={() => refreshSwarm(true)}
              />
            )}
            {tab === "board" && (
              <BoardView
                snap={snap!}
                highlightSeq={highlightSeq}
                pinnedSeqs={pinnedSeqs}
                quickFilter={boardQuickFilter}
                agentFilter={boardAgentFilter}
                onQuickFilterChange={setBoardQuickFilter}
                onAgentFilterChange={setBoardAgentFilter}
                onCopyWaveDigest={handleCopyDigest}
                onTogglePin={handleTogglePin}
                onClearHighlight={() => setHighlightSeq(null)}
                onRefresh={() => refreshSwarm(true)}
              />
            )}
            {tab === "roster" && <RosterView snap={snap!} onJumpToBoardSeq={handleJumpToBoard} onRefresh={() => refreshSwarm(true)} />}
            {tab === "graph" && <GraphView snap={snap!} />}
          </div>
        )}
      </main>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        snap={snap}
        swarms={swarms}
        worktrees={worktrees}
        onSelectTab={setTab}
        onJumpToBoard={handleJumpToBoard}
        onSelectSwarm={handleSelectSwarm}
        onCopyDigest={handleCopyDigest}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
      />

      {/* Keyboard Shortcuts Cheatsheet (?) */}
      <Modal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} title="Keyboard shortcuts">
        <dl className="divide-y divide-hairline text-[13px]">
          {"j / k:Triage,o / Enter:Chat,p:Pin,r:Reply,f:Filter,1 - 5:Tab,Ctrl/Cmd+K:Palette,?:Help".split(",").map((row) => {
            const [key, desc] = row.split(":");
            return (
              <div key={key} className="row py-2 first:pt-0 last:pb-0">
                <dt className="text-ink-2">{desc}</dt>
                <dd className="rounded-chip border border-hairline bg-board px-2 py-0 text-[12px] text-ink mono shrink-0">{key}</dd>
              </div>
            );
          })}
        </dl>
      </Modal>

      {/* Settings Dialog (Guardrail #67: Theme switch lives strictly inside Settings) */}
      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Settings">
        <div className="space-y-4">
          <div className="space-y-1">
            <div className="row">
              <span className="text-[13px] font-medium text-ink">Appearance</span>
              {embedded && hostSynced && <Badge tone="info">Synced to Antigravity</Badge>}
            </div>
            <SegmentControl
              label="Appearance theme"
              value={theme}
              onChange={(next) => { setHostSynced(false); setTheme(next); }}
              options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
            />
          </div>
          <div className="space-y-1">
            <span className="block text-[13px] font-medium text-ink">Poll cadence</span>
            <SegmentControl
              label="Poll cadence"
              value={pollMs}
              onChange={setPollMs}
              options={[{ value: "2000", label: "2s" }, { value: "5000", label: "5s" }, { value: "0", label: "Paused" }]}
            />
          </div>
          <div className="rounded-card bg-board p-3 text-[12px] text-ink-2 space-y-1">
            <div className="f1 font-medium text-ink">
              <CommandIcon />
              <span>Fleet Antigravity Plugin v1.16.0</span>
            </div>
            <p>Reads local swarm files over loopback with no telemetry.</p>
          </div>
        </div>
      </Modal>
    </div>
  );
}
