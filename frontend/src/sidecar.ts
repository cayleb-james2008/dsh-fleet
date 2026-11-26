import type {
  BoardMessage,
  ControlRequest,
  MentionEdge,
  NormalizedPlan,
  PlanMilestone,
  PlanRisk,
  PlanThread,
  PlanWorkstream,
  SwarmControlOp,
  SwarmDeltaPayload,
  SwarmPlan,
  SwarmSnapshot,
  SwarmSummary,
  ThemeMode,
  WorktreeActionName,
  WorktreeActionPayload,
  WorktreeDiffMode,
  WorktreeDiffPayload,
  WorktreesPayload,
} from "./types";

interface AntigravitySidecarBridge {
  conversationId?: string | null;
  standalone?: boolean;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  getWorkspaceUris?: () => Promise<string[]>;
  onWorkspaceChange?: (cb: (uris: string[]) => void) => () => void;
  agent?: {
    sendMessage?: (message: string, convId?: string) => Promise<unknown>;
    startConversation?: (message: string, title?: string) => Promise<unknown>;
  } | null;
  ui?: {
    toggleAuxPane?: (req: Record<string, unknown>) => void;
    toggleConversation?: (conversationId: string, opts?: Record<string, unknown>) => void;
    addArtifactComment?: (comment: string) => void | Promise<unknown>;
  };
}

declare global {
  interface Window {
    sidecar?: AntigravitySidecarBridge;
    __FLEET_LIVE_WEB__?: boolean;
  }
}

const sc = () => (typeof window !== "undefined" ? window.sidecar : undefined);

export function isEmbeddedHost(): boolean {
  try {
    return typeof window !== "undefined" && window.parent !== window && !sc()?.standalone;
  } catch {
    return false;
  }
}

const sidecarFetch = (url: string, init?: RequestInit): Promise<Response> =>
  sc()?.fetch?.(url, init) ?? fetch(url, init);

async function apiJson<T>(url: string, errLabel: string): Promise<T> {
  const res = await sidecarFetch(url);
  if (!res.ok) throw new Error(`${errLabel} (${res.status})`);
  return res.json();
}

const qs = (path: string, params: Record<string, string | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return `${path}${s ? `?${s}` : ""}`;
};

export const fetchSwarms = (): Promise<{ swarms: SwarmSummary[]; defaultConversationId: string | null }> =>
  apiJson("/api/swarms", "List swarms failed");

export const fetchSwarmSnapshot = (conversationId?: string | null, etag?: string): Promise<SwarmSnapshot> =>
  apiJson(qs("/api/swarm", { conversationId, etag }), "Load swarm failed");

export interface FetchSwarmDeltaOptions {
  since?: number;
  etag?: string;
  waitMs?: number;
  signal?: AbortSignal;
}

export async function fetchSwarmDelta(
  conversationId?: string | null,
  opts: FetchSwarmDeltaOptions = {},
): Promise<SwarmDeltaPayload> {
  const url = qs("/api/swarm/delta", {
    conversationId,
    since: typeof opts.since === "number" && opts.since >= 0 ? String(Math.floor(opts.since)) : undefined,
    etag: opts.etag || undefined,
    waitMs: typeof opts.waitMs === "number" && opts.waitMs >= 0 ? String(Math.floor(opts.waitMs)) : undefined,
  });
  const res = await sidecarFetch(url, opts.signal ? { signal: opts.signal } : undefined);
  if (!res.ok) throw new Error(`Load swarm delta failed (${res.status})`);
  return res.json();
}

function mergeMessages(prevMsgs: BoardMessage[] = [], deltaMsgs: BoardMessage[] = []): BoardMessage[] {
  if (!deltaMsgs.length) return prevMsgs;
  const bySeq = new Map<number, BoardMessage>();
  const unseq: BoardMessage[] = [];
  for (const m of prevMsgs) {
    if (!m) continue;
    if (typeof m.seq === "number" && m.seq > 0) bySeq.set(m.seq, m);
    else unseq.push(m);
  }
  for (const m of deltaMsgs) {
    if (!m) continue;
    if (typeof m.seq === "number" && m.seq > 0) bySeq.set(m.seq, m);
    else unseq.push(m);
  }
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return unseq.length ? ordered.concat(unseq) : ordered;
}

function mergeReplyRefs(
  prevRefs: Record<number, number[]> | undefined,
  deltaRefs: Record<number, number[]> | undefined,
): Record<number, number[]> | undefined {
  if (!deltaRefs) return prevRefs;
  const keys = Object.keys(deltaRefs);
  if (!keys.length) return prevRefs;
  const next: Record<number, number[]> = { ...(prevRefs || {}) };
  for (const k of keys) {
    const seqKey = Number(k);
    const addList = deltaRefs[seqKey];
    if (!Array.isArray(addList) || !addList.length) continue;
    const prevList = Array.isArray(next[seqKey]) ? next[seqKey] : [];
    next[seqKey] = [...new Set([...prevList, ...addList])].sort((a, b) => a - b);
  }
  return next;
}

function mergeEdges(prevEdges: MentionEdge[] = [], deltaEdges: MentionEdge[] | undefined): MentionEdge[] {
  if (!deltaEdges || !deltaEdges.length) return prevEdges;
  const byKey = new Map<string, MentionEdge>();
  for (const e of prevEdges) {
    if (!e) continue;
    byKey.set(`${e.from}\0${e.to}`, { ...e });
  }
  for (const d of deltaEdges) {
    if (!d) continue;
    const key = `${d.from}\0${d.to}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += d.count || 0;
      existing.direct += d.direct || 0;
      existing.viaAll += d.viaAll || 0;
    } else {
      byKey.set(key, { ...d });
    }
  }
  return [...byKey.values()];
}

export function mergeSwarmDelta(
  prevSnap: SwarmSnapshot | null,
  delta: SwarmDeltaPayload | null | undefined,
): SwarmSnapshot | null {
  if (!delta) return prevSnap;
  if (delta.unchanged && prevSnap) return prevSnap;

  if (delta.mode === "full" || !prevSnap) {
    const {
      ok: _ok,
      mode: _mode,
      since: _since,
      messagesDelta,
      replyRefsDelta,
      edgesDelta,
      ...rest
    } = delta;
    return {
      conversationId: delta.conversationId !== undefined ? delta.conversationId : (prevSnap?.conversationId ?? delta.swarm ?? null),
      swarm: delta.swarm !== undefined ? delta.swarm : (prevSnap?.swarm ?? null),
      member: delta.member !== undefined ? delta.member : (prevSnap?.member ?? null),
      ...rest,
      unchanged: false,
      messages: delta.messages ?? messagesDelta ?? [],
      replyRefs: delta.replyRefs ?? replyRefsDelta ?? {},
      edges: delta.edges ?? edgesDelta ?? [],
    };
  }

  return {
    ...prevSnap,
    unchanged: false,
    ...(delta.conversationId !== undefined ? { conversationId: delta.conversationId } : {}),
    ...(delta.swarm !== undefined ? { swarm: delta.swarm } : {}),
    ...(delta.member !== undefined ? { member: delta.member } : {}),
    ...(delta.resolvedFrom !== undefined ? { resolvedFrom: delta.resolvedFrom } : {}),
    ...(delta.id !== undefined ? { id: delta.id } : {}),
    ...(delta.title !== undefined ? { title: delta.title } : {}),
    ...(delta.etag !== undefined ? { etag: delta.etag } : {}),
    ...(delta.head !== undefined ? { head: delta.head } : {}),
    messages: delta.messages !== undefined ? delta.messages : mergeMessages(prevSnap.messages, delta.messagesDelta),
    replyRefs: delta.replyRefs !== undefined ? delta.replyRefs : mergeReplyRefs(prevSnap.replyRefs, delta.replyRefsDelta),
    edges: delta.edges !== undefined ? delta.edges : mergeEdges(prevSnap.edges, delta.edgesDelta),
    ...(delta.members !== undefined ? { members: delta.members } : {}),
    ...(delta.channels !== undefined ? { channels: delta.channels } : {}),
    ...(delta.plan !== undefined ? { plan: delta.plan } : {}),
    ...(delta.view !== undefined ? { view: delta.view } : {}),
    ...(delta.frames !== undefined ? { frames: delta.frames } : {}),
    ...(delta.allowedFiles !== undefined ? { allowedFiles: delta.allowedFiles } : {}),
    ...(delta.triage !== undefined ? { triage: delta.triage } : {}),
    ...(delta.burnSummary !== undefined ? { burnSummary: delta.burnSummary } : {}),
    ...(delta.gateReadiness !== undefined ? { gateReadiness: delta.gateReadiness } : {}),
    ...(delta.usage !== undefined ? { usage: delta.usage } : {}),
    ...(delta.unseen !== undefined ? { unseen: delta.unseen } : {}),
    ...(delta.swarms !== undefined ? { swarms: delta.swarms } : {}),
    ...(delta.capabilities !== undefined ? { capabilities: delta.capabilities } : {}),
  };
}

export const fetchWorktrees = (roots: string[]): Promise<WorktreesPayload> =>
  apiJson(qs("/api/worktrees", { roots: roots.join(",") }), "Worktrees failed");

export async function fetchWorktreeDiff(
  root: string,
  worktree: string,
  file: string,
  mode: WorktreeDiffMode = "working",
): Promise<WorktreeDiffPayload> {
  const res = await sidecarFetch(qs("/api/worktrees/diff", { root, worktree, path: worktree, file, mode }));
  const data = (await res.json().catch(() => ({}))) as Partial<WorktreeDiffPayload>;
  if (!res.ok) throw new Error(data.error || `Diff peek failed (${res.status})`);
  return data as WorktreeDiffPayload;
}

export async function runWorktreeAction(
  action: WorktreeActionName,
  path: string,
  targetBranch?: string,
  root?: string,
): Promise<WorktreeActionPayload> {
  const res = await sidecarFetch("/api/worktrees/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      confirm: true,
      action,
      path,
      worktree: path,
      ...(root ? { root } : {}),
      ...(targetBranch ? { targetBranch } : {}),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<WorktreeActionPayload>;
  const conflicts = data.conflicts || data.conflictFiles || [];
  const hasConflict =
    data.status === "conflict" || data.clean === false || conflicts.length > 0 || Boolean(data.aborted);
  if (res.status === 409 || hasConflict) {
    return {
      ok: Boolean(res.ok && data.ok && !hasConflict),
      action: data.action || action,
      status: data.status || (res.status === 409 ? "conflict" : hasConflict ? "conflict" : undefined),
      result: data.result,
      aborted: data.aborted,
      conflicts,
      conflictFiles: conflicts,
      message: data.message || data.error || data.stderr || data.stdout || `Action ${action} blocked (${res.status})`,
      error: data.error,
    };
  }
  if (!res.ok) {
    throw new Error(data.error || data.message || `Worktree action failed (${res.status})`);
  }
  return data as WorktreeActionPayload;
}

export async function sendConfirmedNudge(target: string | string[], message: string): Promise<void> {
  const ids = Array.isArray(target) ? [...new Set(target.filter(Boolean))] : target ? [target] : [];
  if (!ids.length) throw new Error("No target");
  const send = sc()?.agent?.sendMessage;
  if (ids.length === 1 && send) {
    await send(message, ids[0]);
    return;
  }
  if (ids.length > 1 && !window.__FLEET_LIVE_WEB__ && send) {
    await Promise.all(ids.map((id) => send(message, id)));
    return;
  }
  const body = ids.length === 1 ? { confirm: true, conversationId: ids[0], message } : { confirm: true, conversationIds: ids, message };
  const res = await sidecarFetch("/api/nudge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Nudge failed (${res.status})`);
  }
}

export interface PlanPatchPayload {
  title?: string;
  goal?: string;
  goalTitle?: string;
  goalLine?: string;
  gate?: string;
  tasks?: Record<string, string>;
  threads?: PlanThread[];
  workstreams?: PlanWorkstream[];
  milestones?: PlanMilestone[];
  risks?: PlanRisk[];
}

export interface SavePlanRequest {
  conversationId: string;
  ifMatch: string;
  mode?: "patch" | "replace";
  notifyCoordinator?: boolean;
  patch: PlanPatchPayload;
}

export interface SavePlanResponse {
  ok: boolean;
  plan?: NormalizedPlan | SwarmPlan;
  etag?: string;
  notified?: boolean;
  error?: string;
}

export class PlanConflictError extends Error {
  latestPlan?: NormalizedPlan | SwarmPlan;

  constructor(message: string, latestPlan?: NormalizedPlan | SwarmPlan) {
    super(message);
    this.name = "PlanConflictError";
    this.latestPlan = latestPlan;
  }
}

export async function saveSwarmPlan(req: SavePlanRequest): Promise<SavePlanResponse> {
  if (!req.conversationId) throw new Error("No active swarm");
  const res = await sidecarFetch("/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      confirm: true,
      conversationId: req.conversationId,
      ifMatch: req.ifMatch ?? "",
      mode: req.mode || "patch",
      notifyCoordinator: Boolean(req.notifyCoordinator),
      patch: req.patch,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<SavePlanResponse>;
  if (res.status === 409) {
    const latest =
      data.plan && typeof data.plan === "object"
        ? { ...data.plan, ...(data.etag && !data.plan.etag ? { etag: data.etag } : {}) }
        : data.plan;
    throw new PlanConflictError(data.error || "Plan changed on disk", latest);
  }
  if (!res.ok) {
    throw new Error(data.error || `Save plan failed (${res.status})`);
  }
  return data as SavePlanResponse;
}

export interface SwarmControlResponse {
  ok: boolean;
  op: SwarmControlOp;
  coordinatorId?: string;
  directivePreview?: string;
  deliveredAt?: string;
  error?: string;
}

export class SwarmControlError extends Error {
  status: number;
  dirtyFiles?: number;
  ahead?: number;

  constructor(message: string, status: number, extra?: { dirtyFiles?: number; ahead?: number }) {
    super(message);
    this.name = "SwarmControlError";
    this.status = status;
    this.dirtyFiles = extra?.dirtyFiles;
    this.ahead = extra?.ahead;
  }
}

export async function sendSwarmControl(req: ControlRequest): Promise<SwarmControlResponse> {
  if (!req.conversationId) throw new Error("No active swarm");
  const res = await sidecarFetch("/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, confirm: true }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<SwarmControlResponse> & {
    dirtyFiles?: number;
    ahead?: number;
  };
  if (!res.ok) {
    throw new SwarmControlError(data.error || `Control action failed (${res.status})`, res.status, {
      dirtyFiles: typeof data.dirtyFiles === "number" ? data.dirtyFiles : undefined,
      ahead: typeof data.ahead === "number" ? data.ahead : undefined,
    });
  }
  return data as SwarmControlResponse;
}

export async function startSwarmPreset(prompt: string, title: string): Promise<boolean> {
  const start = sc()?.agent?.startConversation;
  if (!start) return false;
  await start(prompt, title);
  return true;
}

export function openWorkerConversation(conversationId: string): boolean {
  const fn = sc()?.ui?.toggleConversation;
  if (!conversationId || !fn) return false;
  fn(conversationId);
  return true;
}

export function openFileInAuxPane(uriOrPath: string): boolean {
  const fn = sc()?.ui?.toggleAuxPane;
  if (!uriOrPath || !fn) return false;
  fn({ tabType: "fileView", uri: uriOrPath.startsWith("file://") ? uriOrPath : `file://${uriOrPath}` });
  return true;
}

export function parseScreenshotLines(text: string): {
  cleanText: string;
  shots: Array<{ path: string; fileName: string; caption: string }>;
} {
  const shots: Array<{ path: string; fileName: string; caption: string }> = [];
  const re = /(?:^|\n)\s*(?:[-*]\s*)?Screenshot:\s*`?(\/[^\s`|]+\.(?:png|jpe?g|webp))`?\s*(?:\|\s*([^\n]+?))?(?=\n|$)/gi;
  const cleanText = String(text || "")
    .replace(re, (_m, path: string, caption?: string) => {
      const fileName = path.split("/").pop() || "screenshot.png";
      shots.push({ path, fileName, caption: String(caption || "").trim() });
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanText, shots };
}

export function extractLocalFilePaths(text: string): string[] {
  const seen = new Set<string>();
  const re = /(?:^|[\s`("'])(\/[a-zA-Z0-9._/-]+\.[a-zA-Z0-9]{1,12})(?=$|[\s`)"',:])/g;
  for (const m of String(text || "").matchAll(re)) {
    const p = m[1];
    if (p.length > 4 && !p.includes("..")) seen.add(p);
    if (seen.size >= 3) break;
  }
  return [...seen];
}

export function inferThemeFromCssColor(color: string): ThemeMode | null {
  const m = String(color || "").trim().match(/^#([0-9a-f]{6})$|^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return null;
  const [r, g, b] = m[1]
    ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)]
    : [Number(m[2]), Number(m[3]), Number(m[4])];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.45 ? "dark" : "light";
}

export function applyTheme(theme: ThemeMode, persist = true): void {
  document.documentElement.setAttribute("data-theme", theme);
  if (persist) try { localStorage.setItem("fleet-theme", theme); } catch {}
}

export function readStoredTheme(): ThemeMode {
  try {
    return localStorage.getItem("fleet-theme") === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}
