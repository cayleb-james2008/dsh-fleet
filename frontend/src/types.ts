export type ThemeMode = "light" | "dark";
export type TabId = "triage" | "board" | "roster" | "graph" | "worktrees";

export interface TokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CostSummary {
  totalUsd: number;
  inputUsd: number;
  cacheReadUsd: number;
  outputUsd: number;
  cacheSavingsUsd: number;
  cacheHitPct: number;
  pricingKnown: boolean;
}

export interface ModelUsageEntry {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  steps: number;
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
  contextLimit?: number;
  contextPct?: number;
  usage: TokenUsage;
  cost?: CostSummary;
  byModel?: Record<string, ModelUsageEntry>;
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
  acked?: boolean;
  snoozed?: boolean;
  ackAction?: "ack" | "snooze" | string | null;
  ackState?: "ack" | "snooze" | "acked" | "snoozed" | string | null;
  ackedAt?: number | null;
  untilSeq?: number | null;
  ackUntilSeq?: number | null;
  ackNote?: string | null;
}

export interface PortfolioUrgentItem extends TriageItem {
  swarmTitle?: string;
  swarmId?: string;
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
  costUsd?: number;
  gateState?: "blocked" | "ready" | "verifying" | string | null;
  blockedCount?: number;
  failureCount?: number;
  repo?: string;
  archived?: boolean;
  topUrgent?: TriageItem | PortfolioUrgentItem | null;
}

export interface PortfolioResponse {
  ok?: boolean;
  totalCostUsd: number;
  totalTokens: number;
  activeSwarms: number;
  urgentCount: number;
  urgentTriage: PortfolioUrgentItem[];
  swarms: SwarmSummary[];
  error?: string;
}

export type TriageAckAction = "ack" | "snooze" | "unack";

export interface TriageAckRecord {
  triageId?: string;
  action?: "ack" | "snooze" | string;
  untilSeq?: number | null;
  note?: string;
  ackedAt?: number | string;
  at?: number;
  seq?: number;
}

export interface TriageAckRequest {
  conversationId: string;
  triageId: string;
  action: TriageAckAction;
  untilSeq?: number;
  note?: string;
}

export interface TriageAckResponse {
  ok: boolean;
  conversationId?: string;
  triageId?: string;
  action?: TriageAckAction;
  acks?: Record<string, TriageAckRecord>;
  ackedTriage?: Record<string, TriageAckRecord>;
  triage?: TriageItem[];
  error?: string;
}

export interface PinPostRequest {
  conversationId: string;
  seq: number;
  pinned: boolean;
}

export interface PinPostResponse {
  ok: boolean;
  conversationId?: string;
  seq?: number;
  pinned?: boolean;
  pinnedSeqs?: number[];
  pins?: number[];
  error?: string;
}

export interface SwarmArchiveRequest {
  conversationId: string;
  archived: boolean;
}

export interface SwarmArchiveResponse {
  ok: boolean;
  conversationId?: string;
  archived?: boolean;
  error?: string;
}

export interface CheckpointWorktreeSnapshot {
  path: string;
  branch: string;
  head: string;
  clean?: boolean;
  dirtyFiles?: number;
}

export interface CheckpointWorktreeDiff {
  path?: string;
  branch?: string;
  head?: string;
  prevHead?: string;
  dirtyFiles?: number;
  changed?: boolean;
  status?: string;
}

export interface CheckpointDiffSummary {
  headDelta?: number;
  newMessages?: number;
  planChanged?: boolean;
  worktreeChanges?: number;
  changedWorktrees?: CheckpointWorktreeDiff[];
  summary?: string;
}

export interface SwarmCheckpoint {
  id: string;
  conversationId?: string;
  label: string;
  createdAt: number | string;
  head: number;
  costUsd?: number;
  plan?: SwarmPlan | NormalizedPlan | null;
  planEtag?: string;
  planGoal?: string;
  memberCount?: number;
  activeCount?: number;
  triageCount?: number;
  worktrees?: CheckpointWorktreeSnapshot[];
  diff?: CheckpointDiffSummary | null;
  diffVsLive?: CheckpointDiffSummary | null;
}

export interface CheckpointsListResponse {
  ok?: boolean;
  conversationId?: string;
  checkpoints: SwarmCheckpoint[];
  error?: string;
}

export interface CreateCheckpointRequest {
  conversationId: string;
  label: string;
  roots?: string[];
}

export interface CreateCheckpointResponse {
  ok: boolean;
  checkpoint?: SwarmCheckpoint;
  checkpoints?: SwarmCheckpoint[];
  error?: string;
}

export type CheckpointRestoreMode = "plan" | "resume_prompt";

export interface RestoreCheckpointRequest {
  conversationId: string;
  checkpointId: string;
  mode: CheckpointRestoreMode;
}

export interface RestoreCheckpointResponse {
  ok: boolean;
  mode: CheckpointRestoreMode;
  checkpointId?: string;
  plan?: SwarmPlan | NormalizedPlan;
  etag?: string;
  resumePrompt?: string;
  prompt?: string;
  message?: string;
  error?: string;
}

export interface BurnWorker {
  name: string;
  totalTokens: number;
  sharePct: number;
  level: "normal" | "warn" | "critical";
  killed?: boolean;
  costUsd?: number;
  cacheHitPct?: number;
  cacheSavingsUsd?: number;
  pricingKnown?: boolean;
}

export interface BurnSummary {
  totalTokens: number;
  topWorker: BurnWorker | null;
  highBurnCount: number;
  workers: BurnWorker[];
  costUsd?: number;
  cacheHitPct?: number;
  cacheSavingsUsd?: number;
  pricingKnown?: boolean;
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

export type SwarmWorkspaceMode = "inherit" | "share" | "branch";

export type SwarmControlOp =
  | "board_post"
  | "spawn_worker"
  | "switch_model"
  | "kill_worker"
  | "channel_op"
  | "gate_verdict";

export type OperatorCommandStatus =
  | "dispatched"
  | "verified"
  | "failed"
  | "timed_out"
  | "dismissed";

export interface OperatorCommand {
  opId: string;
  clientOpId?: string;
  op: string;
  target?: string;
  payload?: unknown;
  status: OperatorCommandStatus;
  createdAt: number | string;
  updatedAt: number | string;
  coordinatorId?: string;
  resolvedSeq?: number | null;
  error?: string | null;
}

export interface CoordinatorDispatchState {
  status?: string;
  failure?: MemberFailure | null;
}

export interface ControlDispatchResponse {
  ok: boolean;
  op?: SwarmControlOp | string;
  opId?: string;
  status?: OperatorCommandStatus | string;
  coordinatorId?: string;
  coordinatorState?: CoordinatorDispatchState | string | null;
  directivePreview?: string;
  deliveredAt?: string;
  delivered?: number;
  error?: string;
}

export type OperatorOpAction = "retry" | "dismiss" | "mark_verified";

export interface OpsListResponse {
  ok?: boolean;
  conversationId?: string;
  ops: OperatorCommand[];
  error?: string;
}

export interface OpActionResponse {
  ok: boolean;
  op?: OperatorCommand;
  ops?: OperatorCommand[];
  opId?: string;
  action?: OperatorOpAction;
  error?: string;
}

export type ControlRequest =
  | {
      op: "board_post";
      conversationId: string;
      confirm?: boolean;
      channel?: string;
      text: string;
      replyToSeq?: number;
    }
  | {
      op: "spawn_worker";
      conversationId: string;
      confirm?: boolean;
      name: string;
      brief: string;
      workspaceMode?: SwarmWorkspaceMode;
      channel?: string;
      model?: string;
      forkFrom?: string;
    }
  | {
      op: "switch_model";
      conversationId: string;
      confirm?: boolean;
      member: string;
      model: string;
      reason?: string;
      allowWorking?: boolean;
    }
  | {
      op: "kill_worker";
      conversationId: string;
      confirm?: boolean;
      member: string;
      forceUnmerged?: boolean;
      reason?: string;
    }
  | {
      op: "channel_op";
      conversationId: string;
      confirm?: boolean;
      action: "create" | "archive" | "subscribe" | "unsubscribe";
      channel: string;
      topic?: string;
      member?: string;
    }
  | {
      op: "gate_verdict";
      conversationId: string;
      confirm?: boolean;
      verdict: "verified" | "blocked" | "ship";
      seq: number;
      targetMember?: string;
      note: string;
    };

export interface SwarmChannel {
  name: string;
  topic: string;
  created_by: string;
  archived: boolean;
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
  replyRefs?: Record<number, number[]>;
  channels?: SwarmChannel[];
  edges?: MentionEdge[];
  view?: SwarmViewState | null;
  plan?: SwarmPlan | NormalizedPlan | null;
  frames?: FrameAsset[];
  allowedFiles?: Record<string, string>;
  triage?: TriageItem[];
  burnSummary?: BurnSummary;
  gateReadiness?: GateReadiness | null;
  usage?: TokenUsage;
  contextLimit?: number;
  contextPct?: number;
  cost?: CostSummary;
  byModel?: Record<string, ModelUsageEntry>;
  unseen?: number[];
  pinnedSeqs?: number[];
  pins?: number[];
  triageAcks?: Record<string, TriageAckRecord>;
  ackedTriage?: Record<string, TriageAckRecord>;
  archived?: boolean;
  checkpoints?: SwarmCheckpoint[];
  ops?: OperatorCommand[];
  swarms?: SwarmSummary[];
  capabilities?: {
    canSendMessage: boolean;
    isSidecar: boolean;
    sseStream?: boolean;
    deltaStream?: boolean;
  };
}

export interface SwarmDeltaPayload {
  ok?: boolean;
  mode?: "delta" | "full";
  unchanged?: boolean;
  conversationId?: string | null;
  swarm?: string | null;
  member?: string | null;
  resolvedFrom?: "conversation" | "latest";
  id?: string;
  title?: string;
  etag?: string;
  since?: number;
  head?: number;
  messagesDelta?: BoardMessage[];
  replyRefsDelta?: Record<number, number[]>;
  edgesDelta?: MentionEdge[];
  messages?: BoardMessage[];
  replyRefs?: Record<number, number[]>;
  edges?: MentionEdge[];
  members?: SwarmMember[];
  channels?: SwarmChannel[];
  plan?: SwarmPlan | NormalizedPlan | null;
  view?: SwarmViewState | null;
  frames?: FrameAsset[];
  allowedFiles?: Record<string, string>;
  triage?: TriageItem[];
  burnSummary?: BurnSummary;
  gateReadiness?: GateReadiness | null;
  usage?: TokenUsage;
  contextLimit?: number;
  contextPct?: number;
  cost?: CostSummary;
  byModel?: Record<string, ModelUsageEntry>;
  unseen?: number[];
  pinnedSeqs?: number[];
  pins?: number[];
  triageAcks?: Record<string, TriageAckRecord>;
  ackedTriage?: Record<string, TriageAckRecord>;
  archived?: boolean;
  checkpoints?: SwarmCheckpoint[];
  ops?: OperatorCommand[];
  swarms?: SwarmSummary[];
  capabilities?: SwarmSnapshot["capabilities"];
}

export type WorktreeMergeability =
  | "clean"
  | "conflict"
  | "dirty"
  | "detached"
  | "main"
  | "ff"
  | "clean_merge"
  | "up_to_date"
  | "unknown";

export type WorktreeDiffMode = "working" | "branch";

export type WorktreeActionName =
  | "dry_run_merge"
  | "ff_merge"
  | "rebase"
  | "remove_worktree";

export interface WorktreeChangedFile {
  path: string;
  state: string;
  uri: string;
  added?: number;
  removed?: number;
}

export interface WorktreeCommitInfo {
  sha: string;
  subject: string;
  authorTime?: string;
  at?: number;
}

export interface WorktreeCollision {
  file: string;
  worktrees: Array<string | { id?: string; branch?: string; path?: string; source?: string }>;
  branches?: string[];
  kind?: "working" | "branch" | "mixed";
  root?: string;
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
  mergeability?: WorktreeMergeability;
  conflictFiles?: string[];
  dirtyFiles: number;
  untrackedFiles: number;
  stagedFiles: number;
  files?: WorktreeChangedFile[];
  filesTruncated?: boolean;
  branchFiles?: Array<string | WorktreeChangedFile>;
  branchFilesTruncated?: boolean;
  commits?: WorktreeCommitInfo[];
  lastCommitSha: string;
  lastCommitSubject: string;
  lastCommitAt: number;
}

export interface WorktreesPayload {
  roots: Array<{ path: string; uri: string; isGit: boolean; count: number; error: string }>;
  worktrees: WorktreeInfo[];
  collisions?: WorktreeCollision[];
  rejected: string[];
}

export interface WorktreeDiffPayload {
  ok: boolean;
  worktree: string;
  file: string;
  mode?: WorktreeDiffMode;
  diff: string;
  truncated: boolean;
  untracked: boolean;
  added: number;
  removed: number;
  error?: string;
}

export interface WorktreeActionPayload {
  ok: boolean;
  action: WorktreeActionName | string;
  status?: string;
  result?: string;
  clean?: boolean;
  aborted?: boolean;
  conflicts?: string[];
  conflictFiles?: string[];
  message?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export type TranscriptFilter = "all" | "errors" | "tools";

export interface TranscriptToolCall {
  name: string;
  summary?: string;
  args?: unknown;
  status?: string;
  outputPreview?: string;
}

export interface TranscriptStepUsage {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

export interface TranscriptStep {
  stepIndex: number;
  type: string;
  status: string;
  ts: number | string;
  durationMs?: number | null;
  model?: string;
  thinking?: string;
  content?: string;
  error?: string | null;
  toolCalls?: TranscriptToolCall[];
  usage?: TranscriptStepUsage | null;
}

export interface TranscriptResponse {
  ok: boolean;
  member: string;
  conversationId: string;
  totalSteps: number;
  nextBefore: number | null;
  hasMore: boolean;
  steps: TranscriptStep[];
  error?: string;
}
