import type {
  BoardMessage,
  CheckpointsListResponse,
  ControlDispatchResponse,
  ControlRequest,
  CreateCheckpointRequest,
  CreateCheckpointResponse,
  MentionEdge,
  NormalizedPlan,
  OpActionResponse,
  OperatorCommand,
  OperatorOpAction,
  OpsListResponse,
  PinPostRequest,
  PinPostResponse,
  PlanMilestone,
  PlanRisk,
  PlanThread,
  PlanWorkstream,
  PortfolioResponse,
  RestoreCheckpointRequest,
  RestoreCheckpointResponse,
  SwarmArchiveRequest,
  SwarmArchiveResponse,
  SwarmDeltaPayload,
  SwarmPlan,
  SwarmSnapshot,
  SwarmSummary,
  ThemeMode,
  TranscriptFilter,
  TranscriptResponse,
  TriageAckRequest,
  TriageAckResponse,
  TriageItem,
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

async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  timeoutLabel: string,
): Promise<Response> {
  const outerSignal = init?.signal;
  if (outerSignal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  const ac = new AbortController();
  let timedOut = false;
  const onOuterAbort = () => ac.abort();
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, timeoutMs)
      : null;
  try {
    return await sidecarFetch(url, { ...(init || {}), signal: ac.signal });
  } catch (err) {
    if (timedOut && !outerSignal?.aborted) {
      throw new Error(`${timeoutLabel} timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

async function apiJson<T>(url: string, errLabel: string, signal?: AbortSignal, timeoutMs = 15_000): Promise<T> {
  const res = await fetchWithTimeout(url, signal ? { signal } : undefined, timeoutMs, errLabel);
  if (!res.ok) throw new Error(`${errLabel} (${res.status})`);
  return res.json();
}

const qs = (path: string, params: Record<string, string | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return `${path}${s ? `?${s}` : ""}`;
};

export const fetchSwarms = (signal?: AbortSignal): Promise<{ swarms: SwarmSummary[]; defaultConversationId: string | null }> =>
  apiJson("/api/swarms", "List swarms failed", signal);

export const fetchSwarmSnapshot = (
  conversationId?: string | null,
  etag?: string,
  signal?: AbortSignal,
): Promise<SwarmSnapshot> =>
  apiJson(qs("/api/swarm", { conversationId, etag }), "Load swarm failed", signal);

export interface FetchMemberTranscriptOptions {
  conversationId: string;
  member: string;
  before?: number | null;
  limit?: number;
  filter?: TranscriptFilter;
  signal?: AbortSignal;
}

export async function fetchMemberTranscript(
  baseUrl: string,
  opts: FetchMemberTranscriptOptions,
): Promise<TranscriptResponse> {
  const prefix = baseUrl ? baseUrl.replace(/\/+$/, "") : "";
  const url = qs(`${prefix}/api/transcript`, {
    conversationId: opts.conversationId,
    member: opts.member,
    before: typeof opts.before === "number" && opts.before >= 0 ? String(Math.floor(opts.before)) : undefined,
    limit: typeof opts.limit === "number" && opts.limit > 0 ? String(Math.min(50, Math.floor(opts.limit))) : undefined,
    filter: opts.filter || undefined,
  });
  const res = await fetchWithTimeout(
    url,
    opts.signal ? { signal: opts.signal } : undefined,
    15_000,
    "Load transcript",
  );
  const data = (await res.json().catch(() => ({}))) as Partial<TranscriptResponse>;
  if (!res.ok) throw new Error(data.error || `Load transcript failed (${res.status})`);
  return data as TranscriptResponse;
}

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
  const timeoutMs = Math.max(30_000, (opts.waitMs || 0) + 10_000);
  const res = await fetchWithTimeout(url, opts.signal ? { signal: opts.signal } : undefined, timeoutMs, "Load swarm delta");
  if (!res.ok) throw new Error(`Load swarm delta failed (${res.status})`);
  return res.json();
}

const isValidSeq = (seq: unknown): seq is number => typeof seq === "number" && Number.isFinite(seq) && seq > 0;
const finiteNonNeg = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function mergeMessages(prevMsgs: BoardMessage[] = [], deltaMsgs: BoardMessage[] = []): BoardMessage[] {
  const bySeq = new Map<number, BoardMessage>();
  const unseq: BoardMessage[] = [];
  for (const list of [prevMsgs, deltaMsgs]) {
    for (const m of list) {
      if (!m) continue;
      if (isValidSeq(m.seq)) bySeq.set(m.seq, m);
      else unseq.push(m);
    }
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
    if (!isValidSeq(seqKey)) continue;
    const rawList = deltaRefs[seqKey];
    if (!Array.isArray(rawList) || !rawList.length) continue;
    const addList = rawList.filter(isValidSeq);
    if (!addList.length) continue;
    const prevList = Array.isArray(next[seqKey]) ? next[seqKey].filter(isValidSeq) : [];
    next[seqKey] = [...new Set([...prevList, ...addList])].sort((a, b) => a - b);
  }
  return next;
}

function mergeEdges(prevEdges: MentionEdge[] = [], deltaEdges: MentionEdge[] | undefined): MentionEdge[] {
  if (!deltaEdges || !deltaEdges.length) return prevEdges;
  const byKey = new Map<string, MentionEdge>();
  for (const e of prevEdges) {
    if (!e) continue;
    byKey.set(`${e.from}\0${e.to}`, {
      ...e,
      count: finiteNonNeg(e.count),
      direct: finiteNonNeg(e.direct),
      viaAll: finiteNonNeg(e.viaAll),
    });
  }
  for (const d of deltaEdges) {
    if (!d) continue;
    const key = `${d.from}\0${d.to}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += finiteNonNeg(d.count);
      existing.direct += finiteNonNeg(d.direct);
      existing.viaAll += finiteNonNeg(d.viaAll);
    } else {
      byKey.set(key, {
        ...d,
        count: finiteNonNeg(d.count),
        direct: finiteNonNeg(d.direct),
        viaAll: finiteNonNeg(d.viaAll),
      });
    }
  }
  return [...byKey.values()];
}

function maxSeqOf(msgs: BoardMessage[]): number {
  let max = 0;
  for (const m of msgs) {
    if (m && isValidSeq(m.seq) && m.seq > max) max = m.seq;
  }
  return max;
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
    const messages = mergeMessages([], delta.messages ?? messagesDelta ?? []);
    const head = Math.max(finiteNonNeg(delta.head), maxSeqOf(messages));
    return {
      conversationId: delta.conversationId !== undefined ? delta.conversationId : (prevSnap?.conversationId ?? delta.swarm ?? null),
      swarm: delta.swarm !== undefined ? delta.swarm : (prevSnap?.swarm ?? null),
      member: delta.member !== undefined ? delta.member : (prevSnap?.member ?? null),
      ...rest,
      unchanged: false,
      head,
      messages,
      replyRefs: delta.replyRefs ?? replyRefsDelta ?? {},
      edges: delta.edges ?? edgesDelta ?? [],
    };
  }

  const prevMsgs = prevSnap.messages || [];
  const prevSeqSet = new Set(prevMsgs.filter((m) => m && isValidSeq(m.seq)).map((m) => m.seq));
  const deltaMsgs = delta.messagesDelta || [];
  const hasOnlyReplayedMsgs =
    deltaMsgs.length > 0 &&
    deltaMsgs.every((m) => !m || !isValidSeq(m.seq) || prevSeqSet.has(m.seq));
  const messages =
    delta.messages !== undefined
      ? mergeMessages([], delta.messages)
      : deltaMsgs.length
        ? mergeMessages(prevMsgs, deltaMsgs)
        : prevMsgs;
  const head = Math.max(finiteNonNeg(prevSnap.head), finiteNonNeg(delta.head), maxSeqOf(messages));

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
    head,
    messages,
    replyRefs: delta.replyRefs !== undefined ? delta.replyRefs : mergeReplyRefs(prevSnap.replyRefs, delta.replyRefsDelta),
    edges:
      delta.edges !== undefined
        ? delta.edges
        : hasOnlyReplayedMsgs
          ? (prevSnap.edges || [])
          : mergeEdges(prevSnap.edges, delta.edgesDelta),
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
    ...(delta.contextLimit !== undefined ? { contextLimit: delta.contextLimit } : {}),
    ...(delta.contextPct !== undefined ? { contextPct: delta.contextPct } : {}),
    ...(delta.cost !== undefined ? { cost: delta.cost } : {}),
    ...(delta.byModel !== undefined ? { byModel: delta.byModel } : {}),
    ...(delta.unseen !== undefined ? { unseen: delta.unseen } : {}),
    ...(delta.pinnedSeqs !== undefined ? { pinnedSeqs: delta.pinnedSeqs } : {}),
    ...(delta.pins !== undefined ? { pins: delta.pins } : {}),
    ...(delta.triageAcks !== undefined ? { triageAcks: delta.triageAcks } : {}),
    ...(delta.ackedTriage !== undefined ? { ackedTriage: delta.ackedTriage } : {}),
    ...(delta.archived !== undefined ? { archived: delta.archived } : {}),
    ...(delta.checkpoints !== undefined ? { checkpoints: delta.checkpoints } : {}),
    ...(delta.ops !== undefined ? { ops: delta.ops } : {}),
    ...(delta.swarms !== undefined ? { swarms: delta.swarms } : {}),
    ...(delta.capabilities !== undefined ? { capabilities: delta.capabilities } : {}),
  };
}

export const fetchWorktrees = (
  roots: string[],
  conversationId?: string | null,
  signal?: AbortSignal,
): Promise<WorktreesPayload> =>
  apiJson(
    qs("/api/worktrees", {
      roots: roots.length ? roots.join(",") : undefined,
      conversationId: conversationId || undefined,
    }),
    "Worktrees failed",
    signal,
    20_000,
  );

export interface FetchWorktreeDiffOptions {
  targetBranch?: string;
  offset?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export async function fetchWorktreeDiff(
  root: string,
  worktree: string,
  file: string,
  mode: WorktreeDiffMode = "working",
  opts: FetchWorktreeDiffOptions = {},
): Promise<WorktreeDiffPayload> {
  const url = qs("/api/worktrees/diff", {
    root,
    worktree,
    path: worktree,
    file,
    mode,
    targetBranch: opts.targetBranch || undefined,
    offset: typeof opts.offset === "number" && opts.offset >= 0 ? String(Math.floor(opts.offset)) : undefined,
    maxBytes:
      typeof opts.maxBytes === "number" && opts.maxBytes > 0
        ? String(Math.min(32768, Math.floor(opts.maxBytes)))
        : undefined,
  });
  const res = await fetchWithTimeout(
    url,
    opts.signal ? { signal: opts.signal } : undefined,
    15_000,
    "Diff peek",
  );
  const data = (await res.json().catch(() => ({}))) as Partial<WorktreeDiffPayload>;
  if (!res.ok) throw new Error(data.error || `Diff peek failed (${res.status})`);
  return data as WorktreeDiffPayload;
}

export interface RunWorktreeActionOptions {
  commitMessage?: string;
  deleteBranch?: boolean;
  signal?: AbortSignal;
}

export async function runWorktreeAction(
  action: WorktreeActionName,
  path: string,
  targetBranch?: string,
  root?: string,
  opts?: RunWorktreeActionOptions,
): Promise<WorktreeActionPayload> {
  const cleanMsg = typeof opts?.commitMessage === "string" ? opts.commitMessage.trim() : "";
  const res = await fetchWithTimeout(
    "/api/worktrees/action",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: true,
        action,
        path,
        worktree: path,
        ...(root ? { root } : {}),
        ...(targetBranch ? { targetBranch } : {}),
        ...(cleanMsg ? { commitMessage: cleanMsg } : {}),
        ...(opts?.deleteBranch !== undefined ? { deleteBranch: opts.deleteBranch } : {}),
      }),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    },
    30_000,
    "Worktree action",
  );
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

export async function sendConfirmedNudge(target: string | string[], message: string): Promise<ControlDispatchResponse> {
  const ids = Array.isArray(target) ? [...new Set(target.filter(Boolean))] : target ? [target] : [];
  if (!ids.length) throw new Error("No target");
  const send = sc()?.agent?.sendMessage;
  if (ids.length === 1 && send) {
    const res = (await send(message, ids[0])) as Partial<ControlDispatchResponse> | undefined;
    return { ok: true, op: "nudge", ...(res && typeof res === "object" ? res : {}) };
  }
  if (ids.length > 1 && !window.__FLEET_LIVE_WEB__ && send) {
    await Promise.all(ids.map((id) => send(message, id)));
    return { ok: true, op: "nudge", delivered: ids.length };
  }
  const body = ids.length === 1 ? { confirm: true, conversationId: ids[0], message } : { confirm: true, conversationIds: ids, message };
  const res = await fetchWithTimeout(
    "/api/nudge",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    20_000,
    "Nudge",
  );
  const data = (await res.json().catch(() => ({}))) as Partial<ControlDispatchResponse>;
  if (!res.ok) {
    throw new Error(data.error || `Nudge failed (${res.status})`);
  }
  return { ok: true, op: "nudge", ...data };
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
  const res = await fetchWithTimeout(
    "/api/plan",
    {
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
    },
    20_000,
    "Save plan",
  );
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

export type SwarmControlResponse = ControlDispatchResponse;

export class SwarmControlError extends Error {
  status: number;
  code?: string;
  workerStatus?: string;
  dirtyFiles?: number;
  ahead?: number;

  constructor(
    message: string,
    status: number,
    extra?: { code?: string; workerStatus?: string; dirtyFiles?: number; ahead?: number },
  ) {
    super(message);
    this.name = "SwarmControlError";
    this.status = status;
    this.code = extra?.code;
    this.workerStatus = extra?.workerStatus;
    this.dirtyFiles = extra?.dirtyFiles;
    this.ahead = extra?.ahead;
  }
}

export async function sendSwarmControl(req: ControlRequest, signal?: AbortSignal): Promise<ControlDispatchResponse> {
  if (!req.conversationId) throw new Error("No active swarm");
  const res = await fetchWithTimeout(
    "/api/control",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...req, confirm: true }),
      ...(signal ? { signal } : {}),
    },
    20_000,
    "Control command",
  );
  const data = (await res.json().catch(() => ({}))) as Partial<ControlDispatchResponse> & {
    dirtyFiles?: number;
    ahead?: number;
  };
  if (!res.ok) {
    const code = typeof data.error === "string" ? data.error : undefined;
    const workerStatus = typeof data.status === "string" ? data.status : undefined;
    const msg =
      res.status === 409 && code === "worker_not_waiting"
        ? `Worker is ${workerStatus || "working"}. Wait for waiting state or enable override`
        : code || `Control action failed (${res.status})`;
    throw new SwarmControlError(msg, res.status, {
      code,
      workerStatus,
      dirtyFiles: typeof data.dirtyFiles === "number" ? data.dirtyFiles : undefined,
      ahead: typeof data.ahead === "number" ? data.ahead : undefined,
    });
  }
  return data as ControlDispatchResponse;
}

export async function getOps(conversationId: string, signal?: AbortSignal): Promise<OpsListResponse> {
  if (!conversationId) return { ok: true, conversationId: "", ops: [] };
  const res = await fetchWithTimeout(
    qs("/api/ops", { conversationId }),
    signal ? { signal } : undefined,
    15_000,
    "Load ops",
  );
  const raw = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = raw && typeof raw === "object" && "error" in raw ? String((raw as { error?: unknown }).error || "") : "";
    throw new Error(errMsg || `Load ops failed (${res.status})`);
  }
  if (Array.isArray(raw)) {
    return { ok: true, conversationId, ops: raw as OperatorCommand[] };
  }
  const data = (raw && typeof raw === "object" ? raw : {}) as Partial<OpsListResponse>;
  return {
    ok: data.ok ?? true,
    conversationId: data.conversationId || conversationId,
    ops: Array.isArray(data.ops) ? data.ops : [],
  };
}

export async function postOpAction(req: {
  conversationId: string;
  opId: string;
  action: OperatorOpAction;
  signal?: AbortSignal;
}): Promise<OpActionResponse> {
  if (!req.conversationId || !req.opId) throw new Error("Missing swarm or opId");
  const res = await fetchWithTimeout(
    "/api/ops/action",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: true,
        conversationId: req.conversationId,
        opId: req.opId,
        action: req.action,
      }),
      ...(req.signal ? { signal: req.signal } : {}),
    },
    20_000,
    "Operator action",
  );
  const data = (await res.json().catch(() => ({}))) as Partial<OpActionResponse>;
  if (!res.ok) {
    throw new Error(data.error || `Op action failed (${res.status})`);
  }
  return data as OpActionResponse;
}

async function postJsonConfirmed<T>(
  url: string,
  payload: Record<string, unknown>,
  errLabel: string,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<T> {
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, confirm: true }),
      ...(signal ? { signal } : {}),
    },
    timeoutMs,
    errLabel,
  );
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    const err = new Error(data.error || `${errLabel} (${res.status})`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data as T;
}

export const fetchPortfolio = (signal?: AbortSignal): Promise<PortfolioResponse> =>
  apiJson("/api/portfolio", "Load portfolio failed", signal, 15_000);

export function ackTriageItem(req: TriageAckRequest, signal?: AbortSignal): Promise<TriageAckResponse> {
  if (!req.conversationId || !req.triageId) throw new Error("Missing swarm or triage item");
  return postJsonConfirmed("/api/triage/ack", { ...req }, "Triage ack failed", signal, 15_000);
}

export async function postPin(req: PinPostRequest): Promise<PinPostResponse & { status?: number }> {
  if (!req.conversationId) throw new Error("No active swarm");
  const res = await fetchWithTimeout(
    "/api/pins",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...req, confirm: true }),
    },
    15_000,
    "Pin update",
  );
  const data = (await res.json().catch(() => ({}))) as Partial<PinPostResponse>;
  if (!res.ok) {
    const err = new Error(data.error || `Pin update failed (${res.status})`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data as PinPostResponse;
}

export function archiveSwarm(req: SwarmArchiveRequest, signal?: AbortSignal): Promise<SwarmArchiveResponse> {
  if (!req.conversationId) throw new Error("Missing swarm id");
  return postJsonConfirmed("/api/swarm/archive", { ...req }, "Archive swarm failed", signal, 15_000);
}

export function fetchCheckpoints(conversationId: string, signal?: AbortSignal): Promise<CheckpointsListResponse> {
  if (!conversationId) return Promise.resolve({ ok: true, conversationId: "", checkpoints: [] });
  return apiJson(qs("/api/checkpoints", { conversationId }), "Load checkpoints failed", signal, 15_000);
}

export function createCheckpoint(req: CreateCheckpointRequest, signal?: AbortSignal): Promise<CreateCheckpointResponse> {
  if (!req.conversationId || !req.label.trim()) throw new Error("Swarm and checkpoint label required");
  return postJsonConfirmed(
    "/api/checkpoints",
    {
      conversationId: req.conversationId,
      label: req.label.trim(),
      ...(req.roots?.length ? { roots: req.roots } : {}),
    },
    "Create checkpoint failed",
    signal,
    20_000,
  );
}

export function restoreCheckpoint(req: RestoreCheckpointRequest, signal?: AbortSignal): Promise<RestoreCheckpointResponse> {
  if (!req.conversationId || !req.checkpointId) throw new Error("Missing swarm or checkpoint");
  return postJsonConfirmed("/api/checkpoints/restore", { ...req }, "Restore checkpoint failed", signal, 20_000);
}

export function isTriageItemAcked(
  item: TriageItem,
  snap?: Pick<SwarmSnapshot, "triageAcks" | "ackedTriage" | "head"> | null,
): boolean {
  if (item.acked || item.snoozed) return true;
  const st = String(item.ackAction || item.ackState || "").toLowerCase();
  if (st === "ack" || st === "acked" || st === "snooze" || st === "snoozed") return true;
  const rec = snap?.triageAcks?.[item.id] ?? snap?.ackedTriage?.[item.id];
  if (!rec || rec.action === "unack") return false;
  if (typeof rec.untilSeq === "number" && rec.untilSeq > 0 && (snap?.head || 0) > rec.untilSeq) {
    return false;
  }
  return true;
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
