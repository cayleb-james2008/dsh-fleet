export type ThemeMode = "light" | "dark";
export type TabId = "triage" | "board" | "roster" | "graph" | "worktrees";

export interface TokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface MemberFailure {
  kind: "quota" | "error";
  text: string;
}

export interface ActivityPeek {
  status: "working" | "waiting";
  label: string;
  tool?: string;
  ts: number;
}

export interface SwarmMember {
  name: string;
  conversation_id: string;
  model: string;
  role: string;
  wake_mode: string;
  status: "working" | "waiting" | "killed";
  wait_since: number;
  last_read_seq: number;
  unread: number;
  killed: boolean;
  steps: number;
  activity: string;
  activityKind: "tool" | "thinking" | "";
  activityPeek?: ActivityPeek | null;
  replied: boolean;
  replyAsk: string;
  narrator: boolean;
  roleWorker: boolean;
  failure: MemberFailure | null;
  transcriptMtime: number;
  startedAt: string;
  lastStepAt: string;
  thinkingHeading?: string;
  recentTools?: Array<{ name: string; summary: string; time: string }>;
  lastContextTokens?: number;
  usage: TokenUsage;
  workspace_mode?: string;
  workspace?: string;
  posts: number;
  lastPostSeq: number;
  lastPostTime: string;
  lastPostTs: number | null;
  channels?: string[];
}

export interface BoardControl {
  op: string;
  channel?: string;
  topic?: string;
  members?: string[];
}

export interface BoardMessage {
  seq: number;
  agent: string;
  text: string;
  time: string;
  ts: number | null;
  mentions: string[];
  all: boolean;
  channel?: string;
  control?: BoardControl;
  channel_mentions?: string[];
  via_channel?: string[];
}

export interface MentionEdge {
  from: string;
  to: string;
  count: number;
  direct: number;
  viaAll: number;
}

export type PlanWorkstreamStatus = "pending" | "running" | "done" | "verified" | "blocked";
export type PlanMilestoneStatus = "pending" | "in_progress" | "done" | "blocked";

export interface PlanWorkstream {
  id?: string;
  title: string;
  owner?: string;
  status?: PlanWorkstreamStatus | string;
  note?: string;
  threadId?: string;
}

export interface PlanMilestone {
  title: string;
  status?: PlanMilestoneStatus | string;
}

export interface PlanThread {
  id: string;
  title: string;
  goal: string;
  tasks: string[];
}

export interface PlanRisk {
  title: string;
  severity?: "low" | "med" | "high" | string;
}

export interface PlanGoalObject {
  title?: string;
  line?: string;
}

export interface NormalizedPlan {
  schema: "native" | "fleet" | "hybrid";
  etag: string;
  title: string;
  goal: string;
  goalTitle?: string;
  goalLine?: string;
  gate: string;
  repo?: string;
  threads: PlanThread[];
  tasks: Record<string, string>;
  workstreams: Array<{
    id: string;
    title: string;
    owner: string;
    status: PlanWorkstreamStatus;
    note?: string;
    threadId?: string;
  }>;
  milestones: Array<{
    title: string;
    status: PlanMilestoneStatus;
  }>;
  risks: PlanRisk[];
}

export interface SwarmPlan {
  schema?: "native" | "fleet" | "hybrid";
  etag?: string;
  title?: string;
  goal?: string | PlanGoalObject;
  goalTitle?: string;
  goalLine?: string;
  gate?: string;
  repo?: string;
  threads?: Array<Partial<PlanThread> & { goal?: string | PlanGoalObject }>;
  tasks?: Record<string, unknown>;
  workstreams?: PlanWorkstream[];
  milestones?: PlanMilestone[];
  risks?: Array<string | PlanRisk>;
}

export interface NarratorViewJson {
  headline?: string;
  phase?: string;
  running_summary?: string;
  now?: Record<string, unknown>;
  attention?: Array<string | { title?: string; detail?: string; member?: string; severity?: string; text?: string }>;
  feedback_ack?: unknown;
}

export interface SwarmViewState {
  exists: boolean;
  dir?: string;
  source?: "swarm" | "narrator";
  json?: NarratorViewJson | null;
  jsonMtime?: number;
  jsonError?: string;
}

export interface TriageItem {
  id: string;
  kind: "quota" | "error" | "stuck" | "blocked" | "question" | "verify";
  severity: "urgent" | "attention" | "verify";
  member: string;
  conversationId: string;
  seq: number;
  title: string;
  detail: string;
  suggestedPrompt: string;
  timestamp: number;
}

export interface FrameAsset {
  path: string;
  seq: number;
  caption: string;
}

export interface SwarmSummary {
  id: string;
  title: string;
  appData: string;
  head: number;
  memberCount: number;
  activeCount: number;
  waitingCount: number;
  killedCount: number;
  triageCount: number;
  totalTokens: number;
  hasPlan: boolean;
  lastActivityTs: number;
}

export interface BurnWorker {
  name: string;
  totalTokens: number;
  sharePct: number;
  level: "normal" | "warn" | "critical";
  killed?: boolean;
}

export interface BurnSummary {
  totalTokens: number;
  topWorker: BurnWorker | null;
  highBurnCount: number;
  workers: BurnWorker[];
}

export interface GateNextAction {
  kind: string;
  target: string;
  conversationId: string;
  seq: number;
  label: string;
  prompt: string;
}

export interface WaveVelocity {
  passRatePct: number;
  waves: number;
  wavesPerHr: number;
  shippedSeq: number;
  exactShipped: boolean;
  done: number;
  verified: number;
  scaleVerified: number;
  blocked: number;
}

export interface GateReadiness {
  state: "blocked" | "ready" | "verifying";
  pendingSeq: number;
  nextAction?: GateNextAction;
  velocity?: WaveVelocity;
  stages: Array<{ key: string; label: string; count: number; seq: number }>;
}

export interface SwarmSnapshot {
  conversationId: string | null;
  swarm: string | null;
  member: string | null;
  resolvedFrom?: "conversation" | "latest";
  unchanged?: boolean;
  etag?: string;
  id?: string;
  title?: string;
  head?: number;
  members?: SwarmMember[];
  messages?: BoardMessage[];
  channels?: Array<{ name: string; topic: string; created_by: string; archived: boolean }>;
  edges?: MentionEdge[];
  view?: SwarmViewState | null;
  plan?: SwarmPlan | NormalizedPlan | null;
  frames?: FrameAsset[];
  allowedFiles?: Record<string, string>;
  triage?: TriageItem[];
  burnSummary?: BurnSummary;
  gateReadiness?: GateReadiness | null;
  usage?: TokenUsage;
  unseen?: number[];
  swarms?: SwarmSummary[];
  capabilities?: {
    canSendMessage: boolean;
    isSidecar: boolean;
    sseStream?: boolean;
  };
}

export interface WorktreeChangedFile {
  path: string;
  state: string;
  uri: string;
}

export interface WorktreeInfo {
  id: string;
  root: string;
  name: string;
  path: string;
  uri: string;
  isMain: boolean;
  exists: boolean;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  branch: string;
  head: string;
  clean: boolean;
  baseBranch?: string;
  ahead?: number;
  behind?: number;
  landStatus?: "main" | "ready" | "rebase" | "dirty" | "merged";
  dirtyFiles: number;
  untrackedFiles: number;
  stagedFiles: number;
  files?: WorktreeChangedFile[];
  filesTruncated?: boolean;
  lastCommitSha: string;
  lastCommitSubject: string;
  lastCommitAt: number;
}

export interface WorktreesPayload {
  roots: Array<{ path: string; uri: string; isGit: boolean; count: number; error: string }>;
  worktrees: WorktreeInfo[];
  rejected: string[];
}

export interface WorktreeDiffPayload {
  ok: boolean;
  worktree: string;
  file: string;
  diff: string;
  truncated: boolean;
  untracked: boolean;
  added: number;
  removed: number;
  error?: string;
}
