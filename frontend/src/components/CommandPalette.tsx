import { useEffect } from "react";
import { Command } from "cmdk";
import {
  Activity,
  ClipboardCopy,
  GitBranch,
  Inbox,
  MessageSquare,
  Network,
  Search,
  Settings,
  Users,
} from "lucide-react";
import { openWorkerConversation } from "../sidecar";
import type { SwarmSnapshot, SwarmSummary, TabId } from "../types";

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

  const members = snap?.members || [];
  if (!open) return null;

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
      <Command
        label="Fleet command palette"
        className="w-full max-w-[440px] overflow-hidden rounded-[var(--radius-dialog)] border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--elev-lift)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-3">
          <Search className="h-4 w-4 text-[var(--ink-3)] shrink-0" aria-hidden="true" />
          <Command.Input
            autoFocus
            placeholder="Jump to tab, swarm, or worker..."
            className="h-11 w-full bg-transparent text-[14px] text-[var(--ink)] placeholder:text-[var(--ink-3)] focus:outline-none"
          />
        </div>
        <Command.List className="max-h-[320px] overflow-y-auto p-1.5">
          <Command.Empty className="py-6 text-center text-[13px] text-[var(--ink-3)]">
            No matching commands.
          </Command.Empty>

          <Command.Group heading="Views" className="px-2 py-1 text-[12px] font-medium text-[var(--ink-3)]">
            {(
              [
                ["triage", "Needs-you Triage & Plan", Inbox],
                ["board", "Swarm Board Feed", Activity],
                ["roster", "Worker Roster & Tokens", Users],
                ["graph", "@Mention Graph & Replay", Network],
                ["worktrees", "Git Worktrees", GitBranch],
              ] as const
            ).map(([id, label, Icon]) => (
              <Command.Item
                key={id}
                value={`${id} ${label}`}
                onSelect={() => {
                  onSelectTab(id);
                  onOpenChange(false);
                }}
                className="flex items-center gap-2 rounded-[var(--radius-chip)] px-2.5 py-2 text-[13px] text-[var(--ink)] aria-selected:bg-[var(--blue-soft)] aria-selected:text-[var(--info-foreground)] cursor-pointer"
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{label}</span>
              </Command.Item>
            ))}
            {snap?.swarm && (
              <Command.Item
                value="copy swarm digest markdown summary"
                onSelect={() => {
                  onCopyDigest();
                  onOpenChange(false);
                }}
                className="flex items-center gap-2 rounded-[var(--radius-chip)] px-2.5 py-2 text-[13px] text-[var(--ink)] aria-selected:bg-[var(--blue-soft)] aria-selected:text-[var(--info-foreground)] cursor-pointer"
              >
                <ClipboardCopy className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Copy swarm digest</span>
              </Command.Item>
            )}
            <Command.Item
              value="settings theme preferences"
              onSelect={() => {
                onOpenChange(false);
                onOpenSettings();
              }}
              className="flex items-center gap-2 rounded-[var(--radius-chip)] px-2.5 py-2 text-[13px] text-[var(--ink)] aria-selected:bg-[var(--blue-soft)] aria-selected:text-[var(--info-foreground)] cursor-pointer"
            >
              <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Settings</span>
            </Command.Item>
            <Command.Item
              value="keyboard shortcuts cheatsheet help ?"
              onSelect={() => {
                onOpenChange(false);
                onOpenShortcuts();
              }}
              className="flex items-center justify-between gap-2 rounded-[var(--radius-chip)] px-2.5 py-2 text-[13px] text-[var(--ink)] aria-selected:bg-[var(--blue-soft)] aria-selected:text-[var(--info-foreground)] cursor-pointer"
            >
              <span>Keyboard shortcuts</span>
              <span className="text-[12px] text-[var(--ink-3)] mono">?</span>
            </Command.Item>
          </Command.Group>

          {swarms.length > 0 && (
            <Command.Group heading="Swarms" className="px-2 py-1 text-[12px] font-medium text-[var(--ink-3)]">
              {swarms.map((sw) => (
                <Command.Item
                  key={sw.id}
                  value={`swarm ${sw.title} ${sw.id}`}
                  onSelect={() => {
                    onSelectSwarm(sw.id);
                    onOpenChange(false);
                  }}
                  className="flex items-center justify-between gap-2 rounded-[var(--radius-chip)] px-2.5 py-2 text-[13px] text-[var(--ink)] aria-selected:bg-[var(--blue-soft)] aria-selected:text-[var(--info-foreground)] cursor-pointer"
                >
                  <span className="truncate">{sw.title || sw.id}</span>
                  <span className="text-[12px] text-[var(--ink-3)] num shrink-0">
                    {sw.activeCount}/{sw.memberCount}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {members.length > 0 && window.sidecar?.ui?.toggleConversation && (
            <Command.Group heading="Open Worker Chat" className="px-2 py-1 text-[12px] font-medium text-[var(--ink-3)]">
              {members
                .filter((m) => Boolean(m.conversation_id))
                .map((m) => (
                  <Command.Item
                    key={m.name}
                    value={`chat worker ${m.name} ${m.role}`}
                    onSelect={() => {
                      openWorkerConversation(m.conversation_id);
                      onOpenChange(false);
                    }}
                    className="flex items-center justify-between gap-2 rounded-[var(--radius-chip)] px-2.5 py-2 text-[13px] text-[var(--ink)] aria-selected:bg-[var(--blue-soft)] aria-selected:text-[var(--info-foreground)] cursor-pointer"
                  >
                    <span className="flex items-center gap-2 truncate">
                      <MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>{m.name}</span>
                    </span>
                    <span className="text-[12px] text-[var(--ink-3)]">{m.status}</span>
                  </Command.Item>
                ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </div>
  );
}
