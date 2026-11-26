import { useEffect, useMemo, useState } from "../hooks";
import { Pause, Play, Radio, SkipBack, SkipForward } from "../icons";
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
  const visibleMsgs = useMemo(() => (activeIdx >= 0 ? nonControlMsgs.slice(0, activeIdx + 1) : []), [nonControlMsgs, activeIdx]);

  const nodes = useMemo(() => {
    const active = new Set<string>();
    for (const m of visibleMsgs) {
      active.add(m.agent);
      for (const t of m.mentions) active.add(t);
    }
    const list = members.filter((m: SwarmMember) =>
      !m.roleWorker &&
      (!hideInactive ||
        (currentMsg && (currentMsg.agent === m.name || currentMsg.mentions.includes(m.name))) ||
        (!m.killed && (active.has(m.name) || m.status === "working"))),
    );
    const r = Math.min(102, Math.max(64, list.length * 15));
    return list.map((m, idx) => {
      const a = (idx / Math.max(list.length, 1)) * Math.PI * 2 - Math.PI / 2;
      const dist = list.length === 1 ? 0 : r;
      return { ...m, x: 170 + Math.cos(a) * dist, y: 140 + Math.sin(a) * dist };
    });
  }, [members, hideInactive, currentMsg, visibleMsgs]);

  const edges = useMemo(() => {
    const map = new Map<string, { from: string; to: string; count: number; viaAll: boolean }>();
    const nodeNames = new Set(nodes.map((n) => n.name));
    const addEdge = (from: string, to: string, direct: boolean) => {
      if (to === from) return;
      const key = `${from}\0${to}`;
      const cur = map.get(key) || { from, to, count: 0, viaAll: true };
      cur.count++;
      if (direct) cur.viaAll = false;
      map.set(key, cur);
    };
    for (const msg of visibleMsgs) {
      if (!nodeNames.has(msg.agent)) continue;
      const seen = new Set<string>();
      for (const t of msg.mentions) {
        if (nodeNames.has(t) && !seen.has(t)) {
          seen.add(t);
          addEdge(msg.agent, t, true);
        }
      }
      if (expandAll && msg.all) {
        for (const t of nodeNames) {
          if (!seen.has(t)) {
            seen.add(t);
            addEdge(msg.agent, t, false);
          }
        }
      }
    }
    return [...map.values()];
  }, [visibleMsgs, nodes, expandAll]);

  const nodeMap = new Map(nodes.map((n) => [n.name, n]));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="h2">
          @Mention graph ({nodes.length} nodes)
        </h2>
        <div className="wrap">
          <Button
            variant={hideInactive ? "secondary" : "outline"}
            onClick={() => setHideInactive((v) => !v)}
          >
            Hide inactive
          </Button>
          <Button
            variant={expandAll ? "secondary" : "outline"}
            onClick={() => setExpandAll((v) => !v)}
          >
            Expand @all
          </Button>
        </div>
      </div>

      <Card className="p-2 overflow-hidden bg-board">
        {nodes.length === 0 ? (
          <p className="py-12 text-center text-[14px] text-ink-2">No active nodes to graph.</p>
        ) : (
          <svg
            viewBox="0 0 340 280"
            className="w-full h-auto max-h-[340px] select-none"
            role="img"
            aria-label="Swarm @mention topology graph"
          >
            <defs>
              {[
                ["fleet-arrow", "var(--ink-3)"],
                ["fleet-arrow-hi", "var(--blue)"],
              ].map(([id, fill]) => (
                <marker key={id} id={id} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M0 1 10 5 0 9z" fill={fill} />
                </marker>
              ))}
            </defs>

            {edges.map((e) => {
              const a = nodeMap.get(e.from);
              const b = nodeMap.get(e.to);
              if (!a || !b) return null;
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const dist = Math.hypot(dx, dy) || 1;
              const ux = (dx / dist) * 26;
              const uy = (dy / dist) * 26;
              const highlighted =
                (currentMsg && currentMsg.agent === e.from && (currentMsg.mentions.includes(e.to) || (expandAll && currentMsg.all))) ||
                selectedNode === e.from ||
                selectedNode === e.to;
              return (
                <line
                  key={`${e.from}-${e.to}`}
                  x1={a.x + ux}
                  y1={a.y + uy}
                  x2={b.x - ux}
                  y2={b.y - uy}
                  stroke={highlighted ? "var(--blue)" : "var(--hairline-s)"}
                  strokeWidth={Math.min(3, 1 + e.count * 0.45)}
                  strokeDasharray={e.viaAll ? "4" : undefined}
                  markerEnd={highlighted ? "url(#fleet-arrow-hi)" : "url(#fleet-arrow)"}
                />
              );
            })}

            {nodes.map((n) => {
              const isSelected = selectedNode === n.name || currentMsg?.agent === n.name;
              const dotFill = n.killed ? "var(--edge)" : n.status === "working" ? "var(--dot-green)" : "var(--ink-3)";
              return (
                <g key={n.name} transform={`translate(${n.x},${n.y})`} onClick={() => setSelectedNode((cur) => (cur === n.name ? null : n.name))} className="cursor-pointer">
                  <rect x={-44} y={-15} width={88} height={30} rx={15} fill="var(--surface)" stroke={isSelected ? "var(--blue)" : "var(--hairline-s)"} strokeWidth={isSelected ? 2 : 1} />
                  <circle cx={-30} cy={0} r={4} fill={dotFill} />
                  <text x={-21} y={4} fontSize={12} fontWeight={500} fill="var(--ink)" fontFamily="var(--font-sans)">
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
        <Card className="p-2 space-y-2">
          <div className="row">
            <div className="f1">
              {([
                ["Previous post", activeIdx <= 0, SkipBack, () => (setPlaying(false), setReplayIndex(Math.max(0, activeIdx - 1)))],
                [playing ? "Pause replay" : "Play replay", false, playing ? Pause : Play, () => { if (isLive && !playing) setReplayIndex(0); setPlaying((p) => !p); }],
                ["Next post", activeIdx >= nonControlMsgs.length - 1, SkipForward, () => { setPlaying(false); const n = activeIdx + 1; setReplayIndex(n >= nonControlMsgs.length - 1 ? null : n); }],
              ] as const).map(([label, disabled, Icon, onClick]) => (
                <Button key={label} size="icon" aria-label={label} disabled={disabled} onClick={onClick}><Icon /></Button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[12px] text-ink-2 num">
                {currentMsg ? `#${currentMsg.seq} ${currentMsg.agent}` : ""}
              </span>
              <Button
                variant={isLive ? "primary" : "outline"}
                onClick={() => {
                  setPlaying(false);
                  setReplayIndex(null);
                }}
              >
                <Radio />
                Live
              </Button>
            </div>
          </div>

          <input
            type="range"
            aria-label="Replay timeline"
            min={0}
            max={Math.max(0, nonControlMsgs.length - 1)}
            value={Math.max(0, activeIdx)}
            onChange={(e) => {
              setPlaying(false);
              const val = Number(e.target.value);
              setReplayIndex(val >= nonControlMsgs.length - 1 ? null : val);
            }}
            className="w-full accent-blue cursor-pointer"
          />
          {currentMsg && (
            <div className="row text-[12px] text-ink-2">
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
