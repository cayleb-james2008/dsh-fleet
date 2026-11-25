//! Multi-step check pipeline runner and file-scope guardrail verification.
//!
//! Supports ordered [`CheckStep`] pipelines with per-step timing, exit codes, tail lines,
//! process-group timeout/stop isolation, and stop-on-first-failure semantics while staying
//! 100% backwards-compatible with single-command `check_cmd: String` sessions.
//!
//! Also provides [`FileScope`] (`allowed_globs` / `forbidden_globs`) checked against
//! hardened `git diff --name-only -z` output so an agent editing outside its permitted
//! paths lands cleanly in `Needs you` with the exact violating file list before ever
//! being marked Done.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Default per-step check timeout in seconds (matches `fleet` default).
pub const DEFAULT_CHECK_TIMEOUT_SECS: u64 = 1800;
/// Hard ceiling on per-step timeout (one week) to prevent `Instant` overflow.
pub const MAX_CHECK_TIMEOUT_SECS: u64 = 604_800;
/// Per-line character cap to bound pathological single-line output.
pub const LINE_CAP: usize = 8192;
/// Stored per-step output character cap.
pub const STEP_OUTPUT_CAP: usize = 128_000;
/// Stored combined pipeline output character cap.
pub const COMBINED_OUTPUT_CAP: usize = 256_000;

/// One ordered verification step inside a check pipeline.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CheckStep {
    pub name: String,
    pub cmd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
}

impl CheckStep {
    pub fn new(name: impl Into<String>, cmd: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            cmd: cmd.into(),
            timeout_secs: None,
        }
    }

    pub fn with_timeout(
        name: impl Into<String>,
        cmd: impl Into<String>,
        timeout_secs: u64,
    ) -> Self {
        Self {
            name: name.into(),
            cmd: cmd.into(),
            timeout_secs: Some(timeout_secs.clamp(1, MAX_CHECK_TIMEOUT_SECS)),
        }
    }

    /// Validate a check step before execution or persistence.
    pub fn validate(&self) -> Result<(), String> {
        if self.cmd.trim().is_empty() {
            return Err("check step command cannot be empty".to_string());
        }
        if self.cmd.contains('\0') || self.name.contains('\0') {
            return Err("check step contains a NUL byte".to_string());
        }
        if let Some(t) = self.timeout_secs {
            if t == 0 {
                return Err(format!(
                    "check step '{}' timeout_secs must be at least 1",
                    self.effective_name(0)
                ));
            }
        }
        Ok(())
    }

    pub fn effective_name(&self, index: usize) -> String {
        let trimmed = self.name.trim();
        if trimmed.is_empty() {
            format!("step-{}", index + 1)
        } else {
            trimmed.to_string()
        }
    }

    pub fn effective_timeout(&self, default_timeout_secs: u64) -> u64 {
        let base = default_timeout_secs.clamp(1, MAX_CHECK_TIMEOUT_SECS);
        self.timeout_secs
            .map(|t| t.clamp(1, MAX_CHECK_TIMEOUT_SECS))
            .unwrap_or(base)
    }
}

/// Terminal state for an individual check step.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StepStatus {
    Passed,
    Failed,
    TimedOut,
    PipesHeld,
    Stopped,
    SpawnFailed,
    Skipped,
}

/// Timed execution receipt for one check step.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CheckStepReceipt {
    pub name: String,
    pub cmd: String,
    pub status: StepStatus,
    pub passed: bool,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u64,
    pub tail_line: String,
    pub output: String,
}

/// Aggregate receipt produced by executing a [`CheckPipeline`].
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PipelineReceipt {
    pub passed: bool,
    pub ran: bool,
    pub total_elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_step_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_step_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub pipes_held: bool,
    pub stopped: bool,
    pub combined_output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_reason: Option<String>,
    pub steps: Vec<CheckStepReceipt>,
}

impl PipelineReceipt {
    /// Number of steps that were actually executed (excluding skipped steps).
    pub fn executed_steps(&self) -> usize {
        self.steps
            .iter()
            .filter(|s| s.status != StepStatus::Skipped)
            .count()
    }

    /// Number of steps skipped after an earlier failure.
    pub fn skipped_steps(&self) -> usize {
        self.steps
            .iter()
            .filter(|s| s.status == StepStatus::Skipped)
            .count()
    }
}

/// Ordered sequence of check steps with backwards-compatible single-command resolution.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CheckPipeline {
    pub steps: Vec<CheckStep>,
    pub default_timeout_secs: u64,
    #[serde(default)]
    legacy_single: bool,
}

impl CheckPipeline {
    /// Wrap a single legacy `check_cmd: String` into a one-step pipeline.
    pub fn from_single_cmd(cmd: impl Into<String>, default_timeout_secs: u64) -> Self {
        let cmd = cmd.into();
        let steps = if cmd.trim().is_empty() {
            Vec::new()
        } else {
            vec![CheckStep::new("check", cmd)]
        };
        Self {
            steps,
            default_timeout_secs: default_timeout_secs.clamp(1, MAX_CHECK_TIMEOUT_SECS),
            legacy_single: true,
        }
    }

    /// Build a pipeline from explicit check steps.
    pub fn from_steps(steps: Vec<CheckStep>, default_timeout_secs: u64) -> Result<Self, String> {
        if steps.is_empty() {
            return Err("check pipeline must contain at least one step".to_string());
        }
        for s in &steps {
            s.validate()?;
        }
        Ok(Self {
            steps,
            default_timeout_secs: default_timeout_secs.clamp(1, MAX_CHECK_TIMEOUT_SECS),
            legacy_single: false,
        })
    }

    /// Backwards-compatible resolver: uses `steps` when non-empty, otherwise falls back
    /// to `legacy_check_cmd`.
    pub fn resolve(
        steps: &[CheckStep],
        legacy_check_cmd: &str,
        default_timeout_secs: u64,
    ) -> Result<Self, String> {
        if !steps.is_empty() {
            Self::from_steps(steps.to_vec(), default_timeout_secs)
        } else if !legacy_check_cmd.trim().is_empty() {
            let p = Self::from_single_cmd(legacy_check_cmd.trim(), default_timeout_secs);
            for s in &p.steps {
                s.validate()?;
            }
            Ok(p)
        } else {
            Err("either check_steps or a non-empty check_cmd is required".to_string())
        }
    }

    /// True if this pipeline came from a single legacy `check_cmd` string.
    pub fn is_legacy_single(&self) -> bool {
        self.legacy_single && self.steps.len() == 1
    }

    /// Display string compatible with `Session::check_cmd`.
    pub fn display_cmd(&self) -> String {
        if self.steps.len() == 1 {
            self.steps[0].cmd.clone()
        } else {
            self.steps
                .iter()
                .map(|s| s.cmd.trim())
                .collect::<Vec<_>>()
                .join(" && ")
        }
    }

    /// Execute the ordered check pipeline in `workdir`, stopping on the first failure.
    pub fn run(&self, workdir: &Path, stop: Option<&AtomicBool>) -> PipelineReceipt {
        let mut noop = |_idx: usize, _receipt: &CheckStepReceipt| {};
        self.run_with_callback(workdir, stop, &mut noop)
    }

    /// Execute the ordered check pipeline, invoking `on_step` after each step settles
    /// (useful for streaming live check receipts over SSE).
    pub fn run_with_callback(
        &self,
        workdir: &Path,
        stop: Option<&AtomicBool>,
        on_step: &mut dyn FnMut(usize, &CheckStepReceipt),
    ) -> PipelineReceipt {
        if self.steps.is_empty() {
            return PipelineReceipt {
                passed: false,
                ran: false,
                total_elapsed_ms: 0,
                failed_step_index: None,
                failed_step_name: None,
                exit_code: None,
                timed_out: false,
                pipes_held: false,
                stopped: false,
                combined_output: String::new(),
                summary_reason: Some("no check steps configured".to_string()),
                steps: Vec::new(),
            };
        }

        let pipeline_start = Instant::now();
        let mut receipts: Vec<CheckStepReceipt> = Vec::with_capacity(self.steps.len());
        let mut failed_idx: Option<usize> = None;
        let mut failed_name: Option<String> = None;
        let mut final_exit: Option<i32> = None;
        let mut any_ran = false;
        let mut any_timed_out = false;
        let mut any_pipes_held = false;
        let mut any_stopped = false;
        let mut summary_reason: Option<String> = None;

        for (idx, step) in self.steps.iter().enumerate() {
            let step_name = step.effective_name(idx);
            if failed_idx.is_some() {
                let skipped = CheckStepReceipt {
                    name: step_name,
                    cmd: step.cmd.clone(),
                    status: StepStatus::Skipped,
                    passed: false,
                    exit_code: None,
                    elapsed_ms: 0,
                    tail_line: "skipped (previous step failed)".to_string(),
                    output: String::new(),
                };
                on_step(idx, &skipped);
                receipts.push(skipped);
                continue;
            }

            let timeout = step.effective_timeout(self.default_timeout_secs);
            let started = Instant::now();
            let outcome = run_shell_bounded(&step.cmd, workdir, timeout, stop);
            let elapsed_ms = started.elapsed().as_millis() as u64;

            let (status, passed, raw_output, reason) = match outcome.end {
                ProcEnd::SpawnFailed(e) => {
                    let out = format!("check could not run: {e}");
                    let r = format!("check step '{step_name}' could not run ({}): {e}", step.cmd);
                    (StepStatus::SpawnFailed, false, out, Some(r))
                }
                ProcEnd::Exited(true) => {
                    any_ran = true;
                    (StepStatus::Passed, true, outcome.lines.join("\n"), None)
                }
                ProcEnd::Exited(false) => {
                    any_ran = true;
                    let out = outcome.lines.join("\n");
                    let r = step_failure_reason(
                        &step_name,
                        &step.cmd,
                        self.is_legacy_single(),
                        outcome.code,
                        &out,
                    );
                    (StepStatus::Failed, false, out, Some(r))
                }
                ProcEnd::TimedOut => {
                    any_ran = true;
                    any_timed_out = true;
                    let out = format!(
                        "{}\n(check timed out after {timeout}s and was killed)",
                        outcome.lines.join("\n")
                    );
                    let r = if self.is_legacy_single() {
                        format!("check timed out after {timeout}s: {}", step.cmd)
                    } else {
                        format!(
                            "check step '{step_name}' timed out after {timeout}s: {}",
                            step.cmd
                        )
                    };
                    (StepStatus::TimedOut, false, out, Some(r))
                }
                ProcEnd::PipesHeld => {
                    any_ran = true;
                    any_pipes_held = true;
                    let out = format!(
                        "{}\n(check's output stayed open past the limit — a detached process held it; the process group was killed)",
                        outcome.lines.join("\n")
                    );
                    let r = format!(
                        "check step '{step_name}' did not finish cleanly — a detached process kept its output open: {}",
                        step.cmd
                    );
                    (StepStatus::PipesHeld, false, out, Some(r))
                }
                ProcEnd::Stopped => {
                    any_ran = true;
                    any_stopped = true;
                    let out = format!(
                        "{}\n(check stopped by you and killed)",
                        outcome.lines.join("\n")
                    );
                    let r = format!("stopped by you while check step '{step_name}' was running");
                    (StepStatus::Stopped, false, out, Some(r))
                }
            };

            let tail_line = extract_tail_line(&raw_output);
            let stored_output = truncate_chars(raw_output, STEP_OUTPUT_CAP);
            final_exit = outcome.code;

            let receipt = CheckStepReceipt {
                name: step_name.clone(),
                cmd: step.cmd.clone(),
                status,
                passed,
                exit_code: outcome.code,
                elapsed_ms,
                tail_line,
                output: stored_output,
            };
            on_step(idx, &receipt);
            receipts.push(receipt);

            if !passed {
                failed_idx = Some(idx);
                failed_name = Some(step_name);
                summary_reason = reason;
            }
        }

        let total_elapsed_ms = pipeline_start.elapsed().as_millis() as u64;
        let combined_output = if self.is_legacy_single() {
            receipts
                .first()
                .map(|r| r.output.clone())
                .unwrap_or_default()
        } else {
            format_combined_output(&receipts)
        };

        PipelineReceipt {
            passed: failed_idx.is_none() && any_ran,
            ran: any_ran,
            total_elapsed_ms,
            failed_step_index: failed_idx,
            failed_step_name: failed_name,
            exit_code: final_exit,
            timed_out: any_timed_out,
            pipes_held: any_pipes_held,
            stopped: any_stopped,
            combined_output: truncate_chars(combined_output, COMBINED_OUTPUT_CAP),
            summary_reason,
            steps: receipts,
        }
    }
}

fn step_failure_reason(
    step_name: &str,
    cmd: &str,
    legacy_single: bool,
    exit: Option<i32>,
    output: &str,
) -> String {
    let code = match exit {
        Some(c) => format!("exit {c}"),
        None => "no exit code".to_string(),
    };
    let head: String = output.trim().chars().take(200).collect();
    if legacy_single {
        if head.is_empty() {
            format!("Check failed ({code}): {cmd}. The check printed nothing.")
        } else {
            format!("Check failed ({code}): {cmd}. Output: {head}")
        }
    } else if head.is_empty() {
        format!("Check step '{step_name}' failed ({code}): {cmd}. The step printed nothing.")
    } else {
        format!("Check step '{step_name}' failed ({code}): {cmd}. Output: {head}")
    }
}

fn extract_tail_line(output: &str) -> String {
    output
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| truncate_chars(l.to_string(), 512))
        .unwrap_or_default()
}

fn format_combined_output(steps: &[CheckStepReceipt]) -> String {
    let total = steps.len();
    let mut parts = Vec::with_capacity(total);
    for (idx, s) in steps.iter().enumerate() {
        let exit_str = match s.exit_code {
            Some(c) => format!("exit {c}"),
            None => format!("{:?}", s.status).to_lowercase(),
        };
        let header = format!(
            "=== [{}/{}] {} ({}ms, {}) ===",
            idx + 1,
            total,
            s.name,
            s.elapsed_ms,
            exit_str
        );
        if s.output.trim().is_empty() {
            parts.push(header);
        } else {
            parts.push(format!("{header}\n{}", s.output));
        }
    }
    parts.join("\n\n")
}

fn truncate_chars(text: String, cap: usize) -> String {
    if text.chars().count() > cap {
        let mut t: String = text.chars().take(cap).collect();
        t.push_str("\n… truncated");
        t
    } else {
        text
    }
}

fn truncate_line(line: String) -> String {
    if line.chars().count() > LINE_CAP {
        let mut t: String = line.chars().take(LINE_CAP).collect();
        t.push_str(" …[line truncated]");
        t
    } else {
        line
    }
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(windows)]
fn kill_group(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output();
}

#[cfg(not(any(unix, windows)))]
fn kill_group(_pid: u32) {}

enum ProcEnd {
    Exited(bool),
    TimedOut,
    PipesHeld,
    Stopped,
    SpawnFailed(String),
}

struct ProcOutcome {
    end: ProcEnd,
    code: Option<i32>,
    lines: Vec<String>,
}

fn run_shell_bounded(
    cmd_str: &str,
    workdir: &Path,
    timeout_secs: u64,
    stop: Option<&AtomicBool>,
) -> ProcOutcome {
    if stop.is_some_and(|s| s.load(Ordering::Relaxed)) {
        return ProcOutcome {
            end: ProcEnd::Stopped,
            code: None,
            lines: Vec::new(),
        };
    }
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", cmd_str]);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(cmd_str);
        c
    };
    cmd.current_dir(workdir)
        .env("PWD", workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return ProcOutcome {
                end: ProcEnd::SpawnFailed(e.to_string()),
                code: None,
                lines: Vec::new(),
            };
        }
    };

    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    for stream in [
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines() {
                match line {
                    Ok(l) => {
                        if tx.send(truncate_line(l)).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }
    drop(tx);

    let deadline = Instant::now()
        .checked_add(Duration::from_secs(timeout_secs))
        .unwrap_or_else(|| Instant::now() + Duration::from_secs(MAX_CHECK_TIMEOUT_SECS));
    const MAX_COLLECTED_CHARS: usize = STEP_OUTPUT_CAP + 4096;
    let mut lines: Vec<String> = Vec::new();
    let mut collected_chars: usize = 0;
    let mut output_capped = false;
    let mut child_status: Option<bool> = None;
    let mut child_code: Option<i32> = None;
    let mut exited_at: Option<Instant> = None;
    let mut last_line_at = Instant::now();
    let stopped = || stop.is_some_and(|s| s.load(Ordering::Relaxed));

    let end = loop {
        if child_status.is_none() && stopped() {
            kill_group(pid);
            let _ = child.kill();
            break ProcEnd::Stopped;
        }
        if child_status.is_none() {
            match child.try_wait() {
                Ok(Some(st)) => {
                    child_status = Some(st.success());
                    child_code = st.code();
                    exited_at = Some(Instant::now());
                }
                Ok(None) => {}
                Err(_) => child_status = Some(false),
            }
        }
        let now = Instant::now();
        if child_status.is_none() && now >= deadline {
            kill_group(pid);
            let _ = child.kill();
            break ProcEnd::TimedOut;
        }
        if let Some(ex) = exited_at {
            if now.duration_since(last_line_at) >= Duration::from_secs(3)
                || now.duration_since(ex) >= Duration::from_secs(30)
            {
                kill_group(pid);
                break ProcEnd::PipesHeld;
            }
        }
        match rx.recv_timeout(Duration::from_millis(25)) {
            Ok(line) => {
                last_line_at = Instant::now();
                if !output_capped {
                    let add = line.chars().count() + 1;
                    if collected_chars + add <= MAX_COLLECTED_CHARS {
                        collected_chars += add;
                        lines.push(line);
                    } else {
                        output_capped = true;
                        lines.push("…[check output truncated above cap]".to_string());
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
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
                            if Instant::now() >= deadline {
                                kill_group(pid);
                                let _ = child.kill();
                                child_status = None;
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(25));
                        }
                        Err(_) => {
                            child_status = Some(false);
                            break;
                        }
                    }
                }
                if stop_hit {
                    break ProcEnd::Stopped;
                }
                match child_status {
                    Some(ok) => break ProcEnd::Exited(ok),
                    None => break ProcEnd::TimedOut,
                }
            }
        }
    };

    for _ in 0..40 {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => break,
        }
    }

    ProcOutcome {
        end,
        code: child_code,
        lines,
    }
}

// ---------------------------------------------------------------------------
// File-scope guardrails (allowed_globs / forbidden_globs)
// ---------------------------------------------------------------------------

/// File-scope rules constraining which repo-relative paths an agent session may modify.
///
/// Precedence:
/// 1. Path traversal (`..`) is always blocked.
/// 2. Any path matching `forbidden_globs` is blocked, even if it also matches `allowed_globs`.
/// 3. If `allowed_globs` is non-empty, every modified path must match at least one pattern.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileScope {
    #[serde(default)]
    pub allowed_globs: Vec<String>,
    #[serde(default)]
    pub forbidden_globs: Vec<String>,
}

/// One path that violated the session's file-scope guardrail.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScopeViolation {
    pub path: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_rule: Option<String>,
}

/// Result of checking a session's modified files against a [`FileScope`].
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileScopeReport {
    pub passed: bool,
    pub changed_files: Vec<String>,
    pub violations: Vec<ScopeViolation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_you_reason: Option<String>,
}

impl FileScope {
    pub fn unrestricted() -> Self {
        Self::default()
    }

    pub fn new(allowed_globs: Vec<String>, forbidden_globs: Vec<String>) -> Self {
        Self {
            allowed_globs: clean_glob_list(allowed_globs),
            forbidden_globs: clean_glob_list(forbidden_globs),
        }
    }

    pub fn is_unrestricted(&self) -> bool {
        self.allowed_globs.iter().all(|g| g.trim().is_empty())
            && self.forbidden_globs.iter().all(|g| g.trim().is_empty())
    }

    /// Merge another scope (e.g. policy defaults) with explicit session overrides.
    /// Forbidden globs union; if `self.allowed_globs` is non-empty it takes precedence,
    /// otherwise inherits `defaults.allowed_globs`.
    pub fn with_defaults(&self, defaults: &FileScope) -> FileScope {
        let mut forbidden = clean_glob_list(defaults.forbidden_globs.clone());
        for g in clean_glob_list(self.forbidden_globs.clone()) {
            if !forbidden.contains(&g) {
                forbidden.push(g);
            }
        }
        let own_allowed = clean_glob_list(self.allowed_globs.clone());
        let allowed = if own_allowed.is_empty() {
            clean_glob_list(defaults.allowed_globs.clone())
        } else {
            own_allowed
        };
        FileScope {
            allowed_globs: allowed,
            forbidden_globs: forbidden,
        }
    }

    /// Verify a list of repo-relative changed file paths against this guardrail.
    pub fn check_paths(&self, changed_files: &[String]) -> FileScopeReport {
        let allowed = clean_glob_list(self.allowed_globs.clone());
        let forbidden = clean_glob_list(self.forbidden_globs.clone());

        let mut normalized_files: Vec<String> = Vec::with_capacity(changed_files.len());
        let mut violations: Vec<ScopeViolation> = Vec::new();

        for raw in changed_files {
            let trimmed = raw.trim().replace('\\', "/");
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.starts_with('/') {
                normalized_files.push(trimmed.clone());
                violations.push(ScopeViolation {
                    path: trimmed,
                    reason: "absolute path escapes repository root".to_string(),
                    matched_rule: None,
                });
                continue;
            }
            let norm = normalize_rel_path(&trimmed);
            if norm.is_empty() {
                continue;
            }
            normalized_files.push(norm.clone());

            if has_parent_traversal(&norm) {
                violations.push(ScopeViolation {
                    path: norm,
                    reason: "path escapes repository root via '..'".to_string(),
                    matched_rule: None,
                });
                continue;
            }

            if let Some(rule) = forbidden.iter().find(|g| glob_matches(g, &norm)) {
                violations.push(ScopeViolation {
                    path: norm,
                    reason: format!("matches forbidden pattern '{rule}'"),
                    matched_rule: Some(rule.clone()),
                });
                continue;
            }

            if !allowed.is_empty() && !allowed.iter().any(|g| glob_matches(g, &norm)) {
                violations.push(ScopeViolation {
                    path: norm,
                    reason: format!("outside allowed scope ({})", allowed.join(", ")),
                    matched_rule: None,
                });
            }
        }

        let passed = violations.is_empty();
        let needs_you_reason = if passed {
            None
        } else {
            let list: Vec<String> = violations
                .iter()
                .take(10)
                .map(|v| format!("{} ({})", v.path, v.reason))
                .collect();
            let suffix = if violations.len() > 10 {
                format!(" (+{} more)", violations.len() - 10)
            } else {
                String::new()
            };
            Some(format!(
                "File-scope guardrail blocked: {}{suffix}",
                list.join("; ")
            ))
        };

        FileScopeReport {
            passed,
            changed_files: normalized_files,
            violations,
            needs_you_reason,
        }
    }
}

fn clean_glob_list(globs: Vec<String>) -> Vec<String> {
    globs
        .into_iter()
        .map(|g| g.trim().to_string())
        .filter(|g| !g.is_empty())
        .collect()
}

fn normalize_rel_path(raw: &str) -> String {
    let mut s = raw.trim().replace('\\', "/");
    while let Some(rest) = s.strip_prefix("./") {
        s = rest.to_string();
    }
    while let Some(rest) = s.strip_prefix('/') {
        s = rest.to_string();
    }
    s
}

fn has_parent_traversal(path: &str) -> bool {
    path.split('/').any(|seg| seg == "..")
}

/// Hardened `git diff --name-only -z <base_ref>...<head_ref>` path listing.
///
/// Disables external diff drivers, textconv, fsmonitor, and hooks so repo-controlled
/// git config cannot forge or tamper with the changed-file set.
pub fn changed_files_between(
    repo: &Path,
    base_ref: &str,
    head_ref: &str,
) -> Result<Vec<String>, String> {
    validate_ref_arg(base_ref)?;
    validate_ref_arg(head_ref)?;
    let range = format!("{base_ref}...{head_ref}");
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            if cfg!(windows) {
                "core.hooksPath=NUL"
            } else {
                "core.hooksPath=/dev/null"
            },
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "-z",
            &range,
        ])
        .output()
        .map_err(|e| format!("could not run git diff --name-only: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("git diff --name-only failed for {range}: {stderr}"));
    }
    let mut files: Vec<String> = out
        .stdout
        .split(|b| *b == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| String::from_utf8_lossy(entry).to_string())
        .collect();
    files.sort();
    files.dedup();
    Ok(files)
}

/// Verify committed branch changes (`base_ref...head_ref`) against `scope`.
pub fn verify_git_scope(
    repo: &Path,
    base_ref: &str,
    head_ref: &str,
    scope: &FileScope,
) -> Result<FileScopeReport, String> {
    let files = changed_files_between(repo, base_ref, head_ref)?;
    Ok(scope.check_paths(&files))
}

/// Verify both committed and uncommitted/untracked files inside a worktree against `base_ref`.
pub fn verify_worktree_scope(
    worktree: &Path,
    base_ref: &str,
    scope: &FileScope,
) -> Result<FileScopeReport, String> {
    validate_ref_arg(base_ref)?;
    let mut all = BTreeSet::new();

    let diff_out = Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            if cfg!(windows) {
                "core.hooksPath=NUL"
            } else {
                "core.hooksPath=/dev/null"
            },
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "-z",
            base_ref,
        ])
        .output()
        .map_err(|e| format!("could not run git diff in worktree: {e}"))?;
    if !diff_out.status.success() {
        let stderr = String::from_utf8_lossy(&diff_out.stderr).trim().to_string();
        return Err(format!("git diff against {base_ref} failed: {stderr}"));
    }
    for entry in diff_out.stdout.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        all.insert(String::from_utf8_lossy(entry).to_string());
    }

    let untracked_out = Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            if cfg!(windows) {
                "core.hooksPath=NUL"
            } else {
                "core.hooksPath=/dev/null"
            },
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .output()
        .map_err(|e| format!("could not list untracked files: {e}"))?;
    if untracked_out.status.success() {
        for entry in untracked_out
            .stdout
            .split(|b| *b == 0)
            .filter(|e| !e.is_empty())
        {
            all.insert(String::from_utf8_lossy(entry).to_string());
        }
    }

    let files: Vec<String> = all.into_iter().collect();
    Ok(scope.check_paths(&files))
}

fn validate_ref_arg(r: &str) -> Result<(), String> {
    let trimmed = r.trim();
    if trimmed.is_empty() {
        return Err("git ref cannot be empty".to_string());
    }
    if trimmed.starts_with('-')
        || trimmed.contains('\0')
        || trimmed.contains('\n')
        || trimmed.contains('\r')
        || trimmed.chars().any(char::is_whitespace)
    {
        return Err(format!("invalid git ref '{trimmed}'"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Polynomial-time path-aware glob matcher (zero external crates, zero ReDoS)
// ---------------------------------------------------------------------------

/// Match a repo-relative path against a git/gitignore-style glob pattern.
///
/// Supported syntax:
/// - `*` matches any sequence of characters within one path segment (not `/`).
/// - `?` matches one character other than `/`.
/// - `**` matches zero or more path segments (`src/**/*.rs` matches `src/main.rs` and `src/a/b.rs`).
/// - `[abc]`, `[a-z]`, `[!a-z]` / `[^a-z]` character classes (never matching `/`).
/// - `{a,b}` brace alternation (bounded to prevent combinatorial blowup).
/// - Trailing `/` (e.g. `web/`) matches everything under that directory (`web/**`).
pub fn glob_matches(pattern: &str, path: &str) -> bool {
    let path_norm = normalize_rel_path(path);
    if path_norm.is_empty() {
        return false;
    }
    let pat_trimmed = pattern.trim();
    if pat_trimmed.is_empty() {
        return false;
    }
    let expanded = expand_braces(pat_trimmed, 128);
    let path_segs: Vec<&str> = path_norm.split('/').collect();
    for raw_pat in expanded {
        let mut norm = normalize_rel_path(&raw_pat);
        if norm.ends_with('/') {
            norm.push_str("**");
        }
        if norm.is_empty() {
            continue;
        }
        let pat_segs: Vec<&str> = norm.split('/').collect();
        if match_segments(&pat_segs, &path_segs) {
            return true;
        }
    }
    false
}

/// Expand `{a,b}` brace groups up to `max_patterns` outputs.
fn expand_braces(pattern: &str, max_patterns: usize) -> Vec<String> {
    let mut results = vec![pattern.to_string()];
    let mut i = 0;
    while i < results.len() && results.len() < max_patterns {
        let current = results[i].clone();
        if let Some((start, end, options)) = find_first_brace_group(&current) {
            let prefix = &current[..start];
            let suffix = &current[end + 1..];
            results.remove(i);
            for opt in options {
                if results.len() >= max_patterns {
                    break;
                }
                results.push(format!("{prefix}{opt}{suffix}"));
            }
        } else {
            i += 1;
        }
    }
    results
}

fn find_first_brace_group(s: &str) -> Option<(usize, usize, Vec<String>)> {
    let bytes = s.as_bytes();
    let start = bytes.iter().position(|&b| b == b'{')?;
    let mut depth = 0usize;
    let mut parts = Vec::new();
    let mut part_start = start + 1;
    for (idx, &b) in bytes.iter().enumerate().skip(start) {
        match b {
            b'{' => depth += 1,
            b',' if depth == 1 => {
                parts.push(s[part_start..idx].to_string());
                part_start = idx + 1;
            }
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    parts.push(s[part_start..idx].to_string());
                    if parts.len() >= 2 {
                        return Some((start, idx, parts));
                    }
                    return None;
                }
            }
            _ => {}
        }
    }
    None
}

/// Segment-level dynamic programming matcher supporting `**`.
fn match_segments(pat: &[&str], path: &[&str]) -> bool {
    let m = pat.len();
    let n = path.len();
    let mut dp = vec![vec![false; n + 1]; m + 1];
    dp[0][0] = true;
    for i in 1..=m {
        if pat[i - 1] == "**" {
            dp[i][0] = dp[i - 1][0];
        }
    }
    for i in 1..=m {
        let p = pat[i - 1];
        for j in 1..=n {
            if p == "**" {
                // `**` matches 0 segments (dp[i-1][j]) or 1+ segments (dp[i][j-1]).
                dp[i][j] = dp[i - 1][j] || dp[i][j - 1];
            } else if dp[i - 1][j - 1] && match_segment(p, path[j - 1]) {
                dp[i][j] = true;
            }
        }
    }
    dp[m][n]
}

/// Single path-segment matcher (`*`, `?`, `[...]` classes) in O(P * S) time.
fn match_segment(pat: &str, seg: &str) -> bool {
    #[derive(Clone)]
    enum Token {
        Star,
        AnyChar,
        Lit(char),
        Class { negated: bool, ranges: Vec<(char, char)> },
    }

    let pchars: Vec<char> = pat.chars().collect();
    let mut tokens: Vec<Token> = Vec::with_capacity(pchars.len());
    let mut i = 0;
    while i < pchars.len() {
        match pchars[i] {
            '*' => {
                if !matches!(tokens.last(), Some(Token::Star)) {
                    tokens.push(Token::Star);
                }
                i += 1;
            }
            '?' => {
                tokens.push(Token::AnyChar);
                i += 1;
            }
            '[' => {
                let mut j = i + 1;
                let negated = j < pchars.len() && (pchars[j] == '!' || pchars[j] == '^');
                if negated {
                    j += 1;
                }
                let mut ranges = Vec::new();
                let mut closed = false;
                while j < pchars.len() {
                    if pchars[j] == ']' && (!ranges.is_empty() || j > i + 1 + usize::from(negated))
                    {
                        closed = true;
                        j += 1;
                        break;
                    }
                    let c = pchars[j];
                    if j + 2 < pchars.len() && pchars[j + 1] == '-' && pchars[j + 2] != ']' {
                        let end_c = pchars[j + 2];
                        let (lo, hi) = if c <= end_c { (c, end_c) } else { (end_c, c) };
                        ranges.push((lo, hi));
                        j += 3;
                    } else {
                        ranges.push((c, c));
                        j += 1;
                    }
                }
                if closed {
                    tokens.push(Token::Class { negated, ranges });
                    i = j;
                } else {
                    tokens.push(Token::Lit('['));
                    i += 1;
                }
            }
            c => {
                tokens.push(Token::Lit(c));
                i += 1;
            }
        }
    }

    let schars: Vec<char> = seg.chars().collect();
    let m = tokens.len();
    let n = schars.len();
    let mut prev = vec![false; n + 1];
    let mut curr = vec![false; n + 1];
    prev[0] = true;

    for tok in &tokens {
        curr.fill(false);
        match tok {
            Token::Star => {
                curr[0] = prev[0];
                for j in 1..=n {
                    curr[j] = prev[j] || curr[j - 1];
                }
            }
            Token::AnyChar => {
                if n > 0 {
                    curr[1..=n].copy_from_slice(&prev[..n]);
                }
            }
            Token::Lit(c) => {
                for j in 1..=n {
                    curr[j] = prev[j - 1] && schars[j - 1] == *c;
                }
            }
            Token::Class { negated, ranges } => {
                for j in 1..=n {
                    if prev[j - 1] {
                        let ch = schars[j - 1];
                        let hit = ranges.iter().any(|&(lo, hi)| ch >= lo && ch <= hi);
                        curr[j] = if *negated { !hit } else { hit };
                    }
                }
            }
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    let _ = m;
    prev[n]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matcher_handles_double_star_classes_and_braces() {
        assert!(glob_matches("src/**/*.rs", "src/main.rs"));
        assert!(glob_matches("src/**/*.rs", "src/a/b/c.rs"));
        assert!(!glob_matches("src/**/*.rs", "tests/main.rs"));
        assert!(!glob_matches("src/*.rs", "src/nested/main.rs"));
        assert!(glob_matches("src/*.rs", "src/main.rs"));
        assert!(glob_matches("web/", "web/src/App.tsx"));
        assert!(glob_matches("**/*.{rs,toml}", "Cargo.toml"));
        assert!(glob_matches("**/*.{rs,toml}", "src/dag.rs"));
        assert!(!glob_matches("**/*.{rs,toml}", "web/index.html"));
        assert!(glob_matches("src/file_[0-9].rs", "src/file_4.rs"));
        assert!(!glob_matches("src/file_[0-9].rs", "src/file_a.rs"));
        assert!(glob_matches("src/[!0-9]*.rs", "src/dag.rs"));
        assert!(!glob_matches("src/[!0-9]*.rs", "src/9lives.rs"));
        // Pathological backtracking resistance
        let evil_pat = format!("{}b", "a*".repeat(40));
        let evil_path = "a".repeat(80);
        assert!(!glob_matches(&evil_pat, &evil_path));
    }

    #[test]
    fn file_scope_forbidden_wins_over_allowed_and_blocks_traversal() {
        let scope = FileScope::new(
            vec!["src/**".to_string(), "Cargo.toml".to_string()],
            vec!["src/secrets/**".to_string(), "**/*.key".to_string()],
        );
        let ok = scope.check_paths(&["src/dag.rs".to_string(), "Cargo.toml".to_string()]);
        assert!(ok.passed, "{ok:?}");
        assert!(ok.needs_you_reason.is_none());

        let bad = scope.check_paths(&[
            "src/dag.rs".to_string(),
            "web/src/App.tsx".to_string(),
            "src/secrets/token.rs".to_string(),
            "../outside.txt".to_string(),
        ]);
        assert!(!bad.passed);
        assert_eq!(bad.violations.len(), 3);
        let reason = bad.needs_you_reason.unwrap();
        assert!(reason.contains("web/src/App.tsx"), "{reason}");
        assert!(reason.contains("src/secrets/token.rs"), "{reason}");
        assert!(reason.contains("../outside.txt"), "{reason}");
    }

    #[test]
    fn multi_step_pipeline_stops_on_first_failure_and_records_timing() {
        let dir = std::env::temp_dir().join(format!("fleet-checks-unit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("step3-ran.txt");

        let pipeline = CheckPipeline::from_steps(
            vec![
                CheckStep::with_timeout("lint", "printf 'lint line 1\\nlint ok\\n'", 30),
                CheckStep::with_timeout("test", "printf 'running tests\\nFAIL test_x\\n'; exit 2", 30),
                CheckStep::with_timeout(
                    "build",
                    format!("touch '{}'", marker.display()),
                    30,
                ),
            ],
            30,
        )
        .unwrap();

        let receipt = pipeline.run(&dir, None);
        assert!(!receipt.passed);
        assert!(receipt.ran);
        assert_eq!(receipt.failed_step_index, Some(1));
        assert_eq!(receipt.failed_step_name.as_deref(), Some("test"));
        assert_eq!(receipt.exit_code, Some(2));
        assert_eq!(receipt.executed_steps(), 2);
        assert_eq!(receipt.skipped_steps(), 1);
        assert_eq!(receipt.steps[0].status, StepStatus::Passed);
        assert_eq!(receipt.steps[0].tail_line, "lint ok");
        assert_eq!(receipt.steps[1].status, StepStatus::Failed);
        assert_eq!(receipt.steps[1].tail_line, "FAIL test_x");
        assert_eq!(receipt.steps[2].status, StepStatus::Skipped);
        assert!(!marker.exists(), "step 3 must NOT execute after step 2 failed");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
