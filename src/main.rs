//! fleet-rs — your agents working in parallel under one screen.
//!
//! You hand out work; each hand-out launches a real CLI agent in its own git
//! worktree; when the agent claims completion the app itself runs the check
//! attached to the task, and only a passing check earns the "done" status.
//! Session policies (parallel cap, default checks) live in policies.rn and
//! are executed through Rune — they drive behaviour, they are not metadata.

use serde::Serialize;
use std::os::unix::ffi::OsStrExt as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------------------
// Rune policy layer
// ---------------------------------------------------------------------------

struct Policy {
    unit: Arc<rune::Unit>,
    runtime: Arc<rune::runtime::RuntimeContext>,
    max_parallel: i64,
    /// Agent/check execution cap in seconds. Read from the policy's
    /// optional timeout_secs(); a policy that doesn't define it gets
    /// DEFAULT_TIMEOUT_SECS — never infinity.
    timeout_secs: u64,
    /// The house model route, from the policy's optional
    /// agent_model() — one config point for which model agent
    /// sessions run. Passed to the engine that speaks that provider
    /// namespace (opencode). Absent means the engine's own default.
    model: Option<String>,
}

const DEFAULT_TIMEOUT_SECS: u64 = 1800;

/// In-memory transcript cap per session (the on-disk log is uncapped).
const TRANSCRIPT_CAP: usize = 2000;
/// Stored-transcript byte budget per session (see log()).
const TRANSCRIPT_BYTES: usize = 512 * 1024;
/// The largest run timeout a policy may set (one week).
const MAX_TIMEOUT_SECS: u64 = 604_800;
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

impl Policy {
    fn load(script: &str) -> Result<Policy, String> {
        let context = rune::Context::with_default_modules().map_err(|e| e.to_string())?;
        let runtime = Arc::new(context.runtime().map_err(|e| e.to_string())?);
        let mut sources = rune::Sources::new();
        sources
            .insert(rune::Source::memory(script).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let mut diagnostics = rune::Diagnostics::new();
        let unit = rune::prepare(&mut sources)
            .with_context(&context)
            .with_diagnostics(&mut diagnostics)
            .build()
            .map_err(|e| format!("policy script failed to build: {e}"))?;
        let unit = Arc::new(unit);
        let mut policy = Policy {
            unit,
            runtime,
            max_parallel: 1,
            timeout_secs: DEFAULT_TIMEOUT_SECS,
            model: None,
        };
        // agent_model is optional in the policy file; absent or
        // unusable means the engine's own default model.
        if let Ok(m) = policy.call_string("agent_model", ()) {
            if !m.is_empty() {
                policy.model = Some(m);
            }
        }
        policy.max_parallel = policy.call_i64("max_parallel", ())?;
        if policy.max_parallel < 1 {
            // A cap of zero would queue every session forever with
            // nothing anywhere saying why. The floor is 1.
            policy.max_parallel = 1;
        }
        // timeout_secs is optional in the policy file; absent or
        // unusable means the default, never "no timeout".
        if let Ok(secs) = policy.call_i64("timeout_secs", ()) {
            if secs > 0 {
                // Clamped: a policy value near i64::MAX would
                // overflow Instant + Duration in the runner and
                // panic the worker, leaving the session working
                // forever. A week is beyond any real run.
                policy.timeout_secs = (secs as u64).min(MAX_TIMEOUT_SECS);
            }
        }
        Ok(policy)
    }

    fn vm(&self) -> rune::Vm {
        rune::Vm::new(self.runtime.clone(), self.unit.clone())
    }

    fn call_i64<A>(&self, name: &str, args: A) -> Result<i64, String>
    where
        A: rune::runtime::Args + rune::runtime::GuardedArgs,
    {
        let value = self
            .vm()
            .call([name], args)
            .map_err(|e| format!("policy call {name} failed: {e}"))?;
        rune::from_value::<i64>(value).map_err(|e| format!("policy {name} returned non-integer: {e}"))
    }

    fn call_string<A>(&self, name: &str, args: A) -> Result<String, String>
    where
        A: rune::runtime::Args + rune::runtime::GuardedArgs,
    {
        let value = self
            .vm()
            .call([name], args)
            .map_err(|e| format!("policy call {name} failed: {e}"))?;
        rune::from_value::<String>(value)
            .map_err(|e| format!("policy {name} returned non-string: {e}"))
    }

    fn default_check(&self, project: &str) -> Result<String, String> {
        let value = self
            .vm()
            .call(["default_check"], (project.to_string(),))
            .map_err(|e| format!("policy call default_check failed: {e}"))?;
        rune::from_value::<String>(value)
            .map_err(|e| format!("policy default_check returned non-string: {e}"))
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
        _ => match &app.default_agent {
            Some(d) => validate_agent(app, d)
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
                vec![
                    "exec".to_string(),
                    "--sandbox".to_string(),
                    "workspace-write".to_string(),
                    "--color".to_string(),
                    "never".to_string(),
                    prompt.to_string(),
                ]
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
            Status::Queued | Status::Working | Status::Checking => "working",
            Status::NeedsYou => "needs-you",
            Status::Done | Status::Merged => "done",
            Status::Archived => "archived",
        }
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
    transcript: Vec<String>,
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

struct App {
    policy: Policy,
    /// The policy file actually loaded (argv), reported by /api/policy
    /// as the source — never a hardcoded display string.
    policy_source: String,
    agents: Vec<AgentInfo>,
    default_agent: Option<String>,
    data_dir: PathBuf,
    /// Tag unique to this server run, baked into session ids and branch
    /// names so a restarted server can never collide with worktrees or
    /// branches a previous run left in the target repo.
    run_tag: String,
    sessions: Mutex<Vec<Session>>,
    /// Transcript lines logged since the last snapshot — the persist
    /// cadence counter (see log()).
    lines_since_persist: std::sync::atomic::AtomicU64,
    counter: Mutex<u64>,
    /// Per-session stop flags. A session's worker thread holds a
    /// clone of its flag and hands it to the bounded runner; the stop
    /// endpoint sets it. In-memory only — a restart already lands
    /// every live session in needs-you with the reason stated.
    stops: Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
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
            kill_group(pid);
            let _ = child.kill();
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
            kill_group(pid);
            let _ = child.kill();
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
                        kill_group(pid);
                        let _ = child.kill();
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
                                kill_group(pid);
                                let _ = child.kill();
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
    /// Snapshot all session state to disk (atomic rename), so a server
    /// restart loses nothing. The per-session log files are the durable
    /// transcript record; this file is the state snapshot.
    fn persist(&self) {
        let (snapshot, records) = {
            let sessions = self.sessions.lock().unwrap();
            let counter = self.counter.lock().unwrap();
            let snapshot = serde_json::json!({ "counter": *counter, "sessions": *sessions });
            // Each session's record: its settings and settled outcome,
            // next to its log. The transcript is already in the log.
            let records: Vec<Session> = sessions
                .iter()
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
        let logs_dir = self.data_dir.join("logs");
        let _ = std::fs::create_dir_all(&logs_dir);
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
        self.persist();
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
        self.log(id, format!("needs you: {reason}"));
        self.persist();
    }
    fn status_of(&self, id: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.status.clone())
    }

    /// The session JSON for the API. Each distinct repo's merge target
    /// is resolved with git outside the sessions lock, once per request;
    /// the JSON is then built under the lock with no git calls in it. A
    /// session that appears while the targets are being resolved is
    /// picked up on the next pass.
    fn sessions_view(&self) -> serde_json::Value {
        let mut targets: std::collections::HashMap<String, Option<String>> =
            std::collections::HashMap::new();
        loop {
            let missing: Vec<String> = {
                let sessions = self.sessions.lock().unwrap();
                let mut repos: Vec<String> = sessions
                    .iter()
                    .filter(|s| !s.repo.is_empty() && !targets.contains_key(&s.repo))
                    .map(|s| s.repo.clone())
                    .collect();
                repos.sort();
                repos.dedup();
                if repos.is_empty() {
                    return sessions_json(&sessions, &targets);
                }
                repos
            };
            for repo in missing {
                let target = merge_target(&repo);
                targets.insert(repo, target);
            }
        }
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
                        // Keep the marker (index 0 when present) and
                        // the newest lines; drop oldest real lines.
                        let start = if s.transcript.first().is_some_and(|l| l.starts_with('…')) {
                            1
                        } else {
                            0
                        };
                        let mut idx = start;
                        while over > 0 && s.transcript.len() > idx + 1 {
                            over = over.saturating_sub(s.transcript[idx].len() + 1);
                            s.transcript.remove(idx);
                        }
                    }
                    s.transcript.len()
                }
                None => return,
            }
        };
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
        let _ = count;
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
    fn active_count(&self) -> i64 {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.bucket == "working" && s.status != "queued")
            .count() as i64
    }

    /// Start a session's worker thread if a parallel slot is free;
    /// otherwise it stays queued. Called on creation and whenever a
    /// session settles.
    fn maybe_start(self: &Arc<Self>, id: &str) {
        // Claim the session under one lock hold: the status check,
        // the cap check and the move to Working are one atomic step,
        // so two concurrent callers (a settle pumping the queue, an
        // HTTP retry) can never both spawn a worker for one session.
        {
            let mut sessions = self.sessions.lock().unwrap();
            let active = sessions
                .iter()
                .filter(|x| x.bucket == "working" && x.status != "queued")
                .count() as i64;
            let Some(s) = sessions.iter_mut().find(|s| s.id == id) else {
                return;
            };
            if s.status != "queued" {
                return;
            }
            if active >= self.policy.max_parallel {
                return;
            }
            s.status = Status::Working.label().to_string();
            s.bucket = Status::Working.bucket().to_string();
        }
        self.persist();
        let app = self.clone();
        let id = id.to_string();
        std::thread::spawn(move || app.run_session(&id));
    }

    fn pump_queue(self: &Arc<Self>) {
        let queued: Vec<String> = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.status == "queued")
            .map(|s| s.id.clone())
            .collect();
        for id in queued {
            self.maybe_start(&id);
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
        let timeout = self.policy.timeout_secs;
        let app_lines = self.clone();
        let id_lines = id.to_string();
        let mut on_line = move |is_err: bool, line: &str| {
            if is_err {
                app_lines.log(&id_lines, format!("stderr: {line}"));
            } else {
                app_lines.log(&id_lines, line.to_string());
            }
        };
        let (prog, args) = engine_command(
            &session.agent,
            self.policy.model.as_deref(),
            prompt,
            continuation,
        );
        let mut agent_cmd = Command::new(&prog);
        agent_cmd.args(&args).current_dir(wt);
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
        let timeout = self.policy.timeout_secs;
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
        let mut sink = |_: bool, _: &str| {};
        let mut check_cmd_proc = Command::new("sh");
        check_cmd_proc
            .arg("-c")
            .arg(&session.check_cmd)
            .current_dir(check_dir);
        let flag = self.stop_flag(id);
        let outcome = run_bounded(check_cmd_proc, timeout, Some(&flag), &mut sink);
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
        let check_ran = !pristine_failed && !matches!(outcome.end, RunEnd::SpawnFailed(_));
        let check_exit = outcome.code;
        let (passed, output, check_timed_out, check_pipes_held, check_stopped) = if pristine_failed {
            (
                false,
                "fleet could not create a pristine checkout of the verified commit to run the check in — the check was not run"
                    .to_string(),
                false,
                false,
                false,
            )
        } else {
            match outcome.end {
            RunEnd::SpawnFailed(e) => (false, format!("check could not run: {e}"), false, false, false),
            RunEnd::Exited(ok) => (ok, outcome.lines.join("\n"), false, false, false),
            RunEnd::TimedOut => (
                false,
                format!(
                    "{}\n(check timed out after {timeout}s and was killed)",
                    outcome.lines.join("\n")
                ),
                true,
                false,
                false,
            ),
            RunEnd::PipesHeld => (
                false,
                format!(
                    "{}\n(check's output stayed open past the limit — a detached process held it; the process group was killed)",
                    outcome.lines.join("\n")
                ),
                false,
                true,
                false,
            ),
            RunEnd::Stopped => (
                false,
                format!(
                    "{}\n(check stopped by you and killed)",
                    outcome.lines.join("\n")
                ),
                false,
                false,
                true,
            ),
            }
        };

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
        // The full check output goes to the session's log file before
        // the stored copy is capped — the cap must never lose it.
        self.append_log_text(id, &format!("--- check output ---\n{output}\n--- end check output ---"));
        let failed_reason = Self::check_failure_reason(&session.check_cmd, check_exit, &output);
        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(s) = sessions.iter_mut().find(|s| s.id == id) {
                s.check_output = Some(truncate_output(output));
                s.check_passed = Some(passed);
                s.check_ran = check_ran;
                s.check_exit = check_exit;
                s.diff = truncate_output(diff.clone());
                // Provisional: every needs-you path below clears it.
                s.verified_commit = tip.clone();
            }
        }
        self.persist();
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
                self.log(id, "check passed — verified done".to_string());
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
            self.set_needs_you(
                id,
                &format!("check timed out after {timeout}s: {}", session.check_cmd),
            );
        } else if check_stopped {
            self.log(id, "check stopped by you — this needs you".to_string());
            self.set_needs_you(id, "stopped by you while the check was running");
        } else {
            self.log(id, "check FAILED — this needs you".to_string());
            let reason = if check_ran {
                failed_reason
            } else {
                format!("the check did not run: {}", session.check_cmd)
            };
            self.set_needs_you(id, &reason);
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
            if matches!(s.status.as_str(), "queued" | "working" | "checking") {
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
            s.reason = None;
            s.diff = String::new();
            s.verified_commit = None;
            s.status = Status::Queued.label().to_string();
            s.bucket = Status::Queued.bucket().to_string();
        }
        self.log(id, "retry: handed back to the agent".to_string());
        self.persist();
        self.maybe_start(id);
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
                s.reason = None;
                s.diff = String::new();
                s.verified_commit = None;
                s.status = Status::Queued.label().to_string();
                s.bucket = Status::Queued.bucket().to_string();
            }
        }
        self.persist();
        self.maybe_start(id);
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
                transcript: Vec::new(),
            };
            sessions.push(child);
            task
        };
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
    fn dismiss(&self, id: &str) -> Result<(), String> {
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
        self.persist();
        Ok(())
    }

    /// Stop a session at the operator's word. A live run (agent or
    /// check) is killed through its stop flag — the bounded runner
    /// kills the whole process group and lands the session in
    /// needs-you with "stopped by you" as the reason. A queued
    /// session is cancelled before it ever starts. A settled session
    /// cannot be stopped; the refusal names its status.
    fn stop(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let status = self.status_of(id).ok_or("no such session")?;
        match status.as_str() {
            "queued" => {
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
                "session is '{other}' — only a queued, working or checking session can be stopped"
            )),
        }
    }

    fn merge(&self, id: &str) -> Result<(String, String), MergeError> {
        let mut detail = String::new();
        let result = self.merge_landing(id, &mut detail).map_err(|message| MergeError {
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
            self.persist();
        }
    }

    /// The merge itself. A refusal carries a plain sentence; git's own
    /// text for a refusal git made is left in `detail`.
    fn merge_landing(&self, id: &str, detail: &mut String) -> Result<(String, String), String> {
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
        // Merge safety: the operator's own state in that repo is not
        // ours to entangle. A merge already in progress, or uncommitted
        // changes to tracked files, stops the merge before it starts.
        let repo_path = Path::new(&session.repo);
        if repo_path.join(".git").join("MERGE_HEAD").exists() {
            return Err(
                "repo already has a merge in progress — resolve or abort it before merging a session"
                    .to_string(),
            );
        }
        let status = Command::new("git")
            .arg("-C")
            .arg(&session.repo)
            .args(["status", "--porcelain"])
            .output()
            .map_err(|e| e.to_string())?;
        let dirty = String::from_utf8_lossy(&status.stdout)
            .lines()
            .any(|l| !l.starts_with("??"));
        if dirty {
            return Err(
                "repo has uncommitted changes — commit or stash them before merging a session"
                    .to_string(),
            );
        }
        // A detached HEAD advances no branch: the merge would
        // "succeed" into limbo and be orphaned at the next checkout.
        let on_branch = Command::new("git")
            .arg("-C")
            .arg(&session.repo)
            .args(["symbolic-ref", "-q", "HEAD"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !on_branch {
            return Err(
                "repo is on a detached HEAD — check out a branch before merging a session, or the work lands on no branch"
                    .to_string(),
            );
        }
        let target_branch = Command::new("git")
            .arg("-C")
            .arg(&session.repo)
            .args(["symbolic-ref", "--short", "-q", "HEAD"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        let out = Command::new("git")
            .arg("-C")
            .arg(&session.repo)
            .args(["merge", "--no-ff", "-m", &format!("merge fleet session {id}")])
            .arg(&pin)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            // Never leave the operator's repo mid-merge on our account.
            let _ = Command::new("git")
                .arg("-C")
                .arg(&session.repo)
                .args(["merge", "--abort"])
                .output();
            // Name the failure for what it is, with enough of git's
            // message to act on: a content conflict is a conflict; an
            // untracked-file collision (or any other refusal) is a
            // refusal, and the filename lives past the first line.
            // Git writes conflict markers to stdout and refusals to
            // stderr — read both.
            let raw = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            *detail = raw.trim().to_string();
            if let Some(plain) = plain_merge_refusal(&raw) {
                return Err(plain);
            }
            let lines: Vec<&str> = raw
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .take(3)
                .collect();
            let summary = if lines.is_empty() {
                "merge failed".to_string()
            } else {
                lines.join(" — ")
            };
            return Err(format!(
                "merge refused: {summary} — nothing was merged"
            ));
        }
        // Verify the landing, don't trust the merge's exit code alone:
        // the session's branch tip must now be part of the repo's
        // history, or nothing was actually merged.
        let landed = Command::new("git")
            .arg("-C")
            .arg(&session.repo)
            .args(["merge-base", "--is-ancestor", &pin, "HEAD"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !landed {
            return Err(
                "merge ran but the session's commit is not in the repo's history — nothing was landed"
                    .to_string(),
            );
        }
        self.set_status(id, Status::Merged);
        self.log(
            id,
            format!("merged into {target_branch} at {pin}"),
        );
        Ok((pin, target_branch))
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

fn read_request(
    stream: &mut std::net::TcpStream,
) -> Option<(String, String, String, String, String, String)> {
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(READ_DEADLINE_SECS);
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    // Arm the socket timeout for the next read: never more than the
    // per-read timeout, never past the request's deadline.
    let arm = |stream: &std::net::TcpStream| -> Option<()> {
        let remaining = deadline.checked_duration_since(std::time::Instant::now())?;
        let t = remaining.min(std::time::Duration::from_secs(READ_TIMEOUT_SECS));
        stream.set_read_timeout(Some(t)).ok()?;
        Some(())
    };
    // Lines are read byte by byte so the deadline is re-armed for
    // EVERY byte: arming once per read_line would let a drip feed
    // one byte per per-read timeout and outlive the deadline inside
    // a single line.
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
        }
    }
    // A declared body over the cap is refused without being read —
    // otherwise one connection can pin its handler thread (and a huge
    // allocation) by declaring a giant body and sending nothing.
    if content_length > MAX_BODY_BYTES {
        return Some((
            "__too_large__".to_string(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            host,
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
    ))
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

/// Serialize sessions for the API with queue positions computed in:
/// a queued session's position is its place among the queued, in
/// hand-out order. Non-queued sessions carry null.
fn sessions_json(
    sessions: &[Session],
    targets: &std::collections::HashMap<String, Option<String>>,
) -> serde_json::Value {
    let mut pos = 0usize;
    let arr: Vec<serde_json::Value> = sessions
        .iter()
        .map(|s| {
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

fn handle(app: &Arc<App>, method: &str, path: &str, body: &str) -> String {
    let (route, query) = match path.split_once('?') {
        Some((r, q)) => (r, q),
        None => (path, ""),
    };
    let _ = query;
    match (method, route) {
        ("GET", "/") => html_response(include_str!("../assets/index.html")),
        ("GET", "/api/policy") => json_response(
            200,
            &serde_json::json!({
                "max_parallel": app.policy.max_parallel,
                "agents": app.agents,
                "default_agent": app.default_agent,
                "default_agent_engine": app
                    .default_agent
                    .as_deref()
                    .map(|a| engine_kind(a).label()),
                "model": app.policy.model,
                "model_engine": "opencode",
                "timeout_secs": app.policy.timeout_secs,
                "source": app.policy_source
            })
            .to_string(),
        ),
        ("GET", "/api/sessions") => {
            json_response(200, &app.sessions_view().to_string())
        }
        ("POST", "/api/sessions") => {
            let req: serde_json::Value = match serde_json::from_str(body) {
                Ok(v) => v,
                Err(e) => return error_response(400, &format!("bad json: {e}")),
            };
            let task = req["task"].as_str().unwrap_or("").trim().to_string();
            let repo = req["repo"].as_str().unwrap_or("").trim().to_string();
            let project = req["project"].as_str().unwrap_or("default").to_string();
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
            let repo_ok = Path::new(&repo).join(".git").exists()
                && Command::new("git")
                    .arg("-C")
                    .arg(&repo)
                    .args(["rev-parse", "--git-dir"])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
            if !Path::new(&repo).is_dir() {
                return error_response(400, &format!("There is no folder at {repo}."));
            }
            if !repo_ok {
                return error_response(
                    400,
                    &format!(
                        "That folder is not a git repository: {repo}. Give the path of a folder that contains a .git folder, for example the one you run git in."
                    ),
                );
            }
            // A blank explicit check is no check: the policy default applies.
            let check_cmd = match req["check"].as_str().map(str::trim) {
                Some(c) if !c.is_empty() => c.to_string(),
                _ => match app.policy.default_check(&project) {
                    Ok(c) => c,
                    Err(e) => return error_response(500, &e),
                },
            };
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
                status: Status::Queued.label().to_string(),
                bucket: Status::Queued.bucket().to_string(),
                agent,
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
                transcript: Vec::new(),
            };
            app.sessions.lock().unwrap().push(session.clone());
            app.persist();
            app.maybe_start(&id);
            let all = app.sessions_view();
            let mine = all
                .as_array()
                .and_then(|a| {
                    a.iter()
                        .find(|v| v["id"].as_str() == Some(id.as_str()))
                        .cloned()
                })
                .unwrap_or_else(|| serde_json::to_value(&session).unwrap());
            json_response(201, &mine.to_string())
        }
        ("GET", route) if route.starts_with("/api/sessions/") => {
            let id = &route["/api/sessions/".len()..];
            let all = app.sessions_view();
            match all
                .as_array()
                .and_then(|a| a.iter().find(|v| v["id"].as_str() == Some(id)).cloned())
            {
                Some(v) => json_response(200, &v.to_string()),
                None => error_response(404, "no such session"),
            }
        }
        ("POST", route) if route.starts_with("/api/sessions/") && route.ends_with("/merge") => {
            let id = &route["/api/sessions/".len()..route.len() - "/merge".len()];
            match app.merge(id) {
                Ok((commit, branch)) => json_response(
                    200,
                    &serde_json::json!({
                        "merged": true,
                        "commit": commit,
                        "branch": branch
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
            let all = app.sessions_view();
            let inbox: Vec<serde_json::Value> = all
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|v| v["status"].as_str() == Some("needs-you"))
                .collect();
            json_response(200, &serde_json::Value::Array(inbox).to_string())
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
        let mut idx = start;
        while over > 0 && kept.len() > idx + 1 {
            over = over.saturating_sub(kept[idx].len() + 1);
            kept.remove(idx);
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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8471);
    let agents = detect_agents();
    let default_agent = std::env::var("FLEET_AGENT")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            agents
                .iter()
                .find(|a| a.found)
                .map(|a| a.name.clone())
        });
    let policy_path = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "policies.rn".to_string());
    let script = std::fs::read_to_string(&policy_path)
        .unwrap_or_else(|e| panic!("cannot read policy script {policy_path}: {e}"));
    let policy = Policy::load(&script).unwrap_or_else(|e| panic!("policy load failed: {e}"));
    let data_dir = std::env::var("FLEET_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("./fleet-data"));
    let _ = std::fs::create_dir_all(data_dir.join("worktrees"));
    let _ = std::fs::create_dir_all(data_dir.join("logs"));

    let run_tag = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "run".to_string());
    let (restored, restored_counter) = load_persisted(&data_dir);
    let app = Arc::new(App {
        policy,
        policy_source: policy_path.clone(),
        agents,
        default_agent,
        data_dir,
        run_tag,
        sessions: Mutex::new(restored),
        lines_since_persist: std::sync::atomic::AtomicU64::new(0),
        counter: Mutex::new(restored_counter),
        stops: Mutex::new(std::collections::HashMap::new()),
    });

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

    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind failed");
    let allowed_hosts = std::env::var("FLEET_ALLOWED_HOSTS").unwrap_or_default();
    let detected: Vec<String> = app
        .agents
        .iter()
        .map(|a| format!("{}:{}", a.name, if a.found { "found" } else { "not found" }))
        .collect();
    println!(
        "fleet-rs listening on http://127.0.0.1:{port} (agents: {}; default: {}; max_parallel: {})",
        detected.join(", "),
        app.default_agent.as_deref().unwrap_or("none"),
        app.policy.max_parallel
    );
    for stream in listener.incoming() {
        match stream {
            Ok(mut stream) => {
                let app = app.clone();
                let allowed_hosts = allowed_hosts.clone();
                std::thread::spawn(move || {
                    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(
                        READ_TIMEOUT_SECS,
                    )));
                    if let Some((method, path, body, content_type, origin, host)) =
                        read_request(&mut stream)
                    {
                        let response = if method == "__headers_too_large__" {
                            error_response(431, "request headers are too large")
                        } else if !host_allowed(&host, &allowed_hosts) {
                            error_response(403, "this board answers only to its own host name")
                        } else if method == "__too_large__" {
                            error_response(413, "request body too large")
                        } else if method == "POST"
                            && !content_type.starts_with("application/json")
                        {
                            // A browser "simple request" (text/plain,
                            // no preflight) must never reach a handler:
                            // requiring JSON is what makes a drive-by
                            // POST from another site impossible.
                            error_response(415, "POST requires Content-Type: application/json")
                        } else if method == "POST"
                            && !origin.is_empty()
                            && !origin_is_local(&origin)
                        {
                            error_response(403, "cross-origin requests are refused")
                        } else {
                            handle(&app, &method, &path, &body)
                        };
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

/// Git's refusal text for a merge, in plain words, for the two cases
/// the operator can act on: a missing committer identity and a content
/// conflict. Anything else is described by the caller from git's own lines.
fn plain_merge_refusal(raw: &str) -> Option<String> {
    if raw.contains("identity unknown")
        || raw.contains("Please tell me who you are")
        || raw.contains("auto-detection is disabled")
    {
        return Some("Git has no name and email for the merge commit. Set them with git config user.name and git config user.email in this repo, then merge again. Nothing was merged.".to_string());
    }
    if raw.contains("CONFLICT") {
        let files: Vec<&str> = raw
            .lines()
            .filter_map(|l| l.split_once("Merge conflict in ").map(|(_, f)| f.trim()))
            .collect();
        return Some(if files.is_empty() {
            "Merge conflict. Nothing was merged.".to_string()
        } else {
            format!("Merge conflict in {}. Nothing was merged.", files.join(", "))
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

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
            Some("opencode-go/deepseek-v4.1-flash")
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
        let model = Some("opencode-go/deepseek-v4.1-flash");
        // opencode: `run`, the house model, the prompt last.
        let (prog, args) = engine_command("opencode", model, "do it", false);
        assert_eq!(prog, "opencode");
        assert_eq!(
            args,
            vec!["run", "--model", "opencode-go/deepseek-v4.1-flash", "do it"]
        );
        // Steering continues the same conversation.
        let (_, args) = engine_command("opencode", model, "also this", true);
        assert_eq!(
            args,
            vec!["run", "--model", "opencode-go/deepseek-v4.1-flash", "--continue", "also this"]
        );
        // claude: print mode; the OpenCode Go model id is NOT passed —
        // it names a provider claude does not speak.
        let (_, args) = engine_command("claude", model, "do it", false);
        assert_eq!(args, vec!["-p", "do it"]);
        let (_, args) = engine_command("claude", model, "also this", true);
        assert_eq!(args, vec!["-p", "--continue", "also this"]);
        // codex: exec with a workspace-write sandbox; resume --last
        // continues (and keeps the first run's sandbox).
        let (_, args) = engine_command("codex", model, "do it", false);
        assert_eq!(
            args,
            vec!["exec", "--sandbox", "workspace-write", "--color", "never", "do it"]
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
            data_dir: dir.join("data"),
            run_tag: "test".to_string(),
            sessions: Mutex::new(Vec::new()),
            lines_since_persist: std::sync::atomic::AtomicU64::new(0),
            counter: Mutex::new(0),
            stops: Mutex::new(std::collections::HashMap::new()),
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
            data_dir,
            run_tag: "test".to_string(),
            sessions: Mutex::new(sessions),
            lines_since_persist: std::sync::atomic::AtomicU64::new(0),
            counter: Mutex::new(0),
            stops: Mutex::new(std::collections::HashMap::new()),
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
}
