import { useEffect, useMemo, useState } from "../hooks";
import { Search } from "../icons";
import { openWorkerConversation } from "../sidecar";
import type { SwarmSnapshot, SwarmSummary, TabId } from "../types";
import { cn } from "../ui";

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
  onSelectTab,
  onSelectSwarm,
  onCopyDigest,
  onOpenSettings,
  onOpenShortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snap: SwarmSnapshot | null;
  swarms: SwarmSummary[];
  onSelectTab: (tab: TabId) => void;
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
      ...swarms.map((sw) => ({
        id: `sw-${sw.id}`,
        group: "Swarms",
        label: sw.title || sw.id,
        meta: `${sw.activeCount}/${sw.memberCount}`,
        onSelect: () => onSelectSwarm(sw.id),
      })),
      ...(window.sidecar?.ui?.toggleConversation
        ? (snap?.members || [])
            .filter((m) => m.conversation_id)
            .map((m) => ({
              id: `ch-${m.name}`,
              group: "Worker Chat",
              label: m.name,
              meta: m.status,
              onSelect: () => openWorkerConversation(m.conversation_id),
            }))
        : []),
    ];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    const terms = q.split(/\s+/);
    return list.filter((it) => {
      const hay = `${it.group} ${it.label} ${it.meta || ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [query, snap, swarms, onSelectTab, onCopyDigest, onOpenSettings, onOpenShortcuts, onSelectSwarm]);

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
            placeholder="Jump to tab, swarm, or worker"
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
