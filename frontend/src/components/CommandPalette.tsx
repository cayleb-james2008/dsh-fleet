import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { openWorkerConversation } from "../sidecar";
import type { SwarmSnapshot, SwarmSummary, TabId } from "../types";
import { cn } from "../ui";

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  meta?: string;
  searchText: string;
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
      { id: "v-triage", group: "Views", label: "Needs-you Triage & Plan", searchText: "triage needs you plan", onSelect: () => onSelectTab("triage") },
      { id: "v-board", group: "Views", label: "Swarm Board Feed", searchText: "board feed posts", onSelect: () => onSelectTab("board") },
      { id: "v-roster", group: "Views", label: "Worker Roster & Tokens", searchText: "roster workers tokens", onSelect: () => onSelectTab("roster") },
      { id: "v-graph", group: "Views", label: "@Mention Graph & Replay", searchText: "graph mention replay", onSelect: () => onSelectTab("graph") },
      { id: "v-worktrees", group: "Views", label: "Git Worktrees", searchText: "worktrees git branches", onSelect: () => onSelectTab("worktrees") },
    ];
    if (snap?.swarm) {
      list.push({
        id: "a-digest",
        group: "Views",
        label: "Copy wave digest",
        searchText: "copy wave swarm digest markdown summary",
        onSelect: onCopyDigest,
      });
    }
    list.push(
      { id: "a-settings", group: "Views", label: "Settings", searchText: "settings theme preferences", onSelect: onOpenSettings },
      { id: "a-keys", group: "Views", label: "Keyboard shortcuts", meta: "?", searchText: "keyboard shortcuts cheatsheet help ?", onSelect: onOpenShortcuts },
    );
    for (const sw of swarms) {
      list.push({
        id: `sw-${sw.id}`,
        group: "Swarms",
        label: sw.title || sw.id,
        meta: `${sw.activeCount}/${sw.memberCount}`,
        searchText: `swarm ${sw.title} ${sw.id}`,
        onSelect: () => onSelectSwarm(sw.id),
      });
    }
    if (window.sidecar?.ui?.toggleConversation) {
      for (const m of snap?.members || []) {
        if (!m.conversation_id) continue;
        list.push({
          id: `ch-${m.name}`,
          group: "Open Worker Chat",
          label: m.name,
          meta: m.status,
          searchText: `chat worker ${m.name} ${m.role}`,
          onSelect: () => openWorkerConversation(m.conversation_id),
        });
      }
    }
    const q = query.trim().toLowerCase();
    if (!q) return list;
    const terms = q.split(/\s+/);
    return list.filter((it) => {
      const hay = `${it.label} ${it.searchText}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [query, snap, swarms, onSelectTab, onCopyDigest, onOpenSettings, onOpenShortcuts, onSelectSwarm]);

  useEffect(() => {
    setActiveIdx((i) => (items.length ? Math.min(i, items.length - 1) : 0));
  }, [items.length]);

  if (!open) return null;

  const groups: Array<{ name: string; rows: Array<{ item: PaletteItem; idx: number }> }> = [];
  items.forEach((item, idx) => {
    let g = groups.find((x) => x.name === item.group);
    if (!g) {
      g = { name: item.group, rows: [] };
      groups.push(g);
    }
    g.rows.push({ item, idx });
  });

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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 p-3 pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div className="w-full max-w-[440px] overflow-hidden rounded-[var(--radius-dialog)] border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--elev-lift)]">
        <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-3">
          <Search className="h-4 w-4 text-[var(--ink-3)] shrink-0" aria-hidden="true" />
          <input
            autoFocus
            type="text"
            cmdk-input=""
            role="combobox"
            aria-expanded="true"
            aria-label="Fleet command palette"
            placeholder="Jump to tab, swarm, or worker..."
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
            className="h-11 w-full bg-transparent text-[14px] text-[var(--ink)] placeholder:text-[var(--ink-3)] focus:outline-none"
          />
        </div>
        <div role="listbox" className="max-h-[320px] overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-[var(--ink-3)]">No matching commands.</p>
          ) : (
            groups.map((g) => (
              <div key={g.name}>
                <div className="px-2 py-1 text-[12px] font-medium text-[var(--ink-3)]">{g.name}</div>
                {g.rows.map(({ item, idx }) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={idx === activeIdx}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => runItem(item)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-[var(--radius-chip)] px-2.5 py-2 text-left text-[13px] cursor-pointer",
                      idx === activeIdx
                        ? "bg-[var(--blue-soft)] text-[var(--info-foreground)]"
                        : "text-[var(--ink)] hover:bg-[var(--track)]",
                    )}
                  >
                    <span className="truncate">{item.label}</span>
                    {item.meta && <span className="text-[12px] text-[var(--ink-3)] num shrink-0">{item.meta}</span>}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
