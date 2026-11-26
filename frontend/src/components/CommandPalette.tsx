import { useEffect, useMemo, useState } from "../hooks";
import { Search } from "../icons";
import { openWorkerConversation } from "../sidecar";
import type { SwarmSnapshot, SwarmSummary, TabId, WorktreesPayload } from "../types";
import { cn, maskHome } from "../ui";

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  meta?: string;
  onSelect: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  snap,
  swarms,
  worktrees,
  onSelectTab,
  onJumpToBoard,
  onSelectSwarm,
  onCopyDigest,
  onOpenSettings,
  onOpenShortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snap: SwarmSnapshot | null;
  swarms: SwarmSummary[];
  worktrees?: WorktreesPayload | null;
  onSelectTab: (tab: TabId) => void;
  onJumpToBoard: (seq: number, agent?: string) => void;
  onSelectSwarm: (id: string) => void;
  onCopyDigest: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      } else if (open && e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const members = (snap?.members || []).filter((m) => !m.killed);
    const recentMsgs = (snap?.messages || []).filter((m) => !m.control).slice(-20).reverse();
    const list: PaletteItem[] = [
      ...([
        ["v-triage", "Needs you", () => onSelectTab("triage")],
        ["v-board", "Board", () => onSelectTab("board")],
        ["v-roster", "Roster", () => onSelectTab("roster")],
        ["v-graph", "Mention graph", () => onSelectTab("graph")],
        ["v-worktrees", "Git worktrees", () => onSelectTab("worktrees")],
        ...(snap?.swarm ? [["a-digest", "Wave digest", onCopyDigest] as const] : []),
        ["a-settings", "Settings", onOpenSettings],
        ["a-keys", "Keyboard shortcuts", onOpenShortcuts, "?"],
      ] as const).map(([id, label, onSelect, meta]) => ({ id, group: "Views", label, meta, onSelect })),
      ...members.flatMap((m) => {
        const rows: PaletteItem[] = [
          {
            id: `wf-${m.name}`,
            group: "Workers",
            label: `Filter Board: @${m.name}`,
            meta: `${m.posts} posts`,
            onSelect: () => onJumpToBoard(m.lastPostSeq || 0, m.name),
          },
          {
            id: `wr-${m.name}`,
            group: "Workers",
            label: `Roster: @${m.name}`,
            meta: m.status,
            onSelect: () => onSelectTab("roster"),
          },
        ];
        if (m.conversation_id && window.sidecar?.ui?.toggleConversation) {
          rows.push({
            id: `ch-${m.name}`,
            group: "Workers",
            label: `Open chat: @${m.name}`,
            meta: m.status,
            onSelect: () => openWorkerConversation(m.conversation_id),
          });
        }
        return rows;
      }),
      ...(snap?.gateReadiness?.nextAction
        ? [{
            id: "tg-next",
            group: "Triage & gates",
            label: `Next gate: ${snap.gateReadiness.nextAction.label}`,
            meta: snap.gateReadiness.nextAction.seq ? `#${snap.gateReadiness.nextAction.seq}` : undefined,
            onSelect: () => onJumpToBoard(snap.gateReadiness?.nextAction?.seq || snap.gateReadiness?.pendingSeq || 0),
          }]
        : []),
      ...(snap?.triage || []).map((it) => ({
        id: `tg-${it.id}`,
        group: "Triage & gates",
        label: it.title,
        meta: it.seq > 0 ? `#${it.seq}` : it.severity,
        onSelect: () => (it.seq > 0 ? onJumpToBoard(it.seq) : onSelectTab("triage")),
      })),
      ...recentMsgs.map((m) => ({
        id: `bm-${m.seq}`,
        group: "Board posts",
        label: `#${m.seq} @${m.agent}: ${m.text.replace(/\s+/g, " ").slice(0, 56)}`,
        onSelect: () => onJumpToBoard(m.seq),
      })),
      ...(worktrees?.worktrees || []).map((wt) => ({
        id: `wt-${wt.id}`,
        group: "Worktrees",
        label: `${wt.branch}${wt.landStatus && wt.landStatus !== "main" ? ` (${wt.landStatus})` : ""}`,
        meta: maskHome(wt.path),
        onSelect: () => onSelectTab("worktrees"),
      })),
      ...swarms.map((sw) => ({
        id: `sw-${sw.id}`,
        group: "Swarms",
        label: sw.title || sw.id,
        meta: `${sw.activeCount}/${sw.memberCount} · #${sw.head}`,
        onSelect: () => onSelectSwarm(sw.id),
      })),
    ];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    const terms = q.split(/\s+/);
    return list.filter((it) => {
      const hay = `${it.group} ${it.label} ${it.meta || ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [query, snap, swarms, worktrees, onSelectTab, onJumpToBoard, onCopyDigest, onOpenSettings, onOpenShortcuts, onSelectSwarm]);

  useEffect(() => {
    setActiveIdx((i) => (items.length ? Math.min(i, items.length - 1) : 0));
  }, [items.length]);

  if (!open) return null;

  const runItem = (item?: PaletteItem) => {
    if (!item) return;
    onOpenChange(false);
    item.onSelect();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Fleet command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--scrim)] p-3 pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div className="w-full max-w-[440px] overflow-hidden rounded-card border border-hairline bg-surface shadow-[var(--elev-lift)]">
        <div className="flex items-center gap-2 border-b border-hairline px-3">
          <Search className="h-4 w-4 text-ink-3 shrink-0" />
          <input
            autoFocus
            type="text"
            cmdk-input=""
            role="combobox"
            aria-expanded="true"
            aria-label="Fleet command palette"
            placeholder="Search tabs, @workers, #seq, worktrees, swarms"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIdx((i) => (items.length ? (i + 1) % items.length : 0));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIdx((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runItem(items[activeIdx]);
              }
            }}
            className="h-11 w-full bg-transparent text-[14px] text-ink placeholder:text-ink-3 focus:outline-none"
          />
        </div>
        <div role="listbox" className="max-h-[320px] overflow-y-auto p-1">
          {items.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-ink-3">No matches.</p>
          ) : (
            items.map((item, idx) => (
              <div key={item.id}>
                {(idx === 0 || items[idx - 1].group !== item.group) && (
                  <div className="px-2 py-1 text-[12px] font-medium text-ink-3">{item.group}</div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={idx === activeIdx}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => runItem(item)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-chip px-2 py-2 text-left text-[13px] cursor-pointer",
                    idx === activeIdx ? "bg-blue-soft text-info" : "text-ink hover:bg-track",
                  )}
                >
                  <span className="truncate">{item.label}</span>
                  {item.meta && <span className="t3 num shrink-0">{item.meta}</span>}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
