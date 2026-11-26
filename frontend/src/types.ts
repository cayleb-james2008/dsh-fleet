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

export interface PlanWorkstream {
  id?: string;
  title: string;
  owner?: string;
  status?: string;
}

export interface PlanMilestone {
  title: string;
  status?: string;
}

export interface SwarmPlan {
  title?: string;
  goal?: string;
  gate?: string;
  repo?: string;
  workstreams?: PlanWorkstream[];
  milestones?: PlanMilestone[];
  risks?: Array<string | { title: string; severity?: string }>;
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

export interface GateReadiness {
  state: "blocked" | "ready" | "verifying";
  pendingSeq: number;
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
  plan?: SwarmPlan | null;
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
