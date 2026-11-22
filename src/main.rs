//! fleet-rs — your agents working in parallel under one screen.
//!
//! You hand out work; each hand-out launches a real CLI agent in its own git
//! worktree; when the agent claims completion the app itself runs the check
//! attached to the task, and only a passing check earns the "done" status.
//! Session policies (parallel cap, default checks) live in policies.rn and
//! are executed through Rune — they drive behaviour, they are not metadata.

mod events;
mod update;

use fleet_rs::autoheal::{
    FailedCheckContext, HealAttempt, HealDecision, HealSessionContext, HealStopReason,
    MAX_AUTO_HEAL_BUDGET, build_heal_prompt, evaluate_auto_heal, heal_badge_label,
};
use fleet_rs::checks::{
    CheckPipeline, CheckStep, CheckStepReceipt, FileScope, PipelineReceipt, ScopeViolation,
    verify_git_scope,
};
use fleet_rs::dag::{BatchSpec, BatchTaskSpec, DagGraph, DagNodeState, TaskNode};
use fleet_rs::merge_check::{
    MergeStrategy, PatchFormat, dry_run_merge, execute_merge, export_patch,
};
use fleet_rs::metrics::{SessionMetricView, compute_metrics_with_capacity};
use fleet_rs::policy::{MAX_TIMEOUT_SECS, Policy, test_policy_script};
use fleet_rs::templates::{PlaybookInput, PlaybookTask, TemplateStore};
use serde::Serialize;
use std::os::unix::ffi::OsStrExt as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------------------
// Core limits & helpers
// ---------------------------------------------------------------------------

/// In-memory transcript cap per session (the on-disk log is uncapped).
const TRANSCRIPT_CAP: usize = 2000;
/// Stored-transcript byte budget per session (see log()).
const TRANSCRIPT_BYTES: usize = 512 * 1024;
/// Stored check output / diff cap, in characters.
const OUTPUT_CAP: usize = 256_000;

/// Does a symlink stored at `path` (repo-relative) with the text
/// target `target` resolve outside the repo? Absolute targets always
/// do; relative ones do when their `..` components climb past the
/// repo root.
fn symlink_escapes(path: &str, target: &str) -> bool {
    if target.starts_with('/') {
        return true;
    }
    let mut depth = path.matches('/').count() as i64; // dirs above the file
    for part in target.split('/') {
        match part {
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            "." | "" => {}
            _ => depth += 1,
        }
    }
    false
}

/// Truncate stored text to OUTPUT_CAP chars with an honest note.
fn truncate_output(text: String) -> String {
    if text.chars().count() > OUTPUT_CAP {
        let mut t: String = text.chars().take(OUTPUT_CAP).collect();
        t.push_str("\n… truncated here — the full text is in the session's log file on disk");
        t
    } else {
        text
    }
}

// ---------------------------------------------------------------------------
// Agent detection — support is detected, never assumed
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct AgentInfo {
    name: String,
    found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

/// The CLI agents fleet-rs knows how to drive, probed against the real
/// PATH at startup. A name is "found" only when `which` resolves it.
fn detect_agents() -> Vec<AgentInfo> {
    ["opencode", "claude", "codex"]
        .iter()
        .map(|name| {
            let path = Command::new("which")
                .arg(name)
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty());
            AgentInfo {
                name: name.to_string(),
                found: path.is_some(),
                path,
            }
        })
        .collect()
}

fn is_executable(p: &Path) -> bool {
    // A directory passes a mode-bits check on unix (its x bits mean
    // "searchable") — an agent must be a regular file first.
    if !p.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Validate an agent reference: a bare name must be a detected, installed
/// agent; a path must be an executable file. Anything else is refused
/// with the problem named — before any session or worktree exists.
fn validate_agent(app: &App, agent: &str) -> Result<String, String> {
    if agent.contains('/') {
        if is_executable(Path::new(agent)) {
            Ok(agent.to_string())
        } else {
            Err(format!("agent '{agent}' is not an executable file"))
        }
    } else {
        match app.agents.iter().find(|a| a.name == agent) {
            Some(a) if a.found => Ok(agent.to_string()),
            _ => {
                let found: Vec<&str> = app
                    .agents
                    .iter()
                    .filter(|a| a.found)
                    .map(|a| a.name.as_str())
                    .collect();
                Err(format!(
                    "agent '{agent}' is not available on this machine — detected agents: {}",
                    if found.is_empty() {
                        "none".to_string()
                    } else {
                        found.join(", ")
                    }
                ))
            }
        }
    }
}

fn resolve_agent(app: &App, requested: Option<&str>) -> Result<String, String> {
    match requested {
        Some(a) if !a.is_empty() => validate_agent(app, a),
        _ => match app.effective_default_agent() {
            Some(d) => validate_agent(app, &d)
                .map_err(|e| format!("the configured default agent is unusable: {e}")),
            None => Err(
                "no agent available: none of opencode, claude, codex is installed and FLEET_AGENT is not set"
                    .to_string(),
            ),
        },
    }
}

// ---------------------------------------------------------------------------
// Engine adapter — how a session's agent is actually invoked
// ---------------------------------------------------------------------------

/// The kind of engine behind a session's agent string. The three
/// known names are real CLI agents, each with its own non-interactive
/// invocation; anything else (an executable path) is a custom command
/// that receives the prompt as its single argument — that is the
/// contract fixture/test agents are written to, and the UI labels it
/// as test mode so a fixture never wears a real engine's name.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum EngineKind {
    Opencode,
    Claude,
    Codex,
    Custom,
}

fn engine_kind(agent: &str) -> EngineKind {
    match agent {
        "opencode" => EngineKind::Opencode,
        "claude" => EngineKind::Claude,
        "codex" => EngineKind::Codex,
        _ => EngineKind::Custom,
    }
}

impl EngineKind {
    /// The stable label the API and UI carry.
    fn label(self) -> &'static str {
        match self {
            EngineKind::Opencode => "opencode",
            EngineKind::Claude => "claude",
            EngineKind::Codex => "codex",
            EngineKind::Custom => "custom",
        }
    }
}

/// Build the argv for one agent run: the program to spawn and its
/// arguments, with `prompt` as the work text. `continuation` selects
/// the engine's own resume mechanism, used when the operator steers a
/// session: the engine continues its previous conversation in the
/// same worktree instead of starting over.
///
/// - opencode: `opencode run [--model M] [--continue] <prompt>`
///   (the invocation proven live on the operator's desktop; the model
///   is the house route from policies.rn agent_model() — DeepSeek
///   V4.1 Flash via OpenCode Go — and opencode is the engine that
///   speaks that provider namespace, so it is the one that gets it).
/// - claude: `claude -p [--continue] <prompt>` (print mode).
/// - codex: `codex exec --sandbox workspace-write --color never
///   <prompt>`; continuation `codex exec resume --last <prompt>`
///   (the resumed session keeps the sandbox of its first run).
/// - custom: `<path> <prompt>` for both — the worktree itself carries
///   the state between runs.
fn engine_command(
    agent: &str,
    model: Option<&str>,
    prompt: &str,
    continuation: bool,
) -> (String, Vec<String>) {
    let model = model.map(str::trim).filter(|m| !m.is_empty());
    let args: Vec<String> = match engine_kind(agent) {
        EngineKind::Opencode => {
            let mut a = vec!["run".to_string()];
            if let Some(m) = model {
                a.push("--model".to_string());
                a.push(m.to_string());
            }
            if continuation {
                a.push("--continue".to_string());
            }
            a.push(prompt.to_string());
            a
        }
        EngineKind::Claude => {
            let mut a = vec!["-p".to_string()];
            if let Some(m) = model {
                // OpenCode provider-namespaced ids (e.g. opencode/...) are not spoken by claude.
                if !m.starts_with("opencode") {
                    a.push("--model".to_string());
                    a.push(m.to_string());
                }
            }
            if continuation {
                a.push("--continue".to_string());
            }
            a.push(prompt.to_string());
            a
        }
        EngineKind::Codex => {
            if continuation {
                vec![
                    "exec".to_string(),
                    "resume".to_string(),
                    "--last".to_string(),
                    prompt.to_string(),
                ]
            } else {
                let mut a = vec![
                    "exec".to_string(),
                    "--sandbox".to_string(),
                    "workspace-write".to_string(),
                    "--color".to_string(),
                    "never".to_string(),
                ];
                if let Some(m) = model {
                    if !m.starts_with("opencode") {
                        a.push("--model".to_string());
                        a.push(m.to_string());
                    }
                }
                a.push(prompt.to_string());
                a
            }
        }
        EngineKind::Custom => vec![prompt.to_string()],
    };
    (agent.to_string(), args)
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Status {
    Blocked,
    Queued,
    Working,
    Checking,
    Done,
    NeedsYou,
    Merged,
    Archived,
}

impl Status {
    fn label(self) -> &'static str {
        match self {
            Status::Blocked => "blocked",
            Status::Queued => "queued",
            Status::Working => "working",
            Status::Checking => "checking",
            Status::Done => "done",
            Status::NeedsYou => "needs-you",
            Status::Merged => "merged",
            Status::Archived => "archived",
        }
    }
    /// The three buckets the sidebar shows: working / needs you / done.
    fn bucket(self) -> &'static str {
        match self {
            Status::Blocked | Status::Queued | Status::Working | Status::Checking => "working",
            Status::NeedsYou => "needs-you",
            Status::Done | Status::Merged => "done",
            Status::Archived => "archived",
        }
    }
}

fn session_dag_state(status: &str) -> DagNodeState {
    match status {
        "blocked" => DagNodeState::Blocked,
        "queued" => DagNodeState::Queued,
        "working" => DagNodeState::Working,
        "checking" => DagNodeState::Checking,
        "done" => DagNodeState::Done,
        "merged" => DagNodeState::Merged,
        "needs-you" => DagNodeState::NeedsYou,
        "archived" => DagNodeState::Archived,
        _ => DagNodeState::NeedsYou,
    }
}

#[derive(Clone, Serialize, serde::Deserialize)]
struct Session {
    id: String,
    task: String,
    project: String,
    repo: String,
    branch: String,
    worktree: String,
    status: String,
    bucket: String,
    /// The agent this session runs under (a detected name or an
    /// executable path), recorded at hand-out so retries and the UI can
    /// say exactly what ran.
    #[serde(default)]
    agent: String,
    /// Optional explicit model override recorded on this session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    check_cmd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    check_output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    check_passed: Option<bool>,
    diff: String,
    /// Why this session needs the operator, when it does. Set at every
    /// needs-you transition so the inbox can aggregate reasons, not just
    /// statuses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    /// The exact commit the check verified, recorded when the session
    /// is marked done. Merging consumes this commit, never the
    /// branch's later tip: work added after verification is not
    /// verified work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    verified_commit: Option<String>,
    /// Operator messages waiting to be delivered to the agent as a
    /// continuation run. Drained by the runner between agent runs —
    /// before commit and check — so a session never settles "done"
    /// on a tree the operator has since steered away from. Persisted:
    /// a message must survive a server restart like everything else.
    #[serde(default)]
    steer: Vec<String>,
    /// Successor work named at hand-out, in order. When this session
    /// reaches verified done, the front item is handed out
    /// automatically (carrying the rest of the chain) — a finished
    /// session pulls the next item instead of idling. Fires ONLY on
    /// verified done: failed work must not cascade.
    #[serde(default)]
    next_queue: Vec<String>,
    /// The session whose verified finish handed this one out, when
    /// this session is a successor.
    #[serde(default)]
    spawned_from: Option<String>,
    /// The successor session this one handed out on finishing, once
    /// it has fired.
    #[serde(default)]
    successor: Option<String>,
    /// The prompt a retried session's next run receives: the original
    /// task plus what failed last time. Set by retry(), read by the run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retry_prompt: Option<String>,
    /// Whether the check command actually started, and the exit code
    /// it ended with when it exited normally.
    #[serde(default)]
    check_ran: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    check_exit: Option<i32>,
    /// The last refusal of a merge of this session (null when none): set
    /// by a refused merge, cleared by a merge that lands or by a retry.
    #[serde(default)]
    merge_error: Option<MergeRefusal>,
    /// Upstream session IDs that must finish verified-done (or merged) before
    /// this session starts. Evaluated by `fleet_rs::dag::DagGraph`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    depends_on: Vec<String>,
    /// Optional multi-step verification pipeline specs; when empty, runs legacy `check_cmd`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    check_step_specs: Vec<CheckStep>,
    /// Structured receipt produced by `CheckPipeline` (per-step status, timing, exit, tail).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    check_receipt: Option<PipelineReceipt>,
    /// Optional repo-relative glob allowlist enforced before marking Done.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    allowed_globs: Vec<String>,
    /// Optional repo-relative glob denylist enforced before marking Done.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    forbidden_globs: Vec<String>,
    /// Recorded file-scope violations when a session touched out-of-scope files.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    scope_violations: Vec<ScopeViolation>,
    /// Merge strategy used when this session landed (`merge-commit`, `squash`, `fast-forward-only`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    merge_strategy: Option<MergeStrategy>,
    /// Maximum autonomous auto-heal repair passes allowed when checks fail (`0` disables auto-heal).
    #[serde(default)]
    auto_steer_budget: u32,
    /// Ordered history of autonomous auto-heal attempts executed on this session.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    heal_attempts: Vec<HealAttempt>,
    /// Total transcript lines logged to disk (may exceed in-memory `TRANSCRIPT_CAP`).
    #[serde(default)]
    transcript_total: usize,
    transcript: Vec<String>,
}

impl SessionMetricView for Session {
    fn status(&self) -> &str {
        &self.status
    }

    fn repo(&self) -> &str {
        &self.repo
    }

    fn project(&self) -> &str {
        &self.project
    }

    fn check_passed(&self) -> Option<bool> {
        self.check_passed
    }

    fn check_elapsed_ms(&self) -> Option<u64> {
        self.check_receipt.as_ref().map(|r| r.total_elapsed_ms)
    }

    fn heal_attempts(&self) -> &[HealAttempt] {
        &self.heal_attempts
    }
}

/// The branch a merge into this repo lands on: its checked-out branch.
fn merge_target(repo: &str) -> Option<String> {
    if repo.is_empty() {
        return None;
    }
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["symbolic-ref", "--short", "-q", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|b| !b.is_empty())
}

/// A refused merge, kept on its session.
#[derive(Clone, Serialize, serde::Deserialize)]
struct MergeRefusal {
    message: String,
    detail: Option<String>,
    ts: u64,
}

/// Runtime engine and model configuration persisted to data_dir/config.json.
#[derive(Clone, Default, Serialize, serde::Deserialize)]
struct RuntimeConfig {
    #[serde(default)]
    default_agent: Option<String>,
    #[serde(default)]
    opencode_model: Option<String>,
    #[serde(default)]
    claude_model: Option<String>,
    #[serde(default)]
    codex_model: Option<String>,
    #[serde(default)]
    max_parallel_agents: Option<i64>,
}

fn load_config(data_dir: &Path) -> RuntimeConfig {
    let path = data_dir.join("config.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<RuntimeConfig>(&t).ok())
        .unwrap_or_default()
}

/// Discovered local git repository returned by GET /api/repos.
#[derive(Clone, Serialize)]
struct RepoInfo {
    name: String,
    path: String,
    branch: Option<String>,
}

struct App {
    policy: Policy,
    /// The policy file actually loaded (argv), reported by /api/policy
    /// as the source — never a hardcoded display string.
    policy_source: String,
    agents: Vec<AgentInfo>,
    default_agent: Option<String>,
    config: Mutex<RuntimeConfig>,
    env_model: Option<String>,
    env_claude_model: Option<String>,
    env_codex_model: Option<String>,
    env_max_parallel: Option<i64>,
    data_dir: PathBuf,
    /// Tag unique to this server run, baked into session ids and branch
    /// names so a restarted server can never collide with worktrees or
    /// branches a previous run left in the target repo.
    run_tag: String,
    sessions: Mutex<Vec<Session>>,
    /// Monotonic revision bumped on every session state/log mutation to
    /// invalidate cached GET /api/sessions responses cleanly.
    state_rev: std::sync::atomic::AtomicU64,
    /// Per-repo checked-out branch cache (5s TTL) so listing 2,000+ sessions
    /// never shells out to git on every poll.
    merge_target_cache: Mutex<std::collections::HashMap<String, (Option<String>, std::time::Instant)>>,
    /// Cached serialized GET /api/sessions payload keyed by (state_rev, cached_at).
    sessions_cache: Mutex<Option<(u64, std::time::Instant, String)>>,
    /// Cached GET /api/repos discovery result keyed by (state_rev, FLEET_REPOS_DIR, cached_at).
    #[allow(clippy::type_complexity)]
    repos_cache: Mutex<Option<(u64, String, std::time::Instant, Vec<RepoInfo>)>>,
    /// Cached serialized GET /api/metrics payload keyed by (state_rev, max_parallel).
    metrics_cache: Mutex<Option<(u64, i64, String)>>,
    /// Atomic file-backed playbook template store (`<data_dir>/templates.json`).
    templates: Mutex<TemplateStore>,
    /// Session IDs whose `.record.json` needs writing on the next persist() pass.
    dirty_records: Mutex<std::collections::HashSet<String>>,
    /// Transcript lines logged since the last snapshot — the persist
    /// cadence counter (see log()).
    lines_since_persist: std::sync::atomic::AtomicU64,
    counter: Mutex<u64>,
    /// Per-session stop flags. A session's worker thread holds a
    /// clone of its flag and hands it to the bounded runner; the stop
    /// endpoint sets it. In-memory only — a restart already lands
    /// every live session in needs-you with the reason stated.
    stops: Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
    /// Real-time SSE event bus (`GET /api/events/stream`).
    events: Arc<events::EventBus>,
    /// Version checks and self-update (see `update`).
    updater: Arc<update::Updater>,
}

/// How a bounded run ended.
/// How an agent run ended, as the caller needs to know it. A
/// steering batch counts as delivered in every outcome except
/// NotStarted — the process never spawned, so its prompt never
/// reached an agent.
#[derive(PartialEq)]
enum AgentRun {
    Clean,
    Failed,
    NotStarted,
}

enum RunEnd {
    /// The process exited; the bool is its success.
    Exited(bool),
    /// The deadline passed with the process still running; its whole
    /// process group was killed.
    TimedOut,
    /// The process exited but a detached descendant kept its output
    /// pipes open past the drain grace — the run's output cannot be
    /// trusted complete. The process group was killed.
    PipesHeld,
    /// The process could not be spawned at all.
    SpawnFailed(String),
    /// The operator stopped the run; its whole process group was
    /// killed at their word, not the clock's.
    Stopped,
}

#[allow(dead_code)]
struct RunOutcome {
    end: RunEnd,
    /// The exit code, when the process exited with one.
    code: Option<i32>,
    /// Every output line (both streams, arrival order), each line
    /// already truncated to LINE_CAP.
    lines: Vec<String>,
}

/// One stored line's cap, in characters. A single unbounded line must
/// not defeat every other cap in the system.
const LINE_CAP: usize = 8192;

fn truncate_line(l: String) -> String {
    if l.chars().count() > LINE_CAP {
        let mut t: String = l.chars().take(LINE_CAP).collect();
        t.push_str(" …[line truncated]");
        t
    } else {
        l
    }
}

/// Kill a whole process group (killpg, via the syscall — this
/// system's `kill` binary silently ignores negative pids, which is
/// exactly the failure this function exists to avoid). The group is
/// the unit a runaway run is stopped by: killing only the direct
/// child leaves its children holding pipes and writing into
/// worktrees the operator believes are settled.
fn kill_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

/// Send SIGTERM to the entire process group first so agents can flush/exit
/// cleanly, then escalate to SIGKILL after `grace_ms` if the child is still alive.
fn kill_group_graceful(pid: u32, child: &mut std::process::Child, grace_ms: u64) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
    let steps = (grace_ms / 50).max(1);
    for _ in 0..steps {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    kill_group(pid);
    let _ = child.kill();
}

/// Run a command in its OWN process group, streaming lines to
/// `on_line` as they arrive. Its stdin is /dev/null, always: a run
/// is non-interactive, and an agent that reads stdin when it is not
/// a TTY (codex exec appends piped stdin to the prompt) would
/// otherwise block forever on the server's inherited stdin, which
/// nothing ever closes. The timeout bounds everything: the
/// process itself, and — after it exits — a short grace for its pipes
/// to close. A descendant that inherited the pipes (or detached into
/// the worktree) can therefore hold a session for at most the timeout
/// plus the grace, and is then killed with the group.
fn run_bounded(
    mut cmd: Command,
    timeout_secs: u64,
    stop: Option<&std::sync::atomic::AtomicBool>,
    on_line: &mut dyn FnMut(bool, &str),
) -> RunOutcome {
    use std::os::unix::process::CommandExt;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return RunOutcome {
                end: RunEnd::SpawnFailed(e.to_string()),
                code: None,
                lines: Vec::new(),
            }
        }
    };
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel::<(bool, String)>();
    for (stream, is_err) in [
        (child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), false),
        (child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), true),
    ] {
        if let Some(s) = stream {
            let tx = tx.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(s).lines() {
                    match line {
                        Ok(l) => {
                            if tx.send((is_err, truncate_line(l))).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }
    }
    drop(tx);
    let deadline = std::time::Instant::now()
        .checked_add(std::time::Duration::from_secs(timeout_secs))
        .unwrap_or_else(|| {
            std::time::Instant::now()
                + std::time::Duration::from_secs(MAX_TIMEOUT_SECS)
        });
    let mut lines: Vec<String> = Vec::new();
    let mut child_status: Option<bool> = None;
    let mut child_code: Option<i32> = None;
    // After the child exits, the pipes get a grace — but measured as
    // INACTIVITY, not wall time: a fast producer's backlog is still
    // being forwarded line by line, and draining it is progress, not
    // a stuck pipe. The pipes count as held only when the child is
    // gone, the pipes are still open, and nothing has flowed for the
    // grace (or the drain exceeds a hard cap, for a descendant that
    // prints forever).
    let mut exited_at: Option<std::time::Instant> = None;
    let mut last_line_at = std::time::Instant::now();
    let stopped = || {
        stop.is_some_and(|s| s.load(std::sync::atomic::Ordering::Relaxed))
    };
    let end = loop {
        if child_status.is_none() && stopped() {
            kill_group_graceful(pid, &mut child, 1200);
            break RunEnd::Stopped;
        }
        if child_status.is_none() {
            match child.try_wait() {
                Ok(Some(st)) => {
                    child_status = Some(st.success());
                    child_code = st.code();
                    exited_at = Some(std::time::Instant::now());
                }
                Ok(None) => {}
                Err(_) => child_status = Some(false),
            }
        }
        let now = std::time::Instant::now();
        if child_status.is_none() && now >= deadline {
            kill_group_graceful(pid, &mut child, 400);
            break RunEnd::TimedOut;
        }
        if let Some(x) = exited_at {
            let idle = now.duration_since(last_line_at);
            let draining = now.duration_since(x);
            if idle >= std::time::Duration::from_secs(3)
                || draining >= std::time::Duration::from_secs(30)
            {
                kill_group(pid);
                break RunEnd::PipesHeld;
            }
        }
        match rx.recv_timeout(std::time::Duration::from_millis(50)) {
            Ok((is_err, line)) => {
                last_line_at = std::time::Instant::now();
                on_line(is_err, &line);
                lines.push(line);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                // Both pipes are closed. The process may still be
                // finishing; give it until the main deadline.
                let mut stop_hit = false;
                loop {
                    if stopped() {
                        kill_group_graceful(pid, &mut child, 1200);
                        stop_hit = true;
                        break;
                    }
                    match child.try_wait() {
                        Ok(Some(st)) => {
                            child_status = Some(st.success());
                            child_code = st.code();
                            break;
                        }
                        Ok(None) => {
                            if std::time::Instant::now() >= deadline {
                                kill_group_graceful(pid, &mut child, 400);
                                child_status = None;
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(50));
                        }
                        Err(_) => {
                            child_status = Some(false);
                            break;
                        }
                    }
                }
                if stop_hit {
                    break RunEnd::Stopped;
                }
                match child_status {
                    Some(ok) => break RunEnd::Exited(ok),
                    None => break RunEnd::TimedOut,
                }
            }
        }
    };
    // Reap with a short bound; after a group kill the child is
    // already dead or dying, and this thread must not become the
    // thing that hangs.
    for _ in 0..40 {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    RunOutcome { end, code: child_code, lines }
}

impl App {
    fn save_config(&self) {
        let text = {
            let cfg = self.config.lock().unwrap();
            serde_json::to_string_pretty(&*cfg).unwrap_or_else(|_| "{}".to_string())
        };
        let _ = std::fs::create_dir_all(&self.data_dir);
        let tmp = self
            .data_dir
            .join(format!("config.json.tmp.{}", std::process::id()));
        let dst = self.data_dir.join("config.json");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &dst);
        }
    }

    fn effective_default_agent(&self) -> Option<String> {
        let cfg = self.config.lock().unwrap();
        cfg.default_agent
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| self.default_agent.clone())
    }

    fn effective_model_for(&self, agent: &str) -> Option<String> {
        let cfg = self.config.lock().unwrap();
        match engine_kind(agent) {
            EngineKind::Opencode => cfg
                .opencode_model
                .clone()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| self.env_model.clone())
                .or_else(|| self.policy.model.clone()),
            EngineKind::Claude => cfg
                .claude_model
                .clone()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| self.env_claude_model.clone()),
            EngineKind::Codex => cfg
                .codex_model
                .clone()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| self.env_codex_model.clone()),
            EngineKind::Custom => None,
        }
    }

    fn effective_max_parallel(&self) -> i64 {
        let cfg = self.config.lock().unwrap();
        cfg.max_parallel_agents
            .or(self.env_max_parallel)
            .unwrap_or(self.policy.max_parallel)
            .clamp(1, 64)
    }

    fn queue_counts(&self) -> (usize, usize, usize) {
        let sessions = self.sessions.lock().unwrap();
        let active = sessions
            .iter()
            .filter(|s| matches!(s.status.as_str(), "working" | "checking"))
            .count();
        let queued = sessions
            .iter()
            .filter(|s| matches!(s.status.as_str(), "queued" | "blocked"))
            .count();
        let total = sessions.iter().filter(|s| s.bucket != "archived").count();
        (active, queued, total)
    }

    fn bump_rev(&self) {
        self.state_rev
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    fn mark_dirty(&self, id: &str) {
        self.dirty_records.lock().unwrap().insert(id.to_string());
        self.bump_rev();
    }

    fn emit_queue_depth(&self) {
        let (active, queued, total) = self.queue_counts();
        self.events.publish(
            "queue_depth",
            &serde_json::json!({
                "active": active,
                "queued": queued,
                "total": total,
                "max_parallel": self.effective_max_parallel(),
            }),
        );
    }

    fn config_json(&self) -> serde_json::Value {
        let default_agent = self.effective_default_agent();
        let default_agent_engine = default_agent
            .as_deref()
            .map(|a| engine_kind(a).label().to_string());
        let eff_opencode = self.effective_model_for("opencode");
        let eff_claude = self.effective_model_for("claude");
        let eff_codex = self.effective_model_for("codex");
        let max_parallel = self.effective_max_parallel();
        let (active, queued, _) = self.queue_counts();
        let cfg = self.config.lock().unwrap();
        serde_json::json!({
            "default_agent": default_agent,
            "default_agent_engine": default_agent_engine,
            "opencode_model": cfg.opencode_model,
            "claude_model": cfg.claude_model,
            "codex_model": cfg.codex_model,
            "max_parallel_agents": cfg.max_parallel_agents,
            "effective_max_parallel": max_parallel,
            "active_sessions": active,
            "queued_sessions": queued,
            "effective_models": {
                "opencode": eff_opencode,
                "claude": eff_claude,
                "codex": eff_codex,
            },
            "policy_model": self.policy.model,
            "env_model": self.env_model,
        })
    }

    /// Prune inactive worktrees strictly inside `self.data_dir/worktrees` and
    /// run `git worktree prune` on target git repos. Active sessions (`queued`,
    /// `working`, `checking`, `done`, `needs-you`) are never touched.
    fn prune_worktrees(&self, filter_repo: Option<&str>) -> serde_json::Value {
        let wt_root = self.data_dir.join("worktrees");
        let (active_ids, session_repos, repo_by_id): (
            std::collections::HashSet<String>,
            std::collections::HashSet<String>,
            std::collections::HashMap<String, String>,
        ) = {
            let sessions = self.sessions.lock().unwrap();
            let mut active = std::collections::HashSet::new();
            let mut repos = std::collections::HashSet::new();
            let mut map = std::collections::HashMap::new();
            for s in sessions.iter() {
                if !s.repo.is_empty() {
                    repos.insert(s.repo.clone());
                    map.insert(s.id.clone(), s.repo.clone());
                }
                if !matches!(s.status.as_str(), "merged" | "archived") {
                    active.insert(s.id.clone());
                }
            }
            (active, repos, map)
        };

        let mut removed_worktrees: Vec<String> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&wt_root) {
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.starts_with(&wt_root) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if active_ids.contains(&name) {
                    continue;
                }
                if let Some(target_repo) = filter_repo {
                    if repo_by_id.get(&name).map(|r| r.as_str()) != Some(target_repo) {
                        continue;
                    }
                }
                if let Some(repo) = repo_by_id.get(&name) {
                    if Path::new(repo).join(".git").exists() {
                        let _ = Command::new("git")
                            .arg("-C")
                            .arg(repo)
                            .args(["worktree", "remove", "--force"])
                            .arg(&p)
                            .output();
                    }
                }
                if p.exists() {
                    let _ = std::fs::remove_dir_all(&p);
                }
                if !p.exists() {
                    removed_worktrees.push(name);
                }
            }
        }
        removed_worktrees.sort();

        let mut repos_to_prune: Vec<String> = if let Some(r) = filter_repo {
            vec![r.to_string()]
        } else {
            let mut all_r: std::collections::HashSet<String> = session_repos;
            for info in self.discover_repos() {
                all_r.insert(info.path);
            }
            all_r.into_iter().collect()
        };
        repos_to_prune.sort();
        let mut pruned_repos: Vec<String> = Vec::new();
        for repo in repos_to_prune {
            if !Path::new(&repo).join(".git").exists() {
                continue;
            }
            if Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["worktree", "prune"])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
            {
                pruned_repos.push(repo);
            }
        }
        let removed_count = removed_worktrees.len();
        let message = if removed_count == 0 {
            "All worktrees are clean.".to_string()
        } else {
            format!(
                "Pruned {removed_count} stale worktree{}.",
                if removed_count == 1 { "" } else { "s" }
            )
        };
        let payload = serde_json::json!({
            "pruned": true,
            "removed": removed_count,
            "message": message,
            "removed_worktrees": removed_worktrees,
            "pruned_repos": pruned_repos,
        });
        self.events.publish("worktrees_pruned", &payload);
        payload
    }

    fn discover_repos(&self) -> Vec<RepoInfo> {
        const REPOS_TTL: std::time::Duration = std::time::Duration::from_secs(3);
        const MAX_REPOS: usize = 60;
        let rev = self.state_rev.load(std::sync::atomic::Ordering::SeqCst);
        let env_dirs_opt = std::env::var("FLEET_REPOS_DIR").ok();
        let env_key = env_dirs_opt.as_deref().unwrap_or("").to_string();
        let now = std::time::Instant::now();
        {
            let guard = self.repos_cache.lock().unwrap();
            if let Some((cached_rev, ref cached_env, at, ref cached_repos)) = *guard {
                if cached_rev == rev
                    && *cached_env == env_key
                    && now.duration_since(at) < REPOS_TTL
                {
                    return cached_repos.clone();
                }
            }
        }

        let mut seen = std::collections::HashSet::<PathBuf>::new();
        let mut discovered: Vec<(String, String)> = Vec::new();

        let mut try_add = |p: &Path| -> bool {
            if discovered.len() >= MAX_REPOS {
                return false;
            }
            if !p.is_dir() || !p.join(".git").exists() {
                return true;
            }
            let canon = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
            if !seen.insert(canon.clone()) {
                return true;
            }
            let path_str = canon.to_string_lossy().to_string();
            let name = canon
                .file_name()
                .and_then(|n| n.to_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("repo")
                .to_string();
            discovered.push((name, path_str));
            discovered.len() < MAX_REPOS
        };

        // Deduplicate raw session repo paths BEFORE canonicalizing or leaving the lock
        // so 2,000+ sessions on a handful of repos do O(unique_repos) filesystem checks.
        let session_repos: Vec<String> = {
            let sessions = self.sessions.lock().unwrap();
            let mut uniq = std::collections::HashSet::<&str>::new();
            let mut out = Vec::new();
            for s in sessions.iter() {
                if !s.repo.is_empty() && uniq.insert(s.repo.as_str()) {
                    out.push(s.repo.clone());
                    if out.len() >= MAX_REPOS {
                        break;
                    }
                }
            }
            out
        };
        for r in session_repos {
            if !try_add(Path::new(&r)) {
                break;
            }
        }

        let mut roots: Vec<PathBuf> = Vec::new();
        if let Some(env_dirs) = env_dirs_opt {
            for part in env_dirs.split(':').filter(|s| !s.trim().is_empty()) {
                roots.push(PathBuf::from(part.trim()));
            }
        } else {
            if let Some(home) = std::env::var_os("HOME").filter(|s| !s.is_empty()) {
                let h = PathBuf::from(home);
                roots.push(h.join("Work/projects"));
                roots.push(h.join("projects"));
                roots.push(h.join("Code"));
            }
            if let Ok(cwd) = std::env::current_dir() {
                roots.push(cwd);
            }
        }

        let skip_dir = |name: &str| {
            name.starts_with('.')
                || matches!(
                    name,
                    "node_modules"
                        | "target"
                        | "vendor"
                        | "dist"
                        | "build"
                        | "__pycache__"
                        | "venv"
                )
        };

        'roots: for root in roots {
            if !root.is_dir() {
                continue;
            }
            if root.join(".git").exists() {
                if !try_add(&root) {
                    break 'roots;
                }
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if skip_dir(&name) {
                    continue;
                }
                if p.join(".git").exists() {
                    if !try_add(&p) {
                        break 'roots;
                    }
                } else if let Ok(sub) = std::fs::read_dir(&p) {
                    for se in sub.flatten() {
                        let sp = se.path();
                        if !sp.is_dir() {
                            continue;
                        }
                        let sname = se.file_name().to_string_lossy().to_string();
                        if skip_dir(&sname) {
                            continue;
                        }
                        if sp.join(".git").exists() && !try_add(&sp) {
                            break 'roots;
                        }
                    }
                }
            }
        }

        let paths: Vec<String> = discovered.iter().map(|(_, p)| p.clone()).collect();
        let targets = self.cached_merge_targets(&paths);
        let mut repos: Vec<RepoInfo> = discovered
            .into_iter()
            .map(|(name, path)| {
                let branch = targets.get(&path).cloned().flatten();
                RepoInfo { name, path, branch }
            })
            .collect();

        repos.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.path.cmp(&b.path))
        });
        let rev_after = self.state_rev.load(std::sync::atomic::Ordering::SeqCst);
        if rev_after == rev {
            *self.repos_cache.lock().unwrap() = Some((rev, env_key, now, repos.clone()));
        }
        repos
    }

    /// Snapshot all session state to disk (atomic rename), so a server
    /// restart loses nothing. The per-session log files are the durable
    /// transcript record; this file is the state snapshot. Only dirty or
    /// missing `.record.json` files are rewritten so 2,000+ sessions stay fast.
    fn persist(&self) {
        self.bump_rev();
        let logs_dir = self.data_dir.join("logs");
        let _ = std::fs::create_dir_all(&logs_dir);
        let dirty: std::collections::HashSet<String> = {
            let mut d = self.dirty_records.lock().unwrap();
            std::mem::take(&mut *d)
        };
        let (snapshot, records) = {
            let sessions = self.sessions.lock().unwrap();
            let counter = self.counter.lock().unwrap();
            let snapshot = serde_json::json!({ "counter": *counter, "sessions": *sessions });
            // Write `.record.json` only for modified sessions or any session
            // missing its record file on disk (preserves crash-recovery tests
            // while avoiding 2,000+ redundant renames on every log flush).
            let records: Vec<Session> = sessions
                .iter()
                .filter(|s| {
                    dirty.contains(&s.id) || !logs_dir.join(format!("{}.record.json", s.id)).exists()
                })
                .map(|s| {
                    let mut r = s.clone();
                    r.transcript.clear();
                    r
                })
                .collect();
            (snapshot, records)
        };
        static PERSIST_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = PERSIST_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = self
            .data_dir
            .join(format!("sessions.json.tmp.{}-{}", std::process::id(), seq));
        let dst = self.data_dir.join("sessions.json");
        if std::fs::write(&tmp, snapshot.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, &dst);
        }
        for r in records {
            let Ok(text) = serde_json::to_string(&r) else {
                continue;
            };
            let tmp = logs_dir.join(format!("{}.record.json.tmp.{}-{}", r.id, std::process::id(), seq));
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, logs_dir.join(format!("{}.record.json", r.id)));
            }
        }
    }

    fn set_status(&self, id: &str, status: Status) {
        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(s) = sessions.iter_mut().find(|s| s.id == id) {
                s.status = status.label().to_string();
                s.bucket = status.bucket().to_string();
            }
        }
        self.mark_dirty(id);
        self.persist();
        let (active, queued, _) = self.queue_counts();
        let session_obj = self.session_json_single(id);
        self.events.publish(
            "session_status",
            &serde_json::json!({
                "id": id,
                "status": status.label(),
                "bucket": status.bucket(),
                "active": active,
                "queued": queued,
                "max_parallel": self.effective_max_parallel(),
                "session": session_obj,
            }),
        );
    }

    /// Mark a session needs-you with the reason recorded on the session
    /// itself (the inbox aggregates these) and in its transcript.
    fn set_needs_you(&self, id: &str, reason: &str) {
        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(s) = sessions.iter_mut().find(|s| s.id == id) {
                s.status = Status::NeedsYou.label().to_string();
                s.bucket = Status::NeedsYou.bucket().to_string();
                s.reason = Some(reason.to_string());
                s.verified_commit = None;
            }
        }
        self.mark_dirty(id);
        self.log(id, format!("needs you: {reason}"));
        self.persist();
        let (active, queued, _) = self.queue_counts();
        let session_obj = self.session_json_single(id);
        self.events.publish(
            "session_status",
            &serde_json::json!({
                "id": id,
                "status": Status::NeedsYou.label(),
                "bucket": Status::NeedsYou.bucket(),
                "reason": reason,
                "active": active,
                "queued": queued,
                "max_parallel": self.effective_max_parallel(),
                "session": session_obj,
            }),
        );
    }

    /// Serialize a single session by ID without scanning/serializing all 2,000+ sessions.
    fn session_json_single(&self, id: &str) -> Option<serde_json::Value> {
        let (session, queue_pos, dep_statuses) = {
            let sessions = self.sessions.lock().unwrap();
            let mut qpos = 0usize;
            let mut found_qpos = None;
            let mut found = None;
            for s in sessions.iter() {
                if s.status == "queued" {
                    qpos += 1;
                    if s.id == id {
                        found_qpos = Some(qpos);
                    }
                }
                if s.id == id {
                    found = Some(s.clone());
                }
            }
            let session = found?;
            let mut dep_map = std::collections::HashMap::with_capacity(session.depends_on.len());
            if !session.depends_on.is_empty() {
                for dep in &session.depends_on {
                    if let Some(ds) = sessions.iter().find(|x| x.id == *dep) {
                        dep_map.insert(dep.clone(), ds.status.clone());
                    }
                }
            }
            (session, found_qpos, dep_map)
        };
        let targets = if session.repo.is_empty() {
            std::collections::HashMap::new()
        } else {
            self.cached_merge_targets(std::slice::from_ref(&session.repo))
        };
        let mut v = session_to_api_value(&session, &targets, &dep_statuses);
        v["queue_position"] = match queue_pos {
            Some(p) => serde_json::json!(p),
            None => serde_json::Value::Null,
        };
        Some(v)
    }
    fn status_of(&self, id: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.status.clone())
    }

    /// Resolve checked-out merge targets for a set of repo paths using a 5s TTL
    /// cache so 2,000-session API queries never re-spawn `git symbolic-ref`.
    fn cached_merge_targets(
        &self,
        repos: &[String],
    ) -> std::collections::HashMap<String, Option<String>> {
        const TTL: std::time::Duration = std::time::Duration::from_secs(5);
        let now = std::time::Instant::now();
        let mut out = std::collections::HashMap::with_capacity(repos.len());
        let mut missing = Vec::new();
        {
            let cache = self.merge_target_cache.lock().unwrap();
            for r in repos {
                if let Some((val, at)) = cache.get(r) {
                    if now.duration_since(*at) < TTL {
                        out.insert(r.clone(), val.clone());
                        continue;
                    }
                }
                missing.push(r.clone());
            }
        }
        for r in missing {
            let val = merge_target(&r);
            self.merge_target_cache
                .lock()
                .unwrap()
                .insert(r.clone(), (val.clone(), now));
            out.insert(r, val);
        }
        out
    }

    fn invalidate_merge_target_cache(&self, repo: &str) {
        self.merge_target_cache.lock().unwrap().remove(repo);
        self.bump_rev();
    }

    /// The session JSON for the API. Each distinct repo's merge target
    /// is resolved with git outside the sessions lock (with a 5s TTL cache).
    fn sessions_view(&self) -> serde_json::Value {
        let repos: Vec<String> = {
            let sessions = self.sessions.lock().unwrap();
            let mut r: Vec<String> = sessions
                .iter()
                .filter(|s| !s.repo.is_empty())
                .map(|s| s.repo.clone())
                .collect();
            r.sort();
            r.dedup();
            r
        };
        let targets = self.cached_merge_targets(&repos);
        let sessions = self.sessions.lock().unwrap();
        sessions_json(&sessions, &targets)
    }

    /// Cached JSON string for unfiltered `GET /api/sessions`, reused across
    /// concurrent HTTP clients while `state_rev` is unchanged (<1ms p95 at 2,000+ sessions).
    fn sessions_view_cached(&self) -> String {
        const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(5);
        let rev = self.state_rev.load(std::sync::atomic::Ordering::SeqCst);
        let now = std::time::Instant::now();
        {
            let guard = self.sessions_cache.lock().unwrap();
            if let Some((cached_rev, at, ref body)) = *guard {
                if cached_rev == rev && now.duration_since(at) < CACHE_TTL {
                    return body.clone();
                }
            }
        }
        let body = self.sessions_view().to_string();
        let rev_after = self.state_rev.load(std::sync::atomic::Ordering::SeqCst);
        if rev_after == rev {
            *self.sessions_cache.lock().unwrap() = Some((rev, now, body.clone()));
        }
        body
    }

    /// Cached JSON string for `GET /api/metrics`, invalidated automatically whenever
    /// `state_rev` or `effective_max_parallel()` changes (O(1) cache hit, single O(N) pass on miss).
    fn metrics_json_cached(&self) -> String {
        let rev = self.state_rev.load(std::sync::atomic::Ordering::SeqCst);
        let max_parallel = self.effective_max_parallel().max(1);
        {
            let guard = self.metrics_cache.lock().unwrap();
            if let Some((cached_rev, cached_max, ref payload)) = *guard {
                if cached_rev == rev && cached_max == max_parallel {
                    return payload.clone();
                }
            }
        }
        let metrics = {
            let sessions = self.sessions.lock().unwrap();
            compute_metrics_with_capacity(&sessions, max_parallel as usize)
        };
        let mut val = serde_json::to_value(&metrics).unwrap_or_else(|_| serde_json::json!({}));
        val["max_parallel"] = serde_json::json!(max_parallel);
        let payload = val.to_string();
        let rev_after = self.state_rev.load(std::sync::atomic::Ordering::SeqCst);
        if rev_after == rev {
            *self.metrics_cache.lock().unwrap() = Some((rev, max_parallel, payload.clone()));
        }
        payload
    }

    /// Fast filtered / paginated query over sessions (supports `q`, `status`,
    /// `bucket`, `project`, `repo`, `engine`, `limit`, `offset`, `compact`, `paginated`).
    fn sessions_query(&self, params: &std::collections::HashMap<String, String>) -> serde_json::Value {
        let q = params.get("q").map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
        let status_f = params.get("status").map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
        let bucket_f = params.get("bucket").map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
        let project_f = params.get("project").map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
        let repo_f = params.get("repo").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let engine_f = params.get("engine").map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
        let compact = matches!(
            params.get("compact").or_else(|| params.get("summary")).map(String::as_str),
            Some("1" | "true" | "yes")
        );
        let paginated = matches!(
            params.get("paginated").map(String::as_str),
            Some("1" | "true" | "yes")
        );
        let offset = params
            .get("offset")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(0);
        let limit = params
            .get("limit")
            .and_then(|v| v.parse::<usize>().ok())
            .map(|l| l.min(2000));

        let max_take = limit.unwrap_or(usize::MAX);
        let (page, total, repos, counts, status_map) = {
            let sessions = self.sessions.lock().unwrap();
            let mut queued_pos = 0usize;
            let (mut c_all, mut c_needs, mut c_work, mut c_done) = (0usize, 0usize, 0usize, 0usize);
            let mut total = 0usize;
            let mut page: Vec<(Session, Option<usize>)> =
                Vec::with_capacity(limit.unwrap_or(64).min(256));
            let mut repo_set = std::collections::HashSet::<String>::new();

            for s in sessions.iter() {
                let qp = if s.status == "queued" {
                    queued_pos += 1;
                    Some(queued_pos)
                } else {
                    None
                };
                if s.bucket != "archived" {
                    c_all += 1;
                    match s.bucket.as_str() {
                        "needs-you" => c_needs += 1,
                        "working" => c_work += 1,
                        "done" => c_done += 1,
                        _ => {}
                    }
                }
                if let Some(ref st) = status_f {
                    if !s.status.eq_ignore_ascii_case(st) {
                        continue;
                    }
                }
                if let Some(ref b) = bucket_f {
                    if !s.bucket.eq_ignore_ascii_case(b) {
                        continue;
                    }
                }
                if let Some(ref p) = project_f {
                    if !s.project.eq_ignore_ascii_case(p) {
                        continue;
                    }
                }
                if let Some(ref r) = repo_f {
                    if s.repo != *r {
                        continue;
                    }
                }
                if let Some(ref e) = engine_f {
                    if engine_kind(&s.agent).label() != e.as_str() {
                        continue;
                    }
                }
                if let Some(ref needle) = q {
                    let hit = s.task.to_lowercase().contains(needle)
                        || s.project.to_lowercase().contains(needle)
                        || s.branch.to_lowercase().contains(needle)
                        || s.id.to_lowercase().contains(needle)
                        || s.repo.to_lowercase().contains(needle);
                    if !hit {
                        continue;
                    }
                }
                let match_idx = total;
                total += 1;
                if match_idx >= offset && page.len() < max_take {
                    let mut clone = s.clone();
                    if compact {
                        if clone.transcript.len() > 3 {
                            let start = clone.transcript.len() - 3;
                            clone.transcript = clone.transcript.split_off(start);
                        }
                        clone.diff.clear();
                    }
                    if !clone.repo.is_empty() {
                        repo_set.insert(clone.repo.clone());
                    }
                    page.push((clone, qp));
                }
            }

            // Populate `status_map` ONLY for `depends_on` targets referenced by this page.
            let mut needed_deps = std::collections::HashSet::<&str>::new();
            for (s, _) in &page {
                for dep in &s.depends_on {
                    needed_deps.insert(dep.as_str());
                }
            }
            let mut status_map = std::collections::HashMap::<String, String>::with_capacity(needed_deps.len());
            if !needed_deps.is_empty() {
                for s in sessions.iter() {
                    if needed_deps.contains(s.id.as_str()) {
                        status_map.insert(s.id.clone(), s.status.clone());
                    }
                }
            }

            let mut r: Vec<String> = repo_set.into_iter().collect();
            r.sort();
            (page, total, r, (c_all, c_needs, c_work, c_done), status_map)
        };

        let targets = self.cached_merge_targets(&repos);
        let arr = serde_json::Value::Array(
            page.iter()
                .map(|(s, qp)| {
                    let mut v = session_to_api_value(s, &targets, &status_map);
                    v["queue_position"] = match qp {
                        Some(p) => serde_json::json!(p),
                        None => serde_json::Value::Null,
                    };
                    v
                })
                .collect(),
        );
        if paginated {
            serde_json::json!({
                "sessions": arr,
                "total": total,
                "offset": offset,
                "limit": limit.unwrap_or(total),
                "counts": {
                    "all": counts.0,
                    "needs_you": counts.1,
                    "working": counts.2,
                    "done": counts.3,
                }
            })
        } else {
            arr
        }
    }

    /// Paginated, searchable transcript view for a single session (supports
    /// 50,000+ lines from `logs/<id>.log` or in-memory transcript cleanly).
    fn transcript_query(
        &self,
        id: &str,
        params: &std::collections::HashMap<String, String>,
    ) -> Option<serde_json::Value> {
        let mem_lines: Vec<String> = {
            let sessions = self.sessions.lock().unwrap();
            sessions.iter().find(|s| s.id == id)?.transcript.clone()
        };
        let log_path = self.data_dir.join("logs").join(format!("{id}.log"));
        let disk_lines = std::fs::read_to_string(&log_path)
            .ok()
            .map(|t| transcript_lines_from_log(&t))
            .unwrap_or_default();
        let all_lines = if disk_lines.len() >= mem_lines.len() && !disk_lines.is_empty() {
            disk_lines
        } else {
            mem_lines
        };
        let is_err_line = |l: &str| {
            let low = l.to_lowercase();
            low.starts_with("stderr:")
                || low.contains("error")
                || low.contains("fail")
                || low.contains("panic")
                || low.contains("exception")
                || low.contains("assertion")
        };
        let total = all_lines.len();
        let first_error_index = all_lines.iter().position(|l| is_err_line(l));
        let q = params.get("q").map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
        let errors_only = matches!(
            params.get("errors_only").map(String::as_str),
            Some("1" | "true" | "yes")
        );
        let offset = params
            .get("offset")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(0);
        let limit = params
            .get("limit")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(500)
            .clamp(1, 60_000);

        let mut filtered_total = 0usize;
        let mut page = Vec::with_capacity(limit.min(500));
        for (idx, line) in all_lines.iter().enumerate() {
            let err = is_err_line(line);
            if errors_only && !err {
                continue;
            }
            if let Some(ref needle) = q {
                if !line.to_lowercase().contains(needle) {
                    continue;
                }
            }
            if filtered_total >= offset && page.len() < limit {
                page.push(serde_json::json!({
                    "index": idx,
                    "text": line,
                    "is_error": err,
                }));
            }
            filtered_total += 1;
        }
        Some(serde_json::json!({
            "id": id,
            "total": total,
            "filtered_total": filtered_total,
            "offset": offset,
            "limit": limit,
            "first_error_index": first_error_index,
            "lines": page,
        }))
    }

    /// The session's stop flag, created on first use. The worker
    /// thread clones it before a run; the stop endpoint sets it.
    fn stop_flag(&self, id: &str) -> Arc<std::sync::atomic::AtomicBool> {
        self.stops
            .lock()
            .unwrap()
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(std::sync::atomic::AtomicBool::new(false)))
            .clone()
    }

    /// Look at a session's pending steering messages WITHOUT taking
    /// them. The runner removes a batch only after the run that
    /// carried it (drop_steer): a server crash mid-delivery must not
    /// lose the operator's words — after a restart the messages are
    /// still in the persisted queue and the resumed pass delivers
    /// them.
    fn peek_steer(&self, id: &str) -> Vec<String> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.steer.clone())
            .unwrap_or_default()
    }

    /// Remove the first `n` steering messages — the batch a finished
    /// continuation run just delivered. Messages that arrived during
    /// the run sit behind them and stay queued.
    fn drop_steer(&self, id: &str, n: usize) {
        if n == 0 {
            return;
        }
        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(s) = sessions.iter_mut().find(|s| s.id == id) {
                let n = n.min(s.steer.len());
                s.steer.drain(..n);
            }
        }
        self.persist();
    }

    fn steer_pending(&self, id: &str) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .find(|s| s.id == id)
            .is_some_and(|s| !s.steer.is_empty())
    }
    /// Append text to a session's on-disk log file (the transcript of
    /// record). Used for content too big for the in-memory view, like a
    /// full check output.
    fn append_log_text(&self, id: &str, text: &str) {
        let logs_dir = self.data_dir.join("logs");
        let _ = std::fs::create_dir_all(&logs_dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs_dir.join(format!("{id}.log")))
        {
            let _ = write!(f, "{text}");
            if !text.ends_with('\n') {
                let _ = writeln!(f);
            }
        }
    }

    fn log(&self, id: &str, line: String) {
        let count = {
            let mut sessions = self.sessions.lock().unwrap();
            match sessions.iter_mut().find(|s| s.id == id) {
                Some(s) => {
                    s.transcript_total = s.transcript_total.max(s.transcript.len()) + 1;
                    s.transcript.push(line.clone());
                    // Cap the in-memory transcript: a flooding agent
                    // must not grow memory, the snapshot file, or every
                    // API response without limit. Nothing is lost —
                    // the log file below keeps every line; this view
                    // keeps the most recent TRANSCRIPT_CAP lines behind
                    // a marker saying where the rest lives.
                    if s.transcript.len() > TRANSCRIPT_CAP {
                        let excess = s.transcript.len() - TRANSCRIPT_CAP + 1;
                        s.transcript.drain(0..excess);
                        s.transcript.insert(
                            0,
                            "… earlier lines are in this session's log file on disk — this view keeps the most recent lines"
                                .to_string(),
                        );
                    }
                    // The byte budget binds even when the line count
                    // does not: a few enormous lines must not bloat
                    // memory, the snapshot, or every API response.
                    let bytes: usize = s.transcript.iter().map(|l| l.len() + 1).sum();
                    if bytes > TRANSCRIPT_BYTES {
                        let mut over = bytes - TRANSCRIPT_BYTES;
                        let start = if s.transcript.first().is_some_and(|l| l.starts_with('…')) {
                            1
                        } else {
                            0
                        };
                        let mut drop_end = start;
                        while over > 0 && drop_end + 1 < s.transcript.len() {
                            over = over.saturating_sub(s.transcript[drop_end].len() + 1);
                            drop_end += 1;
                        }
                        if drop_end > start {
                            s.transcript.drain(start..drop_end);
                        }
                    }
                    s.transcript.len()
                }
                None => return,
            }
        };
        self.mark_dirty(id);
        // The per-session log file is written on every line: it is the
        // transcript record that survives even a hard kill.
        let logs_dir = self.data_dir.join("logs");
        let _ = std::fs::create_dir_all(&logs_dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs_dir.join(format!("{id}.log")))
        {
            let stored =
                if line == "--- check output ---" || line == "--- end check output ---" {
                    format!(" {line}")
                } else {
                    line.clone()
                };
            let _ = writeln!(f, "{stored}");
        }
        self.events.publish(
            "transcript_line",
            &serde_json::json!({
                "id": id,
                "line": line,
                "is_err": line.starts_with("stderr:"),
                "line_count": count,
            }),
        );
        let since = self
            .lines_since_persist
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        if since >= 25 {
            self.lines_since_persist
                .store(0, std::sync::atomic::Ordering::Relaxed);
            self.persist();
        }
    }

    /// Start a session's worker thread if its DAG dependencies are satisfied
    /// and a parallel slot is free; otherwise it stays queued/blocked.
    fn maybe_start(self: &Arc<Self>, id: &str) {
        let cap = self.effective_max_parallel();
        {
            let mut sessions = self.sessions.lock().unwrap();
            let active = sessions
                .iter()
                .filter(|x| matches!(x.status.as_str(), "working" | "checking"))
                .count() as i64;
            let Some(idx) = sessions.iter().position(|s| s.id == id) else {
                return;
            };
            if !matches!(sessions[idx].status.as_str(), "queued" | "blocked") {
                return;
            }
            if !sessions[idx].depends_on.is_empty() {
                let deps_satisfied = sessions[idx].depends_on.iter().all(|dep| {
                    sessions
                        .iter()
                        .find(|x| x.id == *dep)
                        .is_some_and(|x| matches!(x.status.as_str(), "done" | "merged"))
                });
                if !deps_satisfied {
                    return;
                }
            }
            if active >= cap {
                return;
            }
            sessions[idx].status = Status::Working.label().to_string();
            sessions[idx].bucket = Status::Working.bucket().to_string();
        }
        self.mark_dirty(id);
        self.persist();
        self.emit_queue_depth();
        let session_obj = self.session_json_single(id);
        self.events.publish(
            "session_status",
            &serde_json::json!({
                "id": id,
                "status": Status::Working.label(),
                "bucket": Status::Working.bucket(),
                "session": session_obj,
            }),
        );
        let app = self.clone();
        let id = id.to_string();
        std::thread::spawn(move || app.run_session(&id));
    }

    fn pump_queue(self: &Arc<Self>) {
        let (nodes, external_states, has_pending) = {
            let sessions = self.sessions.lock().unwrap();
            let pending = sessions
                .iter()
                .any(|s| matches!(s.status.as_str(), "queued" | "blocked"));
            if !pending {
                return;
            }
            let known: std::collections::HashSet<&str> =
                sessions.iter().map(|s| s.id.as_str()).collect();
            let mut ext: std::collections::HashMap<String, DagNodeState> =
                std::collections::HashMap::new();
            let mut nodes = Vec::with_capacity(sessions.len());
            for s in sessions.iter() {
                for dep in &s.depends_on {
                    if !known.contains(dep.as_str()) {
                        ext.insert(dep.clone(), DagNodeState::Archived);
                    }
                }
                nodes.push(TaskNode {
                    id: s.id.clone(),
                    depends_on: s.depends_on.clone(),
                    state: session_dag_state(&s.status),
                });
            }
            (nodes, ext, pending)
        };
        if !has_pending {
            return;
        }
        let cap = self.effective_max_parallel() as usize;
        match DagGraph::from_nodes_with_external_deps(nodes, &external_states) {
            Ok(graph) => {
                let plan = graph.evaluate(cap);
                for fail in plan.upstream_failed {
                    if matches!(self.status_of(&fail.id).as_deref(), Some("queued" | "blocked")) {
                        self.set_needs_you(&fail.id, &fail.reason);
                    }
                }
                for b in plan.blocked {
                    if self.status_of(&b.id).as_deref() == Some("queued") {
                        self.set_status(&b.id, Status::Blocked);
                    }
                }
                for ready_id in plan.ready_waiting_for_slot {
                    if self.status_of(&ready_id).as_deref() == Some("blocked") {
                        self.set_status(&ready_id, Status::Queued);
                    }
                }
                for start_id in plan.to_start {
                    self.maybe_start(&start_id);
                }
            }
            Err(_) => {
                // Defensive fallback if an externally edited store contains a cycle.
                let queued: Vec<String> = self
                    .sessions
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|s| s.status == "queued" && s.depends_on.is_empty())
                    .map(|s| s.id.clone())
                    .collect();
                for id in queued {
                    self.maybe_start(&id);
                }
            }
        }
    }

    fn run_session(self: &Arc<Self>, id: &str) {
        // Re-verify the claim this thread was spawned on: a queued
        // session that was stopped (cancelled) between the spawn and
        // this thread's start must not run after all.
        if self.status_of(id).as_deref() != Some("working") {
            return;
        }
        let session = {
            let sessions = self.sessions.lock().unwrap();
            sessions.iter().find(|s| s.id == id).unwrap().clone()
        };
        let repo = PathBuf::from(&session.repo);
        let wt = PathBuf::from(&session.worktree);

        // 1. Isolated worktree on its own branch. On a retry the
        // worktree already exists with the agent's earlier work in it —
        // reuse it, so the agent continues from what it already did.
        // A worktree whose link to the repo is gone (the repo's admin
        // record for it was lost) cannot be reused: its files move
        // aside, and the work is re-attached from the session's branch.
        if wt.exists() && !Self::worktree_attached(&wt) {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let aside = wt.with_file_name(format!("{}.detached-{secs}", session.id));
            match std::fs::rename(&wt, &aside) {
                Ok(()) => self.log(
                    id,
                    format!(
                        "the worktree had lost its link to the repo — its files were moved to {}",
                        aside.display()
                    ),
                ),
                Err(e) => {
                    self.log(id, format!("could not move the detached worktree aside: {e}"));
                    self.set_needs_you(
                        id,
                        "the worktree lost its link to the repo and could not be moved aside",
                    );
                    self.pump_queue();
                    return;
                }
            }
        }
        if wt.join(".git").exists() {
            self.log(
                id,
                format!("reusing existing worktree on branch {}", session.branch),
            );
            return self.run_agent_and_check(id, &session, &wt, true);
        }
        if let Some(parent) = wt.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // If the session's branch already exists (its worktree
        // directory was deleted after an earlier run), restore the
        // worktree from the branch — `add -b` would refuse, the branch
        // exists, and the session's committed work would be stranded.
        // Admin records of worktrees whose directories are gone must go
        // first, or git refuses to add the path again.
        let _ = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["worktree", "prune"])
            .output();
        let out = if self.branch_exists(&session.repo, &session.branch) {
            self.log(
                id,
                "worktree directory was missing — restored from the session's branch; earlier committed work is intact"
                    .to_string(),
            );
            Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["worktree", "add"])
                .arg(&wt)
                .arg(&session.branch)
                .output()
        } else {
            Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["worktree", "add", "-b", &session.branch])
                .arg(&wt)
                .arg("HEAD")
                .output()
        };
        match out {
            Ok(o) if o.status.success() => {
                self.log(id, format!("worktree ready on branch {}", session.branch));
            }
            Ok(o) => {
                self.log(
                    id,
                    format!(
                        "worktree creation failed: {}",
                        String::from_utf8_lossy(&o.stderr)
                    ),
                );
                self.set_needs_you(id, "worktree creation failed");
                self.pump_queue();
                return;
            }
            Err(e) => {
                self.log(id, format!("could not run git: {e}"));
                self.set_needs_you(id, "could not run git");
                self.pump_queue();
                return;
            }
        }

        self.run_agent_and_check(id, &session, &wt, false);
    }

    /// Clear a stale index.lock in a worktree's git dir, if one is
    /// there. A lock older than a minute is the residue of a git
    /// process killed mid-operation (a server kill -9 leaves one),
    /// not a live process — and without clearing it, every git
    /// operation on the worktree fails identically forever. Returns
    /// true when a lock was cleared.
    fn clear_stale_index_lock(&self, id: &str, wt: &Path) -> bool {
        let git_dir = Command::new("git")
            .arg("-C")
            .arg(wt)
            .args(["rev-parse", "--git-dir"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                let raw = String::from_utf8_lossy(&o.stdout).trim().to_string();
                let p = PathBuf::from(&raw);
                if p.is_absolute() { p } else { wt.join(p) }
            });
        let Some(lock) = git_dir.map(|d| d.join("index.lock")) else {
            return false;
        };
        let stale = std::fs::metadata(&lock)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_secs() > 60);
        if stale && std::fs::remove_file(&lock).is_ok() {
            self.log(
                id,
                "cleared a stale index.lock (residue of a killed git process)".to_string(),
            );
            return true;
        }
        false
    }

    /// Index bits (assume-unchanged, skip-worktree) make git blind
    /// to real worktree changes: `git add -A` skips a flagged file,
    /// the commit silently omits it, and a check reading the file
    /// would then certify content that was never committed. Clear
    /// both bits on every tracked path that carries one, before
    /// staging anything.
    fn clear_index_bits(wt: &Path) {
        for (list_args, flag) in [
            (["ls-files", "-v", "-z"], "--no-assume-unchanged"),
            (["ls-files", "-t", "-z"], "--no-skip-worktree"),
        ] {
            let out = Command::new("git").arg("-C").arg(wt).args(list_args).output();
            let Ok(o) = out else { continue };
            if !o.status.success() {
                continue;
            }
            let mut paths: Vec<&[u8]> = Vec::new();
            for entry in o.stdout.split(|b| *b == 0) {
                if entry.len() < 3 {
                    continue;
                }
                let tag = entry[0];
                let flagged = if flag == "--no-assume-unchanged" {
                    tag.is_ascii_lowercase()
                } else {
                    tag == b'S'
                };
                if flagged {
                    paths.push(&entry[2..]);
                }
            }
            if paths.is_empty() {
                continue;
            }
            let mut cmd = Command::new("git");
            cmd.arg("-C").arg(wt).args(["update-index", flag, "--"]);
            for p in &paths {
                cmd.arg(std::ffi::OsStr::from_bytes(p));
            }
            let _ = cmd.output();
        }
    }

    /// Kill processes that survived a run by detaching from its
    /// process group (setsid) but still hold the worktree: their
    /// working directory is inside it, or they hold a file open in
    /// it. A group kill cannot reach them, and leaving them means a
    /// settled session's worktree keeps changing underneath the
    /// operator — a retry would then commit a ghost's writes as the
    /// agent's work. (A process that also leaves the tree and closes
    /// its files escapes this sweep; it can no longer touch the
    /// worktree's contents either, short of reopening them by path.)
    fn sweep_detached(&self, id: &str, dir: &Path) {
        let me = std::process::id() as i32;
        let mut killed = 0;
        let Ok(proc_dir) = std::fs::read_dir("/proc") else {
            return;
        };
        for entry in proc_dir.flatten() {
            let name = entry.file_name();
            let Some(pid) = name.to_str().and_then(|s| s.parse::<i32>().ok()) else {
                continue;
            };
            if pid == me {
                continue;
            }
            let base = entry.path();
            let holds = std::fs::read_link(base.join("cwd"))
                .map(|p| p.starts_with(dir))
                .unwrap_or(false)
                || std::fs::read_dir(base.join("fd"))
                    .map(|fds| {
                        fds.flatten().any(|fd| {
                            std::fs::read_link(fd.path())
                                .map(|p| p.starts_with(dir))
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false);
            if holds && unsafe { libc::kill(pid, libc::SIGKILL) } == 0 {
                killed += 1;
            }
        }
        if killed > 0 {
            self.log(
                id,
                format!(
                    "killed {killed} detached process(es) still holding the worktree after the run settled"
                ),
            );
        }
    }

    /// One agent run inside a session's worktree, through the engine
    /// adapter, streamed and bounded (timeout and the operator's stop
    /// flag both apply). Returns how the run ended (AgentRun).
    /// On any other ending the session has already been handed to
    /// needs-you with the reason recorded, the queue pumped, and the
    /// caller must stop.
    fn run_one(
        self: &Arc<Self>,
        id: &str,
        session: &Session,
        wt: &Path,
        prompt: &str,
        continuation: bool,
    ) -> AgentRun {
        let timeout = self.policy.timeout_for(
            &session.repo,
            &session.task,
            engine_kind(&session.agent).label(),
        );
        let app_lines = self.clone();
        let id_lines = id.to_string();
        let mut on_line = move |is_err: bool, line: &str| {
            if is_err {
                app_lines.log(&id_lines, format!("stderr: {line}"));
            } else {
                app_lines.log(&id_lines, line.to_string());
            }
        };
        let resolved_model = session
            .model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .or_else(|| self.effective_model_for(&session.agent));
        let (prog, args) = engine_command(
            &session.agent,
            resolved_model.as_deref(),
            prompt,
            continuation,
        );
        let mut agent_cmd = Command::new(&prog);
        agent_cmd.args(&args).current_dir(wt).env("PWD", wt);
        // The stop flag is NOT cleared at run start: a stop can be
        // pressed in the windows where no run is polling it
        // (worktree creation, between runs, during the settle), and
        // clearing here would silently discard exactly those. The
        // flag is cleared when a session is (re)queued — the one
        // moment a new lifecycle begins — and re-checked at the
        // settle before Done is set.
        let flag = self.stop_flag(id);
        let outcome = run_bounded(agent_cmd, timeout, Some(&flag), &mut on_line);
        self.sweep_detached(id, wt);
        match outcome.end {
            RunEnd::SpawnFailed(e) => {
                self.log(id, format!("agent failed to start: {e}"));
                self.set_needs_you(id, &format!("agent failed to start: {}: {e}", session.agent));
                self.pump_queue();
                AgentRun::NotStarted
            }
            RunEnd::Stopped => {
                self.log(
                    id,
                    "stopped by you — the agent's whole process group was killed".to_string(),
                );
                self.set_needs_you(id, "stopped by you mid-run");
                self.pump_queue();
                AgentRun::Failed
            }
            RunEnd::TimedOut => {
                self.log(
                    id,
                    format!("agent timed out after {timeout}s — killed its whole process group; handing back to you"),
                );
                self.set_needs_you(id, &format!("agent timed out after {timeout}s"));
                self.pump_queue();
                AgentRun::Failed
            }
            RunEnd::PipesHeld => {
                self.log(
                    id,
                    "agent exited but a detached process kept its output open — killed the process group".to_string(),
                );
                self.set_needs_you(
                    id,
                    "agent exited but a detached process kept its output open past the limit — the run cannot be trusted complete",
                );
                self.pump_queue();
                AgentRun::Failed
            }
            RunEnd::Exited(false) => {
                self.log(id, "agent exited non-zero — handing back to you".to_string());
                self.set_needs_you(id, "agent exited non-zero");
                self.pump_queue();
                AgentRun::Failed
            }
            RunEnd::Exited(true) => AgentRun::Clean,
        }
    }

    /// Steps 2–4 of a session: run the agent in its worktree
    /// (delivering any steering first on a resumed pass, and draining
    /// the steering queue between runs), run the task's check, record
    /// the outcome. Entered with the worktree ready (freshly created,
    /// or reused on a retry).
    fn run_agent_and_check(
        self: &Arc<Self>,
        id: &str,
        session: &Session,
        wt: &Path,
        resumed: bool,
    ) {
        // Baseline of ignored files before the agent touches anything,
        // so step 4 can tell agent-produced ignored files from the
        // repo's pre-existing ones.
        let ignored_baseline = self.ignored_baseline(id, wt);
        // 2. Run the agent in the worktree, streaming its output. A
        // resumed pass (retry / steer-reopen) whose operator already
        // left steering messages delivers those FIRST, as a
        // continuation of the work already in the tree — re-running
        // the original task prompt at an agent that has moved past
        // it would waste the run.
        let steer_first = resumed && self.steer_pending(id);
        if !steer_first {
            self.log(id, format!("agent started: {}", session.task));
            let prompt = session
                .retry_prompt
                .clone()
                .unwrap_or_else(|| session.task.clone());
            if session.retry_prompt.is_some() {
                // The retry note is delivered once; a later pass starts
                // from the task again.
                if let Some(s) = self.sessions.lock().unwrap().iter_mut().find(|s| s.id == id) {
                    s.retry_prompt = None;
                }
            }
            if self.run_one(id, session, wt, &prompt, false) != AgentRun::Clean {
                return;
            }
        }
        // Verify-and-auto-heal loop: drain any operator steering, commit,
        // verify in a pristine checkout, and if a healable check fails under
        // the session's `auto_steer_budget`, steer the agent with crisp
        // diagnostics (with identical-error loop-guard protection) and
        // re-verify before settling.
        let mut active_heal_idx: Option<usize> = None;
        let mut active_heal_started: Option<std::time::Instant> = None;
        loop {
        // Drain the steering queue before anything is committed or
        // checked: each batch of pending messages becomes one
        // continuation run through the engine's own resume mechanism,
        // and messages that arrive during a continuation are picked
        // up by the next pass of this loop. "Done" below therefore
        // always describes a tree the operator has not since steered
        // away from.
        loop {
            // Peek, do not take: the batch leaves the persisted
            // queue only after the run that carries it, so a server
            // crash mid-delivery cannot lose the operator's words —
            // after a restart the messages are still queued and the
            // resumed pass delivers them.
            let msgs = self.peek_steer(id);
            if msgs.is_empty() {
                break;
            }
            for m in &msgs {
                self.log(id, format!("you: {m}"));
            }
            self.log(
                id,
                "steering: handing your message to the agent before the check runs".to_string(),
            );
            match self.run_one(id, session, wt, &msgs.join("\n\n"), true) {
                // The process never started, so the batch was never
                // delivered: it stays queued for the next pass.
                AgentRun::NotStarted => return,
                outcome => {
                    self.drop_steer(id, msgs.len());
                    if outcome != AgentRun::Clean {
                        return;
                    }
                }
            }
        }
        self.log(
            id,
            "agent claims completion — committing its work, then running the check on the committed tree"
                .to_string(),
        );
        self.set_status(id, Status::Checking);

        // 3. Commit FIRST, so the check's verdict describes the exact
        // tree a merge would land. A pre-commit hook that rewrites
        // files during the commit changes that tree — the check must
        // judge the tree as committed, not the one the agent left.
        self.clear_stale_index_lock(id, wt);
        Self::clear_index_bits(wt);
        let _ = Command::new("git").arg("-C").arg(wt).args(["add", "-A"]).output();
        // Files the agent produced that this repo gitignores are not in
        // the commit and can never be merged — surface them, by name.
        let new_ignored: Vec<String> = Self::ignored_files(wt)
            .into_iter()
            .filter(|p| !ignored_baseline.contains(p))
            .collect();
        let commit = Command::new("git")
            .arg("-C")
            .arg(wt)
            .args(["-c", "user.email=fleet@localhost", "-c", "user.name=fleet-rs"])
            .args(["commit", "--allow-empty", "-m", &format!("fleet session {}: {}", id, session.task)])
            .output();
        let mut commit_error = match &commit {
            Ok(o) if o.status.success() => None,
            Ok(o) => Some(
                String::from_utf8_lossy(&o.stderr)
                    .lines()
                    .next()
                    .unwrap_or("git commit failed")
                    .trim()
                    .to_string(),
            ),
            Err(e) => Some(format!("could not run git commit: {e}")),
        };
        // If the commit still hit a lock (one that appeared during
        // the run), clear it if stale and retry the commit once —
        // re-running the add first, since the add may have been the
        // lock's first casualty.
        if commit_error
            .as_deref()
            .is_some_and(|e| e.contains("index.lock"))
            && self.clear_stale_index_lock(id, wt)
        {
            let _ = Command::new("git").arg("-C").arg(wt).args(["add", "-A"]).output();
            let retry = Command::new("git")
                .arg("-C")
                .arg(wt)
                .args(["-c", "user.email=fleet@localhost", "-c", "user.name=fleet-rs"])
                .args(["commit", "--allow-empty", "-m", &format!("fleet session {}: {}", id, session.task)])
                .output();
            commit_error = match &retry {
                Ok(o) if o.status.success() => None,
                Ok(o) => Some(
                    String::from_utf8_lossy(&o.stderr)
                        .lines()
                        .next()
                        .unwrap_or("git commit failed")
                        .trim()
                        .to_string(),
                ),
                Err(e) => Some(format!("could not run git commit: {e}")),
            };
        }
        // The commit the check is about to verify — the merge will
        // consume exactly this commit, never the branch's later tip.
        let tip = Command::new("git")
            .arg("-C")
            .arg(wt)
            .args(["rev-parse", "HEAD"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

        // The commit must HOLD the work: if the worktree still
        // differs from the committed tree (index bits the clearing
        // missed, a writer racing the commit), the check would be
        // judging state a merge cannot land.
        let dirty_after_commit: Vec<String> = Command::new("git")
            .arg("-C")
            .arg(wt)
            .args(["status", "--porcelain"])
            .output()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .map(|l| l.to_string())
                    .filter(|l| !l.trim().is_empty())
                    .collect()
            })
            .unwrap_or_default();

        // 4. Verified done: the app runs the task's check itself, on
        // the committed tree (the worktree now matches the commit).
        self.set_status(id, Status::Checking);
        self.events.publish(
            "check_progress",
            &serde_json::json!({
                "id": id,
                "phase": "started",
                "check_cmd": session.check_cmd,
            }),
        );
        let timeout = self.policy.timeout_for(
            &session.repo,
            &session.task,
            engine_kind(&session.agent).label(),
        );
        // The check judges the pinned commit, literally: it runs in
        // a pristine checkout of that commit (a throwaway worktree),
        // never in the session's mutable worktree. A check that
        // writes files — a formatter, a codegen step — then cannot
        // change the thing it is judging, and the tree it sees is
        // byte-for-byte the tree a merge would land.
        let verify_dir: Option<PathBuf> = match (&tip, &commit_error) {
            (Some(t), None) => {
                let dir = self
                    .data_dir
                    .join("verify")
                    .join(format!("{}-{}", id, std::process::id()));
                let _ = std::fs::create_dir_all(self.data_dir.join("verify"));
                let out = Command::new("git")
                    .arg("-C")
                    .arg(&session.repo)
                    .args(["worktree", "add", "--detach"])
                    .arg(&dir)
                    .arg(t)
                    .output();
                match out {
                    Ok(o) if o.status.success() => Some(dir),
                    _ => None,
                }
            }
            _ => None,
        };
        let pristine_failed =
            tip.is_some() && commit_error.is_none() && verify_dir.is_none();
        let check_dir: &Path = verify_dir.as_deref().unwrap_or(wt);
        let flag = self.stop_flag(id);
        let (
            check_ran,
            check_exit,
            passed,
            output,
            check_timed_out,
            check_pipes_held,
            check_stopped,
            check_receipt,
            pipeline_reason,
        ) = if pristine_failed {
            (
                false,
                None,
                false,
                "fleet could not create a pristine checkout of the verified commit to run the check in — the check was not run"
                    .to_string(),
                false,
                false,
                false,
                None,
                None,
            )
        } else {
            match CheckPipeline::resolve(&session.check_step_specs, &session.check_cmd, timeout) {
                Ok(pipeline) => {
                    let bus = self.events.clone();
                    let sid = id.to_string();
                    let mut on_step = |step_idx: usize, step: &CheckStepReceipt| {
                        bus.publish(
                            "check_progress",
                            &serde_json::json!({
                                "id": sid,
                                "session_id": sid,
                                "phase": "step",
                                "step_index": step_idx,
                                "step": step,
                            }),
                        );
                    };
                    let receipt =
                        pipeline.run_with_callback(check_dir, Some(&flag), &mut on_step);
                    (
                        receipt.ran,
                        receipt.exit_code,
                        receipt.passed,
                        receipt.combined_output.clone(),
                        receipt.timed_out,
                        receipt.pipes_held,
                        receipt.stopped,
                        Some(receipt.clone()),
                        receipt.summary_reason,
                    )
                }
                Err(e) => (
                    false,
                    None,
                    false,
                    format!("check could not run: {e}"),
                    false,
                    false,
                    false,
                    None,
                    Some(format!("check could not run: {e}")),
                ),
            }
        };
        self.sweep_detached(id, check_dir);
        if let Some(dir) = &verify_dir {
            let _ = Command::new("git")
                .arg("-C")
                .arg(&session.repo)
                .args(["worktree", "remove", "--force"])
                .arg(dir)
                .output();
            let _ = Command::new("git")
                .arg("-C")
                .arg(&session.repo)
                .args(["worktree", "prune"])
                .output();
        }

        // 5. The diff the operator reviews before merging must be
        // everything the merge will land: the branch's whole history
        // against the repo, not just this run's changes. A retried
        // session commits across runs; showing only the last run's
        // diff would misstate the merge.
        let diff = Command::new("git")
            .arg("-C")
            .arg(&session.repo)
            .arg("diff")
            .arg(format!("HEAD...{}", session.branch))
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        // Problems inside the session's own delta of the committed
        // tree: a nested repo (bare gitlink) or an escaping symlink
        // would make "merged" a lie no matter what the check said.
        let tree_problems = tip
            .as_deref()
            .map(|t| Self::tree_problems(&session.repo, t))
            .unwrap_or_default();
        // File-scope guardrails (`allowed_globs` / `forbidden_globs` from
        // session + Rune policy): verify committed changes stay inside scope
        // before this session can ever earn "done".
        let policy_scope = self.policy.file_scope_for(&session.repo, &session.task);
        let effective_scope = FileScope::new(
            session.allowed_globs.clone(),
            session.forbidden_globs.clone(),
        )
        .with_defaults(&policy_scope);
        let (scope_violations, scope_reason) = match (&tip, &commit_error) {
            (Some(t), None) if !effective_scope.is_unrestricted() => {
                match verify_git_scope(Path::new(&session.repo), "HEAD", t, &effective_scope) {
                    Ok(report) if !report.passed => (report.violations, report.needs_you_reason),
                    Ok(_) => (Vec::new(), None),
                    Err(e) => (
                        vec![ScopeViolation {
                            path: "*".to_string(),
                            reason: format!("could not verify file scope: {e}"),
                            matched_rule: None,
                        }],
                        Some(format!("File-scope guardrail could not verify changes: {e}")),
                    ),
                }
            }
            _ => (Vec::new(), None),
        };
        // The full check output goes to the session's log file before
        // the stored copy is capped — the cap must never lose it.
        self.append_log_text(id, &format!("--- check output ---\n{output}\n--- end check output ---"));
        let failed_reason = if !session.check_step_specs.is_empty() {
            pipeline_reason
                .clone()
                .unwrap_or_else(|| Self::check_failure_reason(&session.check_cmd, check_exit, &output))
        } else {
            Self::check_failure_reason(&session.check_cmd, check_exit, &output)
        };
        let failed_ctx_for_heal = if !passed {
            Some(
                check_receipt
                    .as_ref()
                    .and_then(|r| FailedCheckContext::from_pipeline_receipt(r, &session.check_cmd))
                    .unwrap_or_else(|| {
                        FailedCheckContext::from_legacy(&session.check_cmd, check_exit, &output)
                    }),
            )
        } else {
            None
        };
        let completed_heal_pass = active_heal_idx.is_some();
        let finished_heal_event = if let Some(h_idx) = active_heal_idx.take() {
            let elapsed_ms = active_heal_started
                .take()
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(0);
            let attempt_healed = passed
                && commit_error.is_none()
                && dirty_after_commit.is_empty()
                && tree_problems.is_empty()
                && new_ignored.is_empty()
                && scope_violations.is_empty()
                && !diff.trim().is_empty()
                && !self.stop_flag(id).load(std::sync::atomic::Ordering::Relaxed);
            let mut sessions = self.sessions.lock().unwrap();
            sessions
                .iter_mut()
                .find(|s| s.id == id)
                .and_then(|s| s.heal_attempts.get_mut(h_idx))
                .map(|a| {
                    a.elapsed_ms = elapsed_ms;
                    a.healed = attempt_healed;
                    a.clone()
                })
        } else {
            None
        };
        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(s) = sessions.iter_mut().find(|s| s.id == id) {
                s.check_output = Some(truncate_output(output.clone()));
                s.check_passed = Some(passed);
                s.check_ran = check_ran;
                s.check_exit = check_exit;
                s.check_receipt = check_receipt;
                s.scope_violations = scope_violations.clone();
                s.diff = truncate_output(diff.clone());
                // Provisional: every needs-you path below clears it.
                s.verified_commit = tip.clone();
            }
        }
        self.mark_dirty(id);
        self.events.publish(
            "check_progress",
            &serde_json::json!({
                "id": id,
                "session_id": id,
                "phase": "finished",
                "check_cmd": session.check_cmd,
                "check_passed": passed,
                "check_exit": check_exit,
                "output_tail": output.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or(""),
            }),
        );
        if let Some(ref finished_attempt) = finished_heal_event {
            self.events.publish(
                "auto_heal_attempt",
                &serde_json::json!({
                    "id": id,
                    "session_id": id,
                    "phase": "finished",
                    "attempt": finished_attempt,
                }),
            );
        }
        self.persist();

        // Autonomous Auto-Heal / Auto-Steer feedback loop:
        // Only heal clean check failures (never commit errors, gitignored outputs,
        // tree corruption, file-scope guardrail violations, or operator stops).
        let mut heal_stop_note: Option<String> = None;
        let healable_check_failure = commit_error.is_none()
            && dirty_after_commit.is_empty()
            && tree_problems.is_empty()
            && new_ignored.is_empty()
            && scope_violations.is_empty()
            && !passed
            && !pristine_failed
            && check_ran
            && !check_pipes_held
            && !check_stopped;
        if healable_check_failure {
            if let Some(ref failed_ctx) = failed_ctx_for_heal {
                let (prev_attempts, budget) = {
                    let sessions = self.sessions.lock().unwrap();
                    sessions
                        .iter()
                        .find(|s| s.id == id)
                        .map(|s| (s.heal_attempts.clone(), s.auto_steer_budget))
                        .unwrap_or_else(|| (Vec::new(), 0))
                };
                let stop_requested = self.stop_flag(id).load(std::sync::atomic::Ordering::Relaxed);
                match evaluate_auto_heal(
                    prev_attempts.len() as u32,
                    budget,
                    stop_requested,
                    &prev_attempts,
                    failed_ctx,
                ) {
                    HealDecision::Proceed { next_attempt, .. } => {
                        let effective_budget = budget.min(MAX_AUTO_HEAL_BUDGET);
                        let heal_ctx = HealSessionContext {
                            session_id: id.to_string(),
                            task: session.task.clone(),
                            repo: session.repo.clone(),
                            branch: session.branch.clone(),
                            allowed_globs: effective_scope.allowed_globs.clone(),
                            forbidden_globs: effective_scope.forbidden_globs.clone(),
                            attempt: next_attempt,
                            budget: effective_budget,
                        };
                        let heal_prompt = build_heal_prompt(&heal_ctx, failed_ctx);
                        let trigger_step = if failed_ctx.step_name.trim().is_empty() {
                            "check".to_string()
                        } else {
                            failed_ctx.step_name.clone()
                        };
                        let attempt_record = HealAttempt {
                            attempt: next_attempt,
                            trigger_step: trigger_step.clone(),
                            exit_code: failed_ctx.exit_code,
                            stderr_tail: failed_ctx.diagnostic_tail(),
                            prompt_sent: heal_prompt.clone(),
                            started_ms: HealAttempt::now_ms(),
                            elapsed_ms: 0,
                            healed: false,
                        };
                        let pushed_idx = {
                            let mut sessions = self.sessions.lock().unwrap();
                            sessions.iter_mut().find(|s| s.id == id).map(|s| {
                                s.verified_commit = None;
                                s.heal_attempts.push(attempt_record.clone());
                                s.heal_attempts.len() - 1
                            })
                        };
                        self.mark_dirty(id);
                        self.persist();
                        self.log(
                            id,
                            format!(
                                "auto-heal {next_attempt}/{effective_budget}: check step '{trigger_step}' failed — sending diagnostic steering to the agent"
                            ),
                        );
                        self.events.publish(
                            "auto_heal_attempt",
                            &serde_json::json!({
                                "id": id,
                                "session_id": id,
                                "phase": "started",
                                "attempt": attempt_record,
                            }),
                        );
                        self.set_status(id, Status::Working);
                        let heal_started = std::time::Instant::now();
                        let outcome = self.run_one(id, session, wt, &heal_prompt, true);
                        if outcome != AgentRun::Clean {
                            if let Some(h_idx) = pushed_idx {
                                let finished = {
                                    let mut sessions = self.sessions.lock().unwrap();
                                    sessions
                                        .iter_mut()
                                        .find(|s| s.id == id)
                                        .and_then(|s| s.heal_attempts.get_mut(h_idx))
                                        .map(|a| {
                                            a.elapsed_ms =
                                                heal_started.elapsed().as_millis() as u64;
                                            a.healed = false;
                                            a.clone()
                                        })
                                };
                                if let Some(a) = finished {
                                    self.mark_dirty(id);
                                    self.persist();
                                    self.events.publish(
                                        "auto_heal_attempt",
                                        &serde_json::json!({
                                            "id": id,
                                            "session_id": id,
                                            "phase": "finished",
                                            "attempt": a,
                                        }),
                                    );
                                }
                            }
                            return;
                        }
                        active_heal_idx = pushed_idx;
                        active_heal_started = Some(heal_started);
                        continue;
                    }
                    HealDecision::Stop { reason, message } => {
                        if matches!(
                            reason,
                            HealStopReason::BudgetExhausted | HealStopReason::IdenticalErrorLoop
                        ) {
                            self.log(id, message.clone());
                            heal_stop_note = Some(message);
                        }
                    }
                }
            }
        }

        if let Some(err) = commit_error {
            // The work cannot land at all (a failing pre-commit hook is
            // the usual cause) — never let it be called done.
            self.log(id, format!("commit failed: {err}"));
            self.set_needs_you(id, &format!("could not commit the session's work: {err}"));
        } else if !dirty_after_commit.is_empty() {
            let named = dirty_after_commit.join("; ");
            self.log(
                id,
                format!("the worktree still differs from the committed tree after committing: {named}"),
            );
            self.set_needs_you(
                id,
                &format!(
                    "the commit does not hold all the work — the worktree still differs from the committed tree: {named}"
                ),
            );
        } else if !tree_problems.is_empty() {
            let named = tree_problems.join("; ");
            self.log(id, format!("the committed tree cannot be merged as work: {named}"));
            self.set_needs_you(
                id,
                &format!("the committed tree cannot be merged as work: {named}"),
            );
        } else if !new_ignored.is_empty() {
            // The agent produced files this repo gitignores: they
            // are not in the commit, can never be merged, and the
            // check (judging the committed tree) could not see them.
            // Name them whichever way the check went — "check failed"
            // alone would bury the real problem.
            let named = new_ignored.join(", ");
            if passed {
                self.log(
                    id,
                    format!(
                        "check passed, but the agent produced files this repo gitignores — they cannot be committed or merged: {named}"
                    ),
                );
                self.set_needs_you(
                    id,
                    &format!(
                        "agent produced files this repo gitignores — they cannot be committed or merged: {named}"
                    ),
                );
            } else {
                self.log(
                    id,
                    format!(
                        "check failed, and the agent produced files this repo gitignores — they cannot be committed or merged: {named}"
                    ),
                );
                self.set_needs_you(
                    id,
                    &format!(
                        "check failed: {} — and the agent produced files this repo gitignores, which cannot be committed or merged and so were not in the tree the check judged: {named}",
                        session.check_cmd
                    ),
                );
            }
        } else if !scope_violations.is_empty() {
            let reason = scope_reason
                .unwrap_or_else(|| "File-scope guardrail blocked out-of-scope changes".to_string());
            self.log(id, reason.clone());
            self.set_needs_you(id, &reason);
        } else if passed && diff.trim().is_empty() {
            // The check passed on state the session did not change —
            // there is no work to verify or merge, and calling it
            // "verified done" would invent both.
            self.log(
                id,
                "check passed but the session produced no changes — nothing to verify or merge".to_string(),
            );
            self.set_needs_you(
                id,
                "the check passed but this session produced no changes in its worktree — nothing to verify or merge (the check may be passing on pre-existing state)",
            );
        } else if passed {
            // A stop pressed while the check ran or the gates were
            // computed was accepted but had nothing left to kill —
            // it still lands here, before Done: the operator said
            // stop, so the session needs them, not a merge button.
            if self.stop_flag(id).load(std::sync::atomic::Ordering::Relaxed) {
                self.log(
                    id,
                    "stopped by you — the stop landed before this session settled".to_string(),
                );
                self.set_needs_you(id, "stopped by you");
            } else if self.stop_flag(id).load(std::sync::atomic::Ordering::Relaxed) {
                // The last-moment re-read: a stop that landed
                // during the settle's final steps is honoured too.
                self.log(
                    id,
                    "stopped by you — the stop landed before this session settled".to_string(),
                );
                self.set_needs_you(id, "stopped by you");
            } else {
                // Publish first, then log: a stop that lands after
                // this point arrives after the settle and is
                // refused as a stop on a settled session.
                // (set_status itself is an unconditional write —
                // the residual no-CAS shape is named in the ledger.)
                self.set_status(id, Status::Done);
                if completed_heal_pass {
                    self.log(
                        id,
                        "check passed — auto-healed and verified done".to_string(),
                    );
                } else {
                    self.log(id, "check passed — verified done".to_string());
                }
            }
        } else if check_pipes_held {
            self.log(
                id,
                "check's output stayed open past the limit — this needs you".to_string(),
            );
            self.set_needs_you(
                id,
                &format!(
                    "check did not finish cleanly — a detached process kept its output open past the limit: {}",
                    session.check_cmd
                ),
            );
        } else if check_timed_out {
            self.log(
                id,
                format!("check TIMED OUT after {timeout}s — this needs you"),
            );
            let base = format!("check timed out after {timeout}s: {}", session.check_cmd);
            let reason = match heal_stop_note {
                Some(note) => format!("{base} — {note}"),
                None => base,
            };
            self.set_needs_you(id, &reason);
        } else if check_stopped {
            self.log(id, "check stopped by you — this needs you".to_string());
            self.set_needs_you(id, "stopped by you while the check was running");
        } else {
            self.log(id, "check FAILED — this needs you".to_string());
            let base = if check_ran {
                failed_reason
            } else {
                format!("the check did not run: {}", session.check_cmd)
            };
            let reason = match heal_stop_note {
                Some(note) => format!("{base} — {note}"),
                None => base,
            };
            self.set_needs_you(id, &reason);
        }
        break;
        }
        // Steering that arrived while the check ran must not be
        // stranded on a settled session. If the session finished
        // verified-done with messages still pending, reopen it: the
        // messages are delivered on the next pass and the work is
        // re-verified before it can be merged. (On a needs-you
        // settle the messages simply wait — the operator's next
        // steer or retry runs them.) A clean verified finish with
        // nothing pending pulls the next item of the chain, if the
        // hand-out named one.
        if self.status_of(id).as_deref() == Some("done") {
            if self.steer_pending(id) {
                self.log(
                    id,
                    "your steering arrived while the check ran — reopening so it is delivered and the work re-checked"
                        .to_string(),
                );
                self.requeue(id);
            } else {
                self.fire_successor(id);
            }
        }
        self.pump_queue();
    }

    /// Is this worktree still linked to a repository git can read?
    fn worktree_attached(wt: &Path) -> bool {
        // The worktree's own link file must exist; without it git would
        // walk up to an enclosing repository and wrongly report success.
        wt.join(".git").exists()
            && Command::new("git")
                .arg("-C")
                .arg(wt)
                .args(["rev-parse", "--git-dir"])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
    }

    fn branch_exists(&self, repo: &str, branch: &str) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["rev-parse", "--verify", &format!("refs/heads/{branch}")])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// The ignored files in a worktree, enumerated by CONTENT:
    /// ls-files lists the files inside ignored directories, where
    /// `git status --ignored` collapses a whole directory to a single
    /// `!! build/` line. An agent's work product that the repo
    /// gitignores can never be committed or merged — the app must
    /// notice, or "done" would be invented.
    fn ignored_files(wt: &Path) -> Vec<String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(wt)
            .args(["ls-files", "--others", "--ignored", "--exclude-standard"])
            .output();
        match out {
            Ok(o) => String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// The ignored-files baseline for one run: the ignored files
    /// already in the worktree when the agent starts. Only files a run
    /// ADDS to that set are the run's own — an earlier run's ignored
    /// leftovers must not block this run forever.
    fn ignored_baseline(&self, _id: &str, wt: &Path) -> std::collections::HashSet<String> {
        Self::ignored_files(wt).into_iter().collect()
    }

    /// Problems in the session's own delta that would make
    /// "merged" a lie: a nested git repository commits as a bare
    /// gitlink (its content never enters this repo), and a symlink
    /// whose target is absolute or escapes the repo lands as a
    /// pointer to somewhere else. Only paths this branch changed
    /// against the repo HEAD it diverged from are gated — a problem
    /// the repo already had (a pre-existing submodule) is not this
    /// session's doing and must not block its work forever. All git
    /// output is read NUL-separated: the default quoting of
    /// non-ASCII paths would otherwise hand the gate a literal
    /// quoted string that matches nothing, and the path would slip
    /// through ungated.
    fn tree_problems(repo: &str, commit: &str) -> Vec<String> {
        let mut problems = Vec::new();
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["diff", "--name-status", "-z", &format!("HEAD...{commit}")])
            .output();
        let Ok(o) = out else { return problems };
        if !o.status.success() {
            return problems;
        }
        let fields: Vec<&[u8]> = o
            .stdout
            .split(|b| *b == 0)
            .filter(|f| !f.is_empty())
            .collect();
        let mut i = 0;
        while i < fields.len() {
            let status = fields[i].first().copied().unwrap_or(b'?');
            // Renames and copies carry two paths; the new one gates.
            let npaths = if status == b'R' || status == b'C' { 2 } else { 1 };
            if i + npaths > fields.len() - 1 {
                break;
            }
            let path_bytes = fields[i + npaths];
            i += 1 + npaths;
            let path = String::from_utf8_lossy(path_bytes).to_string();
            let mut lst = Command::new("git");
            lst.arg("-C").arg(repo).args(["ls-tree", "-z", commit, "--"]);
            lst.arg(std::ffi::OsStr::from_bytes(path_bytes));
            let mode = lst
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| {
                    o.stdout
                        .split(|b| *b == b' ')
                        .next()
                        .map(|m| String::from_utf8_lossy(m).to_string())
                })
                .unwrap_or_default();
            if mode == "160000" && status == b'A' {
                problems.push(format!(
                    "{path} is a nested git repository — it commits as a bare pointer and its content never enters this repo"
                ));
            } else if mode == "120000" {
                let mut rev: Vec<u8> = Vec::new();
                rev.extend_from_slice(commit.as_bytes());
                rev.push(b':');
                rev.extend_from_slice(path_bytes);
                let target = Command::new("git")
                    .arg("-C")
                    .arg(repo)
                    .arg("cat-file")
                    .arg("-p")
                    .arg(std::ffi::OsStr::from_bytes(&rev))
                    .output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                    .unwrap_or_default();
                if symlink_escapes(&path, &target) {
                    problems.push(format!(
                        "{path} is a symlink to '{target}', outside this repo — merging it would land a pointer, not the work"
                    ));
                }
            }
        }
        problems
    }

    /// The prompt a retried session's agent receives: the original task,
/// then a delimited note with what failed last time — the check's
/// command and the tail of its output, or the previous reason when the
/// check printed nothing.
fn retry_prompt_text(
    task: &str,
    check_cmd: &str,
    check_output: Option<&str>,
    reason: Option<&str>,
) -> String {
    let note = match check_output.filter(|o| !o.trim().is_empty()) {
        Some(out) => {
            let n = out.chars().count();
            let tail: String = out.chars().skip(n.saturating_sub(4000)).collect();
            format!("Check command: {check_cmd}\nLast output of the check (up to 4000 characters):\n{tail}")
        }
        None => format!(
            "Previous reason: {}",
            reason.unwrap_or("the previous attempt did not finish")
        ),
    };
    format!("{task}\n\n--- retry: the previous attempt did not pass ---\n{note}\n--- end of retry note ---")
}

    /// The reason a failed check gives: its command, its exit code and
    /// the head of its output, or that it printed nothing.
    fn check_failure_reason(cmd: &str, exit: Option<i32>, output: &str) -> String {
        let code = match exit {
            Some(c) => format!("exit {c}"),
            None => "no exit code".to_string(),
        };
        let head: String = output.trim().chars().take(200).collect();
        if head.is_empty() {
            format!("Check failed ({code}): {cmd}. The check printed nothing.")
        } else {
            format!("Check failed ({code}): {cmd}. Output: {head}")
        }
    }

    /// Hand a needs-you session back to its agent: the check state is
    /// cleared and the session re-queues; its worktree (with the agent's
    /// earlier work in it) is reused by run_session.
    fn retry(self: &Arc<Self>, id: &str) -> Result<(), String> {
        {
            let mut sessions = self.sessions.lock().unwrap();
            let s = sessions
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or("no such session")?;
            if matches!(s.status.as_str(), "queued" | "blocked" | "working" | "checking") {
                return Err(format!(
                    "this session is already running ({}) — there is nothing to retry",
                    s.status
                ));
            }
            if s.status != "needs-you" {
                return Err(format!(
                    "session is '{}' — only a needs-you session can be retried",
                    s.status
                ));
            }
            if s.repo.is_empty() {
                return Err(
                    "this session was recovered from its log after the session store was lost — it is a record, not a runnable session; its repo and check settings are gone"
                        .to_string(),
                );
            }
            s.merge_error = None;
            s.retry_prompt = Some(Self::retry_prompt_text(
                &s.task,
                &s.check_cmd,
                s.check_output.as_deref(),
                s.reason.as_deref(),
            ));
            // Claim the session in the same step as the status check, so
            // a second Retry finds it queued and is refused. The stop
            // flag is cleared before the queued status is visible, as
            // requeue does.
            self.stop_flag(id)
                .store(false, std::sync::atomic::Ordering::Relaxed);
            s.check_output = None;
            s.check_passed = None;
            s.check_ran = false;
            s.check_exit = None;
            s.check_receipt = None;
            s.scope_violations.clear();
            s.heal_attempts.clear();
            s.reason = None;
            s.diff = String::new();
            s.verified_commit = None;
            let initial = if s.depends_on.is_empty() {
                Status::Queued
            } else {
                Status::Blocked
            };
            s.status = initial.label().to_string();
            s.bucket = initial.bucket().to_string();
        }
        self.mark_dirty(id);
        self.log(id, "retry: handed back to the agent".to_string());
        self.persist();
        self.emit_queue_depth();
        self.pump_queue();
        Ok(())
    }

    /// Put a settled session back in the queue with its check state
    /// cleared; its worktree (with the agent's earlier work in it) is
    /// reused by the next pass. Shared by retry (from needs-you) and
    /// by steering (which reopens even a verified-done session — its
    /// verified-commit pin is cleared here, so nothing unverified
    /// can ever be merged off a reopened session).
    fn requeue(self: &Arc<Self>, id: &str) {
        // A new lifecycle starts here: clear the stop flag BEFORE
        // the queued status is published, so a pump that claims the
        // session the moment it appears can never meet the previous
        // run's stale flag. (A stop cannot be accepted while the
        // session sits in needs-you, so nothing is lost by clearing
        // first.)
        self.stop_flag(id)
            .store(false, std::sync::atomic::Ordering::Relaxed);
        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(s) = sessions.iter_mut().find(|s| s.id == id) {
                s.check_output = None;
                s.check_passed = None;
                s.check_ran = false;
                s.check_exit = None;
                s.check_receipt = None;
                s.scope_violations.clear();
                s.heal_attempts.clear();
                s.reason = None;
                s.diff = String::new();
                s.verified_commit = None;
                let initial = if s.depends_on.is_empty() {
                    Status::Queued
                } else {
                    Status::Blocked
                };
                s.status = initial.label().to_string();
                s.bucket = initial.bucket().to_string();
            }
        }
        self.mark_dirty(id);
        self.persist();
        self.emit_queue_depth();
        self.pump_queue();
    }

    /// Hand out the next item of a finished session's successor
    /// chain. Called ONLY on a verified-done settle — failed or
    /// unfinished work never cascades. The successor inherits the
    /// repo, project, agent and the resolved check command, and
    /// carries the rest of the chain with it.
    fn fire_successor(self: &Arc<Self>, id: &str) {
        let n = {
            let mut counter = self.counter.lock().unwrap();
            *counter += 1;
            *counter
        };
        let new_id = format!("s{}-{n}", self.run_tag);
        let built = {
            let mut sessions = self.sessions.lock().unwrap();
            let Some(parent) = sessions.iter_mut().find(|s| s.id == id) else {
                return;
            };
            // Re-verify the precondition inside the lock: a steer
            // that landed after the settle's own status read has
            // already reopened this session — a chain must never
            // fire for work that is being re-verified, nor while
            // steering is still waiting to be delivered. The chain
            // fires when the reopened session settles verified done
            // with its steering delivered.
            if parent.status != "done"
                || parent.next_queue.is_empty()
                || !parent.steer.is_empty()
            {
                return;
            }
            let task = parent.next_queue.remove(0);
            let rest = std::mem::take(&mut parent.next_queue);
            parent.successor = Some(new_id.clone());
            let child = Session {
                id: new_id.clone(),
                task: task.clone(),
                project: parent.project.clone(),
                repo: parent.repo.clone(),
                branch: format!("fleet/{new_id}"),
                worktree: self
                    .data_dir
                    .join("worktrees")
                    .join(&new_id)
                    .to_string_lossy()
                    .to_string(),
                status: Status::Queued.label().to_string(),
                bucket: Status::Queued.bucket().to_string(),
                agent: parent.agent.clone(),
                model: parent.model.clone(),
                check_cmd: parent.check_cmd.clone(),
                check_output: None,
                check_passed: None,
                diff: String::new(),
                reason: None,
                verified_commit: None,
                steer: Vec::new(),
                next_queue: rest,
                spawned_from: Some(id.to_string()),
                successor: None,
                retry_prompt: None,
                check_ran: false,
                check_exit: None,
                merge_error: None,
                depends_on: Vec::new(),
                check_step_specs: parent.check_step_specs.clone(),
                check_receipt: None,
                allowed_globs: parent.allowed_globs.clone(),
                forbidden_globs: parent.forbidden_globs.clone(),
                scope_violations: Vec::new(),
                merge_strategy: None,
                auto_steer_budget: parent.auto_steer_budget,
                heal_attempts: Vec::new(),
                transcript_total: 0,
                transcript: Vec::new(),
            };
            sessions.push(child);
            task
        };
        self.mark_dirty(id);
        self.mark_dirty(&new_id);
        self.persist();
        self.log(
            id,
            format!(
                "verified done — the next item was handed out automatically: {built} (session {new_id})"
            ),
        );
        self.log(
            &new_id,
            format!("handed out automatically: session {id} finished verified done"),
        );
        // The successor joins the queue like any hand-out: pumping
        // in hand-out order gives sessions queued earlier first
        // claim on the freed slot — a chain never jumps the queue.
        self.pump_queue();
    }

    /// Record an operator steering message for a session. What
    /// happens next depends on where the session stands:
    /// - queued / working / checking: the message waits in the
    ///   queue; the runner delivers it as a continuation run before
    ///   anything is committed or checked (or, if it lands after the
    ///   check on a done settle, by reopening the session).
    /// - needs-you: the message is queued AND the session is retried
    ///   — the resumed pass delivers pending steering first.
    /// - done: the session is reopened (pin cleared) so the message
    ///   is delivered and the work re-verified.
    /// - merged: refused — the work already landed; steer new work.
    fn steer(self: &Arc<Self>, id: &str, message: &str) -> Result<(), String> {
        let status = {
            let mut sessions = self.sessions.lock().unwrap();
            let s = sessions
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or("no such session")?;
            if s.status == "archived" {
                return Err(
                    "this session was dismissed — hand out new work instead of steering it"
                        .to_string(),
                );
            }
            if s.status == "merged" {
                return Err(
                    "this session's work is already merged — hand out new work instead of steering it"
                        .to_string(),
                );
            }
            if s.repo.is_empty() {
                return Err(
                    "this session was recovered from its log after the session store was lost — it is a record, not a runnable session"
                        .to_string(),
                );
            }
            if s.steer.len() >= 10 {
                return Err(
                    "ten steering messages are already waiting for this session — let the agent catch up before sending more"
                        .to_string(),
                );
            }
            s.steer.push(message.to_string());
            s.status.clone()
        };
        self.mark_dirty(id);
        self.persist();
        match status.as_str() {
            "needs-you" => {
                self.log(id, "steering a waiting session — retrying it with your message".to_string());
                self.requeue(id);
            }
            "done" => {
                self.log(
                    id,
                    "your steering reopens this finished session — the work will be re-checked before it can be merged"
                        .to_string(),
                );
                self.requeue(id);
            }
            _ => {}
        }
        Ok(())
    }

    /// Clear a needs-you session the operator has decided not to
    /// pursue. It leaves the board and the inbox; its record and log
    /// stay on disk. Only a needs-you session can be dismissed.
    fn dismiss(self: &Arc<Self>, id: &str) -> Result<(), String> {
        {
            let mut sessions = self.sessions.lock().unwrap();
            let s = sessions
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or("no such session")?;
            if s.status != "needs-you" {
                return Err(format!(
                    "session is '{}' — only a needs-you session can be dismissed",
                    s.status
                ));
            }
            s.status = Status::Archived.label().to_string();
            s.bucket = Status::Archived.bucket().to_string();
        }
        self.log(id, "dismissed by you — it left the board and the inbox; this log stays on disk".to_string());
        self.mark_dirty(id);
        self.persist();
        self.emit_queue_depth();
        self.pump_queue();
        Ok(())
    }

    /// Stop a session at the operator's word. A live run (agent or
    /// check) is killed through its stop flag — the bounded runner
    /// kills the whole process group and lands the session in
    /// needs-you with "stopped by you" as the reason. A queued or
    /// blocked session is cancelled before it ever starts. A settled
    /// session cannot be stopped; the refusal names its status.
    fn stop(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let status = self.status_of(id).ok_or("no such session")?;
        match status.as_str() {
            "queued" | "blocked" => {
                self.log(id, "stopped by you while queued — it never started".to_string());
                self.set_needs_you(id, "cancelled by you before it started");
                self.pump_queue();
                Ok(())
            }
            "working" | "checking" => {
                self.stop_flag(id)
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                self.log(id, "stop requested by you — killing the run".to_string());
                Ok(())
            }
            other => Err(format!(
                "session is '{other}' — only a queued, blocked, working or checking session can be stopped"
            )),
        }
    }

    fn merge_with_strategy(
        &self,
        id: &str,
        strategy: MergeStrategy,
    ) -> Result<(String, String, String, MergeStrategy), MergeError> {
        let mut detail = String::new();
        let result = self
            .merge_landing(id, strategy, &mut detail)
            .map_err(|message| MergeError {
                status: if message == "no such session" { 404 } else { 409 },
                message,
                detail: (!detail.is_empty()).then_some(detail),
            });
        // The last refusal stays on the session until a merge lands.
        let refusal = result.as_ref().err().map(|e| MergeRefusal {
            message: e.message.clone(),
            detail: e.detail.clone(),
            ts: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        });
        self.set_merge_error(id, refusal);
        result
    }

    fn set_merge_error(&self, id: &str, refusal: Option<MergeRefusal>) {
        let found = {
            let mut sessions = self.sessions.lock().unwrap();
            match sessions.iter_mut().find(|s| s.id == id) {
                Some(s) => {
                    s.merge_error = refusal;
                    true
                }
                None => false,
            }
        };
        if found {
            self.mark_dirty(id);
            self.persist();
        }
    }

    /// The merge itself. A refusal carries a plain sentence; git's own
    /// text for a refusal git made is left in `detail`.
    fn merge_landing(
        &self,
        id: &str,
        strategy: MergeStrategy,
        detail: &mut String,
    ) -> Result<(String, String, String, MergeStrategy), String> {
        let session = {
            let sessions = self.sessions.lock().unwrap();
            sessions
                .iter()
                .find(|s| s.id == id)
                .cloned()
                .ok_or("no such session")?
        };
        if session.status != "done" {
            return Err(format!(
                "session is '{}' — only a verified-done session can be merged",
                session.status
            ));
        }
        // The merge consumes the exact commit the check verified —
        // never the branch's later tip, which may carry work nobody
        // checked.
        let Some(pin) = session.verified_commit.clone() else {
            return Err(
                "this session has no verified commit recorded — retry it so its work is verified before merging"
                    .to_string(),
            );
        };
        if !self.branch_exists(&session.repo, &session.branch) {
            // The verified work itself is gone; "done" no longer
            // describes anything real. Move the session back to
            // Needs you so it can be retried, and say what happened.
            self.set_needs_you(
                id,
                "the session's branch no longer exists — the verified work is gone; retry to run it again",
            );
            return Err(
                "the session's branch no longer exists — the session was moved to Needs you; retry it to re-run the work"
                    .to_string(),
            );
        }
        let outcome = match execute_merge(Path::new(&session.repo), &pin, id, strategy) {
            Ok(o) => o,
            Err(e) => {
                if let Some(d) = e.detail {
                    *detail = d;
                }
                return Err(e.message);
            }
        };
        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(s) = sessions.iter_mut().find(|s| s.id == id) {
                s.merge_strategy = Some(strategy);
            }
        }
        self.set_status(id, Status::Merged);
        self.invalidate_merge_target_cache(&session.repo);
        self.log(
            id,
            format!(
                "merged into {} at {} ({})",
                outcome.target_branch,
                pin,
                strategy.label()
            ),
        );
        // Clean up the session's isolated worktree once its verified commit
        // has landed on the target branch (strictly inside Fleet's worktrees dir).
        if !session.worktree.is_empty() {
            let wt_path = Path::new(&session.worktree);
            let wt_root = self.data_dir.join("worktrees");
            if wt_path.starts_with(&wt_root) && wt_path.exists() {
                let _ = Command::new("git")
                    .arg("-C")
                    .arg(&session.repo)
                    .args(["worktree", "remove", "--force"])
                    .arg(wt_path)
                    .output();
                if wt_path.exists() {
                    let _ = std::fs::remove_dir_all(wt_path);
                }
                let _ = Command::new("git")
                    .arg("-C")
                    .arg(&session.repo)
                    .args(["worktree", "prune"])
                    .output();
                self.log(
                    id,
                    format!("removed merged worktree {}", wt_path.display()),
                );
            }
        }
        let reported_commit = match strategy {
            MergeStrategy::Squash => outcome.landed_commit.clone(),
            _ => pin,
        };
        Ok((
            reported_commit,
            outcome.target_branch,
            outcome.landed_commit,
            strategy,
        ))
    }
}

// ---------------------------------------------------------------------------
// HTTP layer (std-only, one request per connection)
// ---------------------------------------------------------------------------

/// A refused merge: the HTTP status, the plain message for the
/// operator, and git's own text when git made the refusal.
struct MergeError {
    status: u16,
    message: String,
    detail: Option<String>,
}

fn json_response(status: u16, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn html_response(body: &str) -> String {
    format!(
        "HTTP/1.1 200\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

/// The whole request — headers and body together — gets one
/// deadline. A per-read timeout alone is defeated by a client that
/// dribbles a byte at a time under it, parking its handler thread
/// forever.
const READ_DEADLINE_SECS: u64 = 30;

#[cfg(test)]
fn read_request(
    stream: &mut std::net::TcpStream,
) -> Option<(String, String, String, String, String, String)> {
    let (m, p, b, ct, o, h, _) = read_request_full(stream)?;
    Some((m, p, b, ct, o, h))
}

#[allow(clippy::type_complexity)]
fn read_request_full(
    stream: &mut std::net::TcpStream,
) -> Option<(String, String, String, String, String, String, Option<u64>)> {
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(READ_DEADLINE_SECS);
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let arm = |stream: &std::net::TcpStream| -> Option<()> {
        let remaining = deadline.checked_duration_since(std::time::Instant::now())?;
        let t = remaining.min(std::time::Duration::from_secs(READ_TIMEOUT_SECS));
        stream.set_read_timeout(Some(t)).ok()?;
        Some(())
    };
    let read_line_by_byte =
        |reader: &mut BufReader<std::net::TcpStream>,
         stream: &std::net::TcpStream|
         -> Option<String> {
            let mut line = String::new();
            loop {
                arm(stream)?;
                let mut b = [0u8; 1];
                let n = reader.read(&mut b).ok()?;
                if n == 0 {
                    return if line.is_empty() { None } else { Some(line) };
                }
                line.push(b[0] as char);
                if b[0] == b'\n' || line.len() > 16384 {
                    return Some(line);
                }
            }
        };
    let request_line = read_line_by_byte(&mut reader, stream)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut content_length = 0usize;
    let mut content_type = String::new();
    let mut origin = String::new();
    let mut host = String::new();
    let mut last_event_id: Option<u64> = None;
    let mut header_count = 0usize;
    let mut header_bytes = 0usize;
    loop {
        let line = read_line_by_byte(&mut reader, stream)?;
        if line == "\r\n" || line.is_empty() {
            break;
        }
        header_count += 1;
        header_bytes += line.len();
        if header_count > MAX_HEADERS || header_bytes > MAX_HEADER_BYTES {
            return Some((
                "__headers_too_large__".to_string(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                None,
            ));
        }
        let lower = line.to_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            content_length = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = lower.strip_prefix("content-type:") {
            content_type = v.trim().to_string();
        } else if let Some(v) = lower.strip_prefix("origin:") {
            origin = v.trim().to_string();
        } else if let Some(v) = lower.strip_prefix("host:") {
            host = v.trim().to_string();
        } else if let Some(v) = lower.strip_prefix("last-event-id:") {
            last_event_id = v.trim().parse::<u64>().ok();
        }
    }
    if content_length > MAX_BODY_BYTES {
        return Some((
            "__too_large__".to_string(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            host,
            None,
        ));
    }
    let mut body: Vec<u8> = Vec::with_capacity(content_length);
    if content_length > 0 {
        let mut chunk = [0u8; 8192];
        while body.len() < content_length {
            arm(stream)?;
            let want = (content_length - body.len()).min(chunk.len());
            match reader.read(&mut chunk[..want]) {
                Ok(0) => return None,
                Ok(n) => body.extend_from_slice(&chunk[..n]),
                Err(_) => return None,
            }
        }
    }
    Some((
        method,
        path,
        String::from_utf8_lossy(&body).to_string(),
        content_type,
        origin,
        host,
        last_event_id,
    ))
}

fn url_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
            out.push(b'%');
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for pair in query.split('&').filter(|s| !s.is_empty()) {
        if let Some((k, v)) = pair.split_once('=') {
            map.insert(url_decode(k), url_decode(v));
        } else {
            map.insert(url_decode(pair), String::new());
        }
    }
    map
}

/// Serve a long-lived Server-Sent Events stream (`GET /api/events/stream`).
fn serve_sse(
    app: &Arc<App>,
    stream: &mut std::net::TcpStream,
    last_event_id: Option<u64>,
) {
    let _ = stream.set_read_timeout(None);
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(10)));
    let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nX-Accel-Buffering: no\r\n\r\n";
    if stream.write_all(headers.as_bytes()).is_err() {
        return;
    }
    let (sub, replay) = app.events.subscribe(last_event_id);
    let (active, queued, total) = app.queue_counts();
    let hello = format!(
        "event: connected\ndata: {}\n\n",
        serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "active": active,
            "queued": queued,
            "total": total,
            "max_parallel": app.effective_max_parallel(),
        })
    );
    if stream.write_all(hello.as_bytes()).is_err() || stream.flush().is_err() {
        app.events.unsubscribe(sub.id);
        return;
    }
    for frame in replay {
        if stream.write_all(frame.as_bytes()).is_err() || stream.flush().is_err() {
            app.events.unsubscribe(sub.id);
            return;
        }
    }
    loop {
        match sub.rx.recv_timeout(std::time::Duration::from_secs(15)) {
            Ok(frame) => {
                if stream.write_all(frame.as_bytes()).is_err() || stream.flush().is_err() {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if stream.write_all(b": keepalive\n\n").is_err() || stream.flush().is_err() {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    app.events.unsubscribe(sub.id);
}

/// An Origin is acceptable only when it names this machine: the
/// board's own page (127.0.0.1 / localhost / ::1). Any other web
/// origin is a drive-by — a page the operator happens to have open
/// must not be able to hand out work to a command-executing server.
fn origin_is_local(origin: &str) -> bool {
    let host = origin
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split([':', '/'])
        .next()
        .unwrap_or("");
    matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1")
}

/// Is a Host header one this server answers to? Its hostname (port
/// ignored, case ignored) must be a loopback name, or listed in the
/// comma-separated FLEET_ALLOWED_HOSTS. Anything else is a name a
/// browser was pointed at by someone other than the operator.
fn host_allowed(host: &str, extra: &str) -> bool {
    let name = match host.strip_prefix('[') {
        Some(rest) => format!("[{}]", rest.split(']').next().unwrap_or("")),
        None => host.split(':').next().unwrap_or("").to_string(),
    }
    .to_lowercase();
    matches!(name.as_str(), "localhost" | "127.0.0.1" | "[::1]")
        || extra
            .split(',')
            .map(|h| h.trim().to_lowercase())
            .any(|h| !h.is_empty() && h == name)
}

/// Header limits: more header lines, or more header bytes, than these
/// is refused with 431 before any header is acted on.
const MAX_HEADERS: usize = 100;
const MAX_HEADER_BYTES: usize = 32 * 1024;

/// Largest request body the API accepts (hand-outs are small JSON).
const MAX_BODY_BYTES: usize = 1_048_576;
/// Largest task text a hand-out may carry, in bytes.
const MAX_TASK_BYTES: usize = 100_000;
/// How long a connection may take to deliver its request before the
/// handler drops it — a stalled request must not hold a thread forever.
const READ_TIMEOUT_SECS: u64 = 10;

/// Answers one request: the Host, body-size, content-type and origin rules
/// first, then the update routes, then the API.
#[allow(clippy::too_many_arguments)]
fn respond(
    app: &Arc<App>,
    allowed_hosts: &str,
    method: &str,
    path: &str,
    body: &str,
    content_type: &str,
    origin: &str,
    host: &str,
) -> String {
    if method == "__headers_too_large__" {
        error_response(431, "request headers are too large")
    } else if !host_allowed(host, allowed_hosts) {
        error_response(403, "this board answers only to its own host name")
    } else if method == "__too_large__" {
        error_response(413, "request body too large")
    } else if method == "POST" && !content_type.starts_with("application/json") {
        // A browser "simple request" (text/plain, no preflight) must never
        // reach a handler: requiring JSON is what makes a drive-by POST from
        // another site impossible.
        error_response(415, "POST requires Content-Type: application/json")
    } else if matches!(method, "POST" | "DELETE" | "PUT" | "PATCH")
        && !origin.is_empty()
        && !origin_is_local(origin)
    {
        error_response(403, "cross-origin requests are refused")
    } else {
        let route = path.split('?').next().unwrap_or("");
        update_route(app, method, route, body, host).unwrap_or_else(|| handle(app, method, path, body))
    }
}

/// Validate a model identifier submitted via config or session hand-out.
fn validate_model_field(raw: &str) -> Result<Option<String>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > 200 || trimmed.contains('\0') || trimmed.contains('\n') || trimmed.contains('\r') {
        return Err("model name must be a single line of at most 200 characters".to_string());
    }
    Ok(Some(trimmed.to_string()))
}

/// Loopback-guarded routes: version, self-update, local repo discovery, and
/// live engine/model configuration. A name from FLEET_ALLOWED_HOSTS does not
/// count for machine-local mutation or filesystem discovery — only loopback does.
fn update_route(app: &Arc<App>, method: &str, route: &str, body: &str, host: &str) -> Option<String> {
    Some(match (method, route) {
        ("GET", "/api/version") => json_response(
            200,
            &serde_json::json!({"name": "fleet-rs", "version": env!("CARGO_PKG_VERSION")}).to_string(),
        ),
        ("GET", "/api/repos") => {
            if !host_allowed(host, "") {
                return Some(error_response(
                    403,
                    "repo discovery is only allowed from this machine, not through a shared address",
                ));
            }
            let repos = app.discover_repos();
            json_response(200, &serde_json::json!(repos).to_string())
        }
        ("POST", "/api/repos/prune-worktrees") => {
            if !host_allowed(host, "") {
                return Some(error_response(
                    403,
                    "pruning worktrees is only allowed from this machine, not through a shared address",
                ));
            }
            let req: serde_json::Value = if body.trim().is_empty() {
                serde_json::json!({})
            } else {
                match serde_json::from_str(body) {
                    Ok(v) => v,
                    Err(e) => return Some(error_response(400, &format!("bad json: {e}"))),
                }
            };
            let filter_repo = req["repo"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let res = app.prune_worktrees(filter_repo);
            json_response(200, &res.to_string())
        }
        ("GET", "/api/config") => {
            if !host_allowed(host, "") {
                return Some(error_response(
                    403,
                    "reading engine config is only allowed from this machine, not through a shared address",
                ));
            }
            json_response(200, &app.config_json().to_string())
        }
        ("POST", "/api/config") => {
            if !host_allowed(host, "") {
                return Some(error_response(
                    403,
                    "changing engine config is only allowed from this machine, not through a shared address",
                ));
            }
            let req: serde_json::Value = match serde_json::from_str(body) {
                Ok(v) => v,
                Err(e) => return Some(error_response(400, &format!("bad json: {e}"))),
            };
            let Some(obj) = req.as_object() else {
                return Some(error_response(400, "config payload must be a JSON object"));
            };
            let mut next_cfg = app.config.lock().unwrap().clone();
            if let Some(val) = obj.get("default_agent") {
                match val {
                    serde_json::Value::Null => next_cfg.default_agent = None,
                    serde_json::Value::String(s) if s.trim().is_empty() => next_cfg.default_agent = None,
                    serde_json::Value::String(s) => match validate_agent(app, s.trim()) {
                        Ok(valid) => next_cfg.default_agent = Some(valid),
                        Err(e) => return Some(error_response(400, &e)),
                    },
                    _ => return Some(error_response(400, "default_agent must be a string or null")),
                }
            }
            for (key, slot) in [
                ("opencode_model", &mut next_cfg.opencode_model),
                ("claude_model", &mut next_cfg.claude_model),
                ("codex_model", &mut next_cfg.codex_model),
            ] {
                if let Some(val) = obj.get(key) {
                    match val {
                        serde_json::Value::Null => *slot = None,
                        serde_json::Value::String(s) => match validate_model_field(s) {
                            Ok(v) => *slot = v,
                            Err(e) => return Some(error_response(400, &e)),
                        },
                        _ => return Some(error_response(400, &format!("{key} must be a string or null"))),
                    }
                }
            }
            if let Some(val) = obj.get("model") {
                if !obj.contains_key("opencode_model") {
                    match val {
                        serde_json::Value::Null => next_cfg.opencode_model = None,
                        serde_json::Value::String(s) => match validate_model_field(s) {
                            Ok(v) => next_cfg.opencode_model = v,
                            Err(e) => return Some(error_response(400, &e)),
                        },
                        _ => return Some(error_response(400, "model must be a string or null")),
                    }
                }
            }
            if let Some(val) = obj.get("max_parallel_agents").or_else(|| obj.get("max_parallel")) {
                match val {
                    serde_json::Value::Null => next_cfg.max_parallel_agents = None,
                    serde_json::Value::Number(n) => {
                        let Some(cap) = n.as_i64() else {
                            return Some(error_response(400, "max_parallel_agents must be an integer between 1 and 64"));
                        };
                        if !(1..=64).contains(&cap) {
                            return Some(error_response(400, "max_parallel_agents must be between 1 and 64"));
                        }
                        next_cfg.max_parallel_agents = Some(cap);
                    }
                    _ => return Some(error_response(400, "max_parallel_agents must be an integer or null")),
                }
            }
            *app.config.lock().unwrap() = next_cfg;
            app.save_config();
            app.pump_queue();
            let snap = app.config_json();
            app.events.publish("config_updated", &snap);
            json_response(200, &snap.to_string())
        }
        ("GET", "/api/update") => json_response(200, &app.updater.snapshot().to_string()),
        ("POST", "/api/update/check") => json_response(200, &app.updater.check_now().to_string()),
        ("POST", "/api/update/apply") | ("POST", "/api/update/restart") => {
            if !host_allowed(host, "") {
                return Some(error_response(
                    403,
                    "updating is only allowed from this machine, not through a shared address",
                ));
            }
            if route == "/api/update/apply" {
                match app.updater.apply() {
                    Ok(v) => {
                        let mut snap = app.updater.snapshot();
                        snap["applied"] = serde_json::json!(v);
                        json_response(200, &snap.to_string())
                    }
                    Err(e) => error_response(409, &e),
                }
            } else {
                restart_response(app)
            }
        }
        _ => return None,
    })
}

/// Starts the staged build. Refused when nothing is staged, and while any
/// session is queued, blocked, working or checking: a restart would send those to Needs
/// you. The new process starts after this answer has been written.
fn restart_response(app: &Arc<App>) -> String {
    if app.updater.snapshot()["staged"].is_null() {
        return error_response(409, "no update is waiting for a restart");
    }
    let busy = |app: &App| {
        app.sessions
            .lock()
            .unwrap()
            .iter()
            .filter(|s| matches!(s.status.as_str(), "queued" | "blocked" | "working" | "checking"))
            .count()
    };
    let running = busy(app);
    if running > 0 {
        return error_response(
            409,
            &format!(
                "{running} session(s) are still queued, working or checking — a restart would send them to Needs you; wait for them or stop them, then restart"
            ),
        );
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        // Checked again at the last moment: a hand-out may have arrived.
        if busy(&app) > 0 {
            eprintln!("fleet-rs: restart cancelled — a session started while the update was waiting");
            return;
        }
        if let Err(e) = app.updater.restart() {
            eprintln!("fleet-rs: restart failed: {e}");
        }
    });
    json_response(200, &serde_json::json!({"restarting": true}).to_string())
}

/// Convert one `Session` to its public API JSON object, enriching derived
/// fields (`engine`, `test_mode`, `merge_target`, `blocked_by`, `check_steps`,
/// `guardrail_violations`, `elapsed_ms`, `transcript_total`).
fn session_to_api_value(
    s: &Session,
    targets: &std::collections::HashMap<String, Option<String>>,
    status_map: &std::collections::HashMap<String, String>,
) -> serde_json::Value {
    let mut v = serde_json::to_value(s).unwrap();
    // The engine kind is derived from the agent string, never
    // stored — it cannot desync from what actually ran. A
    // custom command (any executable path) is test mode, and
    // the API says so on every session it labels.
    let kind = engine_kind(&s.agent);
    v["engine"] = serde_json::json!(kind.label());
    v["test_mode"] = serde_json::json!(kind == EngineKind::Custom);
    // The receipt facts are always present: null until a check ran.
    v["check_output"] = serde_json::json!(s.check_output.clone().unwrap_or_default());
    v["check_passed"] = serde_json::json!(s.check_passed);
    v["check_ran"] = serde_json::json!(s.check_ran);
    v["check_exit"] = serde_json::json!(s.check_exit);
    v["auto_steer_budget"] = serde_json::json!(s.auto_steer_budget);
    v["heal_attempts"] = serde_json::json!(&s.heal_attempts);
    let auto_healed = s.heal_attempts.iter().any(|a| a.healed)
        && matches!(s.status.as_str(), "done" | "merged");
    v["auto_healed"] = serde_json::json!(auto_healed);
    if let Some(badge) = heal_badge_label(&s.heal_attempts, s.auto_steer_budget) {
        v["heal_badge"] = serde_json::json!(badge);
    }
    v["transcript_total"] = serde_json::json!(s.transcript_total.max(s.transcript.len()));
    // Surface structured per-step check receipts for the Receipt tab.
    if let Some(ref receipt) = s.check_receipt {
        v["elapsed_ms"] = serde_json::json!(receipt.total_elapsed_ms);
        if !receipt.steps.is_empty() {
            v["check_steps"] = serde_json::json!(&receipt.steps);
        }
    } else if !s.check_step_specs.is_empty() {
        let pending_steps: Vec<serde_json::Value> = s
            .check_step_specs
            .iter()
            .enumerate()
            .map(|(idx, spec)| {
                serde_json::json!({
                    "name": spec.effective_name(idx),
                    "cmd": spec.cmd,
                    "status": "pending",
                    "passed": serde_json::Value::Null,
                    "exit_code": serde_json::Value::Null,
                    "elapsed_ms": serde_json::Value::Null,
                    "tail_line": "",
                    "output": "",
                })
            })
            .collect();
        v["check_steps"] = serde_json::json!(pending_steps);
    }
    // Surface active unmet dependencies (`blocked_by`) alongside `depends_on`.
    if !s.depends_on.is_empty() {
        let blocked_by: Vec<&String> = s
            .depends_on
            .iter()
            .filter(|dep| {
                !matches!(
                    status_map.get(*dep).map(String::as_str),
                    Some("done" | "merged")
                )
            })
            .collect();
        if !blocked_by.is_empty() {
            v["blocked_by"] = serde_json::json!(blocked_by);
        }
    }
    // Human-readable guardrail violations alongside structured `scope_violations`.
    if !s.scope_violations.is_empty() {
        let readable: Vec<String> = s
            .scope_violations
            .iter()
            .map(|sv| format!("{} ({})", sv.path, sv.reason))
            .collect();
        v["guardrail_violations"] = serde_json::json!(readable);
    }
    // Where Merge will land: the repo's checked-out branch, null
    // when the repo is unknown or its HEAD is detached.
    let target = if s.repo.is_empty() {
        None
    } else {
        targets.get(&s.repo).cloned().flatten()
    };
    v["merge_target"] = serde_json::json!(target);
    // A needs-you session whose steering is still waiting says
    // so in its reason: the message is not silently pending.
    if s.status == "needs-you" && !s.steer.is_empty() {
        let msg = &s.steer[0];
        let shown: String = msg.chars().take(120).collect();
        let cut = if msg.chars().count() > 120 { "…" } else { "" };
        let note = format!("Your message is still waiting: \"{shown}{cut}\".");
        let base = s.reason.clone().unwrap_or_default();
        v["reason"] = serde_json::json!(format!("{base} {note}").trim_start());
    }
    v
}

/// Serialize sessions for the API with queue positions computed in:
/// a queued session's position is its place among the queued, in
/// hand-out order. Non-queued sessions carry null.
fn sessions_json(
    sessions: &[Session],
    targets: &std::collections::HashMap<String, Option<String>>,
) -> serde_json::Value {
    let status_map: std::collections::HashMap<String, String> = sessions
        .iter()
        .map(|s| (s.id.clone(), s.status.clone()))
        .collect();
    let mut pos = 0usize;
    let arr: Vec<serde_json::Value> = sessions
        .iter()
        .map(|s| {
            let mut v = session_to_api_value(s, targets, &status_map);
            if s.status == "queued" {
                pos += 1;
                v["queue_position"] = serde_json::json!(pos);
            } else {
                v["queue_position"] = serde_json::Value::Null;
            }
            v
        })
        .collect();
    serde_json::Value::Array(arr)
}

fn error_response(status: u16, message: &str) -> String {
    json_response(
        status,
        &serde_json::json!({ "error": message }).to_string(),
    )
}

fn patch_response(filename: &str, body: &str) -> String {
    let safe_name: String = filename
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();
    let name = if safe_name.is_empty() {
        "session.patch".to_string()
    } else {
        safe_name
    };
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/x-patch; charset=utf-8\r\nContent-Disposition: attachment; filename=\"{name}\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn parse_string_list_field(
    val: &serde_json::Value,
    field: &str,
) -> Result<Vec<String>, String> {
    match val {
        serde_json::Value::Null => Ok(Vec::new()),
        serde_json::Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let Some(s) = item.as_str() else {
                    return Err(format!("{field} must be an array of strings"));
                };
                let trimmed = s.trim();
                if !trimmed.is_empty() && !out.iter().any(|x| x == trimmed) {
                    out.push(trimmed.to_string());
                }
            }
            Ok(out)
        }
        _ => Err(format!("{field} must be an array of strings")),
    }
}

fn parse_check_steps_field(val: &serde_json::Value) -> Result<Vec<CheckStep>, String> {
    match val {
        serde_json::Value::Null => Ok(Vec::new()),
        serde_json::Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for (idx, item) in items.iter().enumerate() {
                let step = match item {
                    serde_json::Value::String(cmd) => CheckStep::new(format!("step-{}", idx + 1), cmd),
                    serde_json::Value::Object(obj) => {
                        let cmd = obj
                            .get("cmd")
                            .or_else(|| obj.get("command"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        let name = obj
                            .get("name")
                            .and_then(serde_json::Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("step-{}", idx + 1));
                        let timeout_secs = obj
                            .get("timeout_secs")
                            .and_then(serde_json::Value::as_u64);
                        CheckStep {
                            name,
                            cmd,
                            timeout_secs,
                        }
                    }
                    _ => return Err("check_steps entries must be objects or strings".to_string()),
                };
                step.validate()?;
                out.push(step);
            }
            Ok(out)
        }
        _ => Err("check_steps must be an array".to_string()),
    }
}

fn parse_auto_steer_budget_field(val: &serde_json::Value) -> Result<Option<u32>, String> {
    match val {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::Number(n) => {
            let Some(v) = n.as_u64() else {
                return Err(format!(
                    "auto_steer_budget must be an integer between 0 and {MAX_AUTO_HEAL_BUDGET}"
                ));
            };
            if v > MAX_AUTO_HEAL_BUDGET as u64 {
                return Err(format!(
                    "auto_steer_budget cannot exceed {MAX_AUTO_HEAL_BUDGET}"
                ));
            }
            Ok(Some(v as u32))
        }
        _ => Err(format!(
            "auto_steer_budget must be an integer between 0 and {MAX_AUTO_HEAL_BUDGET}"
        )),
    }
}

fn resolve_auto_steer_budget(
    app: &App,
    explicit: Option<u32>,
    repo: &str,
    task: &str,
    agent: &str,
) -> u32 {
    if let Some(n) = explicit {
        return n.min(MAX_AUTO_HEAL_BUDGET);
    }
    let kind = engine_kind(agent);
    if kind == EngineKind::Custom {
        // Preserve single-pass determinism for custom test scripts unless a budget is requested.
        0
    } else {
        app.policy
            .auto_steer_budget(repo, task, kind.label())
            .min(MAX_AUTO_HEAL_BUDGET)
    }
}

fn handle_upsert_template(app: &Arc<App>, body: &str) -> String {
    let req: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return error_response(400, &format!("bad json: {e}")),
    };
    let Some(obj) = req.as_object() else {
        return error_response(400, "playbook payload must be a JSON object");
    };
    let id = obj
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let name = obj
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let description = obj
        .get("description")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let repo = obj
        .get("repo")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let check_steps = match parse_check_steps_field(
        obj.get("check_steps").unwrap_or(&serde_json::Value::Null),
    ) {
        Ok(steps) => steps,
        Err(e) => return error_response(400, &e),
    };
    let allowed_globs = match parse_string_list_field(
        obj.get("allowed_globs").unwrap_or(&serde_json::Value::Null),
        "allowed_globs",
    ) {
        Ok(v) => v,
        Err(e) => return error_response(400, &e),
    };
    let forbidden_globs = match parse_string_list_field(
        obj.get("forbidden_globs")
            .unwrap_or(&serde_json::Value::Null),
        "forbidden_globs",
    ) {
        Ok(v) => v,
        Err(e) => return error_response(400, &e),
    };
    let auto_steer_budget = match parse_auto_steer_budget_field(
        obj.get("auto_steer_budget")
            .unwrap_or(&serde_json::Value::Null),
    ) {
        Ok(v) => v.unwrap_or(0),
        Err(e) => return error_response(400, &e),
    };
    let tasks = match obj.get("tasks") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for (idx, item) in items.iter().enumerate() {
                match item {
                    serde_json::Value::String(s) => out.push(PlaybookTask::simple(s.clone())),
                    serde_json::Value::Object(t) => {
                        let key = t
                            .get("key")
                            .or_else(|| t.get("alias"))
                            .and_then(serde_json::Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string);
                        let task = t
                            .get("task")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let depends_on = match parse_string_list_field(
                            t.get("depends_on").unwrap_or(&serde_json::Value::Null),
                            "depends_on",
                        ) {
                            Ok(v) => v,
                            Err(e) => return error_response(400, &format!("task #{idx}: {e}")),
                        };
                        let agent = t
                            .get("agent")
                            .and_then(serde_json::Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string);
                        let task_repo = t
                            .get("repo")
                            .and_then(serde_json::Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string);
                        out.push(PlaybookTask {
                            key,
                            task,
                            depends_on,
                            agent,
                            repo: task_repo,
                        });
                    }
                    _ => return error_response(400, "playbook tasks must be strings or objects"),
                }
            }
            out
        }
        _ => return error_response(400, "playbook tasks must be an array"),
    };
    let input = PlaybookInput {
        id,
        name,
        description,
        repo,
        check_steps,
        allowed_globs,
        forbidden_globs,
        auto_steer_budget,
        tasks,
    };
    let saved = {
        let mut store = app.templates.lock().unwrap();
        match store.upsert(input) {
            Ok(tpl) => tpl,
            Err(e) => return error_response(400, &e),
        }
    };
    app.events.publish(
        "templates_updated",
        &serde_json::json!({
            "action": "upsert",
            "id": saved.id,
            "template": saved,
        }),
    );
    json_response(201, &serde_json::to_string(&saved).unwrap())
}

fn validate_git_repo(repo: &str) -> Result<(), String> {
    if !Path::new(repo).is_dir() {
        return Err(format!("There is no folder at {repo}."));
    }
    let repo_ok = Path::new(repo).join(".git").exists()
        && Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["rev-parse", "--git-dir"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    if !repo_ok {
        return Err(format!(
            "That folder is not a git repository: {repo}. Give the path of a folder that contains a .git folder, for example the one you run git in."
        ));
    }
    Ok(())
}

fn handle_policy_test(app: &Arc<App>, body: &str) -> String {
    let req: serde_json::Value = if body.trim().is_empty() {
        serde_json::json!({})
    } else {
        match serde_json::from_str(body) {
            Ok(v) => v,
            Err(e) => return error_response(400, &format!("bad json: {e}")),
        }
    };
    let repo_raw = req
        .get("repo")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let project_raw = req
        .get("project")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let repo_arg = if repo_raw.trim().is_empty() && !project_raw.trim().is_empty() {
        project_raw
    } else {
        repo_raw
    };
    let task_arg = req
        .get("task")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let engine_arg = req
        .get("engine")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let script_arg = req
        .get("script")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.trim().is_empty());

    let decision = if let Some(script) = script_arg {
        if script.len() > 65_536 {
            return error_response(400, "policy script exceeds 64 KiB limit");
        }
        match test_policy_script(script, repo_arg, task_arg, engine_arg) {
            Ok(d) => d,
            Err(e) => return error_response(400, &e),
        }
    } else {
        let mut d = app.policy.test_policy(repo_arg, task_arg, engine_arg);
        d.max_parallel = app.effective_max_parallel();
        d
    };
    let matched_rule = decision
        .trace
        .first()
        .cloned()
        .unwrap_or_else(|| format!("{} -> {}", app.policy_source, decision.project));
    let mut out = serde_json::to_value(&decision).unwrap_or_else(|_| serde_json::json!({}));
    out["matched_rule"] = serde_json::json!(matched_rule);
    json_response(200, &out.to_string())
}

fn handle_batch_sessions(app: &Arc<App>, body: &str) -> String {
    let req: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return error_response(400, &format!("bad json: {e}")),
    };
    let Some(obj) = req.as_object() else {
        return error_response(400, "batch payload must be a JSON object");
    };
    let dry_run = obj
        .get("dry_run")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let raw_tasks = obj
        .get("tasks")
        .or_else(|| obj.get("sessions"))
        .and_then(serde_json::Value::as_array);
    let Some(raw_tasks) = raw_tasks else {
        return error_response(400, "batch payload requires a 'tasks' array");
    };
    if raw_tasks.is_empty() {
        return error_response(400, "batch must contain at least one task");
    }
    if raw_tasks.len() > 2000 {
        return error_response(400, "batch cannot exceed 2000 tasks");
    }

    let mut parsed_tasks: Vec<BatchTaskSpec> = Vec::with_capacity(raw_tasks.len());
    let mut task_budgets: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut explicit_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    for item in raw_tasks {
        if let Some(k) = item
            .get("key")
            .or_else(|| item.get("alias"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            explicit_keys.insert(k.to_string());
        }
    }

    for (idx, item) in raw_tasks.iter().enumerate() {
        let Some(t_obj) = item.as_object() else {
            return error_response(400, &format!("task #{idx} must be a JSON object"));
        };
        let key = t_obj
            .get("key")
            .or_else(|| t_obj.get("alias"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| {
                let synth = format!("#{}", idx + 1);
                (!explicit_keys.contains(&synth)).then_some(synth)
            });
        let task = t_obj
            .get("task")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let repo = t_obj
            .get("repo")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let project = t_obj
            .get("project")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let agent = t_obj
            .get("agent")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let model = t_obj
            .get("model")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let check_cmd = t_obj
            .get("check_cmd")
            .or_else(|| t_obj.get("check"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let check_steps = match parse_check_steps_field(
            t_obj.get("check_steps").unwrap_or(&serde_json::Value::Null),
        ) {
            Ok(s) => s,
            Err(e) => return error_response(400, &format!("task #{idx}: {e}")),
        };
        let depends_on = match parse_string_list_field(
            t_obj.get("depends_on").unwrap_or(&serde_json::Value::Null),
            "depends_on",
        ) {
            Ok(v) => v,
            Err(e) => return error_response(400, &format!("task #{idx}: {e}")),
        };
        let allowed_globs = match parse_string_list_field(
            t_obj.get("allowed_globs").unwrap_or(&serde_json::Value::Null),
            "allowed_globs",
        ) {
            Ok(v) => v,
            Err(e) => return error_response(400, &format!("task #{idx}: {e}")),
        };
        let forbidden_globs = match parse_string_list_field(
            t_obj
                .get("forbidden_globs")
                .unwrap_or(&serde_json::Value::Null),
            "forbidden_globs",
        ) {
            Ok(v) => v,
            Err(e) => return error_response(400, &format!("task #{idx}: {e}")),
        };
        let task_budget = match parse_auto_steer_budget_field(
            t_obj
                .get("auto_steer_budget")
                .unwrap_or(&serde_json::Value::Null),
        ) {
            Ok(v) => v,
            Err(e) => return error_response(400, &format!("task #{idx}: {e}")),
        };
        if let (Some(k), Some(b)) = (key.as_ref(), task_budget) {
            task_budgets.insert(k.clone(), b);
        }
        parsed_tasks.push(BatchTaskSpec {
            key,
            task,
            repo,
            project,
            agent,
            model,
            check_cmd,
            check_steps,
            depends_on,
            allowed_globs,
            forbidden_globs,
        });
    }

    let repos = match parse_string_list_field(
        obj.get("repos").unwrap_or(&serde_json::Value::Null),
        "repos",
    ) {
        Ok(v) => v,
        Err(e) => return error_response(400, &e),
    };
    let batch_allowed = match parse_string_list_field(
        obj.get("allowed_globs").unwrap_or(&serde_json::Value::Null),
        "allowed_globs",
    ) {
        Ok(v) => v,
        Err(e) => return error_response(400, &e),
    };
    let batch_forbidden = match parse_string_list_field(
        obj.get("forbidden_globs")
            .unwrap_or(&serde_json::Value::Null),
        "forbidden_globs",
    ) {
        Ok(v) => v,
        Err(e) => return error_response(400, &e),
    };
    let batch_budget = match parse_auto_steer_budget_field(
        obj.get("auto_steer_budget")
            .unwrap_or(&serde_json::Value::Null),
    ) {
        Ok(v) => v,
        Err(e) => return error_response(400, &e),
    };

    let spec = BatchSpec {
        name: obj
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        repo: obj
            .get("repo")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        repos,
        tasks: parsed_tasks,
        max_parallel: obj
            .get("max_parallel")
            .and_then(serde_json::Value::as_u64)
            .map(|n| n as usize),
        default_check: obj
            .get("default_check")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        default_agent: obj
            .get("default_agent")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        allowed_globs: batch_allowed,
        forbidden_globs: batch_forbidden,
    };

    let existing_states: std::collections::HashMap<String, DagNodeState> = {
        let sessions = app.sessions.lock().unwrap();
        sessions
            .iter()
            .map(|s| (s.id.clone(), session_dag_state(&s.status)))
            .collect()
    };
    let base_counter = *app.counter.lock().unwrap();
    let mut preview_seq = base_counter;
    let expanded = match spec.expand(
        &existing_states,
        app.effective_max_parallel() as usize,
        || {
            preview_seq += 1;
            format!("s{}-{preview_seq}", app.run_tag)
        },
    ) {
        Ok(e) => e,
        Err(e) => return error_response(400, &e.to_string()),
    };

    if dry_run {
        return json_response(
            200,
            &serde_json::json!({
                "valid": true,
                "count": expanded.sessions.len(),
                "effective_max_parallel": expanded.effective_max_parallel,
                "topological_order": expanded.topological_order,
                "immediate_ready": expanded.immediate_ready,
            })
            .to_string(),
        );
    }

    // Deduplicate expensive git/agent/policy validations across large batches (e.g., 1,000 nodes).
    let mut validated_repos: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut resolved_agents: std::collections::HashMap<Option<String>, String> =
        std::collections::HashMap::new();
    let mut default_checks: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    struct ReadySpec {
        planned: fleet_rs::dag::PlannedSession,
        agent: String,
        model: Option<String>,
        check_cmd: String,
        auto_steer_budget: u32,
    }
    let mut ready_specs: Vec<ReadySpec> = Vec::with_capacity(expanded.sessions.len());

    for planned in expanded.sessions {
        if planned.task.contains('\0') {
            return error_response(
                400,
                "a task contains a NUL byte, which an agent cannot receive — remove it",
            );
        }
        if planned.task.len() > MAX_TASK_BYTES {
            return error_response(
                400,
                &format!("a task is over {MAX_TASK_BYTES} bytes — split it into smaller tasks"),
            );
        }
        if !validated_repos.contains(&planned.repo) {
            if let Err(e) = validate_git_repo(&planned.repo) {
                return error_response(400, &e);
            }
            validated_repos.insert(planned.repo.clone());
        }
        let agent = if let Some(cached) = resolved_agents.get(&planned.agent) {
            cached.clone()
        } else {
            match resolve_agent(app, planned.agent.as_deref()) {
                Ok(a) => {
                    resolved_agents.insert(planned.agent.clone(), a.clone());
                    a
                }
                Err(e) => return error_response(400, &e),
            }
        };
        let model = match planned.model.as_deref() {
            Some(raw) => match validate_model_field(raw) {
                Ok(m) => m,
                Err(e) => return error_response(400, &e),
            },
            None => None,
        };
        let check_cmd = if let Some(c) = planned.check_cmd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            c.to_string()
        } else if !planned.check_steps.is_empty() {
            planned
                .check_steps
                .iter()
                .map(|st| st.cmd.as_str())
                .collect::<Vec<_>>()
                .join(" && ")
        } else if let Some(cached) = default_checks.get(&planned.project) {
            cached.clone()
        } else {
            match app.policy.default_check(&planned.project) {
                Ok(c) => {
                    default_checks.insert(planned.project.clone(), c.clone());
                    c
                }
                Err(e) => return error_response(500, &e),
            }
        };
        let explicit_budget = planned
            .key
            .as_ref()
            .and_then(|k| task_budgets.get(k).copied())
            .or(batch_budget);
        let auto_steer_budget = resolve_auto_steer_budget(
            app,
            explicit_budget,
            &planned.repo,
            &planned.task,
            &agent,
        );
        ready_specs.push(ReadySpec {
            planned,
            agent,
            model,
            check_cmd,
            auto_steer_budget,
        });
    }

    // Atomically commit counter + sessions under lock.
    let mut created_ids: Vec<String> = Vec::with_capacity(ready_specs.len());
    let mut created_sessions: Vec<Session> = Vec::with_capacity(ready_specs.len());
    {
        let mut counter = app.counter.lock().unwrap();
        let mut sessions = app.sessions.lock().unwrap();
        // If another request advanced the counter concurrently, remap IDs consistently.
        let id_shift = *counter != base_counter;
        let mut id_remap: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        if id_shift {
            for rs in &ready_specs {
                *counter += 1;
                let fresh = format!("s{}-{}", app.run_tag, *counter);
                id_remap.insert(rs.planned.id.clone(), fresh);
            }
        } else {
            *counter = preview_seq;
        }
        for rs in ready_specs {
            let id = id_remap
                .get(&rs.planned.id)
                .cloned()
                .unwrap_or(rs.planned.id);
            let deps: Vec<String> = rs
                .planned
                .depends_on
                .into_iter()
                .map(|d| id_remap.get(&d).cloned().unwrap_or(d))
                .collect();
            let initial_status = if deps.is_empty() {
                Status::Queued
            } else {
                Status::Blocked
            };
            let s = Session {
                id: id.clone(),
                task: rs.planned.task,
                project: rs.planned.project,
                repo: rs.planned.repo,
                branch: format!("fleet/{id}"),
                worktree: app
                    .data_dir
                    .join("worktrees")
                    .join(&id)
                    .to_string_lossy()
                    .to_string(),
                status: initial_status.label().to_string(),
                bucket: initial_status.bucket().to_string(),
                agent: rs.agent,
                model: rs.model,
                check_cmd: rs.check_cmd,
                check_output: None,
                check_passed: None,
                diff: String::new(),
                reason: None,
                verified_commit: None,
                steer: Vec::new(),
                next_queue: Vec::new(),
                spawned_from: None,
                successor: None,
                retry_prompt: None,
                check_ran: false,
                check_exit: None,
                merge_error: None,
                depends_on: deps,
                check_step_specs: rs.planned.check_steps,
                check_receipt: None,
                allowed_globs: rs.planned.allowed_globs,
                forbidden_globs: rs.planned.forbidden_globs,
                scope_violations: Vec::new(),
                merge_strategy: None,
                auto_steer_budget: rs.auto_steer_budget,
                heal_attempts: Vec::new(),
                transcript_total: 0,
                transcript: Vec::new(),
            };
            created_ids.push(id);
            created_sessions.push(s.clone());
            sessions.push(s);
        }
    }
    for id in &created_ids {
        app.mark_dirty(id);
    }
    app.persist();
    app.emit_queue_depth();
    app.pump_queue();

    let created_json: Vec<serde_json::Value> = created_ids
        .iter()
        .filter_map(|id| app.session_json_single(id))
        .collect();
    for s_val in &created_json {
        if let Some(id) = s_val["id"].as_str() {
            app.events.publish(
                "session_created",
                &serde_json::json!({
                    "id": id,
                    "status": s_val["status"],
                    "bucket": s_val["bucket"],
                    "session": s_val,
                }),
            );
        }
    }
    json_response(
        201,
        &serde_json::json!({
            "sessions": created_json,
            "created": created_json,
            "topological_order": expanded.topological_order,
            "effective_max_parallel": expanded.effective_max_parallel,
            "count": created_ids.len(),
        })
        .to_string(),
    )
}

fn handle(app: &Arc<App>, method: &str, path: &str, body: &str) -> String {
    let (route, query) = match path.split_once('?') {
        Some((r, q)) => (r, q),
        None => (path, ""),
    };
    let params = parse_query(query);
    match (method, route) {
        ("GET", "/") => html_response(include_str!("../assets/index.html")),
        ("GET", "/api/policy") => {
            let default_agent = app.effective_default_agent();
            let opencode_model = app.effective_model_for("opencode");
            let claude_model = app.effective_model_for("claude");
            let codex_model = app.effective_model_for("codex");
            let max_parallel = app.effective_max_parallel();
            let (active, queued, total) = app.queue_counts();
            json_response(
                200,
                &serde_json::json!({
                    "max_parallel": max_parallel,
                    "max_parallel_agents": max_parallel,
                    "active_sessions": active,
                    "queued_sessions": queued,
                    "total_sessions": total,
                    "agents": app.agents,
                    "default_agent": default_agent,
                    "default_agent_engine": default_agent
                        .as_deref()
                        .map(|a| engine_kind(a).label()),
                    "model": opencode_model,
                    "model_engine": "opencode",
                    "models": {
                        "opencode": opencode_model,
                        "claude": claude_model,
                        "codex": codex_model,
                    },
                    "timeout_secs": app.policy.timeout_secs,
                    "auto_retry_budget": app.policy.default_auto_retry_budget,
                    "auto_steer_budget": app.policy.default_auto_steer_budget,
                    "features": {
                        "sse": true,
                        "batch": true,
                        "merge_check": true,
                        "policy_test": true,
                        "prune_worktrees": true,
                        "auto_heal": true,
                        "templates": true,
                        "metrics": true,
                    },
                    "source": app.policy_source,
                    "version": env!("CARGO_PKG_VERSION")
                })
                .to_string(),
            )
        }
        ("GET", "/api/metrics") => json_response(200, &app.metrics_json_cached()),
        ("GET", "/api/templates") => {
            let templates = app.templates.lock().unwrap().list();
            json_response(
                200,
                &serde_json::json!({ "templates": templates }).to_string(),
            )
        }
        ("POST", "/api/templates") => handle_upsert_template(app, body),
        ("DELETE", route) if route.starts_with("/api/templates/") => {
            let raw_id = &route["/api/templates/".len()..];
            let id = url_decode(raw_id);
            let removed = app.templates.lock().unwrap().delete(&id);
            match removed {
                Ok(tpl) => {
                    app.events.publish(
                        "templates_updated",
                        &serde_json::json!({
                            "action": "delete",
                            "id": tpl.id,
                        }),
                    );
                    json_response(
                        200,
                        &serde_json::json!({ "deleted": true, "id": tpl.id }).to_string(),
                    )
                }
                Err(e) => error_response(404, &e),
            }
        }
        ("POST", "/api/policies/test") => handle_policy_test(app, body),
        ("GET", "/api/sessions") => {
            if params.is_empty() {
                json_response(200, &app.sessions_view_cached())
            } else {
                json_response(200, &app.sessions_query(&params).to_string())
            }
        }
        ("POST", "/api/sessions/batch") => handle_batch_sessions(app, body),
        ("POST", "/api/sessions") => {
            let req: serde_json::Value = match serde_json::from_str(body) {
                Ok(v) => v,
                Err(e) => return error_response(400, &format!("bad json: {e}")),
            };
            let task = req["task"].as_str().unwrap_or("").trim().to_string();
            let repo = req["repo"].as_str().unwrap_or("").trim().to_string();
            let project = req["project"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    Path::new(&repo)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or("default")
                        .to_string()
                });
            let explicit_model = match req["model"].as_str() {
                Some(raw) => match validate_model_field(raw) {
                    Ok(m) => m,
                    Err(e) => return error_response(400, &e),
                },
                None => None,
            };
            if task.is_empty() || repo.is_empty() {
                return error_response(400, "task and repo are required");
            }
            if task.contains('\0') {
                return error_response(400, "the task contains a NUL byte, which an agent cannot receive — remove it");
            }
            if task.len() > MAX_TASK_BYTES {
                return error_response(
                    400,
                    &format!("the task is over {MAX_TASK_BYTES} bytes — split it into smaller tasks"),
                );
            }
            // The agent is resolved and validated before anything is
            // created: an unavailable agent is a refusal, not a session
            // that fails later in a worktree nobody asked for.
            let agent = match resolve_agent(app, req["agent"].as_str()) {
                Ok(a) => a,
                Err(e) => {
                    return json_response(
                        400,
                        &serde_json::json!({ "error": e }).to_string(),
                    )
                }
            };
            if let Err(e) = validate_git_repo(&repo) {
                return error_response(400, &e);
            }
            let check_step_specs = match parse_check_steps_field(&req["check_steps"]) {
                Ok(s) => s,
                Err(e) => return error_response(400, &e),
            };
            // A blank explicit check is no check: check_steps or policy default applies.
            let check_cmd = match req["check"].as_str().map(str::trim) {
                Some(c) if !c.is_empty() => c.to_string(),
                _ if !check_step_specs.is_empty() => check_step_specs
                    .iter()
                    .map(|st| st.cmd.as_str())
                    .collect::<Vec<_>>()
                    .join(" && "),
                _ => match app.policy.default_check(&project) {
                    Ok(c) => c,
                    Err(e) => return error_response(500, &e),
                },
            };
            let depends_on = match parse_string_list_field(&req["depends_on"], "depends_on") {
                Ok(v) => v,
                Err(e) => return error_response(400, &e),
            };
            let allowed_globs =
                match parse_string_list_field(&req["allowed_globs"], "allowed_globs") {
                    Ok(v) => v,
                    Err(e) => return error_response(400, &e),
                };
            let forbidden_globs =
                match parse_string_list_field(&req["forbidden_globs"], "forbidden_globs") {
                    Ok(v) => v,
                    Err(e) => return error_response(400, &e),
                };
            let explicit_budget = match parse_auto_steer_budget_field(&req["auto_steer_budget"]) {
                Ok(v) => v,
                Err(e) => return error_response(400, &e),
            };
            let auto_steer_budget =
                resolve_auto_steer_budget(app, explicit_budget, &repo, &task, &agent);
            // Validate every `depends_on` target exists before creating the session.
            if !depends_on.is_empty() {
                let known: std::collections::HashSet<String> = app
                    .sessions
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|s| s.id.clone())
                    .collect();
                for dep in &depends_on {
                    if !known.contains(dep) {
                        return error_response(
                            400,
                            &format!("unknown dependency '{dep}' — no session with that id exists"),
                        );
                    }
                }
            }
            // Successor work named with the order: a single task
            // string, or an array for a chain. Each item must be a
            // non-empty string; anything else is refused up front.
            let mut next_queue: Vec<String> = Vec::new();
            match &req["next"] {
                serde_json::Value::Null => {}
                serde_json::Value::String(s) if !s.trim().is_empty() => {
                    next_queue.push(s.clone());
                }
                serde_json::Value::Array(items) => {
                    for it in items {
                        match it.as_str() {
                            Some(s) if !s.trim().is_empty() => {
                                next_queue.push(s.to_string())
                            }
                            _ => {
                                return error_response(
                                    400,
                                    "next must be a task string or an array of task strings",
                                )
                            }
                        }
                    }
                }
                _ => {
                    return error_response(
                        400,
                        "next must be a task string or an array of task strings",
                    )
                }
            }
            let n = {
                let mut counter = app.counter.lock().unwrap();
                *counter += 1;
                *counter
            };
            let id = format!("s{}-{n}", app.run_tag);
            let initial_status = if depends_on.is_empty() {
                Status::Queued
            } else {
                Status::Blocked
            };
            let session = Session {
                id: id.clone(),
                task,
                project,
                repo: repo.clone(),
                branch: format!("fleet/{id}"),
                worktree: app
                    .data_dir
                    .join("worktrees")
                    .join(&id)
                    .to_string_lossy()
                    .to_string(),
                status: initial_status.label().to_string(),
                bucket: initial_status.bucket().to_string(),
                agent,
                model: explicit_model,
                check_cmd,
                check_output: None,
                check_passed: None,
                diff: String::new(),
                reason: None,
                verified_commit: None,
                steer: Vec::new(),
                next_queue,
                spawned_from: None,
                successor: None,
                retry_prompt: None,
                check_ran: false,
                check_exit: None,
                merge_error: None,
                depends_on,
                check_step_specs,
                check_receipt: None,
                allowed_globs,
                forbidden_globs,
                scope_violations: Vec::new(),
                merge_strategy: None,
                auto_steer_budget,
                heal_attempts: Vec::new(),
                transcript_total: 0,
                transcript: Vec::new(),
            };
            app.sessions.lock().unwrap().push(session.clone());
            app.mark_dirty(&id);
            app.persist();
            let created_obj = app
                .session_json_single(&id)
                .unwrap_or_else(|| serde_json::to_value(&session).unwrap());
            app.events.publish(
                "session_created",
                &serde_json::json!({
                    "id": id,
                    "task": session.task,
                    "project": session.project,
                    "repo": session.repo,
                    "branch": session.branch,
                    "status": session.status,
                    "bucket": session.bucket,
                    "session": created_obj,
                }),
            );
            app.emit_queue_depth();
            app.pump_queue();
            let mine = app
                .session_json_single(&id)
                .unwrap_or_else(|| serde_json::to_value(&session).unwrap());
            json_response(201, &mine.to_string())
        }
        ("GET", route) if route.starts_with("/api/sessions/") && route.ends_with("/transcript") => {
            let id = &route["/api/sessions/".len()..route.len() - "/transcript".len()];
            match app.transcript_query(id, &params) {
                Some(v) => json_response(200, &v.to_string()),
                None => error_response(404, "no such session"),
            }
        }
        ("GET", route) if route.starts_with("/api/sessions/") && route.ends_with("/merge-check") => {
            let id = &route["/api/sessions/".len()..route.len() - "/merge-check".len()];
            let session = {
                let sessions = app.sessions.lock().unwrap();
                sessions.iter().find(|s| s.id == id).cloned()
            };
            let Some(s) = session else {
                return error_response(404, "no such session");
            };
            if s.repo.is_empty() {
                return error_response(409, "session has no repository path");
            }
            let target = params
                .get("target")
                .map(String::as_str)
                .filter(|t| !t.trim().is_empty())
                .unwrap_or("HEAD");
            let source = s.verified_commit.as_deref().unwrap_or(&s.branch);
            match dry_run_merge(Path::new(&s.repo), target, source) {
                Ok(res) => json_response(200, &serde_json::to_string(&res).unwrap()),
                Err(e) => error_response(409, &e),
            }
        }
        ("GET", route) if route.starts_with("/api/sessions/") && route.ends_with("/patch") => {
            let id = &route["/api/sessions/".len()..route.len() - "/patch".len()];
            let session = {
                let sessions = app.sessions.lock().unwrap();
                sessions.iter().find(|s| s.id == id).cloned()
            };
            let Some(s) = session else {
                return error_response(404, "no such session");
            };
            if s.repo.is_empty() {
                return error_response(409, "session has no repository path");
            }
            let fmt_raw = params
                .get("format")
                .map(String::as_str)
                .unwrap_or("format-patch");
            let format = match PatchFormat::parse(fmt_raw) {
                Ok(f) => f,
                Err(e) => return error_response(400, &e),
            };
            let base = params
                .get("base")
                .map(String::as_str)
                .filter(|b| !b.trim().is_empty())
                .unwrap_or("HEAD");
            let source = s.verified_commit.as_deref().unwrap_or(&s.branch);
            let want_json = matches!(
                params.get("json").map(String::as_str),
                Some("1" | "true" | "yes")
            );
            match export_patch(Path::new(&s.repo), base, source, id, format) {
                Ok(mut exported) => {
                    if exported.content.trim().is_empty() && !s.diff.trim().is_empty() {
                        exported.content = s.diff.clone();
                    }
                    if want_json {
                        json_response(200, &serde_json::to_string(&exported).unwrap())
                    } else {
                        patch_response(&exported.filename, &exported.content)
                    }
                }
                Err(e) => error_response(409, &e),
            }
        }
        ("GET", route) if route.starts_with("/api/sessions/") => {
            let id = &route["/api/sessions/".len()..];
            match app.session_json_single(id) {
                Some(v) => json_response(200, &v.to_string()),
                None => error_response(404, "no such session"),
            }
        }
        ("POST", route) if route.starts_with("/api/sessions/") && route.ends_with("/merge") => {
            let id = &route["/api/sessions/".len()..route.len() - "/merge".len()];
            let strategy = if body.trim().is_empty() {
                MergeStrategy::MergeCommit
            } else {
                match serde_json::from_str::<serde_json::Value>(body) {
                    Ok(v) => match v.get("strategy").and_then(serde_json::Value::as_str) {
                        Some(raw) => match MergeStrategy::parse(raw) {
                            Ok(st) => st,
                            Err(e) => return error_response(400, &e),
                        },
                        None => MergeStrategy::MergeCommit,
                    },
                    Err(e) => return error_response(400, &format!("bad json: {e}")),
                }
            };
            match app.merge_with_strategy(id, strategy) {
                Ok((commit, branch, landed_commit, strat)) => json_response(
                    200,
                    &serde_json::json!({
                        "merged": true,
                        "commit": commit,
                        "landed_commit": landed_commit,
                        "branch": branch,
                        "strategy": strat.label(),
                    })
                    .to_string(),
                ),
                Err(e) => {
                    let mut body = serde_json::json!({ "error": e.message });
                    if let Some(d) = e.detail {
                        body["detail"] = serde_json::json!(d);
                    }
                    json_response(e.status, &body.to_string())
                }
            }
        }
        ("POST", route) if route.starts_with("/api/sessions/") && route.ends_with("/retry") => {
            let id = &route["/api/sessions/".len()..route.len() - "/retry".len()];
            match app.retry(id) {
                Ok(()) => json_response(200, "{\"retried\":true}"),
                Err(e) => error_response(409, &e),
            }
        }
        ("POST", route) if route.starts_with("/api/sessions/") && route.ends_with("/steer") => {
            let id = &route["/api/sessions/".len()..route.len() - "/steer".len()];
            let req: serde_json::Value = match serde_json::from_str(body) {
                Ok(v) => v,
                Err(e) => return error_response(400, &format!("bad json: {e}")),
            };
            let message = req["message"].as_str().unwrap_or("").trim().to_string();
            if message.is_empty() {
                return error_response(400, "a steering message is required");
            }
            if message.chars().count() > LINE_CAP {
                return error_response(400, "steering message is too long");
            }
            match app.steer(id, &message) {
                Ok(()) => json_response(200, "{\"steered\":true}"),
                Err(e) if e == "no such session" => error_response(404, &e),
                Err(e) => error_response(409, &e),
            }
        }
        ("POST", route) if route.starts_with("/api/sessions/") && route.ends_with("/dismiss") => {
            let id = &route["/api/sessions/".len()..route.len() - "/dismiss".len()];
            match app.dismiss(id) {
                Ok(()) => json_response(200, "{\"dismissed\":true}"),
                Err(e) if e == "no such session" => error_response(404, &e),
                Err(e) => error_response(409, &e),
            }
        }
        ("POST", route) if route.starts_with("/api/sessions/") && route.ends_with("/stop") => {
            let id = &route["/api/sessions/".len()..route.len() - "/stop".len()];
            match app.stop(id) {
                Ok(()) => json_response(200, "{\"stopped\":true}"),
                Err(e) if e == "no such session" => error_response(404, &e),
                Err(e) => error_response(409, &e),
            }
        }
        ("GET", "/api/inbox") => {
            let mut inbox_params = std::collections::HashMap::new();
            inbox_params.insert("status".to_string(), "needs-you".to_string());
            json_response(200, &app.sessions_query(&inbox_params).to_string())
        }
        _ => error_response(404, "not found"),
    }
}

/// Load the persisted snapshot from a previous run, if one exists.
/// Transcripts are refreshed from the per-session log files, which are
/// written on every line and so can be ahead of the last snapshot.
/// The transcript lines a session's log file actually holds: the
/// check-output blocks the runner appends to the same file are not
/// transcript (they sit between the markers; older logs have no end
/// marker, so their block runs to the end of the file).
fn transcript_lines_from_log(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_check_block = false;
    for line in text.lines() {
        if line == " --- check output ---" || line == " --- end check output ---" {
            // A line the agent itself printed that happens to equal a
            // check-block marker — escaped with a leading space when
            // written to the log, so it cannot forge a block boundary.
            out.push(line[1..].to_string());
            continue;
        }
        if line == "--- check output ---" {
            in_check_block = true;
            continue;
        }
        if line == "--- end check output ---" {
            in_check_block = false;
            continue;
        }
        if !in_check_block {
            out.push(line.to_string());
        }
    }
    out
}

/// Cap a restored transcript exactly as log() caps a live one — BOTH
/// caps: the restart must not resurrect lines the cap had already
/// dropped, by count or by bytes.
fn cap_transcript(lines: Vec<String>) -> Vec<String> {
    let mut kept = if lines.len() <= TRANSCRIPT_CAP {
        lines
    } else {
        let mut kept: Vec<String> = vec![
            "… earlier lines are in this session's log file on disk — this view keeps the most recent lines"
                .to_string(),
        ];
        kept.extend(lines.into_iter().rev().take(TRANSCRIPT_CAP - 1).rev());
        kept
    };
    let bytes: usize = kept.iter().map(|l| l.len() + 1).sum();
    if bytes > TRANSCRIPT_BYTES {
        let mut over = bytes - TRANSCRIPT_BYTES;
        let start = if kept.first().is_some_and(|l| l.starts_with('…')) {
            1
        } else {
            0
        };
        let mut drop_end = start;
        while over > 0 && drop_end + 1 < kept.len() {
            over = over.saturating_sub(kept[drop_end].len() + 1);
            drop_end += 1;
        }
        if drop_end > start {
            kept.drain(start..drop_end);
        }
    }
    kept
}

/// Rebuild sessions from their log files when the store itself is
/// gone or unreadable. The logs, worktrees and branches survive a
/// lost sessions.json; the sessions must not silently vanish with
/// it. A recovered session says what happened and lands in Needs
/// you — its repo and check settings lived only in the store.
/// Added to a session's transcript when it is rebuilt from its record
/// after the session store was lost.
const RESTORED_LINE: &str = "restored from its record after the session store was lost";
/// Appended to the reason of a needs-you session rebuilt that way.
const RESTORED_REASON: &str = "(recovered from its record after the session store was lost)";

fn recover_from_logs(data_dir: &Path) -> Vec<Session> {
    let logs_dir = data_dir.join("logs");
    let mut sessions = Vec::new();
    let Ok(entries) = std::fs::read_dir(&logs_dir) else {
        return sessions;
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(".record.json")
                .or_else(|| name.strip_suffix(".log"))
                .map(|id| id.to_string())
        })
        .collect();
    ids.sort();
    ids.dedup();
    for id in ids {
        let text = std::fs::read_to_string(logs_dir.join(format!("{id}.log"))).unwrap_or_default();
        let lines = transcript_lines_from_log(&text);
        // A session with a record comes back as it was: its repo,
        // check, agent and settled outcome are in the record, so a
        // done session stays done and a merged one stays merged.
        let record = std::fs::read_to_string(logs_dir.join(format!("{id}.record.json")))
            .ok()
            .and_then(|t| serde_json::from_str::<Session>(&t).ok())
            .filter(|r| r.id == id);
        if let Some(mut s) = record {
            // Say so, once, in the transcript; a session that needs the
            // operator says it in its reason too. Status is unchanged.
            let mut lines = lines;
            lines.push(RESTORED_LINE.to_string());
            s.transcript_total = lines.len();
            s.transcript = cap_transcript(lines);
            if s.status == "needs-you" && !s.reason.as_deref().unwrap_or("").contains(RESTORED_REASON) {
                let base = s.reason.clone().unwrap_or_else(|| "needs you".to_string());
                s.reason = Some(format!("{base} {RESTORED_REASON}"));
            }
            sessions.push(s);
            continue;
        }
        let task = lines
            .iter()
            .find_map(|l| l.strip_prefix("agent started: ").map(|t| t.to_string()))
            .unwrap_or_else(|| "(recovered session)".to_string());
        sessions.push(Session {
            id: id.clone(),
            task,
            project: String::new(),
            repo: String::new(),
            branch: format!("fleet/{id}"),
            worktree: data_dir
                .join("worktrees")
                .join(&id)
                .to_string_lossy()
                .to_string(),
            status: Status::NeedsYou.label().to_string(),
            bucket: Status::NeedsYou.bucket().to_string(),
            agent: String::new(),
            model: None,
            check_cmd: String::new(),
            check_output: None,
            check_passed: None,
            diff: String::new(),
            reason: Some(
                "recovered after the session store (sessions.json) was lost or unreadable — the transcript was restored from this session's log file; the repo and check settings lived only in the store, so check them before retrying"
                    .to_string(),
            ),
            verified_commit: None,
            steer: Vec::new(),
            next_queue: Vec::new(),
            spawned_from: None,
            successor: None,
            retry_prompt: None,
            check_ran: false,
            check_exit: None,
            merge_error: None,
            depends_on: Vec::new(),
            check_step_specs: Vec::new(),
            check_receipt: None,
            allowed_globs: Vec::new(),
            forbidden_globs: Vec::new(),
            scope_violations: Vec::new(),
            merge_strategy: None,
            auto_steer_budget: 0,
            heal_attempts: Vec::new(),
            transcript_total: lines.len(),
            transcript: cap_transcript(lines),
        });
    }
    sessions
}

fn load_persisted(data_dir: &Path) -> (Vec<Session>, u64) {
    let path = data_dir.join("sessions.json");
    let parsed = std::fs::read_to_string(&path).ok().and_then(|text| {
        let v = serde_json::from_str::<serde_json::Value>(&text).ok()?;
        let counter = v["counter"].as_u64().unwrap_or(0);
        let sessions: Vec<Session> =
            serde_json::from_value(v["sessions"].clone()).unwrap_or_default();
        Some((sessions, counter))
    });
    if let Some((mut sessions, counter)) = parsed {
        if sessions.is_empty() && !recover_from_logs(data_dir).is_empty() {
            // A readable store that names no sessions while session
            // logs exist is a loss, not a fresh start.
            return (recover_from_logs(data_dir), counter);
        }
        for s in sessions.iter_mut() {
            let log_path = data_dir.join("logs").join(format!("{}.log", s.id));
            if let Ok(text) = std::fs::read_to_string(&log_path) {
                let lines = transcript_lines_from_log(&text);
                s.transcript_total = s.transcript_total.max(lines.len());
                if lines.len() > s.transcript.len() {
                    s.transcript = cap_transcript(lines);
                }
            }
        }
        return (sessions, counter);
    }
    // The store is missing or unreadable. Keep an unreadable one
    // aside as evidence rather than overwriting it, then recover
    // what the logs still know.
    if path.exists() {
        let aside = data_dir.join(format!(
            "sessions.json.corrupt-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        ));
        let _ = std::fs::rename(&path, &aside);
    }
    (recover_from_logs(data_dir), 0)
}

/// Where Fleet keeps its state when the operator has not set `FLEET_DATA`:
/// the platform data folder (`$XDG_DATA_HOME/fleet`, else
/// `~/.local/share/fleet` on Linux, `~/Library/Application Support/fleet` on
/// macOS). A relative `./fleet-data` default would scatter sessions across
/// every directory the binary is launched from.
fn default_data_dir() -> std::path::PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|s| !s.is_empty()) {
        return std::path::PathBuf::from(xdg).join("fleet");
    }
    if let Some(home) = std::env::var_os("HOME").filter(|s| !s.is_empty()) {
        let home = std::path::PathBuf::from(home);
        if cfg!(target_os = "macos") {
            return home.join("Library/Application Support/fleet");
        }
        return home.join(".local/share/fleet");
    }
    std::path::PathBuf::from("./fleet-data")
}

/// The port to listen on. An explicit `PORT` that is busy is an error the
/// operator asked for — fail loudly. An unset `PORT` (the default 8471) that
/// is busy falls back to the next free port, so a second Fleet (or a stale
/// one) does not crash the launch.
fn listen_port() -> Result<u16, String> {
    match std::env::var("PORT").ok().and_then(|p| p.parse::<u16>().ok()) {
        Some(explicit) => Ok(explicit),
        None => {
            for candidate in 8471u16..=8490 {
                if std::net::TcpListener::bind(("127.0.0.1", candidate)).is_ok() {
                    return Ok(candidate);
                }
            }
            Err("no free port in 8471..=8490".to_string())
        }
    }
}

/// Open the board in the operator's browser once, at the given URL — the way
/// a desktop app does. Suppressed when there is no display (a headless
/// service), when the operator opts out (`FLEET_NO_OPEN` or `--no-open`), or
/// when this is a systemd service (`INVOCATION_ID` set). Failures are silent:
/// the board is still reachable at the URL.
fn open_in_browser(url: &str) {
    let opted_out = std::env::var_os("FLEET_NO_OPEN").is_some()
        || std::env::var_os("INVOCATION_ID").is_some()
        || std::env::args().any(|a| a == "--no-open");
    let has_display = std::env::var_os("DISPLAY").is_some()
        || std::env::var_os("WAYLAND_DISPLAY").is_some();
    if opted_out || !has_display {
        return;
    }
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let _ = std::process::Command::new(opener)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // Answered before anything else, in any argument position, so `--version`
    // never reads the policies path.
    if args.iter().skip(1).any(|a| a == "--version" || a == "-V") {
        println!("fleet-rs {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let port: u16 = listen_port().unwrap_or_else(|e| {
        eprintln!("fleet-rs: {e}");
        std::process::exit(1);
    });
    let agents = detect_agents();
    let env_agent = std::env::var("FLEET_AGENT")
        .ok()
        .filter(|s| !s.is_empty());
    let default_agent = env_agent.clone().or_else(|| {
        agents
            .iter()
            .find(|a| a.found)
            .map(|a| a.name.clone())
    });
    let env_model = std::env::var("FLEET_MODEL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let env_claude_model = std::env::var("FLEET_CLAUDE_MODEL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let env_codex_model = std::env::var("FLEET_CODEX_MODEL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let env_max_parallel = std::env::var("FLEET_MAX_PARALLEL")
        .ok()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .map(|v| v.clamp(1, 64));
    let policy_path = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "policies.rn".to_string());
    let script = match std::fs::read_to_string(&policy_path) {
        Ok(text) => text,
        Err(e) => {
            eprintln!("fleet-rs: cannot read the policies file {policy_path}: {e}");
            std::process::exit(1);
        }
    };
    let policy = match Policy::load(&script) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("fleet-rs: the policies file {policy_path} is not valid: {e}");
            std::process::exit(1);
        }
    };
    let data_dir = std::env::var("FLEET_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_data_dir());
    let data_dir_label = data_dir.display().to_string();
    let _ = std::fs::create_dir_all(data_dir.join("worktrees"));
    let _ = std::fs::create_dir_all(data_dir.join("logs"));
    let mut runtime_config = load_config(&data_dir);
    if env_agent.is_some() {
        // Explicit FLEET_AGENT env var wins on startup over persisted default_agent.
        runtime_config.default_agent = None;
    }

    let run_tag = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "run".to_string());
    let (restored, restored_counter) = load_persisted(&data_dir);
    let template_store = TemplateStore::load(&data_dir);
    let app = Arc::new(App {
        policy,
        policy_source: policy_path.clone(),
        agents,
        default_agent,
        config: Mutex::new(runtime_config),
        env_model,
        env_claude_model,
        env_codex_model,
        env_max_parallel,
        data_dir,
        run_tag,
        sessions: Mutex::new(restored),
        state_rev: std::sync::atomic::AtomicU64::new(1),
        merge_target_cache: Mutex::new(std::collections::HashMap::new()),
        sessions_cache: Mutex::new(None),
        repos_cache: Mutex::new(None),
        metrics_cache: Mutex::new(None),
        templates: Mutex::new(template_store),
        dirty_records: Mutex::new(std::collections::HashSet::new()),
        lines_since_persist: std::sync::atomic::AtomicU64::new(0),
        counter: Mutex::new(restored_counter),
        stops: Mutex::new(std::collections::HashMap::new()),
        events: Arc::new(events::EventBus::new()),
        updater: update::Updater::from_env(
            "FLEET",
            "fleet-rs",
            env!("CARGO_PKG_VERSION"),
            "cayleb-james2008/dsh-fleet",
            true,
        ),
    });
    // The periodic release check is started here, by the real binary only;
    // tests never call out.
    app.updater.start_background();

    // Recovery: a session that was mid-work when the server died cannot
    // honestly still be "working" — nobody is running it. Mark it
    // needs-you with the reason stated; queued sessions never started,
    // so they simply resume through the queue.
    let interrupted: Vec<(String, String)> = {
        let sessions = app.sessions.lock().unwrap();
        sessions
            .iter()
            .filter(|s| s.status == "working" || s.status == "checking")
            .map(|s| (s.id.clone(), s.status.clone()))
            .collect()
    };
    for (id, was) in interrupted {
        app.log(
            &id,
            format!(
                "server restarted while this session was {was} — the worktree is intact; retry it or inspect it"
            ),
        );
        app.set_needs_you(&id, &format!("server restarted while {was}"));
    }
    // A verified-done session with steering still waiting was
    // mid-reopen when the server stopped: the operator's message
    // supersedes its settle. It comes back needs-you — a retry
    // delivers the steering, and its chain (if any) fires when it
    // settles verified done again.
    let steered_done: Vec<String> = {
        let sessions = app.sessions.lock().unwrap();
        sessions
            .iter()
            .filter(|s| s.status == "done" && !s.steer.is_empty())
            .map(|s| s.id.clone())
            .collect()
    };
    for id in steered_done {
        app.log(
            &id,
            "server restarted while this session had steering waiting — retry it to deliver your message"
                .to_string(),
        );
        app.set_needs_you(&id, "server restarted while steering was waiting");
    }
    // A verified-done session whose successor never fired (the
    // server died in the settle-to-fire window) must not stall in
    // silence: fire its chain now — fire_successor re-verifies the
    // done status under its lock before handing anything out.
    let stalled_chains: Vec<String> = {
        let sessions = app.sessions.lock().unwrap();
        sessions
            .iter()
            .filter(|s| s.status == "done" && !s.next_queue.is_empty() && s.steer.is_empty())
            .map(|s| s.id.clone())
            .collect()
    };
    for id in stalled_chains {
        app.log(
            &id,
            "server restarted before this session's named successor was handed out — handing it out now"
                .to_string(),
        );
        app.fire_successor(&id);
    }
    if !app.sessions.lock().unwrap().is_empty() {
        println!(
            "fleet-rs: restored {} session(s) from disk",
            app.sessions.lock().unwrap().len()
        );
    }
    app.pump_queue();

    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap_or_else(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            eprintln!(
                "fleet-rs: port {port} is busy. Set PORT to a free port, or stop the process using it."
            );
        } else {
            eprintln!("fleet-rs: cannot listen on port {port}: {e}");
        }
        std::process::exit(1);
    });
    let allowed_hosts = std::env::var("FLEET_ALLOWED_HOSTS").unwrap_or_default();
    let detected: Vec<String> = app
        .agents
        .iter()
        .map(|a| format!("{}:{}", a.name, if a.found { "found" } else { "not found" }))
        .collect();
    println!(
        "fleet-rs listening on http://127.0.0.1:{port}/ (agents: {}; default: {}; max_parallel: {})",
        detected.join(", "),
        app.effective_default_agent().as_deref().unwrap_or("none"),
        app.effective_max_parallel()
    );
    println!("  Data:    {data_dir_label}");
    println!(
        "  Updates: {}",
        std::env::var("FLEET_UPDATE_MODE").unwrap_or_else(|_| "notify".to_string())
    );
    open_in_browser(&format!("http://127.0.0.1:{port}/"));
    for stream in listener.incoming() {
        match stream {
            Ok(mut stream) => {
                let app = app.clone();
                let allowed_hosts = allowed_hosts.clone();
                std::thread::spawn(move || {
                    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(
                        READ_TIMEOUT_SECS,
                    )));
                    if let Some((method, path, body, content_type, origin, host, last_event_id)) =
                        read_request_full(&mut stream)
                    {
                        let (route, query) = match path.split_once('?') {
                            Some((r, q)) => (r, q),
                            None => (path.as_str(), ""),
                        };
                        if method == "GET" && route == "/api/events/stream" {
                            if !host_allowed(&host, &allowed_hosts) {
                                let resp = error_response(403, "this board answers only to its own host name");
                                let _ = stream.write_all(resp.as_bytes());
                                return;
                            }
                            let since = last_event_id.or_else(|| {
                                parse_query(query)
                                    .get("since")
                                    .and_then(|v| v.parse::<u64>().ok())
                            });
                            serve_sse(&app, &mut stream, since);
                            return;
                        }
                        let response = respond(&app, &allowed_hosts, &method, &path, &body, &content_type, &origin, &host);
                        let _ = stream.write_all(response.as_bytes());
                    }
                });
            }
            Err(_) => continue,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use fleet_rs::merge_check::plain_merge_refusal;
    use fleet_rs::policy::DEFAULT_TIMEOUT_SECS;

    const SCRIPT: &str = include_str!("../policies.rn");

    #[test]
    fn policy_loads_and_drives_values() {
        let policy = Policy::load(SCRIPT).unwrap();
        assert_eq!(policy.max_parallel, 4);
        assert_eq!(policy.timeout_secs, 1800);
        assert_eq!(policy.default_check("fixture").unwrap(), "test -s output.txt");
        assert_eq!(policy.default_check("anything-else").unwrap(), "cargo test");
        // The model route is read from the policy, not hardcoded.
        assert_eq!(
            policy.model.as_deref(),
            Some("opencode/deepseek-v4.1-flash-free")
        );
    }

    #[test]
    fn policy_without_agent_model_means_engine_default() {
        let script = "pub fn max_parallel() { 1 }\npub fn default_check(p) { \"true\" }";
        let policy = Policy::load(script).unwrap();
        assert_eq!(policy.model, None);
    }

    #[test]
    fn engine_commands_drive_real_clis_noninteractively() {
        let model = Some("opencode/deepseek-v4.1-flash-free");
        // opencode: `run`, the house model, the prompt last.
        let (prog, args) = engine_command("opencode", model, "do it", false);
        assert_eq!(prog, "opencode");
        assert_eq!(
            args,
            vec!["run", "--model", "opencode/deepseek-v4.1-flash-free", "do it"]
        );
        // Steering continues the same conversation.
        let (_, args) = engine_command("opencode", model, "also this", true);
        assert_eq!(
            args,
            vec!["run", "--model", "opencode/deepseek-v4.1-flash-free", "--continue", "also this"]
        );
        // claude: print mode; the OpenCode model id is NOT passed —
        // it names a provider claude does not speak.
        let (_, args) = engine_command("claude", model, "do it", false);
        assert_eq!(args, vec!["-p", "do it"]);
        let (_, args) = engine_command("claude", model, "also this", true);
        assert_eq!(args, vec!["-p", "--continue", "also this"]);
        // An explicit Claude model IS passed to claude.
        let (_, args) = engine_command("claude", Some("claude-sonnet-4-5"), "do it", false);
        assert_eq!(args, vec!["-p", "--model", "claude-sonnet-4-5", "do it"]);
        // codex: exec with a workspace-write sandbox; resume --last
        // continues (and keeps the first run's sandbox).
        let (_, args) = engine_command("codex", model, "do it", false);
        assert_eq!(
            args,
            vec!["exec", "--sandbox", "workspace-write", "--color", "never", "do it"]
        );
        let (_, args) = engine_command("codex", Some("o4-mini"), "do it", false);
        assert_eq!(
            args,
            vec!["exec", "--sandbox", "workspace-write", "--color", "never", "--model", "o4-mini", "do it"]
        );
        let (_, args) = engine_command("codex", model, "also this", true);
        assert_eq!(args, vec!["exec", "resume", "--last", "also this"]);
        // A custom command (any path) gets the prompt as its single
        // argument, initial and continuation alike — and is labelled
        // custom, i.e. test mode.
        let (prog, args) = engine_command("/tmp/agent.sh", model, "do it", false);
        assert_eq!(prog, "/tmp/agent.sh");
        assert_eq!(args, vec!["do it"]);
        assert_eq!(engine_kind("/tmp/agent.sh"), EngineKind::Custom);
        assert_eq!(engine_kind("opencode"), EngineKind::Opencode);
        assert_eq!(engine_kind("claude"), EngineKind::Claude);
        assert_eq!(engine_kind("codex"), EngineKind::Codex);
    }

    #[test]
    fn policy_cap_is_read_from_rune_not_hardcoded() {
        let script = "pub fn max_parallel() { 1 }\npub fn default_check(p) { \"true\" }";
        let policy = Policy::load(script).unwrap();
        assert_eq!(policy.max_parallel, 1);
        // No timeout_secs in this policy: the app default applies —
        // a policy can never mean "no timeout" by omission.
        assert_eq!(policy.timeout_secs, DEFAULT_TIMEOUT_SECS);
    }

    #[test]
    fn check_must_pass_for_done() {
        // A session whose agent writes nothing must land on needs-you,
        // because the fixture check (test -s output.txt) fails.
        let dir = std::env::temp_dir().join(format!("fleet-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str], cwd: &Path| {
            assert!(Command::new("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .unwrap()
                .status
                .success());
        };
        git(&["init", "-b", "main"], &repo);
        std::fs::write(repo.join("README.md"), "x").unwrap();
        git(&["add", "-A"], &repo);
        git(
            &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
            &repo,
        );
        // Fixture agent that does nothing and exits 0 (claims completion).
        let agent = dir.join("agent.sh");
        std::fs::write(&agent, "#!/bin/sh\necho doing nothing\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let app = Arc::new(App {
            policy: Policy::load(SCRIPT).unwrap(),
            policy_source: "policies.rn".to_string(),
            agents: Vec::new(),
            default_agent: Some(agent.to_string_lossy().to_string()),
            config: Mutex::new(RuntimeConfig::default()),
            env_model: None,
            env_claude_model: None,
            env_codex_model: None,
            env_max_parallel: None,
            data_dir: dir.join("data"),
            run_tag: "test".to_string(),
            sessions: Mutex::new(Vec::new()),
            state_rev: std::sync::atomic::AtomicU64::new(1),
            merge_target_cache: Mutex::new(std::collections::HashMap::new()),
            sessions_cache: Mutex::new(None),
            repos_cache: Mutex::new(None),
            metrics_cache: Mutex::new(None),
            templates: Mutex::new(TemplateStore::load(dir.join("data"))),
            dirty_records: Mutex::new(std::collections::HashSet::new()),
            lines_since_persist: std::sync::atomic::AtomicU64::new(0),
            counter: Mutex::new(0),
            stops: Mutex::new(std::collections::HashMap::new()),
            events: Arc::new(events::EventBus::new()),
            updater: update::Updater::new(update::Config {
                bin: "fleet-rs",
                current: env!("CARGO_PKG_VERSION"),
                repo: "o/r".to_string(),
                api: "http://127.0.0.1:1".to_string(),
                mode: update::Mode::Notify,
                exe: std::env::temp_dir().join("fleet-rs-test-no-such-binary"),
                allow_dev: false,
                may_apply: true,
            })
            .into(),
        });
        // Drive the same path the HTTP layer drives.
        let session = Session {
            id: "s1".to_string(),
            task: "write output".to_string(),
            project: "fixture".to_string(),
            repo: repo.to_string_lossy().to_string(),
            branch: "fleet/s1".to_string(),
            worktree: dir.join("data/worktrees/s1").to_string_lossy().to_string(),
            status: Status::Queued.label().to_string(),
            bucket: Status::Queued.bucket().to_string(),
            agent: agent.to_string_lossy().to_string(),
            model: None,
            check_cmd: "test -s output.txt".to_string(),
            check_output: None,
            check_passed: None,
            diff: String::new(),
            reason: None,
            verified_commit: None,
            steer: Vec::new(),
            next_queue: Vec::new(),
            spawned_from: None,
            successor: None,
            retry_prompt: None,
            check_ran: false,
            check_exit: None,
            merge_error: None,
            depends_on: Vec::new(),
            check_step_specs: Vec::new(),
            check_receipt: None,
            allowed_globs: Vec::new(),
            forbidden_globs: Vec::new(),
            scope_violations: Vec::new(),
            merge_strategy: None,
            auto_steer_budget: 0,
            heal_attempts: Vec::new(),
            transcript_total: 0,
            transcript: Vec::new(),
        };
        app.sessions.lock().unwrap().push(session);
        app.set_status("s1", Status::Working);
        app.run_session("s1");
        assert_eq!(app.status_of("s1").as_deref(), Some("needs-you"));
        let sessions = app.sessions.lock().unwrap();
        assert_eq!(sessions[0].check_passed, Some(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn test_app(data_dir: PathBuf, sessions: Vec<Session>) -> Arc<App> {
        Arc::new(App {
            policy: Policy::load(SCRIPT).unwrap(),
            policy_source: "policies.rn".to_string(),
            agents: Vec::new(),
            default_agent: None,
            config: Mutex::new(RuntimeConfig::default()),
            env_model: None,
            env_claude_model: None,
            env_codex_model: None,
            env_max_parallel: None,
            data_dir: data_dir.clone(),
            run_tag: "test".to_string(),
            sessions: Mutex::new(sessions),
            state_rev: std::sync::atomic::AtomicU64::new(1),
            merge_target_cache: Mutex::new(std::collections::HashMap::new()),
            sessions_cache: Mutex::new(None),
            repos_cache: Mutex::new(None),
            metrics_cache: Mutex::new(None),
            templates: Mutex::new(TemplateStore::load(&data_dir)),
            dirty_records: Mutex::new(std::collections::HashSet::new()),
            lines_since_persist: std::sync::atomic::AtomicU64::new(0),
            counter: Mutex::new(0),
            stops: Mutex::new(std::collections::HashMap::new()),
            events: Arc::new(events::EventBus::new()),
            updater: update::Updater::new(update::Config {
                bin: "fleet-rs",
                current: env!("CARGO_PKG_VERSION"),
                repo: "o/r".to_string(),
                api: "http://127.0.0.1:1".to_string(),
                mode: update::Mode::Notify,
                exe: std::env::temp_dir().join("fleet-rs-test-no-such-binary"),
                allow_dev: false,
                may_apply: true,
            })
            .into(),
        })
    }

    fn test_session(id: &str, status: Status, dir: &Path) -> Session {
        Session {
            id: id.to_string(),
            task: format!("task for {id}"),
            project: "fixture".to_string(),
            repo: dir.join("repo").to_string_lossy().to_string(),
            branch: format!("fleet/{id}"),
            worktree: dir.join("data/worktrees").join(id).to_string_lossy().to_string(),
            status: status.label().to_string(),
            bucket: status.bucket().to_string(),
            agent: "/bin/true".to_string(),
            model: None,
            check_cmd: "test -s output.txt".to_string(),
            check_output: Some("1 passed".to_string()),
            check_passed: Some(true),
            diff: String::new(),
            reason: None,
            verified_commit: Some("abc123".to_string()),
            steer: Vec::new(),
            next_queue: Vec::new(),
            spawned_from: None,
            successor: None,
            retry_prompt: None,
            check_ran: false,
            check_exit: None,
            merge_error: None,
            depends_on: Vec::new(),
            check_step_specs: Vec::new(),
            check_receipt: None,
            allowed_globs: Vec::new(),
            forbidden_globs: Vec::new(),
            scope_violations: Vec::new(),
            merge_strategy: None,
            auto_steer_budget: 0,
            heal_attempts: Vec::new(),
            transcript_total: 0,
            transcript: Vec::new(),
        }
    }

    #[test]
    fn done_and_merged_survive_a_lost_session_store() {
        let dir = std::env::temp_dir().join(format!("fleet-f1-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let mut stuck = test_session("s3", Status::NeedsYou, &dir);
        stuck.reason = Some("check failed: false".to_string());
        let app = test_app(
            data.clone(),
            vec![
                test_session("s1", Status::Done, &dir),
                test_session("s2", Status::Merged, &dir),
                stuck,
            ],
        );
        app.log("s1", "check passed — verified done".to_string());
        app.log("s2", "merged into main".to_string());
        app.log("s3", "needs you: check failed: false".to_string());
        app.persist();
        std::fs::remove_file(data.join("sessions.json")).unwrap();
        let (restored, _) = load_persisted(&data);
        let repo = dir.join("repo").to_string_lossy().to_string();
        let s1 = restored.iter().find(|s| s.id == "s1").unwrap();
        assert_eq!((s1.status.as_str(), s1.bucket.as_str()), ("done", "done"));
        assert_eq!(s1.verified_commit.as_deref(), Some("abc123"));
        assert_eq!(s1.check_passed, Some(true));
        assert_eq!(s1.check_output.as_deref(), Some("1 passed"));
        assert_eq!(s1.repo, repo);
        assert_eq!(s1.check_cmd, "test -s output.txt");
        assert_eq!(s1.branch, "fleet/s1");
        let s2 = restored.iter().find(|s| s.id == "s2").unwrap();
        assert_eq!((s2.status.as_str(), s2.bucket.as_str()), ("merged", "done"));
        assert_eq!(s2.repo, repo);
        // Every session rebuilt from its record says so in its transcript;
        // only a needs-you one also says so in its reason.
        let restored_line = "restored from its record after the session store was lost";
        for id in ["s1", "s2", "s3"] {
            let r = restored.iter().find(|s| s.id == id).unwrap();
            assert!(r.transcript.iter().any(|l| l == restored_line), "{id}: {:?}", r.transcript);
        }
        assert_eq!(s1.reason, None);
        let s3 = restored.iter().find(|s| s.id == "s3").unwrap();
        assert_eq!((s3.status.as_str(), s3.bucket.as_str()), ("needs-you", "needs-you"));
        assert_eq!(
            s3.reason.as_deref(),
            Some("check failed: false (recovered from its record after the session store was lost)")
        );
        // A session with no record keeps the honest needs-you recovery.
        std::fs::write(data.join("logs/s9.log"), "agent started: old task\n").unwrap();
        let (restored, _) = load_persisted(&data);
        let s9 = restored.iter().find(|s| s.id == "s9").unwrap();
        assert_eq!(s9.bucket, "needs-you");
        assert!(!s9.transcript.iter().any(|l| l.starts_with("restored from its record")));
        assert!(s9.reason.as_deref().unwrap_or("").contains("recovered"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn git_repo(dir: &Path) -> PathBuf {
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            assert!(Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap()
                .status
                .success())
        };
        git(&["init", "-b", "main"]);
        std::fs::write(repo.join("README.md"), "x").unwrap();
        git(&["add", "-A"]);
        git(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);
        repo
    }

    #[test]
    fn task_input_is_validated_at_the_api() {
        let dir = std::env::temp_dir().join(format!("fleet-f2-{}", std::process::id()));
        let app = test_app(dir.join("data"), Vec::new());
        let post = |task: String| {
            handle(
                &app,
                "POST",
                "/api/sessions",
                &serde_json::json!({ "task": task, "repo": "/nonexistent" }).to_string(),
            )
        };
        for (task, message) in [
            ("   \n\t".to_string(), "task and repo are required"),
            ("fix\0it".to_string(), "NUL byte"),
            ("x".repeat(100_001), "100000 bytes"),
        ] {
            let resp = post(task);
            assert!(resp.starts_with("HTTP/1.1 400"), "{}", resp.lines().next().unwrap_or(""));
            assert!(resp.contains(message), "expected '{message}' in {resp}");
        }
        assert!(app.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn spawn_failure_reason_carries_the_os_error() {
        let dir = std::env::temp_dir().join(format!("fleet-f2b-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git_repo(&dir);
        let gone = dir.join("gone-agent.sh");
        std::fs::write(&gone, "#!/bin/sh\n").unwrap();
        std::fs::remove_file(&gone).unwrap();
        let mut s = test_session("s1", Status::Queued, &dir);
        s.repo = repo.to_string_lossy().to_string();
        s.agent = gone.to_string_lossy().to_string();
        let app = test_app(dir.join("data"), vec![s]);
        app.set_status("s1", Status::Working);
        app.run_session("s1");
        assert_eq!(app.status_of("s1").as_deref(), Some("needs-you"));
        let sessions = app.sessions.lock().unwrap();
        let reason = sessions[0].reason.clone().unwrap_or_default();
        assert!(reason.contains("No such file or directory"), "reason was: {reason}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retry_hands_the_agent_the_failure_it_must_fix() {
        let dir = std::env::temp_dir().join(format!("fleet-f3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git_repo(&dir);
        // A recording agent: it keeps the prompt it was given.
        let received = dir.join("received.txt");
        let agent = dir.join("recorder.sh");
        std::fs::write(
            &agent,
            format!("#!/bin/sh\nprintf '%s' \"$1\" > '{}'\n", received.display()),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut s = test_session("s1", Status::NeedsYou, &dir);
        s.task = "write output".to_string();
        s.repo = repo.to_string_lossy().to_string();
        s.agent = agent.to_string_lossy().to_string();
        s.check_cmd = "echo boom-output; false".to_string();
        s.check_output = Some("boom-output".to_string());
        s.check_passed = Some(false);
        s.verified_commit = None;
        s.reason = Some("check failed: echo boom-output; false".to_string());
        let app = test_app(dir.join("data"), vec![s]);
        app.retry("s1").unwrap();
        for _ in 0..400 {
            if app.status_of("s1").as_deref() == Some("needs-you") && received.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let prompt = std::fs::read_to_string(&received).unwrap_or_default();
        assert!(prompt.starts_with("write output"), "prompt was: {prompt}");
        assert!(prompt.contains("echo boom-output; false"), "prompt was: {prompt}");
        assert!(prompt.contains("boom-output"), "prompt was: {prompt}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn git_run(cwd: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(["-c", "user.email=t@t", "-c", "user.name=t"])
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?} failed");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn response_body(resp: &str) -> serde_json::Value {
        serde_json::from_str(resp.split("\r\n\r\n").nth(1).unwrap_or("")).unwrap_or_default()
    }

    #[test]
    fn merge_refusals_are_plain_and_keep_git_text() {
        let dir = std::env::temp_dir().join(format!("fleet-f4-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A real content conflict on README.md.
        let repo = git_repo(&dir);
        git_run(&repo, &["checkout", "-b", "fleet/s1"]);
        std::fs::write(repo.join("README.md"), "branch change\n").unwrap();
        git_run(&repo, &["commit", "-am", "branch"]);
        let pin = git_run(&repo, &["rev-parse", "HEAD"]);
        git_run(&repo, &["checkout", "main"]);
        std::fs::write(repo.join("README.md"), "main change\n").unwrap();
        git_run(&repo, &["commit", "-am", "main"]);
        let mut s = test_session("s1", Status::Done, &dir);
        s.repo = repo.to_string_lossy().to_string();
        s.branch = "fleet/s1".to_string();
        s.verified_commit = Some(pin);
        let app = test_app(dir.join("data"), vec![s]);
        let resp = handle(&app, "POST", "/api/sessions/s1/merge", "{}");
        assert!(resp.starts_with("HTTP/1.1 409"), "{}", resp.lines().next().unwrap_or(""));
        let body = response_body(&resp);
        assert_eq!(body["error"], "Merge conflict in README.md. Nothing was merged.", "{body}");
        assert!(body["detail"].as_str().unwrap_or("").contains("CONFLICT"), "{body}");

        // A merge commit with no identity configured: git's own words map to a
        // plain sentence naming the two settings (pure mapping: no process-wide
        // environment is touched, so tests that run git elsewhere cannot race).
        let identity_raw = "Committer identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n  git config --global user.email \"you@example.com\"\n  git config --global user.name \"Your Name\"\n";
        let msg = plain_merge_refusal(identity_raw).unwrap_or_default();
        assert!(msg.contains("git config user.name") && msg.contains("git config user.email"), "{msg}");
        assert!(plain_merge_refusal("Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\n").unwrap().contains("Merge conflict in a.txt"));
        assert!(plain_merge_refusal("fatal: something else").is_none());
        let app2 = test_app(dir.join("data2"), vec![test_session("s2", Status::Done, &dir)]);

        // An unknown session is a 404, as GET answers.
        let resp = handle(&app2, "POST", "/api/sessions/nope/merge", "{}");
        assert!(resp.starts_with("HTTP/1.1 404"), "{}", resp.lines().next().unwrap_or(""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dismiss_clears_a_needs_you_session_and_keeps_its_log() {
        let dir = std::env::temp_dir().join(format!("fleet-f5-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let data = dir.join("data");
        let mut stuck = test_session("s1", Status::NeedsYou, &dir);
        stuck.reason = Some("check failed: false".to_string());
        let app = test_app(data.clone(), vec![stuck, test_session("s2", Status::Done, &dir)]);
        app.log("s1", "check FAILED — this needs you".to_string());

        let resp = handle(&app, "POST", "/api/sessions/s1/dismiss", "{}");
        assert!(resp.starts_with("HTTP/1.1 200"), "{}", resp.lines().next().unwrap_or(""));
        let inbox = response_body(&handle(&app, "GET", "/api/inbox", ""));
        assert!(inbox.as_array().unwrap().is_empty(), "{inbox}");
        let all = response_body(&handle(&app, "GET", "/api/sessions", ""));
        let s1 = all.as_array().unwrap().iter().find(|v| v["id"] == "s1").unwrap();
        assert_eq!((s1["status"].as_str(), s1["bucket"].as_str()), (Some("archived"), Some("archived")));
        assert!(data.join("logs/s1.log").exists());
        // Only a needs-you session can be dismissed.
        let resp = handle(&app, "POST", "/api/sessions/s2/dismiss", "{}");
        assert!(resp.starts_with("HTTP/1.1 409"), "{}", resp.lines().next().unwrap_or(""));
        assert!(response_body(&resp)["error"].as_str().unwrap_or("").contains("only a needs-you"));
        // A dismissed session takes no steering.
        let resp = handle(&app, "POST", "/api/sessions/s1/steer", "{\"message\":\"hello\"}");
        assert!(resp.starts_with("HTTP/1.1 409"), "{}", resp.lines().next().unwrap_or(""));
        let resp = handle(&app, "POST", "/api/sessions/nope/dismiss", "{}");
        assert!(resp.starts_with("HTTP/1.1 404"), "{}", resp.lines().next().unwrap_or(""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Send raw request bytes over a real socket and parse them with
    /// the server's own request reader.
    fn read_raw(request: Vec<u8>) -> Option<(String, String, String, String, String, String)> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = std::thread::spawn(move || {
            let mut c = std::net::TcpStream::connect(addr).unwrap();
            let _ = c.write_all(&request);
            std::thread::sleep(std::time::Duration::from_millis(300));
        });
        let (mut stream, _) = listener.accept().unwrap();
        let parsed = read_request(&mut stream);
        client.join().unwrap();
        parsed
    }

    #[test]
    fn request_headers_are_bounded() {
        let mut many = String::from("GET / HTTP/1.1\r\nHost: 127.0.0.1:9840\r\n");
        for i in 0..101 {
            many.push_str(&format!("X-Pad-{i}: a\r\n"));
        }
        many.push_str("\r\n");
        let parsed = read_raw(many.into_bytes()).unwrap();
        assert_eq!(parsed.0, "__headers_too_large__");
        let big = format!(
            "GET / HTTP/1.1\r\nHost: 127.0.0.1:9840\r\nX-A: {0}\r\nX-B: {0}\r\nX-C: {0}\r\n\r\n",
            "a".repeat(12_000)
        );
        let parsed = read_raw(big.into_bytes()).unwrap();
        assert_eq!(parsed.0, "__headers_too_large__");
        let small = "GET / HTTP/1.1\r\nHost: 127.0.0.1:9840\r\n\r\n".to_string();
        assert_eq!(read_raw(small.into_bytes()).unwrap().0, "GET");
    }

    #[test]
    fn host_header_must_name_this_machine() {
        assert!(host_allowed("127.0.0.1:9840", ""));
        assert!(host_allowed("localhost:9840", ""));
        assert!(host_allowed("[::1]:9840", ""));
        assert!(!host_allowed("evil.example:9840", ""));
        assert!(!host_allowed("127.0.0.1.evil.example:9840", ""));
        assert!(!host_allowed("", ""));
        assert!(host_allowed("fleet.lan:9840", "fleet.lan, other.lan"));
        assert!(!host_allowed("fleet.lan:9840", ""));
        let raw = "GET / HTTP/1.1\r\nHost: Evil.Example:9840\r\n\r\n".to_string();
        assert_eq!(read_raw(raw.into_bytes()).unwrap().5, "evil.example:9840");
    }

    #[test]
    fn waiting_steering_is_named_on_a_needs_you_reason() {
        let mut s = test_session("s1", Status::NeedsYou, Path::new("."));
        s.reason = Some("check failed: false".to_string());
        s.steer = vec!["also fix the tests".to_string()];
        let v = sessions_json(&[s], &std::collections::HashMap::new());
        let reason = v[0]["reason"].as_str().unwrap_or("");
        assert!(reason.starts_with("check failed: false"), "{reason}");
        assert!(
            reason.contains("Your message is still waiting: \"also fix the tests\""),
            "{reason}"
        );
    }

    fn script_agent(dir: &Path, name: &str, body: &str) -> PathBuf {
        let agent = dir.join(name);
        std::fs::write(&agent, format!("#!/bin/sh\n{body}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        agent
    }

    #[test]
    fn whitespace_check_falls_back_to_the_policy_default() {
        let dir = std::env::temp_dir().join(format!("fleet-fb6-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git_repo(&dir);
        let agent = script_agent(&dir, "noop.sh", "");
        let app = test_app(dir.join("data"), Vec::new());
        let body = serde_json::json!({
            "task": "do nothing",
            "repo": repo.to_string_lossy(),
            "project": "fixture",
            "check": "   ",
            "agent": agent.to_string_lossy(),
        });
        let resp = handle(&app, "POST", "/api/sessions", &body.to_string());
        assert!(resp.starts_with("HTTP/1.1 201"), "{}", resp.lines().next().unwrap_or(""));
        let created = response_body(&resp);
        assert_eq!(created["check_cmd"], "test -s output.txt", "{created}");
        let id = created["id"].as_str().unwrap_or("").to_string();
        // The run settles on its own; the policy check fails on an empty tree.
        for _ in 0..400 {
            let st = app.status_of(&id).unwrap_or_default();
            if !matches!(st.as_str(), "queued" | "working" | "checking") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(app.status_of(&id).as_deref(), Some("needs-you"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_json_carries_the_receipt_facts() {
        let dir = std::env::temp_dir().join(format!("fleet-fb8-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git_repo(&dir).to_string_lossy().to_string();
        let agent = script_agent(&dir, "writer.sh", "echo done > out.txt").to_string_lossy().to_string();
        let cases = [("ok", "true"), ("bad", "echo x; exit 3"), ("quiet", "false")];
        let mut sessions = Vec::new();
        for (id, check) in cases {
            let mut s = test_session(id, Status::Working, &dir);
            s.repo = repo.clone();
            s.agent = agent.clone();
            s.check_cmd = check.to_string();
            s.check_output = None;
            s.check_passed = None;
            s.verified_commit = None;
            sessions.push(s);
        }
        // Never run: no check has run, so the receipt says so.
        let mut idle = test_session("idle", Status::NeedsYou, &dir);
        idle.check_output = None;
        idle.check_passed = None;
        idle.verified_commit = None;
        sessions.push(idle);
        let app = test_app(dir.join("data"), sessions);
        for (id, _) in cases {
            app.run_session(id);
        }
        let get = |id: &str| response_body(&handle(&app, "GET", &format!("/api/sessions/{id}"), ""));

        let ok = get("ok");
        assert_eq!(ok["status"], "done", "{ok}");
        assert_eq!(ok["check_cmd"], "true");
        assert_eq!(ok["check_output"], "");
        assert_eq!(ok["check_passed"], true);
        assert_eq!(ok["check_ran"], true);
        assert_eq!(ok["check_exit"], 0);

        let bad = get("bad");
        assert_eq!(bad["check_output"], "x", "{bad}");
        assert_eq!(bad["check_passed"], false);
        assert_eq!(bad["check_ran"], true);
        assert_eq!(bad["check_exit"], 3);
        assert_eq!(bad["reason"], "Check failed (exit 3): echo x; exit 3. Output: x", "{bad}");

        let quiet = get("quiet");
        assert_eq!(quiet["check_exit"], 1, "{quiet}");
        assert_eq!(quiet["reason"], "Check failed (exit 1): false. The check printed nothing.", "{quiet}");

        let idle = get("idle");
        assert_eq!(idle["check_cmd"], "test -s output.txt");
        assert_eq!(idle["check_output"], "");
        assert!(idle["check_passed"].is_null(), "{idle}");
        assert_eq!(idle["check_ran"], false);
        assert!(idle["check_exit"].is_null(), "{idle}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn settle(app: &Arc<App>, id: &str) {
        for _ in 0..600 {
            let st = app.status_of(id).unwrap_or_default();
            if !matches!(st.as_str(), "queued" | "working" | "checking") {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    #[test]
    fn retry_after_restart_reattaches_the_worktree() {
        let dir = std::env::temp_dir().join(format!("fleet-fr1-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git_repo(&dir);
        let agent = script_agent(&dir, "writer.sh", "echo done > out.txt").to_string_lossy().to_string();
        let data = dir.join("data");
        let mut s = test_session("s1", Status::Queued, &dir);
        s.repo = repo.to_string_lossy().to_string();
        s.agent = agent;
        s.check_cmd = "false".to_string();
        s.check_output = None;
        s.check_passed = None;
        s.verified_commit = None;
        let app = test_app(data.clone(), vec![s]);
        app.set_status("s1", Status::Working);
        app.run_session("s1");
        assert_eq!(app.status_of("s1").as_deref(), Some("needs-you"));
        drop(app);

        // Restart from the same data dir: a retry reuses the worktree.
        let (restored, _) = load_persisted(&data);
        let app = test_app(data.clone(), restored);
        app.retry("s1").unwrap();
        settle(&app, "s1");
        let reason = app.sessions.lock().unwrap()[0].reason.clone().unwrap_or_default();
        assert!(reason.starts_with("Check failed"), "after restart: {reason}");
        drop(app);

        // The repo lost this worktree's link (its admin record is gone).
        // A retry after another restart must re-attach the work, not fail
        // at the commit step.
        std::fs::remove_dir_all(repo.join(".git/worktrees/s1")).unwrap();
        let (restored, _) = load_persisted(&data);
        let app = test_app(data.clone(), restored);
        app.retry("s1").unwrap();
        settle(&app, "s1");
        let reason = app.sessions.lock().unwrap()[0].reason.clone().unwrap_or_default();
        assert!(reason.starts_with("Check failed"), "after losing the link: {reason}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_merge_refusal_is_kept_on_the_session() {
        let dir = std::env::temp_dir().join(format!("fleet-fr2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git_repo(&dir);
        git_run(&repo, &["checkout", "-b", "fleet/s1"]);
        std::fs::write(repo.join("README.md"), "branch change\n").unwrap();
        git_run(&repo, &["commit", "-am", "branch"]);
        let pin = git_run(&repo, &["rev-parse", "HEAD"]);
        git_run(&repo, &["checkout", "main"]);
        std::fs::write(repo.join("README.md"), "main change\n").unwrap();
        git_run(&repo, &["commit", "-am", "main"]);
        let data = dir.join("data");
        let mut s = test_session("s1", Status::Done, &dir);
        s.repo = repo.to_string_lossy().to_string();
        s.branch = "fleet/s1".to_string();
        s.verified_commit = Some(pin);
        let app = test_app(data.clone(), vec![s]);

        let resp = handle(&app, "POST", "/api/sessions/s1/merge", "{}");
        assert!(resp.starts_with("HTTP/1.1 409"), "{}", resp.lines().next().unwrap_or(""));
        let got = response_body(&handle(&app, "GET", "/api/sessions/s1", ""));
        assert_eq!(got["merge_error"]["message"], "Merge conflict in README.md. Nothing was merged.", "{got}");
        assert!(got["merge_error"]["detail"].as_str().unwrap_or("").contains("CONFLICT"), "{got}");
        assert!(got["merge_error"]["ts"].as_u64().unwrap_or(0) > 0, "{got}");
        drop(app);

        // It survives a restart from the same data dir.
        let (restored, _) = load_persisted(&data);
        let app = test_app(data.clone(), restored);
        let got = response_body(&handle(&app, "GET", "/api/sessions/s1", ""));
        assert_eq!(got["merge_error"]["message"], "Merge conflict in README.md. Nothing was merged.", "{got}");

        // A merge that lands clears it.
        let head = git_run(&repo, &["rev-parse", "HEAD"]);
        app.sessions.lock().unwrap()[0].verified_commit = Some(head);
        let resp = handle(&app, "POST", "/api/sessions/s1/merge", "{}");
        assert!(resp.starts_with("HTTP/1.1 200"), "{}", resp.lines().next().unwrap_or(""));
        let got = response_body(&handle(&app, "GET", "/api/sessions/s1", ""));
        assert!(got["merge_error"].is_null(), "{got}");

        // A retry clears it too.
        let mut stuck = test_session("s2", Status::NeedsYou, &dir);
        stuck.repo = repo.to_string_lossy().to_string();
        stuck.merge_error = Some(MergeRefusal {
            message: "old refusal".to_string(),
            detail: None,
            ts: 1,
        });
        app.sessions.lock().unwrap().push(stuck);
        let resp = handle(&app, "POST", "/api/sessions/s2/retry", "{}");
        assert!(resp.starts_with("HTTP/1.1 200"), "{}", resp.lines().next().unwrap_or(""));
        let got = response_body(&handle(&app, "GET", "/api/sessions/s2", ""));
        assert!(got["merge_error"].is_null(), "{got}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Set up a session that has run once and landed in needs-you with
    /// its worktree attached. Returns the repo and the agent it used.
    fn needs_you_session(dir: &Path, data: &Path, counter: Option<&Path>) -> (PathBuf, String) {
        let repo = git_repo(dir);
        let body = match counter {
            Some(c) => format!("echo run >> '{}'", c.display()),
            None => "echo done > out.txt".to_string(),
        };
        let agent = script_agent(dir, "agent.sh", &body).to_string_lossy().to_string();
        let mut s = test_session("s1", Status::Queued, dir);
        s.repo = repo.to_string_lossy().to_string();
        s.agent = agent.clone();
        s.check_cmd = "false".to_string();
        s.check_output = None;
        s.check_passed = None;
        s.verified_commit = None;
        let app = test_app(data.to_path_buf(), vec![s]);
        app.set_status("s1", Status::Working);
        app.run_session("s1");
        assert_eq!(app.status_of("s1").as_deref(), Some("needs-you"));
        (repo, agent)
    }

    /// A new App from the same data dir, as after a restart.
    fn restart(data: &Path) -> Arc<App> {
        let (restored, _) = load_persisted(data);
        test_app(data.to_path_buf(), restored)
    }

    #[test]
    fn retry_recovers_a_worktree_whose_git_file_is_gone() {
        let dir = std::env::temp_dir().join(format!("fleet-fr1b-a-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let data = dir.join("data");
        needs_you_session(&dir, &data, None);
        // Only the worktree's own link file is lost; the directory stays.
        std::fs::remove_file(data.join("worktrees/s1/.git")).unwrap();
        let app = restart(&data);
        app.retry("s1").unwrap();
        settle(&app, "s1");
        let reason = app.sessions.lock().unwrap()[0].reason.clone().unwrap_or_default();
        assert!(reason.starts_with("Check failed"), "after losing the .git file: {reason}");
        let aside = std::fs::read_dir(data.join("worktrees")).unwrap().flatten().any(|e| {
            e.file_name().to_string_lossy().starts_with("s1.detached-")
        });
        assert!(aside, "the detached directory was not kept aside");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retry_recovers_a_session_whose_worktree_and_record_are_gone() {
        let dir = std::env::temp_dir().join(format!("fleet-fr1b-b-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let data = dir.join("data");
        let (repo, _) = needs_you_session(&dir, &data, None);
        std::fs::remove_dir_all(data.join("worktrees/s1")).unwrap();
        std::fs::remove_dir_all(repo.join(".git/worktrees/s1")).unwrap();
        let app = restart(&data);
        app.retry("s1").unwrap();
        settle(&app, "s1");
        let reason = app.sessions.lock().unwrap()[0].reason.clone().unwrap_or_default();
        assert!(reason.starts_with("Check failed"), "after losing worktree and record: {reason}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_double_retry_leaves_exactly_one_run() {
        let dir = std::env::temp_dir().join(format!("fleet-fr1b-c-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let data = dir.join("data");
        let runs = dir.join("runs.txt");
        needs_you_session(&dir, &data, Some(&runs));
        let app = restart(&data);
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let app = app.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    app.retry("s1")
                })
            })
            .collect();
        let results: Vec<Result<(), String>> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1, "{results:?}");
        let refused = results.iter().find_map(|r| r.as_ref().err()).cloned().unwrap_or_default();
        assert!(refused.contains("already running"), "refusal was: {refused}");
        settle(&app, "s1");
        let count = std::fs::read_to_string(&runs).unwrap_or_default().lines().count();
        assert_eq!(count, 2, "runs: {count}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bad_repo_paths_get_plain_next_steps_and_merge_target_is_named() {
        let dir = std::env::temp_dir().join(format!("fleet-fb10-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let plain = dir.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let missing = dir.join("missing");
        let agent = script_agent(&dir, "noop.sh", "").to_string_lossy().to_string();
        let app = test_app(dir.join("data"), Vec::new());
        let post = |repo: &Path| {
            handle(
                &app,
                "POST",
                "/api/sessions",
                &serde_json::json!({ "task": "t", "repo": repo.to_string_lossy(), "agent": agent }).to_string(),
            )
        };

        let resp = post(&plain);
        assert!(resp.starts_with("HTTP/1.1 400"), "{}", resp.lines().next().unwrap_or(""));
        let p = plain.to_string_lossy();
        assert_eq!(
            response_body(&resp)["error"],
            format!("That folder is not a git repository: {p}. Give the path of a folder that contains a .git folder, for example the one you run git in."),
            "{resp}"
        );
        let resp = post(&missing);
        assert!(resp.starts_with("HTTP/1.1 400"), "{}", resp.lines().next().unwrap_or(""));
        assert_eq!(
            response_body(&resp)["error"],
            format!("There is no folder at {}.", missing.to_string_lossy()),
            "{resp}"
        );

        // merge_target: the repo's checked-out branch; null when unknown.
        let on_main = git_repo(&dir.join("main"));
        let detached = git_repo(&dir.join("detached"));
        git_run(&detached, &["checkout", "--detach"]);
        let mut sessions = Vec::new();
        for (id, repo) in [("on-main", on_main), ("detached", detached), ("plain", plain.clone())] {
            let mut s = test_session(id, Status::Done, &dir);
            s.repo = repo.to_string_lossy().to_string();
            sessions.push(s);
        }
        app.sessions.lock().unwrap().extend(sessions);
        let get = |id: &str| response_body(&handle(&app, "GET", &format!("/api/sessions/{id}"), ""));
        assert_eq!(get("on-main")["merge_target"], "main");
        assert!(get("detached")["merge_target"].is_null(), "{}", get("detached"));
        assert!(get("plain")["merge_target"].is_null(), "{}", get("plain"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn version_and_update_routes_are_local_only_and_gate_restart() {
        let dir = std::env::temp_dir().join(format!("fleet-upd-ep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let app = test_app(dir.join("data"), Vec::new());
        let call = |method: &str, path: &str, host: &str, allowed: &str| {
            respond(&app, allowed, method, path, "{}", "application/json", "", host)
        };

        let r = call("GET", "/api/version", "127.0.0.1:9840", "");
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
        let v = response_body(&r);
        assert_eq!(v["name"], "fleet-rs");
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
        let p = response_body(&call("GET", "/api/policy", "127.0.0.1:9840", ""));
        assert_eq!(p["version"], env!("CARGO_PKG_VERSION"));

        // Looking at the update state fetches nothing.
        let r = call("GET", "/api/update", "127.0.0.1:9840", "");
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
        let u = response_body(&r);
        assert_eq!(u["current"], env!("CARGO_PKG_VERSION"));
        assert_eq!(u["mode"], "notify");
        assert_eq!(u["available"], false);
        assert!(u["checked_at"].is_null(), "{u}");
        assert!(u["latest"].is_null() && u["staged"].is_null(), "{u}");

        // A name from FLEET_ALLOWED_HOSTS may look, never apply or restart.
        for path in ["/api/update/apply", "/api/update/restart"] {
            let r = call("POST", path, "lan-desk.local:9840", "lan-desk.local");
            assert!(r.starts_with("HTTP/1.1 403"), "{path} through a shared name: {r}");
        }
        // A name nobody allowed is refused by the Host rule.
        let r = call("GET", "/api/version", "evil.example", "");
        assert!(r.starts_with("HTTP/1.1 403"), "{r}");
        // Restart with nothing staged is a plain refusal.
        let r = call("POST", "/api/update/restart", "127.0.0.1:9840", "");
        assert!(r.starts_with("HTTP/1.1 409"), "{r}");
        assert!(response_body(&r)["error"].as_str().unwrap_or("").contains("no update is waiting"), "{r}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restart_is_refused_while_a_session_is_working() {
        let dir = std::env::temp_dir().join(format!("fleet-upd-busy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let app = test_app(dir.join("data"), vec![test_session("s1", Status::Working, &dir)]);
        app.updater.stage_for_test("0.3.0");
        let r = respond(&app, "", "POST", "/api/update/restart", "{}", "application/json", "", "127.0.0.1:9840");
        assert!(r.starts_with("HTTP/1.1 409"), "{r}");
        let msg = response_body(&r)["error"].as_str().unwrap_or("").to_string();
        assert!(msg.contains("1 session(s) are still queued, working or checking"), "{msg}");
        // Nothing was restarted: the session is still working.
        assert_eq!(app.status_of("s1").as_deref(), Some("working"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_and_repos_routes_are_loopback_only_and_persist() {
        let dir = std::env::temp_dir().join(format!("fleet-v040-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let repo = git_repo(&dir.join("alpha-proj"));
        let mut s = test_session("s1", Status::Done, &dir);
        s.repo = repo.to_string_lossy().to_string();
        let app = Arc::new(App {
            policy: Policy::load(SCRIPT).unwrap(),
            policy_source: "policies.rn".to_string(),
            agents: vec![
                AgentInfo { name: "opencode".to_string(), found: true, path: Some("/usr/bin/opencode".to_string()) },
                AgentInfo { name: "claude".to_string(), found: true, path: Some("/usr/bin/claude".to_string()) },
                AgentInfo { name: "codex".to_string(), found: false, path: None },
            ],
            default_agent: Some("opencode".to_string()),
            config: Mutex::new(RuntimeConfig::default()),
            env_model: None,
            env_claude_model: None,
            env_codex_model: None,
            env_max_parallel: None,
            data_dir: data.clone(),
            run_tag: "test".to_string(),
            sessions: Mutex::new(vec![s]),
            state_rev: std::sync::atomic::AtomicU64::new(1),
            merge_target_cache: Mutex::new(std::collections::HashMap::new()),
            sessions_cache: Mutex::new(None),
            repos_cache: Mutex::new(None),
            metrics_cache: Mutex::new(None),
            templates: Mutex::new(TemplateStore::load(&data)),
            dirty_records: Mutex::new(std::collections::HashSet::new()),
            lines_since_persist: std::sync::atomic::AtomicU64::new(0),
            counter: Mutex::new(0),
            stops: Mutex::new(std::collections::HashMap::new()),
            events: Arc::new(events::EventBus::new()),
            updater: update::Updater::new(update::Config {
                bin: "fleet-rs",
                current: env!("CARGO_PKG_VERSION"),
                repo: "o/r".to_string(),
                api: "http://127.0.0.1:1".to_string(),
                mode: update::Mode::Notify,
                exe: std::env::temp_dir().join("fleet-rs-test-no-such-binary"),
                allow_dev: false,
                may_apply: true,
            })
            .into(),
        });

        // Shared LAN host cannot read repos or mutate config.
        let r = respond(&app, "lan.local", "GET", "/api/repos", "", "", "", "lan.local:8471");
        assert!(r.starts_with("HTTP/1.1 403"), "{r}");
        let r = respond(&app, "lan.local", "POST", "/api/config", "{}", "application/json", "", "lan.local:8471");
        assert!(r.starts_with("HTTP/1.1 403"), "{r}");

        // Loopback discovers the session's git repo with its branch.
        let r = respond(&app, "", "GET", "/api/repos", "", "", "", "127.0.0.1:8471");
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
        let repos = response_body(&r);
        let canon = std::fs::canonicalize(&repo).unwrap().to_string_lossy().to_string();
        assert!(
            repos.as_array().unwrap().iter().any(|v| v["path"] == canon && v["branch"] == "main"),
            "expected {canon} in {repos}"
        );

        // Updating config validates agent, persists to disk, and reflects in /api/policy.
        let bad = respond(
            &app,
            "",
            "POST",
            "/api/config",
            r#"{"default_agent":"codex"}"#,
            "application/json",
            "",
            "127.0.0.1:8471",
        );
        assert!(bad.starts_with("HTTP/1.1 400"), "{bad}");

        let ok_resp = respond(
            &app,
            "",
            "POST",
            "/api/config",
            r#"{"default_agent":"claude","opencode_model":"opencode/custom-free","claude_model":"claude-sonnet-4-5"}"#,
            "application/json",
            "",
            "127.0.0.1:8471",
        );
        assert!(ok_resp.starts_with("HTTP/1.1 200"), "{ok_resp}");
        let cfg_body = response_body(&ok_resp);
        assert_eq!(cfg_body["default_agent"], "claude");
        assert_eq!(cfg_body["effective_models"]["opencode"], "opencode/custom-free");
        assert_eq!(cfg_body["effective_models"]["claude"], "claude-sonnet-4-5");

        let pol = response_body(&respond(&app, "", "GET", "/api/policy", "", "", "", "127.0.0.1:8471"));
        assert_eq!(pol["default_agent"], "claude");
        assert_eq!(pol["model"], "opencode/custom-free");

        let reloaded = load_config(&data);
        assert_eq!(reloaded.default_agent.as_deref(), Some("claude"));
        assert_eq!(reloaded.opencode_model.as_deref(), Some("opencode/custom-free"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn post_session_derives_project_from_repo_basename_and_merge_cleans_worktree() {
        let dir = std::env::temp_dir().join(format!("fleet-v040-wt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.join("my-real-app");
        std::fs::create_dir_all(&repo).unwrap();
        git_run(&repo, &["init", "-b", "main"]);
        std::fs::write(repo.join("README.md"), "seed\n").unwrap();
        git_run(&repo, &["add", "-A"]);
        git_run(&repo, &["commit", "-m", "init"]);

        let agent = script_agent(&dir, "ok.sh", "printf 'hello\\n' > output.txt");
        let data = dir.join("data");
        std::fs::create_dir_all(data.join("worktrees")).unwrap();
        std::fs::create_dir_all(data.join("logs")).unwrap();
        let app = test_app(data.clone(), Vec::new());

        // Omit project -> derived from repo folder basename ("my-real-app").
        let body = serde_json::json!({
            "task": "write hello",
            "repo": repo.to_string_lossy(),
            "check": "test -s output.txt",
            "agent": agent.to_string_lossy(),
        });
        let resp = handle(&app, "POST", "/api/sessions", &body.to_string());
        assert!(resp.starts_with("HTTP/1.1 201"), "{resp}");
        let created = response_body(&resp);
        assert_eq!(created["project"], "my-real-app", "{created}");
        let id = created["id"].as_str().unwrap().to_string();
        let wt = PathBuf::from(created["worktree"].as_str().unwrap());

        settle(&app, &id);
        assert_eq!(app.status_of(&id).as_deref(), Some("done"));
        assert!(wt.exists(), "worktree should exist before merge");

        let merge_resp = handle(&app, "POST", &format!("/api/sessions/{id}/merge"), "{}");
        assert!(merge_resp.starts_with("HTTP/1.1 200"), "{merge_resp}");
        assert!(repo.join("output.txt").exists(), "merged output must land on main");
        assert!(!wt.exists(), "merged worktree should be cleaned up automatically");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn max_parallel_agents_config_validates_and_persists() {
        let dir = std::env::temp_dir().join(format!("fleet-v050-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let app = test_app(data.clone(), Vec::new());

        // Reject invalid caps
        let bad0 = respond(&app, "", "POST", "/api/config", r#"{"max_parallel_agents":0}"#, "application/json", "", "127.0.0.1:8471");
        assert!(bad0.starts_with("HTTP/1.1 400"), "{bad0}");
        let bad99 = respond(&app, "", "POST", "/api/config", r#"{"max_parallel_agents":99}"#, "application/json", "", "127.0.0.1:8471");
        assert!(bad99.starts_with("HTTP/1.1 400"), "{bad99}");

        // Valid cap persists and shows in /api/policy
        let ok_r = respond(&app, "", "POST", "/api/config", r#"{"max_parallel_agents":8}"#, "application/json", "", "127.0.0.1:8471");
        assert!(ok_r.starts_with("HTTP/1.1 200"), "{ok_r}");
        assert_eq!(response_body(&ok_r)["effective_max_parallel"], 8);
        let pol = response_body(&respond(&app, "", "GET", "/api/policy", "", "", "", "127.0.0.1:8471"));
        assert_eq!(pol["max_parallel"], 8);
        assert_eq!(load_config(&data).max_parallel_agents, Some(8));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_worktrees_preserves_active_and_cleans_inactive_only_on_loopback() {
        let dir = std::env::temp_dir().join(format!("fleet-v050-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git_repo(&dir);
        let data = dir.join("data");
        let wt_root = data.join("worktrees");
        std::fs::create_dir_all(&wt_root).unwrap();

        let active_wt = wt_root.join("s-active");
        let merged_wt = wt_root.join("s-merged");
        let orphan_wt = wt_root.join("s-orphan");
        std::fs::create_dir_all(&active_wt).unwrap();
        std::fs::create_dir_all(&merged_wt).unwrap();
        std::fs::create_dir_all(&orphan_wt).unwrap();

        let mut s_act = test_session("s-active", Status::NeedsYou, &dir);
        s_act.repo = repo.to_string_lossy().to_string();
        s_act.worktree = active_wt.to_string_lossy().to_string();
        let mut s_mrg = test_session("s-merged", Status::Merged, &dir);
        s_mrg.repo = repo.to_string_lossy().to_string();
        s_mrg.worktree = merged_wt.to_string_lossy().to_string();
        let app = test_app(data.clone(), vec![s_act, s_mrg]);

        // Non-loopback host refused
        let denied = respond(&app, "lan.local", "POST", "/api/repos/prune-worktrees", "{}", "application/json", "", "lan.local:8471");
        assert!(denied.starts_with("HTTP/1.1 403"), "{denied}");

        // Loopback prunes merged & orphan while leaving active intact
        let r = respond(&app, "", "POST", "/api/repos/prune-worktrees", "{}", "application/json", "", "127.0.0.1:8471");
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
        let body = response_body(&r);
        assert_eq!(body["pruned"], true);
        let removed: Vec<&str> = body["removed_worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(removed.contains(&"s-merged"), "{body}");
        assert!(removed.contains(&"s-orphan"), "{body}");
        assert!(!removed.contains(&"s-active"), "{body}");
        assert!(active_wt.exists());
        assert!(!merged_wt.exists());
        assert!(!orphan_wt.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn graceful_sigterm_reaches_agent_before_sigkill_on_stop() {
        let dir = std::env::temp_dir().join(format!("fleet-v050-term-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("got-sigterm.txt");
        let script = script_agent(
            &dir,
            "trapper.sh",
            &format!(
                "trap 'echo sigterm > \"{}\"; exit 0' TERM\necho ready\nsleep 30\n",
                marker.display()
            ),
        );
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_bg = stop.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            stop_bg.store(true, std::sync::atomic::Ordering::Relaxed);
        });
        let mut sink = |_: bool, _: &str| {};
        let out = run_bounded(Command::new(&script), 15, Some(&stop), &mut sink);
        assert!(matches!(out.end, RunEnd::Stopped));
        assert!(marker.exists(), "expected graceful SIGTERM handler to fire before SIGKILL");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sse_stream_delivers_connected_and_live_events() {
        let dir = std::env::temp_dir().join(format!("fleet-v050-sse-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let app = test_app(dir.join("data"), Vec::new());

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let srv_app = app.clone();
        let server_handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request_full(&mut stream);
            serve_sse(&srv_app, &mut stream, None);
        });

        let mut client = std::net::TcpStream::connect(addr).unwrap();
        client
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        client
            .write_all(b"GET /api/events/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .unwrap();

        let pub_app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(120));
            pub_app.events.publish(
                "transcript_line",
                &serde_json::json!({"id": "s1", "line": "hello sse"}),
            );
        });

        let mut buf = [0u8; 4096];
        let mut acc = String::new();
        for _ in 0..10 {
            match client.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if acc.contains("hello sse") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        drop(client);
        // Trigger one write so serve_sse detects EOF immediately instead of waiting for keepalive.
        app.events.publish("queue_depth", &serde_json::json!({"active": 0}));
        let _ = server_handle.join();
        assert!(acc.contains("text/event-stream"), "{acc}");
        assert!(acc.contains("event: connected"), "{acc}");
        assert!(acc.contains("event: transcript_line"), "{acc}");
        assert!(acc.contains("hello sse"), "{acc}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scale_2000_sessions_and_50000_transcript_lines_stay_fast() {
        let dir = std::env::temp_dir().join(format!("fleet-v050-scale-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let data = dir.join("data");
        std::fs::create_dir_all(data.join("logs")).unwrap();

        let mut sessions = Vec::with_capacity(2000);
        for i in 0..2000usize {
            let st = match i % 4 {
                0 => Status::Done,
                1 => Status::NeedsYou,
                2 => Status::Queued,
                _ => Status::Merged,
            };
            let mut s = test_session(&format!("s-{i:04}"), st, &dir);
            s.repo = String::new(); // avoid non-existent repo git calls
            s.project = format!("proj-{}", i % 10);
            s.task = if i == 1337 {
                "needle: optimize websocket frame parser".to_string()
            } else {
                format!("batch task #{i}")
            };
            s.transcript = vec![format!("line 1 for {i}"), format!("line 2 for {i}")];
            sessions.push(s);
        }

        // Write a real 50,000-line log file for session s-0000 with an error at line 32,000.
        let mut big_log = String::with_capacity(50_000 * 32);
        for i in 0..50_000usize {
            if i == 32_000 {
                big_log.push_str("stderr: AssertionError at step 32000\n");
            } else {
                big_log.push_str(&format!("build step {i}: ok\n"));
            }
        }
        std::fs::write(data.join("logs/s-0000.log"), &big_log).unwrap();

        let app = test_app(data.clone(), sessions);

        // 1. Paginated filtered query across 2,000 sessions
        let t0 = std::time::Instant::now();
        let r = handle(&app, "GET", "/api/sessions?q=needle&compact=1&paginated=1&limit=25&offset=0", "");
        let q_ms = t0.elapsed().as_millis();
        assert!(r.starts_with("HTTP/1.1 200"));
        let body = response_body(&r);
        assert_eq!(body["total"], 1);
        assert_eq!(body["sessions"][0]["id"], "s-1337");
        assert!(q_ms < 200, "filtered query over 2,000 sessions took {q_ms}ms");

        // 2. Cached full GET /api/sessions under repeat reads
        let _warm = handle(&app, "GET", "/api/sessions", "");
        let t1 = std::time::Instant::now();
        for _ in 0..30 {
            let full = handle(&app, "GET", "/api/sessions", "");
            assert!(full.starts_with("HTTP/1.1 200"));
        }
        let cached_avg_ms = t1.elapsed().as_millis() / 30;
        assert!(cached_avg_ms < 50, "cached 2,000-session GET averaged {cached_avg_ms}ms");

        // 3. 50,000-line transcript pagination + first_error_index + search
        let t2 = std::time::Instant::now();
        let tr = handle(&app, "GET", "/api/sessions/s-0000/transcript?offset=31995&limit=20", "");
        let tr_ms = t2.elapsed().as_millis();
        assert!(tr.starts_with("HTTP/1.1 200"));
        let tbody = response_body(&tr);
        assert_eq!(tbody["total"], 50_000);
        assert_eq!(tbody["first_error_index"], 32_000);
        assert_eq!(tbody["lines"].as_array().unwrap().len(), 20);
        assert!(tr_ms < 200, "50,000-line transcript slice took {tr_ms}ms");

        let tr_err = response_body(&handle(&app, "GET", "/api/sessions/s-0000/transcript?errors_only=1&limit=10", ""));
        assert_eq!(tr_err["filtered_total"], 1);
        assert_eq!(tr_err["lines"][0]["index"], 32_000);

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[test]
    fn v050_batch_dag_execution_cycle_rejection_and_upstream_cascade() {
        let dir = std::env::temp_dir().join(format!("fleet-v050-dag-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git_repo(&dir);
        let ok_agent = write_script(
            &dir,
            "ok.sh",
            "#!/bin/sh\necho \"$1\" > output.txt\necho ok\n",
        );
        let bad_agent = write_script(&dir, "bad.sh", "#!/bin/sh\necho fail\nexit 1\n");
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let app = test_app(data.clone(), Vec::new());

        // 1. Atomic cycle rejection: zero sessions created.
        let cycle_body = serde_json::json!({
            "repo": repo.to_string_lossy(),
            "tasks": [
                { "key": "a", "task": "step a", "depends_on": ["b"], "agent": ok_agent.to_string_lossy() },
                { "key": "b", "task": "step b", "depends_on": ["a"], "agent": ok_agent.to_string_lossy() }
            ]
        });
        let cyc = handle(&app, "POST", "/api/sessions/batch", &cycle_body.to_string());
        assert!(cyc.starts_with("HTTP/1.1 400"), "expected 400 on cycle: {cyc}");
        assert!(app.sessions.lock().unwrap().is_empty());

        // 2. 1,000-node DAG dry-run validation & 1,000-node cycle rejection <200ms.
        let mut big_tasks = Vec::with_capacity(1000);
        for i in 0..1000usize {
            let deps = if i == 0 {
                Vec::new()
            } else {
                vec![format!("n{}", i - 1)]
            };
            big_tasks.push(serde_json::json!({
                "key": format!("n{i}"),
                "task": format!("task {i}"),
                "depends_on": deps,
            }));
        }
        let t0 = std::time::Instant::now();
        let dry = handle(
            &app,
            "POST",
            "/api/sessions/batch",
            &serde_json::json!({
                "dry_run": true,
                "repo": repo.to_string_lossy(),
                "tasks": big_tasks,
            })
            .to_string(),
        );
        let dry_ms = t0.elapsed().as_millis();
        assert!(dry.starts_with("HTTP/1.1 200"), "dry run failed: {dry}");
        assert_eq!(response_body(&dry)["count"], 1000);
        assert!(dry_ms < 200, "1000-node DAG dry_run took {dry_ms}ms");

        // Inject cycle edge n0 -> n999 and ensure fast 400 rejection.
        big_tasks[0]["depends_on"] = serde_json::json!(["n999"]);
        let t1 = std::time::Instant::now();
        let big_cyc = handle(
            &app,
            "POST",
            "/api/sessions/batch",
            &serde_json::json!({
                "repo": repo.to_string_lossy(),
                "tasks": big_tasks,
            })
            .to_string(),
        );
        let cyc_ms = t1.elapsed().as_millis();
        assert!(big_cyc.starts_with("HTTP/1.1 400"));
        assert!(cyc_ms < 200, "1000-node cycle rejection took {cyc_ms}ms");

        // 3. Real execution: A -> B (#1 -> #2) completes in order.
        let chain_body = serde_json::json!({
            "repo": repo.to_string_lossy(),
            "tasks": [
                {
                    "alias": "#1",
                    "task": "upstream task",
                    "agent": ok_agent.to_string_lossy(),
                    "check": "test -s output.txt"
                },
                {
                    "alias": "#2",
                    "task": "downstream task",
                    "agent": ok_agent.to_string_lossy(),
                    "check": "test -s output.txt",
                    "depends_on": ["#1"]
                }
            ]
        });
        let created = handle(&app, "POST", "/api/sessions/batch", &chain_body.to_string());
        assert!(created.starts_with("HTTP/1.1 201"), "batch failed: {created}");
        let body = response_body(&created);
        let id_a = body["sessions"][0]["id"].as_str().unwrap().to_string();
        let id_b = body["sessions"][1]["id"].as_str().unwrap().to_string();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            if app.status_of(&id_a).as_deref() == Some("done")
                && app.status_of(&id_b).as_deref() == Some("done")
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(app.status_of(&id_a).as_deref(), Some("done"));
        assert_eq!(app.status_of(&id_b).as_deref(), Some("done"));

        // 4. Upstream failure cascade: X fails -> Y automatically lands in needs-you.
        let fail_chain = serde_json::json!({
            "repo": repo.to_string_lossy(),
            "tasks": [
                {
                    "key": "x",
                    "task": "failing upstream",
                    "agent": bad_agent.to_string_lossy(),
                    "check": "test -s output.txt"
                },
                {
                    "key": "y",
                    "task": "blocked downstream",
                    "agent": ok_agent.to_string_lossy(),
                    "check": "test -s output.txt",
                    "depends_on": ["x"]
                }
            ]
        });
        let fc = handle(&app, "POST", "/api/sessions/batch", &fail_chain.to_string());
        assert!(fc.starts_with("HTTP/1.1 201"));
        let fc_body = response_body(&fc);
        let id_y = fc_body["sessions"][1]["id"].as_str().unwrap().to_string();

        let deadline2 = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while std::time::Instant::now() < deadline2 {
            if app.status_of(&id_y).as_deref() == Some("needs-you") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(app.status_of(&id_y).as_deref(), Some("needs-you"));
        let y_view = response_body(&handle(&app, "GET", &format!("/api/sessions/{id_y}"), ""));
        assert!(
            y_view["reason"]
                .as_str()
                .unwrap_or("")
                .contains("upstream failed"),
            "expected upstream failed reason, got: {y_view}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v050_file_scope_guardrail_and_multistep_check_receipt() {
        let dir = std::env::temp_dir().join(format!("fleet-v050-scope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git_repo(&dir);
        let oos_agent = write_script(
            &dir,
            "oos.sh",
            "#!/bin/sh\necho touched >> README.md\nmkdir -p src\necho ok > src/ok.rs\n",
        );
        let ok_agent = write_script(
            &dir,
            "ok.sh",
            "#!/bin/sh\nmkdir -p src\necho ok > src/ok.rs\n",
        );
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let app = test_app(data.clone(), Vec::new());

        // 1. Out-of-scope edit blocked cleanly in needs-you even when check passes!
        let r1 = handle(
            &app,
            "POST",
            "/api/sessions",
            &serde_json::json!({
                "repo": repo.to_string_lossy(),
                "task": "only touch src",
                "agent": oos_agent.to_string_lossy(),
                "check": "test -s src/ok.rs",
                "allowed_globs": ["src/**"]
            })
            .to_string(),
        );
        assert!(r1.starts_with("HTTP/1.1 201"));
        let id1 = response_body(&r1)["id"].as_str().unwrap().to_string();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            if app.status_of(&id1).as_deref() == Some("needs-you") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let s1 = response_body(&handle(&app, "GET", &format!("/api/sessions/{id1}"), ""));
        assert_eq!(s1["status"], "needs-you");
        assert!(s1["verified_commit"].is_null());
        assert!(s1["reason"].as_str().unwrap_or("").contains("README.md"));
        assert!(!s1["guardrail_violations"].as_array().unwrap().is_empty());

        // 2. Multi-step check pipeline runs steps in order and populates receipt!
        let r2 = handle(
            &app,
            "POST",
            "/api/sessions",
            &serde_json::json!({
                "repo": repo.to_string_lossy(),
                "task": "in-scope edit",
                "agent": ok_agent.to_string_lossy(),
                "allowed_globs": ["src/**"],
                "check_steps": [
                    { "name": "exists", "cmd": "test -s src/ok.rs && echo exists ok" },
                    { "name": "verify", "cmd": "grep -q ok src/ok.rs && echo 2 passed" }
                ]
            })
            .to_string(),
        );
        assert!(r2.starts_with("HTTP/1.1 201"));
        let id2 = response_body(&r2)["id"].as_str().unwrap().to_string();
        let deadline2 = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while std::time::Instant::now() < deadline2 {
            if app.status_of(&id2).as_deref() == Some("done") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let s2 = response_body(&handle(&app, "GET", &format!("/api/sessions/{id2}"), ""));
        assert_eq!(s2["status"], "done");
        assert_eq!(s2["check_passed"], true);
        let steps = s2["check_steps"].as_array().unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0]["name"], "exists");
        assert_eq!(steps[0]["passed"], true);
        assert_eq!(steps[1]["name"], "verify");
        assert_eq!(steps[1]["tail_line"], "2 passed");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v050_merge_check_patch_export_and_squash_merge() {
        let dir = std::env::temp_dir().join(format!("fleet-v050-merge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git_repo(&dir);
        git_run(&repo, &["config", "user.email", "fleet@test"]);
        git_run(&repo, &["config", "user.name", "fleet"]);
        let ok_agent = write_script(
            &dir,
            "ok.sh",
            "#!/bin/sh\necho feature > feature.txt\n",
        );
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let app = test_app(data.clone(), Vec::new());

        let r = handle(
            &app,
            "POST",
            "/api/sessions",
            &serde_json::json!({
                "repo": repo.to_string_lossy(),
                "task": "add feature file",
                "agent": ok_agent.to_string_lossy(),
                "check": "test -s feature.txt"
            })
            .to_string(),
        );
        assert!(r.starts_with("HTTP/1.1 201"));
        let id = response_body(&r)["id"].as_str().unwrap().to_string();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            if app.status_of(&id).as_deref() == Some("done") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(app.status_of(&id).as_deref(), Some("done"));

        // 1. Dry-run merge-check clean
        let mc = handle(&app, "GET", &format!("/api/sessions/{id}/merge-check"), "");
        assert!(mc.starts_with("HTTP/1.1 200"), "merge-check failed: {mc}");
        let mc_body = response_body(&mc);
        assert_eq!(mc_body["clean"], true);
        assert_eq!(mc_body["commits_ahead"], 1);
        assert!(mc_body["conflicting_files"].as_array().unwrap().is_empty());

        // 2. Patch export (raw text/x-patch + JSON)
        let raw_patch = handle(&app, "GET", &format!("/api/sessions/{id}/patch"), "");
        assert!(raw_patch.starts_with("HTTP/1.1 200 OK"));
        assert!(raw_patch.contains("Content-Type: text/x-patch"));
        assert!(raw_patch.contains("Content-Disposition: attachment"));
        assert!(raw_patch.contains("feature.txt"));
        let json_patch = response_body(&handle(
            &app,
            "GET",
            &format!("/api/sessions/{id}/patch?json=1"),
            "",
        ));
        assert_eq!(json_patch["files_changed"], 1);
        assert_eq!(json_patch["insertions"], 1);

        // 3. Squash merge lands cleanly on main
        let merged = handle(
            &app,
            "POST",
            &format!("/api/sessions/{id}/merge"),
            r#"{"strategy":"squash"}"#,
        );
        assert!(merged.starts_with("HTTP/1.1 200"), "squash merge failed: {merged}");
        let m_body = response_body(&merged);
        assert_eq!(m_body["merged"], true);
        assert_eq!(m_body["strategy"], "squash");
        assert!(repo.join("feature.txt").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v050_policy_test_endpoint_and_fuzz_resilience() {
        let dir = std::env::temp_dir().join(format!("fleet-v050-poltest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let app = test_app(dir.clone(), Vec::new());

        let ok = handle(
            &app,
            "POST",
            "/api/policies/test",
            r#"{"repo":"/home/dev/security-api","task":"security audit of jwt","engine":"auto"}"#,
        );
        assert!(ok.starts_with("HTTP/1.1 200"));
        let b = response_body(&ok);
        assert_eq!(b["engine"], "claude");
        assert_eq!(b["model"], "claude-sonnet-4-5");
        assert!(b["matched_rule"].is_string());

        // Fuzz payloads: zero panics, zero 500s.
        let big = "a".repeat(40_000);
        let fuzz_cases = vec![
            "".to_string(),
            "{}".to_string(),
            "not json at all {{{".to_string(),
            "[]".to_string(),
            r#"{"repo":123,"task":null,"engine":true}"#.to_string(),
            format!(r#"{{"repo":"{big}","task":"{big}\u0000evil","engine":"unknown"}}"#),
            r#"{"script":"pub fn broken( {","repo":"/tmp/x","task":"y"}"#.to_string(),
            r#"{"script":"pub fn max_parallel() { 2 } pub fn default_check(p) { \"echo ok\" }","repo":"/tmp/x","task":"y"}"#.to_string(),
        ];
        for payload in fuzz_cases {
            let resp = handle(&app, "POST", "/api/policies/test", &payload);
            assert!(
                resp.starts_with("HTTP/1.1 200") || resp.starts_with("HTTP/1.1 400"),
                "unexpected status on fuzz payload: {}",
                resp.lines().next().unwrap_or("")
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v060_auto_heal_recovers_failing_check_and_emits_sse() {
        let dir = std::env::temp_dir().join(format!("fleet-v060-heal-ok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git_repo(&dir.join("repo"));
        let agent = script_agent(
            &dir,
            "healing-agent.sh",
            r#"#!/bin/sh
if echo "$1" | grep -q "Verification check failed"; then
    echo "fixed" > answer.txt
else
    echo "broken" > answer.txt
fi
"#,
        );
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let app = test_app(data.clone(), Vec::new());
        let (sub, _replay) = app.events.subscribe(None);

        let body = serde_json::json!({
            "repo": repo.to_string_lossy(),
            "task": "write fixed answer",
            "agent": agent.to_string_lossy(),
            "check_steps": [
                { "name": "verify-answer", "cmd": "grep -qx fixed answer.txt" }
            ],
            "auto_steer_budget": 2
        })
        .to_string();
        let resp = handle(&app, "POST", "/api/sessions", &body);
        assert!(resp.starts_with("HTTP/1.1 201"), "{resp}");
        let created = response_body(&resp);
        let sid = created["id"].as_str().unwrap().to_string();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            if matches!(app.status_of(&sid).as_deref(), Some("done" | "needs-you")) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let got = handle(&app, "GET", &format!("/api/sessions/{sid}"), "");
        let session = response_body(&got);
        assert_eq!(session["status"], "done", "session={session}");
        assert_eq!(session["auto_healed"], true, "session={session}");
        assert_eq!(session["auto_steer_budget"], 2);
        assert_eq!(session["heal_badge"], "Healed on attempt 1/2");
        let attempts = session["heal_attempts"].as_array().unwrap();
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0]["attempt"], 1);
        assert_eq!(attempts[0]["trigger_step"], "verify-answer");
        assert_eq!(attempts[0]["healed"], true);
        assert!(attempts[0]["prompt_sent"]
            .as_str()
            .unwrap()
            .contains("Verification check failed"));

        // Verify SSE auto_heal_attempt events were broadcast for both started and finished phases.
        let mut saw_started = false;
        let mut saw_finished = false;
        while let Ok(frame) = sub.rx.try_recv() {
            if frame.contains("event: auto_heal_attempt\n") {
                if let Some(data_line) = frame.lines().find(|l| l.starts_with("data: ")) {
                    let payload: serde_json::Value =
                        serde_json::from_str(&data_line["data: ".len()..]).unwrap();
                    if payload["id"] == sid {
                        if payload["phase"] == "started" {
                            saw_started = true;
                        }
                        if payload["phase"] == "finished" && payload["attempt"]["healed"] == true {
                            saw_finished = true;
                        }
                    }
                }
            }
        }
        assert!(saw_started, "expected SSE auto_heal_attempt phase=started");
        assert!(saw_finished, "expected SSE auto_heal_attempt phase=finished healed=true");

        // Verify GET /api/metrics counts this as auto_healed (not first_pass).
        let m_resp = handle(&app, "GET", "/api/metrics", "");
        assert!(m_resp.starts_with("HTTP/1.1 200"));
        let metrics = response_body(&m_resp);
        assert_eq!(metrics["total"], 1);
        assert_eq!(metrics["first_pass_count"], 0);
        assert_eq!(metrics["auto_healed_count"], 1);
        assert_eq!(metrics["effective_pass_rate_pct"], 100.0);
        assert_eq!(metrics["first_pass_rate_pct"], 0.0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v060_auto_heal_loop_guard_halts_identical_error_early() {
        let dir = std::env::temp_dir().join(format!("fleet-v060-heal-loop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git_repo(&dir.join("repo"));
        let agent = script_agent(
            &dir,
            "stubborn-agent.sh",
            "#!/bin/sh\necho still-broken >> log.txt\n",
        );
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let app = test_app(data.clone(), Vec::new());

        let body = serde_json::json!({
            "repo": repo.to_string_lossy(),
            "task": "fix stubborn test",
            "agent": agent.to_string_lossy(),
            "check_steps": [
                { "name": "unit", "cmd": "echo 'AssertionError: expected 42 got 0' >&2; exit 2" }
            ],
            "auto_steer_budget": 3
        })
        .to_string();
        let resp = handle(&app, "POST", "/api/sessions", &body);
        assert!(resp.starts_with("HTTP/1.1 201"), "{resp}");
        let sid = response_body(&resp)["id"].as_str().unwrap().to_string();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            if matches!(app.status_of(&sid).as_deref(), Some("done" | "needs-you")) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let got = handle(&app, "GET", &format!("/api/sessions/{sid}"), "");
        let session = response_body(&got);
        assert_eq!(session["status"], "needs-you", "session={session}");
        assert_eq!(session["auto_healed"], false);
        let attempts = session["heal_attempts"].as_array().unwrap();
        assert_eq!(
            attempts.len(),
            1,
            "loop guard must halt after attempt 1 on identical error instead of exhausting budget=3"
        );
        assert!(session["reason"]
            .as_str()
            .unwrap_or("")
            .contains("identical error"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v060_guardrail_violation_never_triggers_auto_heal() {
        let dir = std::env::temp_dir().join(format!("fleet-v060-heal-guard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git_repo(&dir.join("repo"));
        let agent = script_agent(
            &dir,
            "naughty-agent.sh",
            "#!/bin/sh\necho SECRET=1 > .env\necho ok > README.md\n",
        );
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let app = test_app(data.clone(), Vec::new());

        let body = serde_json::json!({
            "repo": repo.to_string_lossy(),
            "task": "update docs only",
            "agent": agent.to_string_lossy(),
            "check": "test -s README.md",
            "allowed_globs": ["README.md"],
            "forbidden_globs": [".env"],
            "auto_steer_budget": 3
        })
        .to_string();
        let resp = handle(&app, "POST", "/api/sessions", &body);
        assert!(resp.starts_with("HTTP/1.1 201"), "{resp}");
        let sid = response_body(&resp)["id"].as_str().unwrap().to_string();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            if matches!(app.status_of(&sid).as_deref(), Some("done" | "needs-you")) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let got = handle(&app, "GET", &format!("/api/sessions/{sid}"), "");
        let session = response_body(&got);
        assert_eq!(session["status"], "needs-you", "session={session}");
        assert_eq!(session["heal_attempts"].as_array().unwrap().len(), 0);
        assert!(!session["guardrail_violations"].as_array().unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v060_templates_crud_persistence_and_metrics_endpoint() {
        let dir = std::env::temp_dir().join(format!("fleet-v060-tpl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();

        let mut s1 = test_session("s1", Status::Done, &dir);
        s1.repo = "/work/alpha".to_string();
        s1.project = "alpha".to_string();
        let mut s2 = test_session("s2", Status::NeedsYou, &dir);
        s2.repo = "/work/beta".to_string();
        s2.project = "beta".to_string();
        s2.check_passed = Some(false);
        let app = test_app(data.clone(), vec![s1, s2]);

        // Policy advertises v0.6.0 features.
        let pol = response_body(&handle(&app, "GET", "/api/policy", ""));
        assert_eq!(pol["features"]["auto_heal"], true);
        assert_eq!(pol["features"]["templates"], true);
        assert_eq!(pol["features"]["metrics"], true);

        // GET /api/metrics returns exact counts and max_parallel.
        let met = response_body(&handle(&app, "GET", "/api/metrics", ""));
        assert_eq!(met["total"], 2);
        assert_eq!(met["first_pass_count"], 1);
        assert_eq!(met["needs_you_count"], 1);
        assert_eq!(met["first_pass_rate_pct"], 50.0);
        assert!(met["max_parallel"].as_i64().unwrap_or(0) >= 1);
        assert_eq!(met["per_repo_breakdown"].as_array().unwrap().len(), 2);

        // GET /api/templates returns 4 built-in playbooks.
        let list = response_body(&handle(&app, "GET", "/api/templates", ""));
        assert_eq!(list["templates"].as_array().unwrap().len(), 4);

        // POST /api/templates creates a custom playbook (accepting UI-style `alias` on tasks).
        let create_payload = serde_json::json!({
            "name": "API Release Smoke",
            "description": "Lint + contract smoke across backend services",
            "repo": "/work/alpha",
            "check_steps": [{ "name": "smoke", "cmd": "npm test", "timeout_secs": 90 }],
            "allowed_globs": ["src/**", "tests/**"],
            "forbidden_globs": [".env"],
            "auto_steer_budget": 2,
            "tasks": [
                { "alias": "api", "task": "Add endpoint" },
                { "alias": "tests", "task": "Add contract test", "depends_on": ["api"] }
            ]
        })
        .to_string();
        let created_resp = handle(&app, "POST", "/api/templates", &create_payload);
        assert!(created_resp.starts_with("HTTP/1.1 201"), "{created_resp}");
        let created = response_body(&created_resp);
        let tpl_id = created["id"].as_str().unwrap().to_string();
        assert_eq!(created["name"], "API Release Smoke");
        assert_eq!(created["tasks"][0]["key"], "api");

        // Reload store from disk and verify persistence.
        let reloaded = test_app(data.clone(), Vec::new());
        let after_reload = response_body(&handle(&reloaded, "GET", "/api/templates", ""));
        assert_eq!(after_reload["templates"].as_array().unwrap().len(), 5);

        // Cross-origin DELETE is blocked by CSRF guard (403).
        let csrf_block = respond(
            &app,
            "",
            "DELETE",
            &format!("/api/templates/{tpl_id}"),
            "",
            "",
            "https://evil.example",
            "127.0.0.1:8471",
        );
        assert!(csrf_block.starts_with("HTTP/1.1 403"), "{csrf_block}");

        // Same-origin DELETE succeeds (200) and second DELETE returns 404.
        let del_ok = respond(
            &app,
            "",
            "DELETE",
            &format!("/api/templates/{tpl_id}"),
            "",
            "",
            "http://127.0.0.1:8471",
            "127.0.0.1:8471",
        );
        assert!(del_ok.starts_with("HTTP/1.1 200"), "{del_ok}");
        let del_again = handle(&app, "DELETE", &format!("/api/templates/{tpl_id}"), "");
        assert!(del_again.starts_with("HTTP/1.1 404"), "{del_again}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
