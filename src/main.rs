//! fleet-rs — your agents working in parallel under one screen.
//!
//! You hand out work; each hand-out launches a real CLI agent in its own git
//! worktree; when the agent claims completion the app itself runs the check
//! attached to the task, and only a passing check earns the "done" status.
//! Session policies (parallel cap, default checks) live in policies.rn and
//! are executed through Rune — they drive behaviour, they are not metadata.

use serde::Serialize;
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
}

const DEFAULT_TIMEOUT_SECS: u64 = 1800;

/// In-memory transcript cap per session (the on-disk log is uncapped).
const TRANSCRIPT_CAP: usize = 2000;
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
        };
        policy.max_parallel = policy.call_i64("max_parallel", ())?;
        // timeout_secs is optional in the policy file; absent or
        // unusable means the default, never "no timeout".
        if let Ok(secs) = policy.call_i64("timeout_secs", ()) {
            if secs > 0 {
                policy.timeout_secs = secs as u64;
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
        }
    }
    /// The three buckets the sidebar shows: working / needs you / done.
    fn bucket(self) -> &'static str {
        match self {
            Status::Queued | Status::Working | Status::Checking => "working",
            Status::NeedsYou => "needs-you",
            Status::Done | Status::Merged => "done",
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
    transcript: Vec<String>,
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
    counter: Mutex<u64>,
}

/// How a bounded run ended.
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
}

struct RunOutcome {
    end: RunEnd,
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
/// `on_line` as they arrive. The timeout bounds everything: the
/// process itself, and — after it exits — a short grace for its pipes
/// to close. A descendant that inherited the pipes (or detached into
/// the worktree) can therefore hold a session for at most the timeout
/// plus the grace, and is then killed with the group.
fn run_bounded(
    mut cmd: Command,
    timeout_secs: u64,
    on_line: &mut dyn FnMut(bool, &str),
) -> RunOutcome {
    use std::os::unix::process::CommandExt;
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return RunOutcome {
                end: RunEnd::SpawnFailed(e.to_string()),
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
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let mut lines: Vec<String> = Vec::new();
    let mut child_status: Option<bool> = None;
    // After the child exits, the pipes get a grace — but measured as
    // INACTIVITY, not wall time: a fast producer's backlog is still
    // being forwarded line by line, and draining it is progress, not
    // a stuck pipe. The pipes count as held only when the child is
    // gone, the pipes are still open, and nothing has flowed for the
    // grace (or the drain exceeds a hard cap, for a descendant that
    // prints forever).
    let mut exited_at: Option<std::time::Instant> = None;
    let mut last_line_at = std::time::Instant::now();
    let end = loop {
        if child_status.is_none() {
            match child.try_wait() {
                Ok(Some(st)) => {
                    child_status = Some(st.success());
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
                loop {
                    match child.try_wait() {
                        Ok(Some(st)) => {
                            child_status = Some(st.success());
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
    RunOutcome { end, lines }
}

impl App {
    /// Snapshot all session state to disk (atomic rename), so a server
    /// restart loses nothing. The per-session log files are the durable
    /// transcript record; this file is the state snapshot.
    fn persist(&self) {
        let snapshot = {
            let sessions = self.sessions.lock().unwrap();
            let counter = self.counter.lock().unwrap();
            serde_json::json!({ "counter": *counter, "sessions": *sessions })
        };
        let tmp = self.data_dir.join("sessions.json.tmp");
        let dst = self.data_dir.join("sessions.json");
        if std::fs::write(&tmp, snapshot.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, &dst);
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
            let _ = writeln!(f, "{line}");
        }
        if count % 25 == 0 {
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
        if self.status_of(id).as_deref() != Some("queued") {
            return;
        }
        if self.active_count() >= self.policy.max_parallel {
            return;
        }
        self.set_status(id, Status::Working);
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
        let session = {
            let sessions = self.sessions.lock().unwrap();
            sessions.iter().find(|s| s.id == id).unwrap().clone()
        };
        let repo = PathBuf::from(&session.repo);
        let wt = PathBuf::from(&session.worktree);

        // 1. Isolated worktree on its own branch. On a retry the
        // worktree already exists with the agent's earlier work in it —
        // reuse it, so the agent continues from what it already did.
        if wt.join(".git").exists() {
            self.log(
                id,
                format!("reusing existing worktree on branch {}", session.branch),
            );
            return self.run_agent_and_check(id, &session, &wt);
        }
        if let Some(parent) = wt.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // If the session's branch already exists (its worktree
        // directory was deleted after an earlier run), restore the
        // worktree from the branch — `add -b` would refuse, the branch
        // exists, and the session's committed work would be stranded.
        let out = if self.branch_exists(&session.repo, &session.branch) {
            let _ = Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["worktree", "prune"])
                .output();
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

        self.run_agent_and_check(id, &session, &wt);
    }

    /// Steps 2–4 of a session: run the agent in its worktree, run the
    /// task's check, record the outcome. Entered with the worktree ready
    /// (freshly created, or reused on a retry).
    fn run_agent_and_check(self: &Arc<Self>, id: &str, session: &Session, wt: &Path) {
        // Baseline of ignored files before the agent touches anything,
        // so step 4 can tell agent-produced ignored files from the
        // repo's pre-existing ones.
        let ignored_baseline = self.ignored_baseline(id, wt);
        // 2. Run the agent in the worktree, streaming its output.
        self.log(id, format!("agent started: {}", session.task));
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
        let mut agent_cmd = Command::new(&session.agent);
        agent_cmd.arg(&session.task).current_dir(wt);
        let outcome = run_bounded(agent_cmd, timeout, &mut on_line);
        match outcome.end {
            RunEnd::SpawnFailed(e) => {
                self.log(id, format!("agent failed to start: {e}"));
                self.set_needs_you(id, &format!("agent failed to start: {}", session.agent));
                self.pump_queue();
                return;
            }
            RunEnd::TimedOut => {
                self.log(
                    id,
                    format!("agent timed out after {timeout}s — killed its whole process group; handing back to you"),
                );
                self.set_needs_you(id, &format!("agent timed out after {timeout}s"));
                self.pump_queue();
                return;
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
                return;
            }
            RunEnd::Exited(false) => {
                self.log(id, "agent exited non-zero — handing back to you".to_string());
                self.set_needs_you(id, "agent exited non-zero");
                self.pump_queue();
                return;
            }
            RunEnd::Exited(true) => {}
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
        let commit_error = match &commit {
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

        // 4. Verified done: the app runs the task's check itself, on
        // the committed tree (the worktree now matches the commit).
        self.set_status(id, Status::Checking);
        let timeout = self.policy.timeout_secs;
        let mut sink = |_: bool, _: &str| {};
        let mut check_cmd_proc = Command::new("sh");
        check_cmd_proc
            .arg("-c")
            .arg(&session.check_cmd)
            .current_dir(wt);
        let outcome = run_bounded(check_cmd_proc, timeout, &mut sink);
        let (passed, output, check_timed_out, check_pipes_held) = match outcome.end {
            RunEnd::SpawnFailed(e) => (false, format!("check could not run: {e}"), false, false),
            RunEnd::Exited(ok) => (ok, outcome.lines.join("\n"), false, false),
            RunEnd::TimedOut => (
                false,
                format!(
                    "{}\n(check timed out after {timeout}s and was killed)",
                    outcome.lines.join("\n")
                ),
                true,
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
            ),
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
        // Problems inside the committed tree itself: a nested repo
        // (bare gitlink) or an escaping symlink would make "merged"
        // a lie no matter what the check said.
        let tree_problems = tip
            .as_deref()
            .map(|t| Self::tree_problems(wt, t))
            .unwrap_or_default();
        // The full check output goes to the session's log file before
        // the stored copy is capped — the cap must never lose it.
        self.append_log_text(id, &format!("--- check output ---\n{output}"));
        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(s) = sessions.iter_mut().find(|s| s.id == id) {
                s.check_output = Some(truncate_output(output));
                s.check_passed = Some(passed);
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
        } else if !tree_problems.is_empty() {
            let named = tree_problems.join("; ");
            self.log(id, format!("the committed tree cannot be merged as work: {named}"));
            self.set_needs_you(
                id,
                &format!("the committed tree cannot be merged as work: {named}"),
            );
        } else if passed && !new_ignored.is_empty() {
            self.log(
                id,
                format!(
                    "check passed, but the agent produced files this repo gitignores — they cannot be committed or merged: {}",
                    new_ignored.join(", ")
                ),
            );
            self.set_needs_you(
                id,
                &format!(
                    "agent produced files this repo gitignores — they cannot be committed or merged: {}",
                    new_ignored.join(", ")
                ),
            );
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
            self.log(id, "check passed — verified done".to_string());
            self.set_status(id, Status::Done);
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
        } else {
            self.log(id, "check FAILED — this needs you".to_string());
            self.set_needs_you(id, &format!("check failed: {}", session.check_cmd));
        }
        self.pump_queue();
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

    /// Problems in the committed tree that would make "merged" a lie:
    /// a nested git repository commits as a bare gitlink (its content
    /// never enters this repo), and a symlink whose target is absolute
    /// or escapes the repo lands as a pointer to somewhere else.
    fn tree_problems(wt: &Path, commit: &str) -> Vec<String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(wt)
            .args(["ls-tree", "-r", commit])
            .output();
        let mut problems = Vec::new();
        let Ok(o) = out else { return problems };
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            // "<mode> <type> <hash>\t<path>"
            let Some((meta, path)) = line.split_once('\t') else { continue };
            let mode = meta.split_whitespace().next().unwrap_or("");
            if mode == "160000" {
                problems.push(format!(
                    "{path} is a nested git repository — it commits as a bare pointer and its content never enters this repo"
                ));
            } else if mode == "120000" {
                let target = Command::new("git")
                    .arg("-C")
                    .arg(wt)
                    .args(["cat-file", "-p", &format!("{commit}:{path}")])
                    .output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                    .unwrap_or_default();
                if symlink_escapes(path, &target) {
                    problems.push(format!(
                        "{path} is a symlink to '{target}', outside this repo — merging it would land a pointer, not the work"
                    ));
                }
            }
        }
        problems
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
            if s.status != "needs-you" {
                return Err(format!(
                    "session is '{}' — only a needs-you session can be retried",
                    s.status
                ));
            }
            s.check_output = None;
            s.check_passed = None;
            s.reason = None;
            s.diff = String::new();
            s.status = Status::Queued.label().to_string();
            s.bucket = Status::Queued.bucket().to_string();
        }
        self.log(id, "retry: handed back to the agent".to_string());
        self.persist();
        self.maybe_start(id);
        Ok(())
    }

    fn merge(&self, id: &str) -> Result<String, String> {
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
            let detail = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            let lines: Vec<&str> = detail
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
            if detail.contains("CONFLICT") {
                return Err(format!(
                    "merge conflict: {summary} — the merge was aborted and nothing was merged"
                ));
            }
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
        Ok(pin)
    }
}

// ---------------------------------------------------------------------------
// HTTP layer (std-only, one request per connection)
// ---------------------------------------------------------------------------

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

fn read_request(stream: &mut std::net::TcpStream) -> Option<(String, String, String)> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).ok()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        if line == "\r\n" || line.is_empty() {
            break;
        }
        let lower = line.to_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            content_length = v.trim().parse().unwrap_or(0);
        }
    }
    // A declared body over the cap is refused without being read —
    // otherwise one connection can pin its handler thread (and a huge
    // allocation) by declaring a giant body and sending nothing.
    if content_length > MAX_BODY_BYTES {
        return Some(("__too_large__".to_string(), String::new(), String::new()));
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body).ok()?;
    }
    Some((method, path, String::from_utf8_lossy(&body).to_string()))
}

/// Largest request body the API accepts (hand-outs are small JSON).
const MAX_BODY_BYTES: usize = 1_048_576;
/// How long a connection may take to deliver its request before the
/// handler drops it — a stalled request must not hold a thread forever.
const READ_TIMEOUT_SECS: u64 = 10;

/// Serialize sessions for the API with queue positions computed in:
/// a queued session's position is its place among the queued, in
/// hand-out order. Non-queued sessions carry null.
fn sessions_json(sessions: &[Session]) -> serde_json::Value {
    let mut pos = 0usize;
    let arr: Vec<serde_json::Value> = sessions
        .iter()
        .map(|s| {
            let mut v = serde_json::to_value(s).unwrap();
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
                "timeout_secs": app.policy.timeout_secs,
                "source": app.policy_source
            })
            .to_string(),
        ),
        ("GET", "/api/sessions") => {
            let sessions = app.sessions.lock().unwrap();
            json_response(200, &sessions_json(&sessions).to_string())
        }
        ("POST", "/api/sessions") => {
            let req: serde_json::Value = match serde_json::from_str(body) {
                Ok(v) => v,
                Err(e) => return error_response(400, &format!("bad json: {e}")),
            };
            let task = req["task"].as_str().unwrap_or("").to_string();
            let repo = req["repo"].as_str().unwrap_or("").to_string();
            let project = req["project"].as_str().unwrap_or("default").to_string();
            if task.is_empty() || repo.is_empty() {
                return error_response(400, "task and repo are required");
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
            if !Path::new(&repo).join(".git").exists() {
                return error_response(400, "repo is not a git repository");
            }
            let check_cmd = match req["check"].as_str() {
                Some(c) if !c.is_empty() => c.to_string(),
                _ => match app.policy.default_check(&project) {
                    Ok(c) => c,
                    Err(e) => return error_response(500, &e),
                },
            };
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
                transcript: Vec::new(),
            };
            app.sessions.lock().unwrap().push(session.clone());
            app.persist();
            app.maybe_start(&id);
            let sessions = app.sessions.lock().unwrap();
            let all = sessions_json(&sessions);
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
            let sessions = app.sessions.lock().unwrap();
            let all = sessions_json(&sessions);
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
                Ok(commit) => json_response(
                    200,
                    &format!("{{\"merged\":true,\"commit\":\"{commit}\"}}"),
                ),
                Err(e) => error_response(409, &e),
            }
        }
        ("POST", route) if route.starts_with("/api/sessions/") && route.ends_with("/retry") => {
            let id = &route["/api/sessions/".len()..route.len() - "/retry".len()];
            match app.retry(id) {
                Ok(()) => json_response(200, "{\"retried\":true}"),
                Err(e) => error_response(409, &e),
            }
        }
        ("GET", "/api/inbox") => {
            let sessions = app.sessions.lock().unwrap();
            let all = sessions_json(&sessions);
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
fn load_persisted(data_dir: &Path) -> (Vec<Session>, u64) {
    let path = data_dir.join("sessions.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return (Vec::new(), 0);
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return (Vec::new(), 0);
    };
    let counter = v["counter"].as_u64().unwrap_or(0);
    let mut sessions: Vec<Session> =
        serde_json::from_value(v["sessions"].clone()).unwrap_or_default();
    for s in sessions.iter_mut() {
        let log_path = data_dir.join("logs").join(format!("{}.log", s.id));
        if let Ok(text) = std::fs::read_to_string(&log_path) {
            let lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
            if lines.len() > s.transcript.len() {
                s.transcript = lines;
            }
        }
    }
    (sessions, counter)
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
        counter: Mutex::new(restored_counter),
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
    if !app.sessions.lock().unwrap().is_empty() {
        println!(
            "fleet-rs: restored {} session(s) from disk",
            app.sessions.lock().unwrap().len()
        );
    }
    app.pump_queue();

    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind failed");
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
                std::thread::spawn(move || {
                    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(
                        READ_TIMEOUT_SECS,
                    )));
                    if let Some((method, path, body)) = read_request(&mut stream) {
                        let response = if method == "__too_large__" {
                            error_response(413, "request body too large")
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
            counter: Mutex::new(0),
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
}
