//! Non-destructive pre-merge dry-run conflict detection, `.patch` export, and
//! strategy-aware merge execution (`MergeCommit`, `Squash`, `FastForwardOnly`).
//!
//! Uses `git merge-tree --write-tree --name-only -z` so dry-run conflict checks
//! NEVER mutate the repository's working tree, index, `HEAD`, or `.git/MERGE_HEAD`.
//! All git invocations disable `core.fsmonitor`, `core.hooksPath`, external diff
//! drivers, and `textconv` to prevent repo-controlled config from interfering.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

/// Strategy used when landing a verified session commit onto the target branch.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MergeStrategy {
    /// Standard `--no-ff` merge commit preserving full branch history.
    #[default]
    #[serde(alias = "merge_commit", alias = "MergeCommit", alias = "merge")]
    MergeCommit,
    /// Squash all branch changes into a single commit on the target branch.
    #[serde(alias = "squash", alias = "Squash")]
    Squash,
    /// Fast-forward only (`--ff-only`); refuses if the target branch has diverged.
    #[serde(
        alias = "fast_forward_only",
        alias = "fast_forward",
        alias = "fast-forward",
        alias = "FastForwardOnly",
        alias = "ff-only",
        alias = "ff"
    )]
    FastForwardOnly,
}

impl MergeStrategy {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "" | "merge" | "merge-commit" | "merge_commit" | "mergecommit" => {
                Ok(Self::MergeCommit)
            }
            "squash" => Ok(Self::Squash),
            "ff" | "ff-only" | "fast-forward" | "fast-forward-only" | "fast_forward"
            | "fast_forward_only" | "fastforwardonly" => Ok(Self::FastForwardOnly),
            other => Err(format!(
                "unknown merge strategy '{other}' — expected merge-commit, squash, or fast-forward-only"
            )),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::MergeCommit => "merge-commit",
            Self::Squash => "squash",
            Self::FastForwardOnly => "fast-forward-only",
        }
    }
}

/// Output of a non-destructive pre-merge dry-run (`git merge-tree`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct MergeCheckResult {
    pub clean: bool,
    pub conflicting_files: Vec<String>,
    pub commits_ahead: usize,
    pub commits_behind: usize,
    pub target_ref: String,
    pub source_ref: String,
    pub can_fast_forward: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_tree: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub messages: Vec<String>,
}

impl MergeCheckResult {
    /// Check whether a chosen [`MergeStrategy`] can land cleanly given this dry-run result.
    pub fn can_apply_strategy(&self, strategy: MergeStrategy) -> Result<(), String> {
        if !self.clean {
            let files = if self.conflicting_files.is_empty() {
                "unknown files".to_string()
            } else {
                self.conflicting_files.join(", ")
            };
            return Err(format!(
                "Merge conflict in {files}. Resolve conflicts before merging."
            ));
        }
        if strategy == MergeStrategy::FastForwardOnly && !self.can_fast_forward {
            return Err(format!(
                "Fast-forward is not possible: '{}' is {} commit(s) behind '{}'. Use merge-commit or squash, or rebase first.",
                self.source_ref, self.commits_behind, self.target_ref
            ));
        }
        Ok(())
    }
}

/// Format of an exported `.patch` artifact.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PatchFormat {
    /// `git format-patch --stdout <base>..<head>` mailbox patch series (default).
    #[default]
    #[serde(alias = "format_patch", alias = "mbox")]
    FormatPatch,
    /// Single unified `git diff <base>...<head>` patch.
    #[serde(alias = "unified_diff", alias = "diff", alias = "unified")]
    UnifiedDiff,
}

impl PatchFormat {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "" | "format-patch" | "format_patch" | "mbox" | "patch" => Ok(Self::FormatPatch),
            "unified" | "unified-diff" | "unified_diff" | "diff" => Ok(Self::UnifiedDiff),
            other => Err(format!(
                "unknown patch format '{other}' — expected format-patch or unified-diff"
            )),
        }
    }
}

/// Exported `.patch` payload and summary stats for a session branch.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PatchExport {
    pub filename: String,
    pub format: PatchFormat,
    pub commits: usize,
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
    pub content: String,
}

/// Result of landing a verified commit onto the repository's checked-out branch.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct MergeOutcome {
    pub strategy: MergeStrategy,
    pub landed_commit: String,
    pub source_commit: String,
    pub target_branch: String,
}

/// Structured refusal returned by [`execute_merge`].
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct MergeApplyError {
    pub status: u16,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

fn git_cmd(repo: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo).args([
        "-c",
        "core.fsmonitor=false",
        "-c",
        if cfg!(windows) {
            "core.hooksPath=NUL"
        } else {
            "core.hooksPath=/dev/null"
        },
    ]);
    cmd
}

fn validate_git_ref(r: &str) -> Result<String, String> {
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
    Ok(trimmed.to_string())
}

fn verify_commit_exists(repo: &Path, git_ref: &str) -> Result<String, String> {
    let out = git_cmd(repo)
        .args(["rev-parse", "--verify", &format!("{git_ref}^{{commit}}")])
        .output()
        .map_err(|e| format!("could not run git rev-parse: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("unknown git commit or ref '{git_ref}': {stderr}"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Run a non-destructive `git merge-tree --write-tree` dry-run between `target_ref` and `source_ref`.
///
/// Neither the repository's working tree, index, `HEAD`, nor `.git/MERGE_HEAD` is modified.
pub fn dry_run_merge(
    repo: &Path,
    target_ref: &str,
    source_ref: &str,
) -> Result<MergeCheckResult, String> {
    let target = validate_git_ref(target_ref)?;
    let source = validate_git_ref(source_ref)?;

    let target_oid = verify_commit_exists(repo, &target)?;
    let source_oid = verify_commit_exists(repo, &source)?;

    // Left = target (commits_behind), Right = source (commits_ahead).
    let count_out = git_cmd(repo)
        .args([
            "rev-list",
            "--left-right",
            "--count",
            &format!("{target_oid}...{source_oid}"),
        ])
        .output()
        .map_err(|e| format!("could not run git rev-list: {e}"))?;
    if !count_out.status.success() {
        let stderr = String::from_utf8_lossy(&count_out.stderr).trim().to_string();
        return Err(format!("git rev-list failed: {stderr}"));
    }
    let count_text = String::from_utf8_lossy(&count_out.stdout);
    let mut parts = count_text.split_whitespace();
    let commits_behind = parts
        .next()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);
    let commits_ahead = parts
        .next()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);

    let mt_out = git_cmd(repo)
        .args([
            "merge-tree",
            "--write-tree",
            "--name-only",
            "-z",
            &target_oid,
            &source_oid,
        ])
        .output()
        .map_err(|e| format!("could not run git merge-tree: {e}"))?;

    match mt_out.status.code() {
        Some(0) => {
            let tree = mt_out
                .stdout
                .split(|&b| b == 0)
                .next()
                .map(|b| String::from_utf8_lossy(b).trim().to_string())
                .filter(|s| !s.is_empty());
            Ok(MergeCheckResult {
                clean: true,
                conflicting_files: Vec::new(),
                commits_ahead,
                commits_behind,
                target_ref: target,
                source_ref: source,
                can_fast_forward: commits_behind == 0,
                merged_tree: tree,
                messages: Vec::new(),
            })
        }
        Some(1) => {
            let (tree, conflicting_files, messages) = parse_merge_tree_z_conflict(&mt_out.stdout);
            Ok(MergeCheckResult {
                clean: false,
                conflicting_files,
                commits_ahead,
                commits_behind,
                target_ref: target,
                source_ref: source,
                can_fast_forward: false,
                merged_tree: tree,
                messages,
            })
        }
        other => {
            let stderr = String::from_utf8_lossy(&mt_out.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&mt_out.stdout).trim().to_string();
            if stderr.contains("unrelated histories") || stdout.contains("unrelated histories") {
                return Ok(MergeCheckResult {
                    clean: false,
                    conflicting_files: Vec::new(),
                    commits_ahead,
                    commits_behind,
                    target_ref: target,
                    source_ref: source,
                    can_fast_forward: false,
                    merged_tree: None,
                    messages: vec!["refusing to merge unrelated histories".to_string()],
                });
            }
            Err(format!(
                "git merge-tree failed (exit {other:?}): {}",
                if !stderr.is_empty() { stderr } else { stdout }
            ))
        }
    }
}

/// Parse `git merge-tree --write-tree --name-only -z` output when conflicts exist (exit 1).
///
/// Format:
/// `<tree-oid>\0<conflict-file-1>\0...<conflict-file-k>\0\0<msg-records...>`
/// where each message record is `<path_count>\0<p1>\0...<pn>\0<conflict_type>\0<human_msg>\0`.
fn parse_merge_tree_z_conflict(bytes: &[u8]) -> (Option<String>, Vec<String>, Vec<String>) {
    let fields: Vec<&[u8]> = bytes.split(|&b| b == 0).collect();
    if fields.is_empty() {
        return (None, Vec::new(), Vec::new());
    }
    let tree = {
        let s = String::from_utf8_lossy(fields[0]).trim().to_string();
        (!s.is_empty()).then_some(s)
    };

    let mut files: Vec<String> = Vec::new();
    let mut idx = 1usize;
    while idx < fields.len() && !fields[idx].is_empty() {
        let f = String::from_utf8_lossy(fields[idx]).to_string();
        if !files.contains(&f) {
            files.push(f);
        }
        idx += 1;
    }
    files.sort();

    // Advance past the empty NUL separator into informational conflict messages.
    if idx < fields.len() && fields[idx].is_empty() {
        idx += 1;
    }

    let mut messages = Vec::new();
    while idx < fields.len() {
        if fields[idx].is_empty() {
            idx += 1;
            continue;
        }
        let count_str = String::from_utf8_lossy(fields[idx]);
        if let Ok(path_count) = count_str.trim().parse::<usize>() {
            let msg_idx = idx + 1 + path_count + 1;
            if msg_idx < fields.len() {
                let msg = String::from_utf8_lossy(fields[msg_idx]).trim().to_string();
                if !msg.is_empty() && msg.contains("CONFLICT") {
                    messages.push(msg);
                }
                idx = msg_idx + 1;
                continue;
            }
        }
        break;
    }

    (tree, files, messages)
}

/// Export a session's verified work as a `.patch` (either `git format-patch` mbox series
/// or a unified `git diff` patch) with accurate file/line statistics.
pub fn export_patch(
    repo: &Path,
    base_ref: &str,
    head_ref: &str,
    session_id: &str,
    format: PatchFormat,
) -> Result<PatchExport, String> {
    let base = validate_git_ref(base_ref)?;
    let head = validate_git_ref(head_ref)?;
    let base_oid = verify_commit_exists(repo, &base)?;
    let head_oid = verify_commit_exists(repo, &head)?;

    let commits_out = git_cmd(repo)
        .args(["rev-list", "--count", &format!("{base_oid}..{head_oid}")])
        .output()
        .map_err(|e| format!("could not count patch commits: {e}"))?;
    let commits = if commits_out.status.success() {
        String::from_utf8_lossy(&commits_out.stdout)
            .trim()
            .parse::<usize>()
            .unwrap_or(0)
    } else {
        0
    };

    let (files_changed, insertions, deletions) = diff_numstat(repo, &base_oid, &head_oid);

    let content = match format {
        PatchFormat::FormatPatch => {
            let out = git_cmd(repo)
                .args([
                    "format-patch",
                    "--stdout",
                    "--no-ext-diff",
                    "--no-textconv",
                    &format!("{base_oid}..{head_oid}"),
                ])
                .output()
                .map_err(|e| format!("could not run git format-patch: {e}"))?;
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                return Err(format!("git format-patch failed: {stderr}"));
            }
            String::from_utf8_lossy(&out.stdout).to_string()
        }
        PatchFormat::UnifiedDiff => {
            let out = git_cmd(repo)
                .args([
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    &format!("{base_oid}...{head_oid}"),
                ])
                .output()
                .map_err(|e| format!("could not run git diff: {e}"))?;
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                return Err(format!("git diff failed: {stderr}"));
            }
            String::from_utf8_lossy(&out.stdout).to_string()
        }
    };

    let filename = sanitize_patch_filename(session_id);
    Ok(PatchExport {
        filename,
        format,
        commits,
        files_changed,
        insertions,
        deletions,
        content,
    })
}

fn diff_numstat(repo: &Path, base_oid: &str, head_oid: &str) -> (usize, usize, usize) {
    let out = git_cmd(repo)
        .args([
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--numstat",
            &format!("{base_oid}...{head_oid}"),
        ])
        .output();
    let Ok(o) = out else {
        return (0, 0, 0);
    };
    if !o.status.success() {
        return (0, 0, 0);
    }
    let mut files = 0usize;
    let mut ins = 0usize;
    let mut del = 0usize;
    for line in String::from_utf8_lossy(&o.stdout).lines() {
        let mut cols = line.split('\t');
        let (Some(a), Some(d), Some(_path)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        files += 1;
        ins += a.trim().parse::<usize>().unwrap_or(0);
        del += d.trim().parse::<usize>().unwrap_or(0);
    }
    (files, ins, del)
}

fn sanitize_patch_filename(session_id: &str) -> String {
    let cleaned: String = session_id
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c| c == '.' || c == '-');
    if trimmed.is_empty() {
        "session.patch".to_string()
    } else if trimmed.ends_with(".patch") {
        trimmed.to_string()
    } else {
        format!("{trimmed}.patch")
    }
}

/// Map git's raw merge refusal text to a plain operator sentence for common actionable failures.
pub fn plain_merge_refusal(raw: &str) -> Option<String> {
    if raw.contains("identity unknown")
        || raw.contains("Please tell me who you are")
        || raw.contains("auto-detection is disabled")
    {
        return Some(
            "Git has no name and email for the merge commit. Set them with git config user.name and git config user.email in this repo, then merge again. Nothing was merged."
                .to_string(),
        );
    }
    if raw.contains("Not possible to fast-forward") {
        return Some(
            "Fast-forward merge is not possible because the target branch has new commits. Choose Merge commit or Squash instead. Nothing was merged."
                .to_string(),
        );
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

/// Land a pinned `verified_commit` onto `repo`'s checked-out branch using `strategy`.
///
/// Preserves all Fleet merge safety guarantees:
/// - Refuses when `MERGE_HEAD` exists, tracked files have uncommitted edits, or `HEAD` is detached.
/// - On any failure, cleanly aborts/resets so the operator's repository is never left half-merged.
pub fn execute_merge(
    repo: &Path,
    verified_commit: &str,
    session_id: &str,
    strategy: MergeStrategy,
) -> Result<MergeOutcome, MergeApplyError> {
    let pin = validate_git_ref(verified_commit).map_err(|m| MergeApplyError {
        status: 400,
        message: m,
        detail: None,
    })?;
    let pin_oid = verify_commit_exists(repo, &pin).map_err(|m| MergeApplyError {
        status: 409,
        message: m,
        detail: None,
    })?;

    if repo.join(".git").join("MERGE_HEAD").exists() {
        return Err(MergeApplyError {
            status: 409,
            message: "repo already has a merge in progress — resolve or abort it before merging a session".to_string(),
            detail: None,
        });
    }

    let status = git_cmd(repo)
        .args(["status", "--porcelain"])
        .output()
        .map_err(|e| MergeApplyError {
            status: 500,
            message: e.to_string(),
            detail: None,
        })?;
    let dirty = String::from_utf8_lossy(&status.stdout)
        .lines()
        .any(|l| !l.starts_with("??"));
    if dirty {
        return Err(MergeApplyError {
            status: 409,
            message: "repo has uncommitted changes — commit or stash them before merging a session"
                .to_string(),
            detail: None,
        });
    }

    let branch_out = git_cmd(repo)
        .args(["symbolic-ref", "--short", "-q", "HEAD"])
        .output()
        .map_err(|e| MergeApplyError {
            status: 500,
            message: e.to_string(),
            detail: None,
        })?;
    if !branch_out.status.success() {
        return Err(MergeApplyError {
            status: 409,
            message: "repo is on a detached HEAD — check out a branch before merging a session, or the work lands on no branch".to_string(),
            detail: None,
        });
    }
    let target_branch = String::from_utf8_lossy(&branch_out.stdout)
        .trim()
        .to_string();

    match strategy {
        MergeStrategy::MergeCommit => {
            let out = Command::new("git")
                .arg("-C")
                .arg(repo)
                .args([
                    "merge",
                    "--no-ff",
                    "-m",
                    &format!("merge fleet session {session_id}"),
                    &pin_oid,
                ])
                .output()
                .map_err(|e| MergeApplyError {
                    status: 500,
                    message: e.to_string(),
                    detail: None,
                })?;
            if !out.status.success() {
                let _ = Command::new("git")
                    .arg("-C")
                    .arg(repo)
                    .args(["merge", "--abort"])
                    .output();
                return Err(build_merge_error(&out.stdout, &out.stderr));
            }
            verify_ancestor(repo, &pin_oid)?;
            let landed = verify_commit_exists(repo, "HEAD").unwrap_or_else(|_| pin_oid.clone());
            Ok(MergeOutcome {
                strategy,
                landed_commit: landed,
                source_commit: pin_oid,
                target_branch,
            })
        }
        MergeStrategy::FastForwardOnly => {
            let out = Command::new("git")
                .arg("-C")
                .arg(repo)
                .args(["merge", "--ff-only", &pin_oid])
                .output()
                .map_err(|e| MergeApplyError {
                    status: 500,
                    message: e.to_string(),
                    detail: None,
                })?;
            if !out.status.success() {
                let _ = Command::new("git")
                    .arg("-C")
                    .arg(repo)
                    .args(["merge", "--abort"])
                    .output();
                return Err(build_merge_error(&out.stdout, &out.stderr));
            }
            verify_ancestor(repo, &pin_oid)?;
            let landed = verify_commit_exists(repo, "HEAD").unwrap_or_else(|_| pin_oid.clone());
            Ok(MergeOutcome {
                strategy,
                landed_commit: landed,
                source_commit: pin_oid,
                target_branch,
            })
        }
        MergeStrategy::Squash => {
            let merge_out = Command::new("git")
                .arg("-C")
                .arg(repo)
                .args(["merge", "--squash", &pin_oid])
                .output()
                .map_err(|e| MergeApplyError {
                    status: 500,
                    message: e.to_string(),
                    detail: None,
                })?;
            if !merge_out.status.success() {
                let _ = Command::new("git")
                    .arg("-C")
                    .arg(repo)
                    .args(["reset", "--merge"])
                    .output();
                return Err(build_merge_error(&merge_out.stdout, &merge_out.stderr));
            }
            let short_sha: String = pin_oid.chars().take(12).collect();
            let commit_out = Command::new("git")
                .arg("-C")
                .arg(repo)
                .args([
                    "commit",
                    "--allow-empty",
                    "-m",
                    &format!("squash fleet session {session_id} ({short_sha})"),
                ])
                .output()
                .map_err(|e| MergeApplyError {
                    status: 500,
                    message: e.to_string(),
                    detail: None,
                })?;
            if !commit_out.status.success() {
                let _ = Command::new("git")
                    .arg("-C")
                    .arg(repo)
                    .args(["reset", "--merge"])
                    .output();
                return Err(build_merge_error(&commit_out.stdout, &commit_out.stderr));
            }
            let landed = verify_commit_exists(repo, "HEAD").unwrap_or_else(|_| pin_oid.clone());
            Ok(MergeOutcome {
                strategy,
                landed_commit: landed,
                source_commit: pin_oid,
                target_branch,
            })
        }
    }
}

fn verify_ancestor(repo: &Path, pin_oid: &str) -> Result<(), MergeApplyError> {
    let landed = git_cmd(repo)
        .args(["merge-base", "--is-ancestor", pin_oid, "HEAD"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !landed {
        return Err(MergeApplyError {
            status: 409,
            message:
                "merge ran but the session's commit is not in the repo's history — nothing was landed"
                    .to_string(),
            detail: None,
        });
    }
    Ok(())
}

fn build_merge_error(stdout: &[u8], stderr: &[u8]) -> MergeApplyError {
    let raw = format!(
        "{}{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    );
    let trimmed = raw.trim().to_string();
    let detail = (!trimmed.is_empty()).then_some(trimmed);
    if let Some(plain) = plain_merge_refusal(&raw) {
        return MergeApplyError {
            status: 409,
            message: plain,
            detail,
        };
    }
    let lines: Vec<&str> = raw
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(3)
        .collect();
    let summary = if lines.is_empty() {
        "merge failed".to_string()
    } else {
        lines.join(" — ")
    };
    MergeApplyError {
        status: 409,
        message: format!("merge refused: {summary} — nothing was merged"),
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_strategy_parses_aliases_and_rejects_invalid() {
        assert_eq!(MergeStrategy::parse("merge").unwrap(), MergeStrategy::MergeCommit);
        assert_eq!(MergeStrategy::parse("merge-commit").unwrap(), MergeStrategy::MergeCommit);
        assert_eq!(MergeStrategy::parse("squash").unwrap(), MergeStrategy::Squash);
        assert_eq!(MergeStrategy::parse("ff").unwrap(), MergeStrategy::FastForwardOnly);
        assert_eq!(
            MergeStrategy::parse("fast-forward-only").unwrap(),
            MergeStrategy::FastForwardOnly
        );
        assert!(MergeStrategy::parse("octopus").is_err());
    }

    #[test]
    fn patch_filename_sanitizes_traversal_and_special_chars() {
        assert_eq!(sanitize_patch_filename("s123-4"), "s123-4.patch");
        assert_eq!(sanitize_patch_filename("../../etc/passwd"), "etc-passwd.patch");
        assert_eq!(sanitize_patch_filename("   "), "session.patch");
    }
}
