//! Task Dependency DAG Scheduler and Multi-Repo Batch/Matrix Dispatch.
//!
//! - Validates `depends_on: Vec<String>` graphs in linear $O(V + E)$ time using Kahn's
//!   algorithm plus iterative DFS cycle extraction (zero recursion — safe at 10,000+ nodes).
//! - Evaluates topological readiness (`Queued`/`Blocked` -> `Ready` when all upstream
//!   dependencies reach `Done`/`Merged`, or `Needs you: upstream failed` when any
//!   upstream dependency fails or is dismissed, cascading transitively down the DAG).
//! - Provides [`BatchSpec`] for fanning out N tasks across 1 or multiple repositories
//!   under a shared concurrency cap (`max_parallel`), resolving intra-batch symbolic
//!   keys and rejecting cyclic or dangling specs atomically before any session starts.

use crate::checks::CheckStep;
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};
use std::fmt;

/// Scheduling state of a session node inside the dependency DAG.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum DagNodeState {
    Queued,
    Blocked,
    Working,
    Checking,
    Done,
    NeedsYou,
    Merged,
    Archived,
}

impl DagNodeState {
    /// Parse a Fleet session status string into a [`DagNodeState`].
    pub fn from_status_str(status: &str) -> Option<Self> {
        match status.trim().to_ascii_lowercase().as_str() {
            "queued" => Some(Self::Queued),
            "blocked" => Some(Self::Blocked),
            "working" => Some(Self::Working),
            "checking" => Some(Self::Checking),
            "done" => Some(Self::Done),
            "needs-you" | "needs_you" | "needs you" => Some(Self::NeedsYou),
            "merged" => Some(Self::Merged),
            "archived" | "dismissed" => Some(Self::Archived),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Blocked => "blocked",
            Self::Working => "working",
            Self::Checking => "checking",
            Self::Done => "done",
            Self::NeedsYou => "needs-you",
            Self::Merged => "merged",
            Self::Archived => "archived",
        }
    }

    /// Upstream dependency counts as satisfied once verified Done or already Merged.
    pub fn is_satisfied(self) -> bool {
        matches!(self, Self::Done | Self::Merged)
    }

    /// Upstream dependency has failed or been dismissed — downstream work cannot proceed.
    pub fn is_failed_upstream(self) -> bool {
        matches!(self, Self::NeedsYou | Self::Archived)
    }

    /// Currently holding a parallel worker slot.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Working | Self::Checking)
    }

    /// Waiting to be dispatched once dependencies and concurrency slots allow.
    pub fn is_pending_dispatch(self) -> bool {
        matches!(self, Self::Queued | Self::Blocked)
    }
}

/// Lightweight node view supplied to [`DagGraph`] from `Session` records.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskNode {
    pub id: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    pub state: DagNodeState,
}

impl TaskNode {
    pub fn new(id: impl Into<String>, depends_on: Vec<String>, state: DagNodeState) -> Self {
        Self {
            id: id.into(),
            depends_on,
            state,
        }
    }
}

/// Errors produced when validating or expanding a task dependency graph.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DagError {
    EmptyNodeId,
    DuplicateNodeId {
        id: String,
    },
    SelfDependency {
        id: String,
    },
    UnknownDependency {
        node_id: String,
        missing_dep: String,
    },
    CycleDetected {
        cycle: Vec<String>,
    },
    InvalidBatch {
        message: String,
    },
}

impl fmt::Display for DagError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyNodeId => write!(f, "session node id cannot be empty"),
            Self::DuplicateNodeId { id } => write!(f, "duplicate session id '{id}' in DAG"),
            Self::SelfDependency { id } => {
                write!(f, "dependency cycle detected: session '{id}' depends on itself")
            }
            Self::UnknownDependency {
                node_id,
                missing_dep,
            } => write!(
                f,
                "session '{node_id}' depends on unknown session '{missing_dep}'"
            ),
            Self::CycleDetected { cycle } => {
                write!(f, "dependency cycle detected: {}", cycle.join(" -> "))
            }
            Self::InvalidBatch { message } => write!(f, "invalid batch spec: {message}"),
        }
    }
}

impl std::error::Error for DagError {}

/// Evaluated scheduling readiness of a single node.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "readiness", rename_all = "kebab-case")]
pub enum DagReadiness {
    Ready,
    Blocked {
        waiting_on: Vec<String>,
    },
    UpstreamFailed {
        failed_deps: Vec<String>,
        reason: String,
    },
    NotPending,
}

/// A pending node blocked on incomplete upstream dependencies.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlockedNode {
    pub id: String,
    pub waiting_on: Vec<String>,
}

/// A pending node whose upstream dependency failed or was dismissed.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpstreamFailure {
    pub id: String,
    pub failed_deps: Vec<String>,
    pub reason: String,
}

/// Actionable scheduling decisions computed for one tick of the DAG engine.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SchedulePlan {
    /// Ready nodes promoted to start immediately (bounded by `available_slots`).
    pub to_start: Vec<String>,
    /// Ready nodes waiting only for a concurrency slot to free up.
    pub ready_waiting_for_slot: Vec<String>,
    /// Nodes still waiting on pending upstream dependencies.
    pub blocked: Vec<BlockedNode>,
    /// Nodes that must transition to `Needs you` because an upstream dep failed/dismissed.
    pub upstream_failed: Vec<UpstreamFailure>,
    pub active_count: usize,
    pub max_parallel: usize,
    pub available_slots: usize,
}

/// Validated, acyclic dependency graph over task sessions.
#[derive(Clone, Debug)]
pub struct DagGraph {
    nodes: Vec<TaskNode>,
    index_by_id: HashMap<String, usize>,
    /// For each node `i`, indices of in-graph upstream dependencies of `i`.
    deps: Vec<Vec<usize>>,
    /// For each node `i`, external (pre-existing/settled) dependency states.
    external_deps: Vec<Vec<(String, DagNodeState)>>,
    /// For each node `i`, indices of in-graph nodes that depend on `i`.
    dependents: Vec<Vec<usize>>,
    /// Cached topological order (all upstreams appear before their dependents).
    topo_indices: Vec<usize>,
}

impl DagGraph {
    /// Build and validate a strict DAG where every `depends_on` entry must refer to a node in `nodes`.
    pub fn from_nodes(nodes: Vec<TaskNode>) -> Result<Self, DagError> {
        let empty = HashMap::new();
        Self::from_nodes_with_external_deps(nodes, &empty)
    }

    /// Build and validate a DAG that may also reference pre-existing external sessions
    /// whose states are provided in `external_states`.
    pub fn from_nodes_with_external_deps(
        mut nodes: Vec<TaskNode>,
        external_states: &HashMap<String, DagNodeState>,
    ) -> Result<Self, DagError> {
        let n = nodes.len();
        let mut index_by_id = HashMap::with_capacity(n);

        for (idx, node) in nodes.iter_mut().enumerate() {
            let trimmed = node.id.trim();
            if trimmed.is_empty() {
                return Err(DagError::EmptyNodeId);
            }
            if trimmed != node.id {
                node.id = trimmed.to_string();
            }
            if index_by_id.insert(node.id.clone(), idx).is_some() {
                return Err(DagError::DuplicateNodeId {
                    id: node.id.clone(),
                });
            }
        }

        let mut deps: Vec<Vec<usize>> = vec![Vec::new(); n];
        let mut external_deps: Vec<Vec<(String, DagNodeState)>> = vec![Vec::new(); n];
        let mut dependents: Vec<Vec<usize>> = vec![Vec::new(); n];
        let mut in_degree: Vec<usize> = vec![0; n];

        for (idx, node) in nodes.iter().enumerate() {
            let mut seen_local = HashSet::new();
            for raw_dep in &node.depends_on {
                let dep = raw_dep.trim();
                if dep.is_empty() {
                    continue;
                }
                if dep == node.id {
                    return Err(DagError::SelfDependency {
                        id: node.id.clone(),
                    });
                }
                if !seen_local.insert(dep.to_string()) {
                    continue;
                }
                if let Some(&dep_idx) = index_by_id.get(dep) {
                    deps[idx].push(dep_idx);
                    dependents[dep_idx].push(idx);
                    in_degree[idx] += 1;
                } else if let Some(&ext_state) = external_states.get(dep) {
                    external_deps[idx].push((dep.to_string(), ext_state));
                } else {
                    return Err(DagError::UnknownDependency {
                        node_id: node.id.clone(),
                        missing_dep: dep.to_string(),
                    });
                }
            }
        }

        // Kahn's topological sort with deterministic submission-order tie breaking.
        let mut ready_heap: BinaryHeap<Reverse<usize>> = BinaryHeap::new();
        for (idx, &deg) in in_degree.iter().enumerate() {
            if deg == 0 {
                ready_heap.push(Reverse(idx));
            }
        }

        let mut topo_indices = Vec::with_capacity(n);
        while let Some(Reverse(u)) = ready_heap.pop() {
            topo_indices.push(u);
            for &v in &dependents[u] {
                in_degree[v] -= 1;
                if in_degree[v] == 0 {
                    ready_heap.push(Reverse(v));
                }
            }
        }

        if topo_indices.len() < n {
            let cycle = extract_cycle_iterative(&nodes, &deps, &in_degree);
            return Err(DagError::CycleDetected { cycle });
        }

        Ok(Self {
            nodes,
            index_by_id,
            deps,
            external_deps,
            dependents,
            topo_indices,
        })
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Return session IDs in topological order (every dependency precedes its dependents).
    pub fn topological_order(&self) -> Vec<String> {
        self.topo_indices
            .iter()
            .map(|&idx| self.nodes[idx].id.clone())
            .collect()
    }

    /// Borrowed topological order slice of IDs.
    pub fn topological_order_refs(&self) -> Vec<&str> {
        self.topo_indices
            .iter()
            .map(|&idx| self.nodes[idx].id.as_str())
            .collect()
    }

    /// Validate adding a brand-new node `id` with `depends_on` against the current graph.
    pub fn validate_addition(&self, id: &str, depends_on: &[String]) -> Result<(), DagError> {
        let id = id.trim();
        if id.is_empty() {
            return Err(DagError::EmptyNodeId);
        }
        if self.index_by_id.contains_key(id) {
            return Err(DagError::DuplicateNodeId { id: id.to_string() });
        }
        for raw_dep in depends_on {
            let dep = raw_dep.trim();
            if dep.is_empty() {
                continue;
            }
            if dep == id {
                return Err(DagError::SelfDependency { id: id.to_string() });
            }
            if !self.index_by_id.contains_key(dep) {
                return Err(DagError::UnknownDependency {
                    node_id: id.to_string(),
                    missing_dep: dep.to_string(),
                });
            }
        }
        Ok(())
    }

    /// Validate adding a dependency edge (`node_id` depends on `dep_id`) to an existing graph.
    /// Rejects if `dep_id` is reachable downstream from `node_id` (which would form a cycle).
    pub fn validate_edge_addition(&self, node_id: &str, dep_id: &str) -> Result<(), DagError> {
        let Some(&node_idx) = self.index_by_id.get(node_id) else {
            return Err(DagError::UnknownDependency {
                node_id: node_id.to_string(),
                missing_dep: node_id.to_string(),
            });
        };
        let Some(&dep_idx) = self.index_by_id.get(dep_id) else {
            return Err(DagError::UnknownDependency {
                node_id: node_id.to_string(),
                missing_dep: dep_id.to_string(),
            });
        };
        if node_idx == dep_idx {
            return Err(DagError::SelfDependency {
                id: node_id.to_string(),
            });
        }
        // If `dep_idx` already depends (directly or transitively) on `node_idx`, adding
        // `node_idx -> dep_idx` creates a cycle. Walk `dependents` iteratively from `node_idx`.
        let mut parent: HashMap<usize, usize> = HashMap::new();
        let mut queue = VecDeque::new();
        queue.push_back(node_idx);
        parent.insert(node_idx, node_idx);
        while let Some(cur) = queue.pop_front() {
            for &next in &self.dependents[cur] {
                if let std::collections::hash_map::Entry::Vacant(e) = parent.entry(next) {
                    e.insert(cur);
                    if next == dep_idx {
                        // Reconstruct cycle path: dep -> ... -> node -> dep
                        let mut chain = vec![self.nodes[dep_idx].id.clone()];
                        let mut walk = dep_idx;
                        while walk != node_idx {
                            walk = parent[&walk];
                            chain.push(self.nodes[walk].id.clone());
                        }
                        chain.push(self.nodes[dep_idx].id.clone());
                        return Err(DagError::CycleDetected { cycle: chain });
                    }
                    queue.push_back(next);
                }
            }
        }
        Ok(())
    }

    /// Evaluate the entire DAG in topological order under concurrency cap `max_parallel`.
    ///
    /// - Upstream failures (`NeedsYou` / `Archived`) propagate transitively in one $O(V + E)$ pass.
    /// - Pending nodes whose upstreams are all `Done`/`Merged` become `Ready`, ordered
    ///   deterministically by submission index and capped to `available_slots`.
    pub fn evaluate(&self, max_parallel: usize) -> SchedulePlan {
        let cap = max_parallel.max(1);
        let active_count = self
            .nodes
            .iter()
            .filter(|n| n.state.is_active())
            .count();
        let available_slots = cap.saturating_sub(active_count);

        let mut effective_state: Vec<DagNodeState> = self.nodes.iter().map(|n| n.state).collect();
        let mut ready_indices: Vec<usize> = Vec::new();
        let mut blocked: Vec<BlockedNode> = Vec::new();
        let mut upstream_failed: Vec<UpstreamFailure> = Vec::new();

        for &idx in &self.topo_indices {
            if !self.nodes[idx].state.is_pending_dispatch() {
                continue;
            }
            let mut failed_deps: Vec<(String, DagNodeState)> = Vec::new();
            let mut waiting_on: Vec<String> = Vec::new();

            for (ext_id, ext_state) in &self.external_deps[idx] {
                if ext_state.is_failed_upstream() {
                    failed_deps.push((ext_id.clone(), *ext_state));
                } else if !ext_state.is_satisfied() {
                    waiting_on.push(ext_id.clone());
                }
            }

            for &dep_idx in &self.deps[idx] {
                let st = effective_state[dep_idx];
                if st.is_failed_upstream() {
                    failed_deps.push((self.nodes[dep_idx].id.clone(), st));
                } else if !st.is_satisfied() {
                    waiting_on.push(self.nodes[dep_idx].id.clone());
                }
            }

            if !failed_deps.is_empty() {
                effective_state[idx] = DagNodeState::NeedsYou;
                let dep_ids: Vec<String> = failed_deps.iter().map(|(id, _)| id.clone()).collect();
                let desc: Vec<String> = failed_deps
                    .iter()
                    .map(|(id, st)| format!("{id} ({})", st.label()))
                    .collect();
                upstream_failed.push(UpstreamFailure {
                    id: self.nodes[idx].id.clone(),
                    failed_deps: dep_ids,
                    reason: format!("Needs you: upstream failed ({})", desc.join(", ")),
                });
            } else if !waiting_on.is_empty() {
                blocked.push(BlockedNode {
                    id: self.nodes[idx].id.clone(),
                    waiting_on,
                });
            } else {
                ready_indices.push(idx);
            }
        }

        // Preserve FIFO submission order among simultaneously ready nodes.
        ready_indices.sort_unstable();

        let mut to_start = Vec::with_capacity(available_slots.min(ready_indices.len()));
        let mut ready_waiting_for_slot = Vec::new();
        for (pos, idx) in ready_indices.into_iter().enumerate() {
            let id = self.nodes[idx].id.clone();
            if pos < available_slots {
                to_start.push(id);
            } else {
                ready_waiting_for_slot.push(id);
            }
        }

        SchedulePlan {
            to_start,
            ready_waiting_for_slot,
            blocked,
            upstream_failed,
            active_count,
            max_parallel: cap,
            available_slots,
        }
    }

    /// Evaluate readiness for a single session ID (accounting for transitive upstream failures).
    pub fn readiness_of(&self, id: &str) -> Option<DagReadiness> {
        let &idx = self.index_by_id.get(id)?;
        if !self.nodes[idx].state.is_pending_dispatch() {
            return Some(DagReadiness::NotPending);
        }
        let plan = self.evaluate(self.nodes.len().max(1));
        if let Some(fail) = plan.upstream_failed.into_iter().find(|u| u.id == id) {
            return Some(DagReadiness::UpstreamFailed {
                failed_deps: fail.failed_deps,
                reason: fail.reason,
            });
        }
        if let Some(b) = plan.blocked.into_iter().find(|b| b.id == id) {
            return Some(DagReadiness::Blocked {
                waiting_on: b.waiting_on,
            });
        }
        Some(DagReadiness::Ready)
    }

    /// Return all transitive downstream dependent IDs of `id` in BFS order.
    pub fn downstream_of(&self, id: &str) -> Vec<String> {
        let Some(&start) = self.index_by_id.get(id) else {
            return Vec::new();
        };
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        let mut out = Vec::new();
        visited.insert(start);
        queue.push_back(start);
        while let Some(u) = queue.pop_front() {
            for &v in &self.dependents[u] {
                if visited.insert(v) {
                    out.push(self.nodes[v].id.clone());
                    queue.push_back(v);
                }
            }
        }
        out
    }

    /// Compute the execution wave / critical-path depth for every node (roots = 0).
    pub fn wave_depths(&self) -> HashMap<String, usize> {
        let mut depths = vec![0usize; self.nodes.len()];
        for &idx in &self.topo_indices {
            let max_dep = self.deps[idx]
                .iter()
                .map(|&d| depths[d] + 1)
                .max()
                .unwrap_or(0);
            depths[idx] = max_dep;
        }
        self.nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id.clone(), depths[i]))
            .collect()
    }
}

/// Iterative 3-color DFS extracting a concrete cycle path `[v0, v1, ..., vk, v0]`.
fn extract_cycle_iterative(
    nodes: &[TaskNode],
    deps: &[Vec<usize>],
    in_degree: &[usize],
) -> Vec<String> {
    let n = nodes.len();
    let mut color = vec![0u8; n]; // 0 = white, 1 = gray, 2 = black
    let mut frames: Vec<(usize, usize)> = Vec::new();
    let mut path: Vec<usize> = Vec::new();

    for start in 0..n {
        if in_degree[start] == 0 || color[start] != 0 {
            continue;
        }
        color[start] = 1;
        path.push(start);
        frames.push((start, 0));

        while let Some((u, edge_i)) = frames.last_mut() {
            let u = *u;
            if *edge_i < deps[u].len() {
                let next = deps[u][*edge_i];
                *edge_i += 1;
                if color[next] == 1 {
                    let pos = path.iter().position(|&x| x == next).unwrap_or(0);
                    let mut cycle: Vec<String> = path[pos..]
                        .iter()
                        .map(|&idx| nodes[idx].id.clone())
                        .collect();
                    cycle.push(nodes[next].id.clone());
                    return cycle;
                } else if color[next] == 0 {
                    color[next] = 1;
                    path.push(next);
                    frames.push((next, 0));
                }
            } else {
                frames.pop();
                path.pop();
                color[u] = 2;
            }
        }
    }

    // Defensive fallback (unreachable whenever Kahn's sort left nodes with in_degree > 0).
    nodes
        .iter()
        .enumerate()
        .filter(|(i, _)| in_degree[*i] > 0)
        .map(|(_, n)| n.id.clone())
        .collect()
}

// ---------------------------------------------------------------------------
// Batch / Matrix Dispatch
// ---------------------------------------------------------------------------

/// One task template inside a [`BatchSpec`].
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BatchTaskSpec {
    /// Optional local symbolic key so sibling tasks in the batch can reference it in `depends_on`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub task: String,
    /// Optional per-task repository override. When omitted, fans out across `BatchSpec::repos`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_cmd: Option<String>,
    #[serde(default)]
    pub check_steps: Vec<CheckStep>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub allowed_globs: Vec<String>,
    #[serde(default)]
    pub forbidden_globs: Vec<String>,
}

/// Multi-task / multi-repo fan-out dispatch specification.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BatchSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Optional single-repo shorthand when `repos` is omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// Target repositories for matrix fan-out. Tasks without an explicit `repo` are
    /// materialized once per entry in `repos`.
    #[serde(default)]
    pub repos: Vec<String>,
    pub tasks: Vec<BatchTaskSpec>,
    /// Shared concurrency cap for the batch (clamped to policy `max_parallel`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_parallel: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_check: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_agent: Option<String>,
    #[serde(default)]
    pub allowed_globs: Vec<String>,
    #[serde(default)]
    pub forbidden_globs: Vec<String>,
}

/// Concrete session plan produced by [`BatchSpec::expand`].
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlannedSession {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub task: String,
    pub repo: String,
    pub project: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check_cmd: Option<String>,
    #[serde(default)]
    pub check_steps: Vec<CheckStep>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub allowed_globs: Vec<String>,
    #[serde(default)]
    pub forbidden_globs: Vec<String>,
    pub initial_state: DagNodeState,
}

/// Validated, acyclic expansion of a [`BatchSpec`], ready for session creation and queuing.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExpandedBatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub effective_max_parallel: usize,
    pub sessions: Vec<PlannedSession>,
    pub topological_order: Vec<String>,
    pub immediate_ready: Vec<String>,
}

impl BatchSpec {
    /// Expand a batch or matrix specification into validated concrete sessions.
    ///
    /// - Resolves symbolic `key` dependencies within each repo slice (and globally when unambiguous).
    /// - Rejects empty tasks, missing repos, duplicate keys, unknown dependencies, and cycles atomically.
    /// - Clamps `max_parallel` to `1..=policy_max_parallel.max(1)`.
    pub fn expand<F>(
        &self,
        existing_session_states: &HashMap<String, DagNodeState>,
        policy_max_parallel: usize,
        mut id_gen: F,
    ) -> Result<ExpandedBatch, DagError>
    where
        F: FnMut() -> String,
    {
        if self.tasks.is_empty() {
            return Err(DagError::InvalidBatch {
                message: "batch must contain at least one task".to_string(),
            });
        }

        let mut clean_repos: Vec<String> = self
            .repos
            .iter()
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty())
            .collect();
        if clean_repos.is_empty() {
            if let Some(single) = self.repo.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
                clean_repos.push(single.to_string());
            }
        }

        // First pass: materialize concrete items and map symbolic keys -> generated session IDs.
        struct RawEntry {
            id: String,
            repo_slice: Option<usize>,
            spec: BatchTaskSpec,
            repo: String,
        }

        let mut entries: Vec<RawEntry> = Vec::new();
        let mut scoped_keys: HashMap<(Option<usize>, String), String> = HashMap::new();
        let mut global_keys: HashMap<String, Vec<String>> = HashMap::new();

        for (task_idx, spec) in self.tasks.iter().enumerate() {
            if spec.task.trim().is_empty() {
                return Err(DagError::InvalidBatch {
                    message: format!("task #{task_idx} cannot have an empty description"),
                });
            }
            for step in &spec.check_steps {
                step.validate().map_err(|e| DagError::InvalidBatch {
                    message: format!("task #{task_idx}: {e}"),
                })?;
            }

            let explicit_repo = spec
                .repo
                .as_deref()
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .map(str::to_string);

            let targets: Vec<(Option<usize>, String)> = match explicit_repo {
                Some(r) => vec![(None, r)],
                None => {
                    if clean_repos.is_empty() {
                        return Err(DagError::InvalidBatch {
                            message: format!(
                                "task #{task_idx} has no repo and batch.repos is empty"
                            ),
                        });
                    }
                    clean_repos
                        .iter()
                        .enumerate()
                        .map(|(ri, r)| (Some(ri), r.clone()))
                        .collect()
                }
            };

            for (repo_slice, repo) in targets {
                let id = id_gen();
                if id.trim().is_empty() {
                    return Err(DagError::EmptyNodeId);
                }
                if let Some(raw_key) = spec.key.as_deref().map(str::trim).filter(|k| !k.is_empty())
                {
                    let key = raw_key.to_string();
                    if scoped_keys
                        .insert((repo_slice, key.clone()), id.clone())
                        .is_some()
                    {
                        return Err(DagError::DuplicateNodeId { id: key });
                    }
                    global_keys.entry(key).or_default().push(id.clone());
                }
                entries.push(RawEntry {
                    id,
                    repo_slice,
                    spec: spec.clone(),
                    repo,
                });
            }
        }

        let generated_ids: HashSet<String> = entries.iter().map(|e| e.id.clone()).collect();
        let mut sessions: Vec<PlannedSession> = Vec::with_capacity(entries.len());
        let mut dag_nodes: Vec<TaskNode> = Vec::with_capacity(entries.len());

        for entry in entries {
            let mut resolved_deps = Vec::with_capacity(entry.spec.depends_on.len());
            for raw_dep in &entry.spec.depends_on {
                let dep = raw_dep.trim();
                if dep.is_empty() {
                    continue;
                }
                let resolved = if let Some(id) =
                    scoped_keys.get(&(entry.repo_slice, dep.to_string()))
                {
                    id.clone()
                } else if let Some(ids) = global_keys.get(dep) {
                    if ids.len() == 1 {
                        ids[0].clone()
                    } else {
                        // A cross-repo task depending on a matrix key depends on all expanded copies.
                        for multi_id in ids {
                            if !resolved_deps.contains(multi_id) {
                                resolved_deps.push(multi_id.clone());
                            }
                        }
                        continue;
                    }
                } else if generated_ids.contains(dep) || existing_session_states.contains_key(dep) {
                    dep.to_string()
                } else {
                    return Err(DagError::UnknownDependency {
                        node_id: entry
                            .spec
                            .key
                            .clone()
                            .unwrap_or_else(|| entry.id.clone()),
                        missing_dep: dep.to_string(),
                    });
                };
                if !resolved_deps.contains(&resolved) {
                    resolved_deps.push(resolved);
                }
            }

            let project = entry
                .spec
                .project
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| derive_project(&entry.repo));

            let allowed_globs = if entry.spec.allowed_globs.is_empty() {
                self.allowed_globs.clone()
            } else {
                entry.spec.allowed_globs.clone()
            };

            let mut forbidden_globs = self.forbidden_globs.clone();
            for g in &entry.spec.forbidden_globs {
                if !forbidden_globs.contains(g) {
                    forbidden_globs.push(g.clone());
                }
            }

            let initial_state = if resolved_deps.is_empty() {
                DagNodeState::Queued
            } else {
                DagNodeState::Blocked
            };

            dag_nodes.push(TaskNode {
                id: entry.id.clone(),
                depends_on: resolved_deps.clone(),
                state: initial_state,
            });

            sessions.push(PlannedSession {
                id: entry.id,
                key: entry.spec.key,
                task: entry.spec.task.trim().to_string(),
                repo: entry.repo,
                project,
                agent: entry.spec.agent.or_else(|| self.default_agent.clone()),
                model: entry.spec.model,
                check_cmd: entry.spec.check_cmd.or_else(|| self.default_check.clone()),
                check_steps: entry.spec.check_steps,
                depends_on: resolved_deps,
                allowed_globs,
                forbidden_globs,
                initial_state,
            });
        }

        let dag = DagGraph::from_nodes_with_external_deps(dag_nodes, existing_session_states)?;
        let cap = policy_max_parallel.max(1);
        let effective_max_parallel = self
            .max_parallel
            .map(|m| m.clamp(1, cap))
            .unwrap_or(cap);
        let plan = dag.evaluate(effective_max_parallel);

        // Reflect readiness on initial_state for tasks whose external deps are already Done.
        let ready_set: HashSet<&str> = plan
            .to_start
            .iter()
            .chain(plan.ready_waiting_for_slot.iter())
            .map(String::as_str)
            .collect();
        let failed_set: HashSet<&str> = plan
            .upstream_failed
            .iter()
            .map(|u| u.id.as_str())
            .collect();
        for s in &mut sessions {
            if failed_set.contains(s.id.as_str()) {
                s.initial_state = DagNodeState::NeedsYou;
            } else if ready_set.contains(s.id.as_str()) {
                s.initial_state = DagNodeState::Queued;
            }
        }

        Ok(ExpandedBatch {
            name: self.name.clone(),
            effective_max_parallel,
            sessions,
            topological_order: dag.topological_order(),
            immediate_ready: plan.to_start,
        })
    }
}

fn derive_project(repo: &str) -> String {
    std::path::Path::new(repo)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("default")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_cycles_and_self_dependencies_with_explicit_path() {
        let self_cycle = DagGraph::from_nodes(vec![TaskNode::new(
            "a",
            vec!["a".to_string()],
            DagNodeState::Queued,
        )]);
        assert!(matches!(self_cycle, Err(DagError::SelfDependency { ref id }) if id == "a"));

        let tri_cycle = DagGraph::from_nodes(vec![
            TaskNode::new("a", vec!["c".to_string()], DagNodeState::Queued),
            TaskNode::new("b", vec!["a".to_string()], DagNodeState::Queued),
            TaskNode::new("c", vec!["b".to_string()], DagNodeState::Queued),
        ]);
        match tri_cycle {
            Err(DagError::CycleDetected { cycle }) => {
                assert!(cycle.len() >= 4, "expected closed cycle, got {cycle:?}");
                assert_eq!(cycle.first(), cycle.last());
            }
            other => panic!("expected CycleDetected, got {other:?}"),
        }
    }

    #[test]
    fn evaluates_readiness_and_propagates_upstream_failure_transitively() {
        let dag = DagGraph::from_nodes(vec![
            TaskNode::new("root-ok", vec![], DagNodeState::Done),
            TaskNode::new("root-bad", vec![], DagNodeState::NeedsYou),
            TaskNode::new("mid-ready", vec!["root-ok".to_string()], DagNodeState::Blocked),
            TaskNode::new("mid-fail", vec!["root-bad".to_string()], DagNodeState::Blocked),
            TaskNode::new(
                "leaf-cascade",
                vec!["mid-fail".to_string()],
                DagNodeState::Blocked,
            ),
            TaskNode::new(
                "leaf-wait",
                vec!["mid-ready".to_string()],
                DagNodeState::Blocked,
            ),
        ])
        .unwrap();

        let plan = dag.evaluate(4);
        assert_eq!(plan.to_start, vec!["mid-ready"]);
        assert_eq!(plan.blocked.len(), 1);
        assert_eq!(plan.blocked[0].id, "leaf-wait");
        assert_eq!(plan.blocked[0].waiting_on, vec!["mid-ready"]);
        assert_eq!(plan.upstream_failed.len(), 2);
        assert_eq!(plan.upstream_failed[0].id, "mid-fail");
        assert!(plan.upstream_failed[0].reason.contains("upstream failed"));
        assert_eq!(plan.upstream_failed[1].id, "leaf-cascade");
    }

    #[test]
    fn batch_matrix_dispatch_expands_repos_x_tasks_with_scoped_deps() {
        let spec = BatchSpec {
            name: Some("nightly".to_string()),
            repo: None,
            repos: vec!["/repos/api".to_string(), "/repos/worker".to_string()],
            tasks: vec![
                BatchTaskSpec {
                    key: Some("lint".to_string()),
                    task: "Fix clippy warnings".to_string(),
                    repo: None,
                    project: None,
                    agent: None,
                    model: None,
                    check_cmd: None,
                    check_steps: vec![],
                    depends_on: vec![],
                    allowed_globs: vec![],
                    forbidden_globs: vec![],
                },
                BatchTaskSpec {
                    key: Some("test".to_string()),
                    task: "Add integration tests".to_string(),
                    repo: None,
                    project: None,
                    agent: None,
                    model: None,
                    check_cmd: None,
                    check_steps: vec![],
                    depends_on: vec!["lint".to_string()],
                    allowed_globs: vec![],
                    forbidden_globs: vec![],
                },
            ],
            max_parallel: Some(2),
            default_check: Some("cargo test".to_string()),
            default_agent: Some("opencode".to_string()),
            allowed_globs: vec!["src/**".to_string()],
            forbidden_globs: vec![".env".to_string()],
        };

        let mut seq = 0u64;
        let expanded = spec
            .expand(&HashMap::new(), 4, || {
                seq += 1;
                format!("s-{seq}")
            })
            .unwrap();
        assert_eq!(expanded.sessions.len(), 4);
        assert_eq!(expanded.effective_max_parallel, 2);
        // The two `lint` tasks (s-1 for api, s-2 for worker) are immediately ready.
        assert_eq!(expanded.immediate_ready, vec!["s-1", "s-2"]);
        // Each `test` task depends only on its own repo's `lint` task!
        assert_eq!(expanded.sessions[2].repo, "/repos/api");
        assert_eq!(expanded.sessions[2].depends_on, vec!["s-1"]);
        assert_eq!(expanded.sessions[3].repo, "/repos/worker");
        assert_eq!(expanded.sessions[3].depends_on, vec!["s-2"]);
    }
}
