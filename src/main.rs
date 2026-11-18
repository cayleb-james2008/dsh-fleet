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
        };
        policy.max_parallel = policy.call_i64("max_parallel", ())?;
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.exists()
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
    transcript: Vec<String>,
}

struct App {
    policy: Policy,
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
    fn log(&self, id: &str, line: String) {
        let count = {
            let mut sessions = self.sessions.lock().unwrap();
            match sessions.iter_mut().find(|s| s.id == id) {
                Some(s) => {
                    s.transcript.push(line.clone());
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
        let out = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["worktree", "add", "-b", &session.branch])
            .arg(&wt)
            .arg("HEAD")
            .output();
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
        // 2. Run the agent in the worktree, streaming its output.
        self.log(id, format!("agent started: {}", session.task));
        let child = Command::new(&session.agent)
            .arg(&session.task)
            .current_dir(wt)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                self.log(id, format!("agent failed to start: {e}"));
                self.set_needs_you(id, &format!("agent failed to start: {}", session.agent));
                self.pump_queue();
                return;
            }
        };
        // Drain stderr on its own thread into the transcript: a piped but
        // unread stderr would fill its buffer and wedge the agent.
        let stderr_thread = child.stderr.take().map(|stderr| {
            let app = self.clone();
            let id = id.to_string();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    match line {
                        Ok(l) => app.log(&id, format!("stderr: {l}")),
                        Err(_) => break,
                    }
                }
            })
        });
        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(l) => self.log(id, l),
                    Err(_) => break,
                }
            }
        }
        let agent_ok = child.wait().map(|s| s.success()).unwrap_or(false);
        if let Some(t) = stderr_thread {
            let _ = t.join();
        }
        if !agent_ok {
            self.log(id, "agent exited non-zero — handing back to you".to_string());
            self.set_needs_you(id, "agent exited non-zero");
            self.pump_queue();
            return;
        }
        self.log(id, "agent claims completion — running the check".to_string());

        // 3. Verified done: the app runs the task's check itself.
        self.set_status(id, Status::Checking);
        let check = Command::new("sh")
            .arg("-c")
            .arg(&session.check_cmd)
            .current_dir(wt)
            .output();
        let (passed, output) = match check {
            Ok(o) => (
                o.status.success(),
                format!(
                    "{}{}",
                    String::from_utf8_lossy(&o.stdout),
                    String::from_utf8_lossy(&o.stderr)
                ),
            ),
            Err(e) => (false, format!("check could not run: {e}")),
        };

        // 4. Capture the diff and commit the worktree so it can be merged.
        let _ = Command::new("git").arg("-C").arg(wt).args(["add", "-A"]).output();
        let diff = Command::new("git")
            .arg("-C")
            .arg(wt)
            .args(["diff", "--cached"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        let _ = Command::new("git")
            .arg("-C")
            .arg(wt)
            .args(["-c", "user.email=fleet@localhost", "-c", "user.name=fleet-rs"])
            .args(["commit", "--allow-empty", "-m", &format!("fleet session {}: {}", id, session.task)])
            .output();

        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(s) = sessions.iter_mut().find(|s| s.id == id) {
                s.check_output = Some(output);
                s.check_passed = Some(passed);
                s.diff = diff;
            }
        }
        self.persist();
        if passed {
            self.log(id, "check passed — verified done".to_string());
            self.set_status(id, Status::Done);
        } else {
            self.log(id, "check FAILED — this needs you".to_string());
            self.set_needs_you(id, &format!("check failed: {}", session.check_cmd));
        }
        self.pump_queue();
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

    fn merge(&self, id: &str) -> Result<(), String> {
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
        let out = Command::new("git")
            .arg("-C")
            .arg(&session.repo)
            .args(["merge", "--no-ff", "-m", &format!("merge fleet session {id}")])
            .arg(&session.branch)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            // Never leave the operator's repo mid-merge on our account.
            let _ = Command::new("git")
                .arg("-C")
                .arg(&session.repo)
                .args(["merge", "--abort"])
                .output();
            let detail = String::from_utf8_lossy(&out.stderr);
            let first = detail.lines().next().unwrap_or("merge failed").trim();
            return Err(format!(
                "merge conflict: {first} — the merge was aborted and nothing was merged"
            ));
        }
        self.set_status(id, Status::Merged);
        Ok(())
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
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body).ok()?;
    }
    Some((method, path, String::from_utf8_lossy(&body).to_string()))
}

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
                "source": "policies.rn (Rune)"
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
                Err(e) => return json_response(400, &format!("{{\"error\":\"bad json: {e}\"}}")),
            };
            let task = req["task"].as_str().unwrap_or("").to_string();
            let repo = req["repo"].as_str().unwrap_or("").to_string();
            let project = req["project"].as_str().unwrap_or("default").to_string();
            if task.is_empty() || repo.is_empty() {
                return json_response(400, "{\"error\":\"task and repo are required\"}");
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
                return json_response(400, "{\"error\":\"repo is not a git repository\"}");
            }
            let check_cmd = match req["check"].as_str() {
                Some(c) if !c.is_empty() => c.to_string(),
                _ => match app.policy.default_check(&project) {
                    Ok(c) => c,
                    Err(e) => return json_response(500, &format!("{{\"error\":\"{e}\"}}")),
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
                None => json_response(404, "{\"error\":\"no such session\"}"),
            }
        }
        ("POST", route) if route.starts_with("/api/sessions/") && route.ends_with("/merge") => {
            let id = &route["/api/sessions/".len()..route.len() - "/merge".len()];
            match app.merge(id) {
                Ok(()) => json_response(200, "{\"merged\":true}"),
                Err(e) => json_response(409, &format!("{{\"error\":\"{e}\"}}")),
            }
        }
        ("POST", route) if route.starts_with("/api/sessions/") && route.ends_with("/retry") => {
            let id = &route["/api/sessions/".len()..route.len() - "/retry".len()];
            match app.retry(id) {
                Ok(()) => json_response(200, "{\"retried\":true}"),
                Err(e) => json_response(409, &format!("{{\"error\":\"{e}\"}}")),
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
        _ => json_response(404, "{\"error\":\"not found\"}"),
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
                    if let Some((method, path, body)) = read_request(&mut stream) {
                        let response = handle(&app, &method, &path, &body);
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
        assert_eq!(policy.default_check("fixture").unwrap(), "test -s output.txt");
        assert_eq!(policy.default_check("anything-else").unwrap(), "cargo test");
    }

    #[test]
    fn policy_cap_is_read_from_rune_not_hardcoded() {
        let script = "pub fn max_parallel() { 1 }\npub fn default_check(p) { \"true\" }";
        let policy = Policy::load(script).unwrap();
        assert_eq!(policy.max_parallel, 1);
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
