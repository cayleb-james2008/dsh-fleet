import { useEffect, useMemo, useState } from "react";
import { Pause, Play, Radio, SkipBack, SkipForward } from "lucide-react";
import type { BoardMessage, SwarmMember, SwarmSnapshot } from "../types";
import { Badge, Button, Card, cn } from "../ui";

export function GraphView({ snap }: { snap: SwarmSnapshot }) {
  const [hideInactive, setHideInactive] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  const nonControlMsgs = useMemo(
    () => (snap.messages || []).filter((m: BoardMessage) => !m.control),
    [snap.messages],
  );
  const [replayIndex, setReplayIndex] = useState<number | null>(null);

  const activeIdx = replayIndex === null ? nonControlMsgs.length - 1 : Math.min(replayIndex, nonControlMsgs.length - 1);
  const isLive = replayIndex === null || activeIdx >= nonControlMsgs.length - 1;
  const currentMsg = activeIdx >= 0 ? nonControlMsgs[activeIdx] : null;

  useEffect(() => {
    if (!playing || nonControlMsgs.length === 0) return;
    const t = setInterval(() => {
      setReplayIndex((prev) => {
        const cur = prev === null ? 0 : prev + 1;
        if (cur >= nonControlMsgs.length - 1) {
          setPlaying(false);
          return null;
        }
        return cur;
      });
    }, 850);
    return () => clearInterval(t);
  }, [playing, nonControlMsgs.length]);

  const members = snap.members || [];
  const visibleMsgs = useMemo(
    () => (activeIdx >= 0 ? nonControlMsgs.slice(0, activeIdx + 1) : []),
    [nonControlMsgs, activeIdx],
  );

  const activeParticipantNames = useMemo(() => {
    const s = new Set<string>();
    for (const m of visibleMsgs) {
      s.add(m.agent);
      for (const t of m.mentions) s.add(t);
    }
    return s;
  }, [visibleMsgs]);

  const nodes = useMemo(() => {
    const list = members.filter((m: SwarmMember) => {
      if (m.roleWorker) return false;
      if (!hideInactive) return true;
      if (currentMsg && (currentMsg.agent === m.name || currentMsg.mentions.includes(m.name))) return true;
      return !m.killed && (activeParticipantNames.has(m.name) || m.status === "working");
    });
    const cx = 170;
    const cy = 140;
    const r = Math.min(102, Math.max(64, list.length * 15));
    return list.map((m, idx) => {
      const angle = (idx / Math.max(list.length, 1)) * Math.PI * 2 - Math.PI / 2;
      return {
        ...m,
        x: cx + Math.cos(angle) * (list.length === 1 ? 0 : r),
        y: cy + Math.sin(angle) * (list.length === 1 ? 0 : r),
      };
    });
  }, [members, hideInactive, currentMsg, activeParticipantNames]);

  const edges = useMemo(() => {
    const map = new Map<string, { from: string; to: string; count: number; viaAll: boolean }>();
    const nodeNames = new Set(nodes.map((n) => n.name));
    for (const msg of visibleMsgs) {
      if (!nodeNames.has(msg.agent)) continue;
      const targets = new Set(msg.mentions.filter((t) => nodeNames.has(t)));
      if (expandAll && msg.all) {
        for (const n of nodeNames) {
          if (n !== msg.agent) targets.add(n);
        }
      }
      for (const to of targets) {
        if (to === msg.agent) continue;
        const key = `${msg.agent}\0${to}`;
        const cur = map.get(key) || { from: msg.agent, to, count: 0, viaAll: true };
        cur.count++;
        if (msg.mentions.includes(to)) cur.viaAll = false;
        map.set(key, cur);
      }
    }
    return [...map.values()];
  }, [visibleMsgs, nodes, expandAll]);

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.name, n])), [nodes]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--ink-2)]">
          @Mention Graph ({nodes.length} nodes)
        </h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant={hideInactive ? "secondary" : "outline"}
            size="sm"
            onClick={() => setHideInactive((v) => !v)}
          >
            Hide inactive
          </Button>
          <Button
            variant={expandAll ? "secondary" : "outline"}
            size="sm"
            onClick={() => setExpandAll((v) => !v)}
          >
            Expand @all
          </Button>
        </div>
      </div>

      <Card className="p-2 overflow-hidden bg-[var(--board)]">
        {nodes.length === 0 ? (
          <p className="py-12 text-center text-[14px] text-[var(--ink-2)]">No active nodes to graph.</p>
        ) : (
          <svg
            viewBox="0 0 340 280"
            className="w-full h-auto max-h-[340px] select-none"
            role="img"
            aria-label="Swarm @mention topology graph"
          >
            <defs>
              <marker id="fleet-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--ink-3)" />
              </marker>
              <marker id="fleet-arrow-hi" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--blue)" />
              </marker>
            </defs>

            {edges.map((e) => {
              const a = nodeMap.get(e.from);
              const b = nodeMap.get(e.to);
              if (!a || !b) return null;
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const dist = Math.hypot(dx, dy) || 1;
              const pad = 26;
              const x1 = a.x + (dx / dist) * pad;
              const y1 = a.y + (dy / dist) * pad;
              const x2 = b.x - (dx / dist) * pad;
              const y2 = b.y - (dy / dist) * pad;
              const activeEdge =
                currentMsg &&
                currentMsg.agent === e.from &&
                (currentMsg.mentions.includes(e.to) || (expandAll && currentMsg.all));
              const highlighted = activeEdge || selectedNode === e.from || selectedNode === e.to;
              return (
                <line
                  key={`${e.from}-${e.to}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={highlighted ? "var(--blue)" : "var(--hairline-s)"}
                  strokeWidth={Math.min(3, 1 + e.count * 0.45)}
                  strokeDasharray={e.viaAll ? "4 3" : undefined}
                  markerEnd={highlighted ? "url(#fleet-arrow-hi)" : "url(#fleet-arrow)"}
                />
              );
            })}

            {nodes.map((n) => {
              const isSelected = selectedNode === n.name || currentMsg?.agent === n.name;
              const dotFill = n.killed
                ? "var(--edge)"
                : n.status === "working"
                  ? "var(--dot-green)"
                  : "var(--ink-3)";
              return (
                <g
                  key={n.name}
                  transform={`translate(${n.x},${n.y})`}
                  onClick={() => setSelectedNode((cur) => (cur === n.name ? null : n.name))}
                  className="cursor-pointer"
                >
                  <rect
                    x={-44}
                    y={-15}
                    width={88}
                    height={30}
                    rx={15}
                    fill="var(--surface)"
                    stroke={isSelected ? "var(--blue)" : "var(--hairline-s)"}
                    strokeWidth={isSelected ? 2 : 1}
                  />
                  <circle cx={-30} cy={0} r={4} fill={dotFill} />
                  <text
                    x={-21}
                    y={4}
                    fontSize={12}
                    fontWeight={500}
                    fill="var(--ink)"
                    fontFamily="var(--font-sans)"
                  >
                    {n.name.length > 9 ? `${n.name.slice(0, 8)}…` : n.name}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </Card>

      {/* Replay Controls */}
      {nonControlMsgs.length > 0 && (
        <Card className="p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                aria-label="Previous post"
                disabled={activeIdx <= 0}
                onClick={() => {
                  setPlaying(false);
                  setReplayIndex(Math.max(0, activeIdx - 1));
                }}
              >
                <SkipBack className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label={playing ? "Pause replay" : "Play replay"}
                onClick={() => {
                  if (isLive && !playing) setReplayIndex(0);
                  setPlaying((p) => !p);
                }}
              >
                {playing ? <Pause className="h-3.5 w-3.5" aria-hidden="true" /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Next post"
                disabled={activeIdx >= nonControlMsgs.length - 1}
                onClick={() => {
                  setPlaying(false);
                  const next = activeIdx + 1;
                  setReplayIndex(next >= nonControlMsgs.length - 1 ? null : next);
                }}
              >
                <SkipForward className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[12px] text-[var(--ink-2)] num">
                {currentMsg ? `#${currentMsg.seq} ${currentMsg.agent}` : "none"}
              </span>
              <Button
                variant={isLive ? "primary" : "outline"}
                size="sm"
                onClick={() => {
                  setPlaying(false);
                  setReplayIndex(null);
                }}
              >
                <Radio className="h-3.5 w-3.5" aria-hidden="true" />
                Live
              </Button>
            </div>
          </div>

          <input
            type="range"
            aria-label="Replay post timeline"
            min={0}
            max={Math.max(0, nonControlMsgs.length - 1)}
            value={Math.max(0, activeIdx)}
            onChange={(e) => {
              setPlaying(false);
              const val = Number(e.target.value);
              setReplayIndex(val >= nonControlMsgs.length - 1 ? null : val);
            }}
            className="w-full accent-[var(--blue)] cursor-pointer"
          />
          {currentMsg && (
            <div className="flex items-center justify-between gap-2 text-[12px] text-[var(--ink-2)]">
              <span className="truncate">{currentMsg.text}</span>
              <Badge tone="neutral" className="shrink-0 num">
                {activeIdx + 1}/{nonControlMsgs.length}
              </Badge>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
