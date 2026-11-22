//! Git Worktree Inspector and safe non-main worktree removal.
//!
//! - [`list_repo_worktrees`] parses `git worktree list --porcelain` for a repository,
//!   annotates every linked worktree with its live dirty state, linked Fleet session
//!   status, and `is_orphan` flag.
//! - [`remove_worktree`] and [`remove_worktree_checked`] strictly enforce an allowlist
//!   against the repository's live registered non-main worktrees (refusing main repo
//!   worktrees, path-traversal escapes, symlink escapes, locked worktrees, and active
//!   running sessions).

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

/// Read-only projection of a Fleet session used to correlate worktrees to sessions.
pub trait WorktreeSessionView {
    fn id(&self) -> &str;
    fn status(&self) -> &str;
    fn repo(&self) -> &str;
    fn branch(&self) -> &str;
    fn worktree(&self) -> &str;
}

/// Concrete serializable session input for standalone callers and tests.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorktreeSessionInput {
    pub id: String,
    pub status: String,
    pub repo: String,
    pub branch: String,
    pub worktree: String,
}

impl WorktreeSessionView for WorktreeSessionInput {
    fn id(&self) -> &str {
        &self.id
    }
    fn status(&self) -> &str {
        &self.status
    }
    fn repo(&self) -> &str {
        &self.repo
    }
    fn branch(&self) -> &str {
        &self.branch
    }
    fn worktree(&self) -> &str {
        &self.worktree
    }
}

/// Raw parsed entry from `git worktree list --porcelain`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PorcelainWorktree {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub is_bare: bool,
    pub is_detached: bool,
    pub is_locked: bool,
    pub lock_reason: Option<String>,
    pub is_prunable: bool,
    pub prunable_reason: Option<String>,
}

/// Rich inspected worktree entry returned by `GET /api/repos/worktrees`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorktreeEntry {
    pub path: String,
    pub repo: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub is_main: bool,
    pub is_bare: bool,
    pub is_detached: bool,
    pub is_locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_reason: Option<String>,
    pub is_prunable: bool,
    pub exists_on_disk: bool,
    pub dirty: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_status: Option<String>,
    pub is_orphan: bool,
    pub removable: bool,
}

/// Result returned when a linked worktree is safely removed.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorktreeRemovalResult {
    pub removed: bool,
    pub repo: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub pruned: bool,
    pub message: String,
}

/// Structured HTTP-ready error returned when worktree inspection or removal is refused.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorktreeError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

fn git_cmd(repo: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]);
    cmd
}

/// Parse `git worktree list --porcelain` output into structured [`PorcelainWorktree`] items.
pub fn parse_worktree_porcelain(stdout: &str) -> Vec<PorcelainWorktree> {
    let mut entries = Vec::new();
    let mut current: Option<PorcelainWorktree> = None;

    for raw_line in stdout.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() {
            if let Some(entry) = current.take() {
                if !entry.path.is_empty() {
                    entries.push(entry);
                }
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(prev) = current.take() {
                if !prev.path.is_empty() {
                    entries.push(prev);
                }
            }
            current = Some(PorcelainWorktree {
                path: path.to_string(),
                ..PorcelainWorktree::default()
            });
            continue;
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        if let Some(head) = line.strip_prefix("HEAD ") {
            let h = head.trim();
            if !h.is_empty() {
                entry.head = Some(h.to_string());
            }
        } else if let Some(branch_ref) = line.strip_prefix("branch ") {
            let trimmed = branch_ref.trim();
            let short = trimmed.strip_prefix("refs/heads/").unwrap_or(trimmed);
            if !short.is_empty() {
                entry.branch = Some(short.to_string());
            }
        } else if line == "bare" {
            entry.is_bare = true;
        } else if line == "detached" {
            entry.is_detached = true;
        } else if line == "locked" {
            entry.is_locked = true;
        } else if let Some(reason) = line.strip_prefix("locked ") {
            entry.is_locked = true;
            let r = reason.trim();
            if !r.is_empty() {
                entry.lock_reason = Some(r.to_string());
            }
        } else if line == "prunable" {
            entry.is_prunable = true;
        } else if let Some(reason) = line.strip_prefix("prunable ") {
            entry.is_prunable = true;
            let r = reason.trim();
            if !r.is_empty() {
                entry.prunable_reason = Some(r.to_string());
            }
        }
    }

    if let Some(entry) = current {
        if !entry.path.is_empty() {
            entries.push(entry);
        }
    }
    entries
}

fn canonical_or_normalized(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| {
        if let (Some(parent), Some(name)) = (p.parent(), p.file_name()) {
            if let Ok(canon_parent) = std::fs::canonicalize(parent) {
                return canon_parent.join(name);
            }
        }
        p.to_path_buf()
    })
}

fn verify_git_repo(repo: &Path) -> Result<PathBuf, WorktreeError> {
    if !repo.is_dir() {
        return Err(WorktreeError {
            status: 400,
            code: "invalid-repo".to_string(),
            message: format!("repository folder does not exist: {}", repo.display()),
        });
    }
    let out = git_cmd(repo)
        .args(["rev-parse", "--git-dir"])
        .output()
        .map_err(|e| WorktreeError {
            status: 500,
            code: "git-error".to_string(),
            message: format!("could not run git rev-parse: {e}"),
        })?;
    if !out.status.success() {
        return Err(WorktreeError {
            status: 400,
            code: "invalid-repo".to_string(),
            message: format!("folder is not a git repository: {}", repo.display()),
        });
    }
    Ok(canonical_or_normalized(repo))
}

fn query_porcelain(repo: &Path) -> Result<Vec<PorcelainWorktree>, WorktreeError> {
    let out = git_cmd(repo)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| WorktreeError {
            status: 500,
            code: "git-error".to_string(),
            message: format!("could not run git worktree list: {e}"),
        })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(WorktreeError {
            status: 500,
            code: "git-worktree-list-failed".to_string(),
            message: format!("git worktree list failed: {stderr}"),
        });
    }
    Ok(parse_worktree_porcelain(&String::from_utf8_lossy(&out.stdout)))
}

fn worktree_is_dirty(wt_path: &Path) -> bool {
    if !wt_path.is_dir() {
        return false;
    }
    git_cmd(wt_path)
        .args(["status", "--porcelain"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

/// Inspect all git worktrees registered for `repo`, correlating each with `sessions`.
pub fn list_repo_worktrees<S: WorktreeSessionView>(
    repo: &Path,
    sessions: &[S],
) -> Result<Vec<WorktreeEntry>, WorktreeError> {
    let canon_repo = verify_git_repo(repo)?;
    let repo_str = canon_repo.to_string_lossy().to_string();
    let raw = query_porcelain(&canon_repo)?;

    let mut out = Vec::with_capacity(raw.len());
    for (idx, item) in raw.into_iter().enumerate() {
        let wt_path = PathBuf::from(&item.path);
        let canon_wt = canonical_or_normalized(&wt_path);
        // The first entry from `git worktree list --porcelain` is always the main worktree.
        let is_main = idx == 0 || canon_wt == canon_repo;
        let exists_on_disk = wt_path.is_dir();
        let dirty = if exists_on_disk && !item.is_bare {
            worktree_is_dirty(&wt_path)
        } else {
            false
        };

        let matched_session = if is_main {
            None
        } else {
            sessions.iter().find(|s| {
                let s_wt = s.worktree().trim();
                if !s_wt.is_empty() {
                    let s_canon = canonical_or_normalized(Path::new(s_wt));
                    if s_canon == canon_wt || s_wt == item.path {
                        return true;
                    }
                }
                if let Some(ref b) = item.branch {
                    let s_repo = s.repo().trim();
                    if !s_repo.is_empty()
                        && canonical_or_normalized(Path::new(s_repo)) == canon_repo
                        && s.branch().trim() == b
                    {
                        return true;
                    }
                }
                false
            })
        };

        let session_id = matched_session.map(|s| s.id().to_string());
        let session_status = matched_session.map(|s| s.status().to_string());

        let is_orphan = if is_main || item.is_bare {
            false
        } else if !exists_on_disk || item.is_prunable {
            true
        } else {
            match session_status.as_deref() {
                None => true,
                Some("merged" | "archived") => true,
                Some(_) => false,
            }
        };

        let is_running_session = matches!(
            session_status.as_deref(),
            Some("working" | "checking")
        );
        let removable = !is_main && !item.is_bare && !item.is_locked && !is_running_session;

        out.push(WorktreeEntry {
            path: item.path,
            repo: repo_str.clone(),
            head: item.head,
            branch: item.branch,
            is_main,
            is_bare: item.is_bare,
            is_detached: item.is_detached,
            is_locked: item.is_locked,
            lock_reason: item.lock_reason,
            is_prunable: item.is_prunable,
            exists_on_disk,
            dirty,
            session_id,
            session_status,
            is_orphan,
            removable,
        });
    }

    Ok(out)
}

/// Strictly validate `target_path` against path-escape vectors (`..`, NUL, relative paths)
/// and remove it ONLY if it matches a registered, non-main, unlocked linked worktree of `repo`.
pub fn remove_worktree(
    repo: &Path,
    target_path: &Path,
) -> Result<WorktreeRemovalResult, WorktreeError> {
    let empty: [WorktreeSessionInput; 0] = [];
    remove_worktree_checked(repo, target_path, None, &empty)
}

/// Remove a registered non-main worktree with optional containment root (`data_dir/worktrees`)
/// and active-session protection.
pub fn remove_worktree_checked<S: WorktreeSessionView>(
    repo: &Path,
    target_path: &Path,
    allowed_root: Option<&Path>,
    sessions: &[S],
) -> Result<WorktreeRemovalResult, WorktreeError> {
    let raw_str = target_path.to_string_lossy();
    if raw_str.trim().is_empty() || raw_str.contains('\0') {
        return Err(WorktreeError {
            status: 400,
            code: "invalid-path".to_string(),
            message: "worktree path cannot be empty or contain NUL bytes".to_string(),
        });
    }
    if !target_path.is_absolute() {
        return Err(WorktreeError {
            status: 400,
            code: "relative-path-refused".to_string(),
            message: "worktree path must be an absolute path".to_string(),
        });
    }
    if target_path
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(WorktreeError {
            status: 403,
            code: "path-traversal-refused".to_string(),
            message: "worktree path must not contain '..' traversal segments".to_string(),
        });
    }

    let canon_repo = verify_git_repo(repo)?;
    let canon_target = canonical_or_normalized(target_path);

    if canon_target == canon_repo {
        return Err(WorktreeError {
            status: 403,
            code: "main-worktree-protected".to_string(),
            message: "cannot remove the main repository worktree".to_string(),
        });
    }

    if let Some(root) = allowed_root {
        let canon_root = canonical_or_normalized(root);
        if !canon_target.starts_with(&canon_root) || canon_target == canon_root {
            return Err(WorktreeError {
                status: 403,
                code: "outside-worktree-root".to_string(),
                message: format!(
                    "worktree path '{}' escapes allowed worktrees directory '{}'",
                    target_path.display(),
                    root.display()
                ),
            });
        }
    }

    // Authoritative allowlist: target MUST be a registered worktree of `repo`!
    let entries = list_repo_worktrees(&canon_repo, sessions)?;
    let matched = entries
        .into_iter()
        .find(|e| canonical_or_normalized(Path::new(&e.path)) == canon_target);

    let Some(entry) = matched else {
        return Err(WorktreeError {
            status: 403,
            code: "unregistered-worktree".to_string(),
            message: format!(
                "refusing to remove '{}': path is not a registered linked worktree of '{}'",
                target_path.display(),
                canon_repo.display()
            ),
        });
    };

    if entry.is_main || entry.is_bare {
        return Err(WorktreeError {
            status: 403,
            code: "main-worktree-protected".to_string(),
            message: "cannot remove the main or bare repository worktree".to_string(),
        });
    }
    if entry.is_locked {
        return Err(WorktreeError {
            status: 409,
            code: "worktree-locked".to_string(),
            message: format!(
                "worktree '{}' is locked — unlock it in git before removing",
                entry.path
            ),
        });
    }
    if matches!(
        entry.session_status.as_deref(),
        Some("working" | "checking")
    ) {
        return Err(WorktreeError {
            status: 409,
            code: "session-active".to_string(),
            message: format!(
                "cannot remove worktree '{}' while session '{}' is active ({})",
                entry.path,
                entry.session_id.as_deref().unwrap_or("unknown"),
                entry.session_status.as_deref().unwrap_or("working")
            ),
        });
    }

    let registered_path = PathBuf::from(&entry.path);
    if registered_path.exists() {
        let rm = git_cmd(&canon_repo)
            .args(["worktree", "remove", "--force"])
            .arg(&registered_path)
            .output()
            .map_err(|e| WorktreeError {
                status: 500,
                code: "git-error".to_string(),
                message: format!("could not run git worktree remove: {e}"),
            })?;
        if !rm.status.success() && registered_path.exists() {
            // Double-check non-main invariant before any fallback directory removal.
            let canon_reg = canonical_or_normalized(&registered_path);
            if canon_reg == canon_repo {
                return Err(WorktreeError {
                    status: 403,
                    code: "main-worktree-protected".to_string(),
                    message: "cannot remove the main repository worktree".to_string(),
                });
            }
            let _ = std::fs::remove_dir_all(&registered_path);
        }
    }

    let pruned = git_cmd(&canon_repo)
        .args(["worktree", "prune"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if registered_path.exists() {
        return Err(WorktreeError {
            status: 500,
            code: "remove-incomplete".to_string(),
            message: format!(
                "worktree directory '{}' could not be removed completely",
                entry.path
            ),
        });
    }

    Ok(WorktreeRemovalResult {
        removed: true,
        repo: canon_repo.to_string_lossy().to_string(),
        path: entry.path.clone(),
        branch: entry.branch,
        pruned,
        message: format!("Removed worktree '{}'.", entry.path),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_parser_handles_main_linked_detached_locked_and_prunable() {
        let sample = "\
worktree /repos/app
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /data/worktrees/s1
HEAD 2222222222222222222222222222222222222222
branch refs/heads/fleet/s1
locked editing in progress

worktree /data/worktrees/s2
HEAD 3333333333333333333333333333333333333333
detached
prunable gitdir file points to non-existent location
";
        let parsed = parse_worktree_porcelain(sample);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].path, "/repos/app");
        assert_eq!(parsed[0].branch.as_deref(), Some("main"));
        assert!(!parsed[0].is_locked);

        assert_eq!(parsed[1].path, "/data/worktrees/s1");
        assert_eq!(parsed[1].branch.as_deref(), Some("fleet/s1"));
        assert!(parsed[1].is_locked);
        assert_eq!(parsed[1].lock_reason.as_deref(), Some("editing in progress"));

        assert_eq!(parsed[2].path, "/data/worktrees/s2");
        assert!(parsed[2].is_detached);
        assert!(parsed[2].is_prunable);
    }
}
