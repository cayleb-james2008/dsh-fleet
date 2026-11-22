//! Pull Request Preview generator and safe confirmation-gated GitHub PR creation.
//!
//! - [`build_pr_preview`] inspects a session's verified commit, check receipts, auto-heal
//!   timeline, and hardened git diff statistics to generate a structured PR title and
//!   copy-ready Markdown body (zero mutations, zero network calls).
//! - [`create_github_pr`] enforces an explicit `confirm: true` gate, verifies branch/remote
//!   state and `gh` CLI availability BEFORE ever pushing, supports non-destructive
//!   `dry_run: true` validation against local/remote git repos, and passes PR body text
//!   over stdin (`--body-file -`) with zero shell interpolation.

use crate::autoheal::HealAttempt;
use crate::checks::{PipelineReceipt, StepStatus};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

const MAX_PR_TITLE_CHARS: usize = 256;
const DEFAULT_TITLE_TARGET_CHARS: usize = 72;
const MAX_PR_BODY_BYTES: usize = 128 * 1024;
const MAX_FILES_IN_BODY: usize = 25;

/// Read-only projection of a Fleet session used to construct a PR preview.
///
/// Implemented for [`PrSessionInput`] and trivially implementable for `fleet-rs`'s
/// internal `Session` struct with zero cloning.
pub trait PrSessionView {
    fn id(&self) -> &str;
    fn task(&self) -> &str;
    fn project(&self) -> &str;
    fn branch(&self) -> &str;
    fn status(&self) -> &str;
    fn check_cmd(&self) -> &str;
    fn check_passed(&self) -> Option<bool>;
    fn verified_commit(&self) -> Option<&str>;
    fn check_receipt(&self) -> Option<&PipelineReceipt>;
    fn heal_attempts(&self) -> &[HealAttempt];
    fn diff(&self) -> &str;
}

/// Concrete serializable session input for standalone callers and integration tests.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrSessionInput {
    pub id: String,
    pub task: String,
    #[serde(default)]
    pub project: String,
    pub branch: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub check_cmd: String,
    #[serde(default)]
    pub check_passed: Option<bool>,
    #[serde(default)]
    pub verified_commit: Option<String>,
    #[serde(default)]
    pub check_receipt: Option<PipelineReceipt>,
    #[serde(default)]
    pub heal_attempts: Vec<HealAttempt>,
    #[serde(default)]
    pub diff: String,
}

impl PrSessionView for PrSessionInput {
    fn id(&self) -> &str {
        &self.id
    }
    fn task(&self) -> &str {
        &self.task
    }
    fn project(&self) -> &str {
        &self.project
    }
    fn branch(&self) -> &str {
        &self.branch
    }
    fn status(&self) -> &str {
        &self.status
    }
    fn check_cmd(&self) -> &str {
        &self.check_cmd
    }
    fn check_passed(&self) -> Option<bool> {
        self.check_passed
    }
    fn verified_commit(&self) -> Option<&str> {
        self.verified_commit.as_deref()
    }
    fn check_receipt(&self) -> Option<&PipelineReceipt> {
        self.check_receipt.as_ref()
    }
    fn heal_attempts(&self) -> &[HealAttempt] {
        &self.heal_attempts
    }
    fn diff(&self) -> &str {
        &self.diff
    }
}

/// Per-file insertion/deletion counts for PR diff summary rendering.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiffFileStat {
    pub path: String,
    pub insertions: usize,
    pub deletions: usize,
}

/// Aggregate diff statistics for a PR preview.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiffStatSummary {
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
    #[serde(default)]
    pub files: Vec<DiffFileStat>,
}

/// Structured PR preview returned by `GET /api/sessions/:id/pr-preview`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrPreview {
    pub session_id: String,
    pub title: String,
    pub body: String,
    pub base_branch: String,
    pub head_branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified_commit: Option<String>,
    pub commits_ahead: usize,
    pub diff_stat: DiffStatSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check_passed: Option<bool>,
    pub check_steps_count: usize,
    pub heal_attempts_count: usize,
    pub gh_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    pub ready_to_create: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Request payload for `POST /api/sessions/:id/pr`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrCreateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    #[serde(default)]
    pub draft: bool,
    /// Explicit confirmation gate. Must be `true` before pushing or invoking `gh`.
    #[serde(default)]
    pub confirm: bool,
    /// When `true` (with `confirm: true`), validates `git push --dry-run` without pushing or calling GitHub.
    #[serde(default)]
    pub dry_run: bool,
}

/// Outcome returned by [`create_github_pr`] / [`create_github_pr_with_options`].
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrCreateResult {
    pub created: bool,
    pub dry_run: bool,
    pub pushed: bool,
    pub branch: String,
    pub base_branch: String,
    pub title: String,
    pub draft: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub message: String,
}

/// Structured HTTP-ready error returned when PR creation is refused or fails.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrError {
    pub status: u16,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

fn git_cmd(repo: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]);
    cmd
}

/// Detect whether the GitHub CLI (`gh`) is executable on `PATH` without making network calls.
pub fn is_gh_available() -> bool {
    Command::new("gh")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn validate_branch_ref(branch: &str, label: &str) -> Result<String, PrError> {
    let trimmed = branch.trim();
    if trimmed.is_empty() {
        return Err(PrError {
            status: 400,
            code: "invalid-branch".to_string(),
            message: format!("{label} cannot be empty"),
            detail: None,
        });
    }
    if trimmed.starts_with('-')
        || trimmed.contains('\0')
        || trimmed.contains("..")
        || trimmed.chars().any(char::is_whitespace)
    {
        return Err(PrError {
            status: 400,
            code: "invalid-branch".to_string(),
            message: format!("invalid {label} '{trimmed}'"),
            detail: None,
        });
    }
    Ok(trimmed.to_string())
}

fn detect_base_branch(repo: &Path) -> String {
    git_cmd(repo)
        .args(["symbolic-ref", "--short", "-q", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "main".to_string())
}

fn detect_origin_remote(repo: &Path) -> (Option<String>, Option<String>) {
    let origin = git_cmd(repo)
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(url) = origin {
        return (Some("origin".to_string()), Some(url));
    }
    let first_remote = git_cmd(repo)
        .args(["remote"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .map(str::to_string)
        });
    if let Some(name) = first_remote {
        let url = git_cmd(repo)
            .args(["remote", "get-url", &name])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty());
        return (Some(name), url);
    }
    (None, None)
}

fn local_branch_exists(repo: &Path, branch: &str) -> bool {
    git_cmd(repo)
        .args(["rev-parse", "--verify", &format!("refs/heads/{branch}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn collect_git_diff_stat(repo: &Path, base_ref: &str, head_ref: &str) -> Option<DiffStatSummary> {
    let out = git_cmd(repo)
        .args([
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--numstat",
            &format!("{base_ref}...{head_ref}"),
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut files = Vec::new();
    let mut insertions = 0usize;
    let mut deletions = 0usize;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut cols = line.split('\t');
        let (Some(a), Some(d), Some(path)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        let ins = a.trim().parse::<usize>().unwrap_or(0);
        let del = d.trim().parse::<usize>().unwrap_or(0);
        insertions += ins;
        deletions += del;
        files.push(DiffFileStat {
            path: path.to_string(),
            insertions: ins,
            deletions: del,
        });
    }
    Some(DiffStatSummary {
        files_changed: files.len(),
        insertions,
        deletions,
        files,
    })
}

fn parse_unified_diff_stat(diff: &str) -> DiffStatSummary {
    let mut files: Vec<DiffFileStat> = Vec::new();
    let mut insertions = 0usize;
    let mut deletions = 0usize;
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            let path = rest
                .split(" b/")
                .nth(1)
                .unwrap_or(rest)
                .trim()
                .to_string();
            files.push(DiffFileStat {
                path,
                insertions: 0,
                deletions: 0,
            });
        } else if line.starts_with('+') && !line.starts_with("+++") {
            insertions += 1;
            if let Some(last) = files.last_mut() {
                last.insertions += 1;
            }
        } else if line.starts_with('-') && !line.starts_with("---") {
            deletions += 1;
            if let Some(last) = files.last_mut() {
                last.deletions += 1;
            }
        }
    }
    DiffStatSummary {
        files_changed: files.len(),
        insertions,
        deletions,
        files,
    }
}

/// Derive a clean single-line PR title (<= 72 characters) from the session task.
pub fn generate_pr_title(task: &str, project: &str) -> String {
    let first_line = task
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let stripped = first_line
        .trim_start_matches(['#', '-', '*', '>', ' '])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if stripped.is_empty() {
        let proj = project.trim();
        return if proj.is_empty() {
            "Fleet verified session update".to_string()
        } else {
            format!("Fleet verified update for {proj}")
        };
    }
    let count = stripped.chars().count();
    if count <= DEFAULT_TITLE_TARGET_CHARS {
        stripped
    } else {
        let mut short: String = stripped
            .chars()
            .take(DEFAULT_TITLE_TARGET_CHARS - 1)
            .collect();
        if let Some(pos) = short.rfind(' ') {
            if pos >= DEFAULT_TITLE_TARGET_CHARS / 2 {
                short.truncate(pos);
            }
        }
        short.push('…');
        short
    }
}

/// Build a structured PR title and Markdown body for a session without mutating git or
/// touching the network.
pub fn build_pr_preview<S: PrSessionView>(repo: &Path, session: &S) -> Result<PrPreview, String> {
    if session.branch().trim().is_empty() {
        return Err("session has no git branch recorded".to_string());
    }
    let repo_ok = repo.is_dir() && repo.join(".git").exists();
    let base_branch = if repo_ok {
        detect_base_branch(repo)
    } else {
        "main".to_string()
    };
    let head_branch = session.branch().trim().to_string();
    let head_ref = session
        .verified_commit()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&head_branch);

    let mut warnings = Vec::new();
    let (remote_name, remote_url) = if repo_ok {
        detect_origin_remote(repo)
    } else {
        warnings.push("repository path is not accessible locally".to_string());
        (None, None)
    };

    let branch_present = repo_ok && local_branch_exists(repo, &head_branch);
    if repo_ok && !branch_present {
        warnings.push(format!(
            "local branch '{head_branch}' does not exist in {}",
            repo.display()
        ));
    }

    let commits_ahead = if repo_ok && branch_present {
        git_cmd(repo)
            .args([
                "rev-list",
                "--count",
                &format!("{base_branch}..{head_ref}"),
            ])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<usize>().ok())
            .unwrap_or(0)
    } else {
        0
    };

    let diff_stat = if repo_ok && branch_present {
        collect_git_diff_stat(repo, &base_branch, head_ref)
            .unwrap_or_else(|| parse_unified_diff_stat(session.diff()))
    } else {
        parse_unified_diff_stat(session.diff())
    };

    let gh_available = is_gh_available();
    if !gh_available {
        warnings.push("GitHub CLI (gh) is not installed on PATH; copy Markdown or install gh to create PRs directly".to_string());
    }
    if remote_name.is_none() {
        warnings.push("no git remote configured; configure 'origin' before creating a remote PR".to_string());
    }
    if session.check_passed() != Some(true) {
        warnings.push("session verification check has not passed yet".to_string());
    }

    let title = generate_pr_title(session.task(), session.project());
    let body = render_pr_markdown(
        session,
        &base_branch,
        &head_branch,
        commits_ahead,
        &diff_stat,
    );

    let check_steps_count = session
        .check_receipt()
        .map(|r| r.steps.len())
        .unwrap_or_else(|| usize::from(!session.check_cmd().trim().is_empty()));
    let heal_attempts_count = session.heal_attempts().len();
    let ready_to_create = repo_ok
        && branch_present
        && remote_name.is_some()
        && gh_available
        && session.check_passed() == Some(true);

    Ok(PrPreview {
        session_id: session.id().to_string(),
        title,
        body,
        base_branch,
        head_branch,
        verified_commit: session.verified_commit().map(str::to_string),
        commits_ahead,
        diff_stat,
        check_passed: session.check_passed(),
        check_steps_count,
        heal_attempts_count,
        gh_available,
        remote_name,
        remote_url,
        ready_to_create,
        warnings,
    })
}

fn render_pr_markdown<S: PrSessionView>(
    session: &S,
    base_branch: &str,
    head_branch: &str,
    commits_ahead: usize,
    diff_stat: &DiffStatSummary,
) -> String {
    let mut md = String::with_capacity(1024);

    md.push_str("## Summary\n\n");
    let task_text = session.task().trim();
    if task_text.is_empty() {
        md.push_str("_No task description recorded._\n\n");
    } else {
        md.push_str(task_text);
        md.push_str("\n\n");
    }

    let short_sha = session
        .verified_commit()
        .map(|c| c.chars().take(12).collect::<String>())
        .unwrap_or_else(|| "unverified".to_string());
    md.push_str(&format!(
        "- **Session:** `{}`\n\
         - **Branches:** `{head_branch}` -> `{base_branch}` ({commits_ahead} commit{})\n\
         - **Verified commit:** `{short_sha}`\n\
         - **Status:** `{}`\n\n",
        session.id(),
        if commits_ahead == 1 { "" } else { "s" },
        session.status()
    ));

    md.push_str("## Verification Receipt\n\n");
    if let Some(receipt) = session.check_receipt() {
        let verdict = if receipt.passed { "Passed" } else { "Failed" };
        md.push_str(&format!(
            "Overall verdict: **{verdict}** ({}ms total)\n\n",
            receipt.total_elapsed_ms
        ));
        md.push_str("| Step | Command | Result | Exit | Duration | Tail |\n");
        md.push_str("| --- | --- | --- | --- | ---: | --- |\n");
        for step in &receipt.steps {
            let status_label = match step.status {
                StepStatus::Passed => "Passed",
                StepStatus::Failed => "Failed",
                StepStatus::TimedOut => "Timed out",
                StepStatus::PipesHeld => "Pipes held",
                StepStatus::Stopped => "Stopped",
                StepStatus::SpawnFailed => "Spawn failed",
                StepStatus::Skipped => "Skipped",
            };
            let exit_s = step
                .exit_code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "-".to_string());
            let tail = escape_md_cell(&step.tail_line, 80);
            let cmd = escape_md_cell(&step.cmd, 60);
            let name = escape_md_cell(&step.name, 40);
            md.push_str(&format!(
                "| {name} | `{cmd}` | {status_label} | {exit_s} | {}ms | {tail} |\n",
                step.elapsed_ms
            ));
        }
        md.push('\n');
    } else if !session.check_cmd().trim().is_empty() {
        let verdict = match session.check_passed() {
            Some(true) => "Passed",
            Some(false) => "Failed",
            None => "Not run",
        };
        md.push_str(&format!(
            "- **Check command:** `{}`\n- **Verdict:** {verdict}\n\n",
            escape_md_cell(session.check_cmd(), 120)
        ));
    } else {
        md.push_str("_No verification check recorded._\n\n");
    }

    let attempts = session.heal_attempts();
    if !attempts.is_empty() {
        md.push_str("## Auto-Heal Timeline\n\n");
        let healed_attempt = attempts.iter().rev().find(|a| a.healed).map(|a| a.attempt);
        if let Some(n) = healed_attempt {
            md.push_str(&format!(
                "Automatically repaired verification failure on attempt **{n}** of **{}**.\n\n",
                attempts.len()
            ));
        } else {
            md.push_str(&format!(
                "Executed **{}** automatic repair attempt(s).\n\n",
                attempts.len()
            ));
        }
        md.push_str("| Attempt | Trigger Step | Exit | Duration | Outcome | Diagnostic Tail |\n");
        md.push_str("| ---: | --- | --- | ---: | --- | --- |\n");
        for a in attempts {
            let exit_s = a
                .exit_code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "-".to_string());
            let outcome = if a.healed { "Healed" } else { "Retry needed" };
            let tail = escape_md_cell(
                a.stderr_tail
                    .lines()
                    .rev()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or(""),
                80,
            );
            md.push_str(&format!(
                "| {} | {} | {exit_s} | {}ms | {outcome} | {tail} |\n",
                a.attempt,
                escape_md_cell(&a.trigger_step, 40),
                a.elapsed_ms
            ));
        }
        md.push('\n');
    }

    md.push_str("## Diff Summary\n\n");
    md.push_str(&format!(
        "**{} file{} changed**, `+{} / -{}`\n",
        diff_stat.files_changed,
        if diff_stat.files_changed == 1 { "" } else { "s" },
        diff_stat.insertions,
        diff_stat.deletions
    ));
    if !diff_stat.files.is_empty() {
        md.push_str("\n| File | Additions | Deletions |\n");
        md.push_str("| --- | ---: | ---: |\n");
        for f in diff_stat.files.iter().take(MAX_FILES_IN_BODY) {
            md.push_str(&format!(
                "| `{}` | +{} | -{} |\n",
                escape_md_cell(&f.path, 120),
                f.insertions,
                f.deletions
            ));
        }
        if diff_stat.files.len() > MAX_FILES_IN_BODY {
            md.push_str(&format!(
                "\n_… and {} more file(s)._\n",
                diff_stat.files.len() - MAX_FILES_IN_BODY
            ));
        }
    }

    md
}

fn escape_md_cell(raw: &str, max_chars: usize) -> String {
    let compact: String = raw
        .replace(['\r', '\n'], " ")
        .replace('|', "\\|")
        .replace('`', "'")
        .trim()
        .to_string();
    if compact.chars().count() <= max_chars {
        compact
    } else {
        let mut s: String = compact.chars().take(max_chars.saturating_sub(1)).collect();
        s.push('…');
        s
    }
}

/// Safe confirmation-gated GitHub PR creation helper.
///
/// Refuses cleanly without pushing or calling `gh` unless `confirm == true`.
pub fn create_github_pr(
    repo: &Path,
    branch: &str,
    title: &str,
    body: &str,
    draft: bool,
    confirm: bool,
) -> Result<PrCreateResult, PrError> {
    create_github_pr_with_options(repo, branch, None, title, body, draft, confirm, false)
}

/// Full confirmation-gated PR creation supporting explicit base branch and `dry_run` mode
/// (validates `git push --dry-run` against a remote without mutating remote refs or calling GitHub).
#[allow(clippy::too_many_arguments)]
pub fn create_github_pr_with_options(
    repo: &Path,
    branch: &str,
    base_branch: Option<&str>,
    title: &str,
    body: &str,
    draft: bool,
    confirm: bool,
    dry_run: bool,
) -> Result<PrCreateResult, PrError> {
    if !confirm {
        return Err(PrError {
            status: 400,
            code: "confirmation-required".to_string(),
            message:
                "PR creation requires explicit confirmation (confirm: true). Nothing was pushed."
                    .to_string(),
            detail: None,
        });
    }

    let head = validate_branch_ref(branch, "branch")?;
    let clean_title = title.trim().to_string();
    if clean_title.is_empty()
        || clean_title.contains('\0')
        || clean_title.contains('\n')
        || clean_title.contains('\r')
        || clean_title.chars().count() > MAX_PR_TITLE_CHARS
    {
        return Err(PrError {
            status: 400,
            code: "invalid-title".to_string(),
            message: format!(
                "PR title must be a non-empty single line of at most {MAX_PR_TITLE_CHARS} characters"
            ),
            detail: None,
        });
    }
    if body.contains('\0') || body.len() > MAX_PR_BODY_BYTES {
        return Err(PrError {
            status: 400,
            code: "invalid-body".to_string(),
            message: format!(
                "PR body must be at most {MAX_PR_BODY_BYTES} bytes with no NUL bytes"
            ),
            detail: None,
        });
    }

    if !repo.is_dir() || !repo.join(".git").exists() {
        return Err(PrError {
            status: 400,
            code: "invalid-repo".to_string(),
            message: format!("'{}' is not a git repository", repo.display()),
            detail: None,
        });
    }

    if !local_branch_exists(repo, &head) {
        return Err(PrError {
            status: 409,
            code: "missing-branch".to_string(),
            message: format!("local branch '{head}' does not exist — nothing was pushed"),
            detail: None,
        });
    }

    let resolved_base = match base_branch.map(str::trim).filter(|s| !s.is_empty()) {
        Some(b) => validate_branch_ref(b, "base_branch")?,
        None => detect_base_branch(repo),
    };

    let (Some(remote_name), _remote_url) = detect_origin_remote(repo) else {
        return Err(PrError {
            status: 409,
            code: "missing-remote".to_string(),
            message: "no git remote configured (expected 'origin') — nothing was pushed".to_string(),
            detail: None,
        });
    };

    if dry_run {
        let dry_push = git_cmd(repo)
            .args(["push", "--dry-run", "--", &remote_name, &head])
            .output()
            .map_err(|e| PrError {
                status: 500,
                code: "git-error".to_string(),
                message: format!("could not run git push --dry-run: {e}"),
                detail: None,
            })?;
        if !dry_push.status.success() {
            let detail = format!(
                "{}{}",
                String::from_utf8_lossy(&dry_push.stdout),
                String::from_utf8_lossy(&dry_push.stderr)
            )
            .trim()
            .to_string();
            return Err(PrError {
                status: 409,
                code: "push-dry-run-failed".to_string(),
                message: format!("git push --dry-run to '{remote_name}' failed — nothing was pushed"),
                detail: (!detail.is_empty()).then_some(detail),
            });
        }
        return Ok(PrCreateResult {
            created: false,
            dry_run: true,
            pushed: false,
            branch: head,
            base_branch: resolved_base,
            title: clean_title,
            draft,
            url: None,
            message: format!(
                "Dry-run passed: branch push to '{remote_name}' verified cleanly without pushing or calling GitHub."
            ),
        });
    }

    // Check `gh` availability BEFORE pushing anything to the remote!
    if !is_gh_available() {
        return Err(PrError {
            status: 503,
            code: "gh-unavailable".to_string(),
            message: "GitHub CLI (gh) is not installed on this machine — install gh or copy the PR Markdown instead. Nothing was pushed.".to_string(),
            detail: None,
        });
    }

    // Push the verified session branch (never --force!).
    let push_out = git_cmd(repo)
        .args(["push", "-u", "--", &remote_name, &head])
        .output()
        .map_err(|e| PrError {
            status: 500,
            code: "git-error".to_string(),
            message: format!("could not run git push: {e}"),
            detail: None,
        })?;
    if !push_out.status.success() {
        let detail = format!(
            "{}{}",
            String::from_utf8_lossy(&push_out.stdout),
            String::from_utf8_lossy(&push_out.stderr)
        )
        .trim()
        .to_string();
        return Err(PrError {
            status: 409,
            code: "push-failed".to_string(),
            message: format!("git push to '{remote_name}' failed — PR was not created"),
            detail: (!detail.is_empty()).then_some(detail),
        });
    }

    let mut gh = Command::new("gh");
    gh.current_dir(repo)
        .args([
            "pr",
            "create",
            "--head",
            &head,
            "--base",
            &resolved_base,
            "--title",
            &clean_title,
            "--body-file",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if draft {
        gh.arg("--draft");
    }

    let mut child = gh.spawn().map_err(|e| PrError {
        status: 503,
        code: "gh-spawn-failed".to_string(),
        message: format!("could not start gh pr create: {e}"),
        detail: None,
    })?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(body.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| PrError {
        status: 500,
        code: "gh-wait-failed".to_string(),
        message: format!("gh pr create failed while waiting: {e}"),
        detail: None,
    })?;
    if !out.status.success() {
        let detail = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
        .trim()
        .to_string();
        return Err(PrError {
            status: 409,
            code: "gh-pr-create-failed".to_string(),
            message: "gh pr create failed after pushing the branch".to_string(),
            detail: (!detail.is_empty()).then_some(detail),
        });
    }

    let stdout_text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let url = stdout_text
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with("https://") || l.starts_with("http://"))
        .map(str::to_string);

    Ok(PrCreateResult {
        created: true,
        dry_run: false,
        pushed: true,
        branch: head,
        base_branch: resolved_base,
        title: clean_title,
        draft,
        url: url.clone(),
        message: match url {
            Some(ref u) => format!("Pull request created: {u}"),
            None => "Pull request created.".to_string(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_generator_truncates_and_cleans_markdown_prefixes() {
        assert_eq!(
            generate_pr_title("## Fix invoice tax rounding\nSecond line", "billing"),
            "Fix invoice tax rounding"
        );
        assert_eq!(
            generate_pr_title("   ", "billing"),
            "Fleet verified update for billing"
        );
        let long = "Implement comprehensive end-to-end worktree inspector with non-main validation and budget limits across repositories";
        let t = generate_pr_title(long, "fleet");
        assert!(t.chars().count() <= DEFAULT_TITLE_TARGET_CHARS);
        assert!(t.ends_with('…'));
    }

    #[test]
    fn create_github_pr_refuses_immediately_without_confirm() {
        let err = create_github_pr(
            Path::new("/nonexistent"),
            "fleet/s1",
            "Add feature",
            "body",
            false,
            false,
        )
        .unwrap_err();
        assert_eq!(err.status, 400);
        assert_eq!(err.code, "confirmation-required");
        assert!(err.message.contains("confirm: true"));
    }
}
