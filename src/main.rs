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

#[derive(Clone, Serialize)]
struct Session {
    id: String,
    task: String,
    project: String,
    repo: String,
    branch: String,
    worktree: String,
    status: String,
    bucket: String,
    check_cmd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    check_output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    check_passed: Option<bool>,
    diff: String,
    transcript: Vec<String>,
}

struct App {
    policy: Policy,
    agent_cmd: String,
    data_dir: PathBuf,
    sessions: Mutex<Vec<Session>>,
    counter: Mutex<u64>,
}

impl App {
    fn set_status(&self, id: &str, status: Status) {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(s) = sessions.iter_mut().find(|s| s.id == id) {
            s.status = status.label().to_string();
            s.bucket = status.bucket().to_string();
        }
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
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(s) = sessions.iter_mut().find(|s| s.id == id) {
            s.transcript.push(line);
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

        // 1. Isolated worktree on its own branch.
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
                self.set_status(id, Status::NeedsYou);
                self.pump_queue();
                return;
            }
            Err(e) => {
                self.log(id, format!("could not run git: {e}"));
                self.set_status(id, Status::NeedsYou);
                self.pump_queue();
                return;
            }
        }

        // 2. Run the agent in the worktree, streaming its output.
        self.log(id, format!("agent started: {}", session.task));
        let child = Command::new(&self.agent_cmd)
            .arg(&session.task)
            .current_dir(&wt)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                self.log(id, format!("agent failed to start: {e}"));
                self.set_status(id, Status::NeedsYou);
                self.pump_queue();
                return;
            }
        };
        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(l) => self.log(id, l),
                    Err(_) => break,
                }
            }
        }
        let agent_ok = child.wait().map(|s| s.success()).unwrap_or(false);
        if !agent_ok {
            self.log(id, "agent exited non-zero — handing back to you".to_string());
            self.set_status(id, Status::NeedsYou);
            self.pump_queue();
            return;
        }
        self.log(id, "agent claims completion — running the check".to_string());

        // 3. Verified done: the app runs the task's check itself.
        self.set_status(id, Status::Checking);
        let check = Command::new("sh")
            .arg("-c")
            .arg(&session.check_cmd)
            .current_dir(&wt)
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
        let _ = Command::new("git").arg("-C").arg(&wt).args(["add", "-A"]).output();
        let diff = Command::new("git")
            .arg("-C")
            .arg(&wt)
            .args(["diff", "--cached"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        let _ = Command::new("git")
            .arg("-C")
            .arg(&wt)
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
        if passed {
            self.log(id, "check passed — verified done".to_string());
            self.set_status(id, Status::Done);
        } else {
            self.log(id, "check FAILED — this needs you".to_string());
            self.set_status(id, Status::NeedsYou);
        }
        self.pump_queue();
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
        let out = Command::new("git")
            .arg("-C")
            .arg(&session.repo)
            .args(["merge", "--no-ff", "-m", &format!("merge fleet session {id}")])
            .arg(&session.branch)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "merge failed: {}",
                String::from_utf8_lossy(&out.stderr)
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
                "agent_cmd": app.agent_cmd,
                "source": "policies.rn (Rune)"
            })
            .to_string(),
        ),
        ("GET", "/api/sessions") => {
            let sessions = app.sessions.lock().unwrap();
            json_response(200, &serde_json::to_string(&*sessions).unwrap())
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
            let id = format!("s{n}");
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
                check_cmd,
                check_output: None,
                check_passed: None,
                diff: String::new(),
                transcript: Vec::new(),
            };
            app.sessions.lock().unwrap().push(session.clone());
            app.maybe_start(&id);
            json_response(201, &serde_json::to_string(&session).unwrap())
        }
        ("GET", route) if route.starts_with("/api/sessions/") => {
            let id = &route["/api/sessions/".len()..];
            let sessions = app.sessions.lock().unwrap();
            match sessions.iter().find(|s| s.id == id) {
                Some(s) => json_response(200, &serde_json::to_string(s).unwrap()),
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
        _ => json_response(404, "{\"error\":\"not found\"}"),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8471);
    let agent_cmd = std::env::var("FLEET_AGENT").unwrap_or_else(|_| {
        for candidate in ["opencode", "claude", "codex"] {
            if Command::new("which")
                .arg(candidate)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
            {
                return candidate.to_string();
            }
        }
        "codex".to_string()
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

    let app = Arc::new(App {
        policy,
        agent_cmd,
        data_dir,
        sessions: Mutex::new(Vec::new()),
        counter: Mutex::new(0),
    });

    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind failed");
    println!("fleet-rs listening on http://127.0.0.1:{port} (agent: {}, max_parallel: {})", app.agent_cmd, app.policy.max_parallel);
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
            agent_cmd: agent.to_string_lossy().to_string(),
            data_dir: dir.join("data"),
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
            check_cmd: "test -s output.txt".to_string(),
            check_output: None,
            check_passed: None,
            diff: String::new(),
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
