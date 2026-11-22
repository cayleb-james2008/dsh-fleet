// Interactive Multi-Wave DAG Dependency Visualizer (v0.7.0).
// Computes topological execution waves from depends_on / blocked_by links, renders smooth SVG
// directed Bezier arrows between wave columns, and opens any node straight into Session Inspector.
import { useMemo, useState } from "react";
import {
  CheckCircle2,
  Clock,
  GitBranch,
  Layers,
  Network,
  Wrench,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  diffStat,
  healBadgeInfo,
  isActivelyRunning,
  isFailed,
  isQueuedOrBlocked,
  isVerified,
  statusText,
  type Session,
} from "./api";

type DagNodePos = {
  session: Session;
  wave: number;
  row: number;
  x: number;
  y: number;
  externalDeps: string[];
};

type DagEdge = {
  id: string;
  from: DagNodePos;
  to: DagNodePos;
};

const NODE_W = 276;
const NODE_H = 132;
const COL_GAP = 84;
const ROW_GAP = 18;
const PAD_X = 24;
const PAD_TOP = 56;
const PAD_BOTTOM = 28;

const TAG_SKINS = [
  "bg-tag-ops-bg text-tag-ops-fg",
  "bg-tag-mint-bg text-tag-mint-fg",
  "bg-tag-research-bg text-tag-research-fg",
  "bg-tag-dev-bg text-tag-dev-fg",
  "bg-tag-plan-bg text-tag-plan-fg",
];

function projectSkin(project: string): string {
  let h = 0;
  for (let i = 0; i < project.length; i++) h = (h * 31 + project.charCodeAt(i)) >>> 0;
  return TAG_SKINS[h % TAG_SKINS.length];
}

function buildDagLayout(sessions: Session[]) {
  const byId = new Map<string, Session>();
  for (const s of sessions) byId.set(s.id, s);

  const depsOf = new Map<string, string[]>();
  const extDepsOf = new Map<string, string[]>();
  for (const s of sessions) {
    const raw = Array.from(new Set([...(s.depends_on ?? []), ...(s.blocked_by ?? [])])).filter(
      (id) => id && id !== s.id,
    );
    const local = raw.filter((id) => byId.has(id));
    const external = raw.filter((id) => !byId.has(id));
    depsOf.set(s.id, local);
    extDepsOf.set(s.id, external);
  }

  // Memoized longest-path wave assignment with cycle protection
  const waveMemo = new Map<string, number>();
  const visiting = new Set<string>();
  const computeWave = (id: string): number => {
    const cached = waveMemo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    const parents = depsOf.get(id) ?? [];
    let w = 0;
    for (const p of parents) {
      w = Math.max(w, computeWave(p) + 1);
    }
    visiting.delete(id);
    waveMemo.set(id, w);
    return w;
  };

  let maxWave = 0;
  for (const s of sessions) {
    const w = computeWave(s.id);
    if (w > maxWave) maxWave = w;
  }

  const bucketRank = (s: Session) =>
    s.bucket === "needs-you" ? 0 : isActivelyRunning(s) ? 1 : isQueuedOrBlocked(s) ? 2 : 3;

  const waves: Session[][] = Array.from({ length: maxWave + 1 }, () => []);
  for (const s of sessions) {
    waves[waveMemo.get(s.id) ?? 0].push(s);
  }
  for (const list of waves) {
    list.sort((a, b) => bucketRank(a) - bucketRank(b) || a.id.localeCompare(b.id));
  }

  const nodes: DagNodePos[] = [];
  const nodeById = new Map<string, DagNodePos>();
  let maxRows = 0;
  waves.forEach((list, wIdx) => {
    if (list.length > maxRows) maxRows = list.length;
    list.forEach((s, rIdx) => {
      const pos: DagNodePos = {
        session: s,
        wave: wIdx,
        row: rIdx,
        x: PAD_X + wIdx * (NODE_W + COL_GAP),
        y: PAD_TOP + rIdx * (NODE_H + ROW_GAP),
        externalDeps: extDepsOf.get(s.id) ?? [],
      };
      nodes.push(pos);
      nodeById.set(s.id, pos);
    });
  });

  const edges: DagEdge[] = [];
  for (const to of nodes) {
    const parents = depsOf.get(to.session.id) ?? [];
    for (const pId of parents) {
      const from = nodeById.get(pId);
      if (from) {
        edges.push({ id: `${from.session.id}->${to.session.id}`, from, to });
      }
    }
  }

  const width = Math.max(640, PAD_X * 2 + waves.length * NODE_W + Math.max(0, waves.length - 1) * COL_GAP);
  const height = Math.max(240, PAD_TOP + maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP + PAD_BOTTOM);

  return { waves, nodes, edges, width, height };
}

function edgePath(from: DagNodePos, to: DagNodePos): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const dx = Math.max(36, Math.abs(x2 - x1) * 0.48);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function edgeTone(parent: Session, highlighted: boolean): { stroke: string; marker: string; width: number } {
  if (highlighted) return { stroke: "var(--accent)", marker: "url(#dag-arrow-accent)", width: 2.25 };
  if (isVerified(parent)) return { stroke: "var(--dot-green)", marker: "url(#dag-arrow-good)", width: 1.75 };
  if (parent.bucket === "needs-you") return { stroke: "var(--unread)", marker: "url(#dag-arrow-bad)", width: 1.75 };
  return { stroke: "var(--ink-3)", marker: "url(#dag-arrow-muted)", width: 1.5 };
}

function statusRailClass(s: Session): string {
  if (isVerified(s)) return "border-l-dot-green";
  if (isFailed(s)) return "border-l-unread";
  if (s.bucket === "needs-you") return "border-l-dot-clay";
  if (isActivelyRunning(s)) return "border-l-accent";
  if (isQueuedOrBlocked(s)) return "border-l-dot-amber";
  return "border-l-hairline";
}

export function DagWaveGraph({
  sessions,
  selectedId,
  onOpen,
  onNewBatch,
}: {
  sessions: Session[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onNewBatch: () => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const { waves, nodes, edges, width, height } = useMemo(() => buildDagLayout(sessions), [sessions]);

  const activeFocusId = hoveredId || selectedId;
  const connectedIds = useMemo(() => {
    if (!activeFocusId) return null;
    const set = new Set<string>([activeFocusId]);
    for (const e of edges) {
      if (e.from.session.id === activeFocusId) set.add(e.to.session.id);
      if (e.to.session.id === activeFocusId) set.add(e.from.session.id);
    }
    return set;
  }, [activeFocusId, edges]);

  if (sessions.length === 0) {
    return (
      <section
        aria-label="DAG dependency graph"
        data-testid="dag-graph-view"
        className="mx-4 my-5 rounded-card border border-hairline bg-surface p-6 text-center md:mx-6"
      >
        <Network className="mx-auto size-6 text-icon" strokeWidth={1.5} aria-hidden />
        <p className="mt-2 text-sm font-medium text-ink">No sessions in the DAG graph</p>
        <p className="mt-1 text-xs text-ink-2">
          Adjust active filters or dispatch a multi-stage Batch DAG so upstream and downstream waves appear here.
        </p>
        <div className="mt-4">
          <Button size="sm" onClick={onNewBatch} className="max-md:min-h-11 max-md:px-4">
            <Layers className="size-4" strokeWidth={1.5} aria-hidden />
            <span>Dispatch Batch DAG</span>
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="DAG dependency graph"
      data-testid="dag-graph-view"
      className="px-4 py-4 md:px-6 md:py-5"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-2">
          <span className="inline-flex items-center gap-1.5 font-medium text-ink">
            <Network className="size-4 text-icon" strokeWidth={1.5} aria-hidden />
            <span>Multi-wave execution DAG</span>
          </span>
          <span className="font-mono text-ink-3 tabular-nums" data-testid="dag-graph-summary">
            {nodes.length} {nodes.length === 1 ? "session" : "sessions"} · {waves.length}{" "}
            {waves.length === 1 ? "wave" : "waves"} · {edges.length}{" "}
            {edges.length === 1 ? "dependency" : "dependencies"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-dot-green" aria-hidden />
            <span>Verified</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-accent" aria-hidden />
            <span>Working</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-dot-amber" aria-hidden />
            <span>Queued / Blocked</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-unread" aria-hidden />
            <span>Needs you</span>
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onNewBatch}
            className="h-8 px-2.5 text-xs max-md:min-h-11 max-md:px-3"
          >
            <Layers className="size-3.5" strokeWidth={1.5} aria-hidden />
            <span>Add DAG wave</span>
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-card border border-hairline bg-board/60">
        <div className="relative" style={{ width: `${width}px`, height: `${height}px` }}>
          {/* Wave column headers */}
          {waves.map((list, wIdx) => (
            <div
              key={`wave-hdr-${wIdx}`}
              className="absolute top-3 flex items-center justify-between border-b border-hairline pb-2 text-xs"
              style={{ left: `${PAD_X + wIdx * (NODE_W + COL_GAP)}px`, width: `${NODE_W}px` }}
            >
              <span className="font-medium text-ink">
                Wave {wIdx + 1}
                <span className="ml-1.5 font-normal text-ink-3">
                  {wIdx === 0 ? "Root tasks" : "Dependent stage"}
                </span>
              </span>
              <span className="rounded-chip bg-track px-1.5 py-0.5 font-mono text-xs text-ink-2 tabular-nums">
                {list.length}
              </span>
            </div>
          ))}

          {/* Directed SVG dependency arrows */}
          <svg
            aria-hidden
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            data-testid="dag-edges-svg"
            className="pointer-events-none absolute inset-0"
          >
            <defs>
              <marker id="dag-arrow-accent" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--accent)" />
              </marker>
              <marker id="dag-arrow-good" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--dot-green)" />
              </marker>
              <marker id="dag-arrow-bad" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--unread)" />
              </marker>
              <marker id="dag-arrow-muted" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--ink-3)" />
              </marker>
            </defs>
            {edges.map((e) => {
              const isHighlighted =
                activeFocusId !== null &&
                (e.from.session.id === activeFocusId || e.to.session.id === activeFocusId);
              const faded = activeFocusId !== null && !isHighlighted;
              const tone = edgeTone(e.from.session, isHighlighted);
              return (
                <path
                  key={e.id}
                  data-testid="dag-edge"
                  data-from={e.from.session.id}
                  data-to={e.to.session.id}
                  d={edgePath(e.from, e.to)}
                  fill="none"
                  stroke={tone.stroke}
                  strokeWidth={tone.width}
                  strokeDasharray={isQueuedOrBlocked(e.to.session) ? "5 4" : undefined}
                  opacity={faded ? 0.25 : 0.92}
                  markerEnd={tone.marker}
                />
              );
            })}
          </svg>

          {/* Interactive session nodes */}
          {nodes.map((node) => {
            const s = node.session;
            const verified = isVerified(s);
            const failed = isFailed(s);
            const heal = healBadgeInfo(s);
            const ds = diffStat(s.diff);
            const isSelected = selectedId === s.id;
            const isDimmed = connectedIds !== null && !connectedIds.has(s.id);
            const depCount = (s.depends_on?.length ?? 0) + node.externalDeps.length;
            return (
              <button
                key={s.id}
                type="button"
                data-testid="dag-node"
                data-session-id={s.id}
                data-wave={node.wave + 1}
                aria-label={`Open DAG session ${s.id}: ${s.task}`}
                onClick={() => onOpen(s.id)}
                onMouseEnter={() => setHoveredId(s.id)}
                onMouseLeave={() => setHoveredId((cur) => (cur === s.id ? null : cur))}
                onFocus={() => setHoveredId(s.id)}
                onBlur={() => setHoveredId((cur) => (cur === s.id ? null : cur))}
                style={{
                  left: `${node.x}px`,
                  top: `${node.y}px`,
                  width: `${NODE_W}px`,
                  height: `${NODE_H}px`,
                }}
                className={cn(
                  "absolute flex cursor-pointer flex-col justify-between rounded-card border border-l-[3px] border-hairline bg-surface p-3 text-left outline-none transition-colors duration-(--dur-press) ease-(--ease-house) hover:border-ink-3 hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring",
                  statusRailClass(s),
                  isSelected && "ring-2 ring-accent",
                  isDimmed && "opacity-45",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "inline-flex max-w-[116px] truncate rounded-chip px-1.5 py-0.5 text-xs font-medium",
                      projectSkin(s.project),
                    )}
                  >
                    {s.project}
                  </span>
                  <span className="font-mono text-xs text-ink-3">{s.id}</span>
                  <Badge
                    variant={
                      verified
                        ? "success"
                        : failed
                          ? "error"
                          : s.bucket === "needs-you"
                            ? "info"
                            : isQueuedOrBlocked(s)
                              ? "warning"
                              : "secondary"
                    }
                    size="sm"
                    className="ml-auto shrink-0"
                  >
                    {verified ? (s.status === "merged" ? "merged" : "verified") : statusText(s)}
                  </Badge>
                </div>

                <p className="line-clamp-2 text-xs font-medium leading-snug text-ink [overflow-wrap:anywhere]">
                  {s.task}
                </p>

                <div className="flex items-center justify-between gap-2 font-mono text-xs text-ink-3 tabular-nums">
                  <span className="inline-flex min-w-0 items-center gap-1 truncate">
                    {verified ? (
                      <CheckCircle2 className="size-3.5 shrink-0 text-success-foreground" strokeWidth={1.5} aria-hidden />
                    ) : failed ? (
                      <XCircle className="size-3.5 shrink-0 text-destructive-foreground" strokeWidth={1.5} aria-hidden />
                    ) : (
                      <Clock className="size-3.5 shrink-0 text-icon" strokeWidth={1.5} aria-hidden />
                    )}
                    <span className="truncate">{s.branch || s.engine || s.agent || "agent"}</span>
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1.5">
                    {heal && (
                      <span className="inline-flex items-center gap-0.5 rounded-chip bg-pill-active-bg px-1.5 py-0.5 text-pill-active-fg">
                        <Wrench className="size-3" strokeWidth={1.5} aria-hidden />
                        <span>{heal.shortLabel}</span>
                      </span>
                    )}
                    {ds.files > 0 && !heal && (
                      <span className="text-diff-add-fg">+{ds.add}</span>
                    )}
                    {depCount > 0 && (
                      <span className="inline-flex items-center gap-0.5 rounded-chip bg-track px-1.5 py-0.5 text-ink-2">
                        <GitBranch className="size-3 text-icon" strokeWidth={1.5} aria-hidden />
                        <span>{depCount}</span>
                      </span>
                    )}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
