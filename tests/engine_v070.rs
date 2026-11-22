//! Integration, real-git, and adversarial security tests for `v0.7.0` DSH-Fleet engines:
//! - `pr`: PR preview Markdown/stats + confirmation-gated local bare-remote dry-run
//! - `worktrees`: `git worktree list --porcelain` inspector, orphan/dirty detection, path-escape defense
//! - `budget`: `BudgetConfig`/`BudgetStatus`/`BudgetTracker` 429 enforcement, UTC rollover & fuzzing

use fleet_rs::autoheal::HealAttempt;
use fleet_rs::budget::{
    check_dispatch_allowance, evaluate_budget, utc_day_string, BudgetConfig, BudgetStatus,
    BudgetTracker, MAX_ALLOWED_DAILY_SESSIONS, MAX_ALLOWED_HEAL_ATTEMPTS, MAX_ALLOWED_SESSION_MINS,
};
use fleet_rs::checks::{CheckStepReceipt, PipelineReceipt, StepStatus};
use fleet_rs::pr::{
    build_pr_preview, create_github_pr, create_github_pr_with_options, PrCreateRequest,
    PrCreateResult, PrPreview, PrSessionInput,
};
use fleet_rs::worktrees::{
    list_repo_worktrees, remove_worktree, remove_worktree_checked, WorktreeEntry,
    WorktreeSessionInput,
};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

struct TempDirGuard(PathBuf);

impl TempDirGuard {
    fn new(tag: &str) -> Self {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "fleet-v070-eng-{tag}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git_ok(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.email=fleet-test@localhost",
            "-c",
            "user.name=Fleet Test",
        ])
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git should spawn");
    assert!(
        out.status.success(),
        "git {:?} failed in {}:\nstdout: {}\nstderr: {}",
        args,
        cwd.display(),
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn seed_repo_with_bare_origin(dir: &Path) -> (PathBuf, PathBuf) {
    let bare = dir.join("origin.git");
    std::fs::create_dir_all(&bare).unwrap();
    git_ok(&bare, &["init", "--bare", "-b", "main"]);

    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git_ok(&repo, &["init", "-b", "main"]);
    git_ok(&repo, &["config", "user.email", "fleet-test@localhost"]);
    git_ok(&repo, &["config", "user.name", "Fleet Test"]);
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(repo.join("README.md"), "# Demo Repo\n").unwrap();
    std::fs::write(repo.join("src/math.rs"), "pub fn add(a: i32, b: i32) -> i32 { a + b }\n")
        .unwrap();
    git_ok(&repo, &["add", "-A"]);
    git_ok(&repo, &["commit", "-m", "initial commit"]);
    git_ok(&repo, &["remote", "add", "origin", bare.to_str().unwrap()]);
    git_ok(&repo, &["push", "-u", "origin", "main"]);
    (repo, bare)
}

#[test]
fn pr_preview_and_confirmation_gated_local_bare_remote_dry_run() {
    let tmp = TempDirGuard::new("pr");
    let (repo, bare) = seed_repo_with_bare_origin(tmp.path());

    // Create a verified session branch with 2 commits.
    git_ok(&repo, &["checkout", "-b", "fleet/s77"]);
    std::fs::write(
        repo.join("src/math.rs"),
        "pub fn add(a: i32, b: i32) -> i32 { a + b }\npub fn mul(a: i32, b: i32) -> i32 { a * b }\n",
    )
    .unwrap();
    git_ok(&repo, &["add", "-A"]);
    git_ok(&repo, &["commit", "-m", "feat: add mul"]);
    std::fs::write(repo.join("README.md"), "# Demo Repo\n\nIncludes `mul`.\n").unwrap();
    git_ok(&repo, &["add", "-A"]);
    git_ok(&repo, &["commit", "-m", "docs: document mul"]);
    let verified_sha = git_ok(&repo, &["rev-parse", "HEAD"]);
    git_ok(&repo, &["checkout", "main"]);

    let receipt = PipelineReceipt {
        passed: true,
        ran: true,
        total_elapsed_ms: 420,
        failed_step_index: None,
        failed_step_name: None,
        exit_code: Some(0),
        timed_out: false,
        pipes_held: false,
        stopped: false,
        combined_output: "ok".to_string(),
        summary_reason: None,
        steps: vec![
            CheckStepReceipt {
                name: "clippy".to_string(),
                cmd: "cargo clippy --all-targets -- -D warnings".to_string(),
                status: StepStatus::Passed,
                passed: true,
                exit_code: Some(0),
                elapsed_ms: 170,
                tail_line: "0 warnings".to_string(),
                output: "0 warnings".to_string(),
            },
            CheckStepReceipt {
                name: "test".to_string(),
                cmd: "cargo test".to_string(),
                status: StepStatus::Passed,
                passed: true,
                exit_code: Some(0),
                elapsed_ms: 250,
                tail_line: "12 passed; 0 failed".to_string(),
                output: "12 passed; 0 failed".to_string(),
            },
        ],
    };

    let session = PrSessionInput {
        id: "s77".to_string(),
        task: "Add integer multiplication helper and README docs".to_string(),
        project: "demo-repo".to_string(),
        branch: "fleet/s77".to_string(),
        status: "done".to_string(),
        check_cmd: "cargo clippy && cargo test".to_string(),
        check_passed: Some(true),
        verified_commit: Some(verified_sha.clone()),
        check_receipt: Some(receipt),
        heal_attempts: vec![HealAttempt {
            attempt: 1,
            trigger_step: "test".to_string(),
            exit_code: Some(101),
            stderr_tail: "test mul ... FAILED".to_string(),
            prompt_sent: "fix mul".to_string(),
            started_ms: 1000,
            elapsed_ms: 850,
            healed: true,
        }],
        diff: String::new(),
    };

    let preview = build_pr_preview(&repo, &session).unwrap();
    assert_eq!(preview.session_id, "s77");
    assert_eq!(
        preview.title,
        "Add integer multiplication helper and README docs"
    );
    assert_eq!(preview.base_branch, "main");
    assert_eq!(preview.head_branch, "fleet/s77");
    assert_eq!(preview.commits_ahead, 2);
    assert_eq!(preview.diff_stat.files_changed, 2);
    assert_eq!(preview.diff_stat.insertions, 3);
    assert_eq!(preview.diff_stat.deletions, 0);
    assert_eq!(preview.check_steps_count, 2);
    assert_eq!(preview.heal_attempts_count, 1);
    assert_eq!(preview.remote_name.as_deref(), Some("origin"));
    assert!(preview.body.contains("## Summary"));
    assert!(preview.body.contains("## Verification Receipt"));
    assert!(preview.body.contains("12 passed; 0 failed"));
    assert!(preview.body.contains("## Auto-Heal Timeline"));
    assert!(preview.body.contains("Automatically repaired verification failure on attempt **1**"));
    assert!(preview.body.contains("## Diff Summary"));
    assert!(preview.body.contains("`src/math.rs`"));
    assert!(
        !preview.body.to_lowercase().contains("rune"),
        "PR body must contain zero internal jargon"
    );

    // 1. Without confirm=true -> refuses cleanly without pushing.
    let unconfirmed = create_github_pr(
        &repo,
        "fleet/s77",
        &preview.title,
        &preview.body,
        true,
        false,
    )
    .unwrap_err();
    assert_eq!(unconfirmed.status, 400);
    assert_eq!(unconfirmed.code, "confirmation-required");

    // 2. With confirm=true + dry_run=true -> validates git push --dry-run against bare origin without mutating bare!
    let dry = create_github_pr_with_options(
        &repo,
        "fleet/s77",
        Some("main"),
        &preview.title,
        &preview.body,
        true,
        true,
        true,
    )
    .unwrap();
    assert!(dry.dry_run);
    assert!(!dry.pushed);
    assert!(!dry.created);
    assert_eq!(dry.branch, "fleet/s77");
    assert_eq!(dry.base_branch, "main");

    // Verify bare remote STILL has only `main` (nothing pushed!).
    let bare_refs = git_ok(&bare, &["branch", "--list"]);
    assert!(
        !bare_refs.contains("fleet/s77"),
        "dry_run must not push branch to bare remote: {bare_refs}"
    );

    // 3. Flag-injection branch / missing branch / missing remote all fail cleanly.
    let bad_flag = create_github_pr_with_options(
        &repo,
        "--all",
        None,
        "Title",
        "Body",
        false,
        true,
        true,
    )
    .unwrap_err();
    assert_eq!(bad_flag.status, 400);
    assert_eq!(bad_flag.code, "invalid-branch");

    let missing_branch = create_github_pr_with_options(
        &repo,
        "fleet/no-such-branch",
        None,
        "Title",
        "Body",
        false,
        true,
        true,
    )
    .unwrap_err();
    assert_eq!(missing_branch.status, 409);
    assert_eq!(missing_branch.code, "missing-branch");
}

#[test]
fn worktree_inspector_detects_dirty_orphans_and_blocks_all_escape_attacks() {
    let tmp = TempDirGuard::new("worktrees");
    let (repo, _bare) = seed_repo_with_bare_origin(tmp.path());
    let wt_root = tmp.path().join("data/worktrees");
    std::fs::create_dir_all(&wt_root).unwrap();

    let wt_active = wt_root.join("s-active");
    let wt_dirty = wt_root.join("s-dirty");
    let wt_orphan = wt_root.join("s-orphan");
    let wt_merged = wt_root.join("s-merged");
    let wt_locked = wt_root.join("s-locked");

    for (branch, path) in [
        ("fleet/s-active", &wt_active),
        ("fleet/s-dirty", &wt_dirty),
        ("fleet/s-orphan", &wt_orphan),
        ("fleet/s-merged", &wt_merged),
        ("fleet/s-locked", &wt_locked),
    ] {
        git_ok(
            &repo,
            &["worktree", "add", "-b", branch, path.to_str().unwrap(), "main"],
        );
    }

    // Dirty one worktree and lock another.
    std::fs::write(wt_dirty.join("uncommitted.txt"), "dirty\n").unwrap();
    git_ok(
        &repo,
        &[
            "worktree",
            "lock",
            "--reason",
            "operator hold",
            wt_locked.to_str().unwrap(),
        ],
    );

    let sessions = vec![
        WorktreeSessionInput {
            id: "s-active".to_string(),
            status: "working".to_string(),
            repo: repo.to_string_lossy().to_string(),
            branch: "fleet/s-active".to_string(),
            worktree: wt_active.to_string_lossy().to_string(),
        },
        WorktreeSessionInput {
            id: "s-dirty".to_string(),
            status: "done".to_string(),
            repo: repo.to_string_lossy().to_string(),
            branch: "fleet/s-dirty".to_string(),
            worktree: wt_dirty.to_string_lossy().to_string(),
        },
        WorktreeSessionInput {
            id: "s-merged".to_string(),
            status: "merged".to_string(),
            repo: repo.to_string_lossy().to_string(),
            branch: "fleet/s-merged".to_string(),
            worktree: wt_merged.to_string_lossy().to_string(),
        },
    ];

    let listed = list_repo_worktrees(&repo, &sessions).unwrap();
    assert_eq!(listed.len(), 6);

    let main_entry = listed.iter().find(|e| e.is_main).unwrap();
    assert!(!main_entry.is_orphan);
    assert!(!main_entry.removable);

    let active_e = listed
        .iter()
        .find(|e| e.branch.as_deref() == Some("fleet/s-active"))
        .unwrap();
    assert_eq!(active_e.session_id.as_deref(), Some("s-active"));
    assert_eq!(active_e.session_status.as_deref(), Some("working"));
    assert!(!active_e.is_orphan);
    assert!(!active_e.removable);
    assert!(!active_e.dirty);

    let dirty_e = listed
        .iter()
        .find(|e| e.branch.as_deref() == Some("fleet/s-dirty"))
        .unwrap();
    assert!(dirty_e.dirty);
    assert!(!dirty_e.is_orphan);
    assert!(dirty_e.removable);

    let orphan_e = listed
        .iter()
        .find(|e| e.branch.as_deref() == Some("fleet/s-orphan"))
        .unwrap();
    assert!(orphan_e.session_id.is_none());
    assert!(orphan_e.is_orphan);
    assert!(orphan_e.removable);

    let merged_e = listed
        .iter()
        .find(|e| e.branch.as_deref() == Some("fleet/s-merged"))
        .unwrap();
    assert_eq!(merged_e.session_status.as_deref(), Some("merged"));
    assert!(merged_e.is_orphan);
    assert!(merged_e.removable);

    let locked_e = listed
        .iter()
        .find(|e| e.branch.as_deref() == Some("fleet/s-locked"))
        .unwrap();
    assert!(locked_e.is_locked);
    assert_eq!(locked_e.lock_reason.as_deref(), Some("operator hold"));
    assert!(!locked_e.removable);

    // --- Adversarial Path-Escape & Safety Attacks ---
    // 1. Main repo worktree MUST be refused.
    let err_main = remove_worktree(&repo, &repo).unwrap_err();
    assert_eq!(err_main.status, 403);
    assert_eq!(err_main.code, "main-worktree-protected");
    assert!(repo.join("README.md").exists());

    // 2. Traversal `..` MUST be refused.
    let traversal = wt_root.join("../../repo");
    let err_trav = remove_worktree_checked(&repo, &traversal, Some(&wt_root), &sessions).unwrap_err();
    assert_eq!(err_trav.status, 403);
    assert_eq!(err_trav.code, "path-traversal-refused");

    // 3. Relative path MUST be refused.
    let err_rel = remove_worktree(&repo, Path::new("s-orphan")).unwrap_err();
    assert_eq!(err_rel.status, 400);
    assert_eq!(err_rel.code, "relative-path-refused");

    // 4. Arbitrary unregistered directory outside worktrees MUST be refused.
    let victim = tmp.path().join("innocent-dir");
    std::fs::create_dir_all(&victim).unwrap();
    std::fs::write(victim.join("keep.txt"), "safe").unwrap();
    let err_unreg = remove_worktree(&repo, &victim).unwrap_err();
    assert_eq!(err_unreg.status, 403);
    assert_eq!(err_unreg.code, "unregistered-worktree");
    assert!(victim.join("keep.txt").exists());

    // 5. Symlink inside wt_root pointing to main repo or external dir MUST be refused!
    #[cfg(unix)]
    {
        let sym_main = wt_root.join("sym-to-main");
        std::os::unix::fs::symlink(&repo, &sym_main).unwrap();
        let err_sym =
            remove_worktree_checked(&repo, &sym_main, Some(&wt_root), &sessions).unwrap_err();
        assert_eq!(err_sym.status, 403);
        assert_eq!(err_sym.code, "main-worktree-protected");
        assert!(repo.join("README.md").exists());

        let sym_ext = wt_root.join("sym-to-victim");
        std::os::unix::fs::symlink(&victim, &sym_ext).unwrap();
        let err_ext =
            remove_worktree_checked(&repo, &sym_ext, Some(&wt_root), &sessions).unwrap_err();
        assert_eq!(err_ext.status, 403);
        assert_eq!(err_ext.code, "outside-worktree-root");
        assert!(victim.join("keep.txt").exists());
    }

    // 6. Active running session worktree MUST be refused (409).
    let err_active =
        remove_worktree_checked(&repo, &wt_active, Some(&wt_root), &sessions).unwrap_err();
    assert_eq!(err_active.status, 409);
    assert_eq!(err_active.code, "session-active");
    assert!(wt_active.exists());

    // 7. Locked worktree MUST be refused (409).
    let err_locked =
        remove_worktree_checked(&repo, &wt_locked, Some(&wt_root), &sessions).unwrap_err();
    assert_eq!(err_locked.status, 409);
    assert_eq!(err_locked.code, "worktree-locked");
    assert!(wt_locked.exists());

    // --- Legitimate Targeted Removals ---
    let res_orphan =
        remove_worktree_checked(&repo, &wt_orphan, Some(&wt_root), &sessions).unwrap();
    assert!(res_orphan.removed && res_orphan.pruned);
    assert_eq!(res_orphan.branch.as_deref(), Some("fleet/s-orphan"));
    assert!(!wt_orphan.exists());

    let res_merged = remove_worktree(&repo, &wt_merged).unwrap();
    assert!(res_merged.removed);
    assert!(!wt_merged.exists());

    let after = list_repo_worktrees(&repo, &sessions).unwrap();
    assert_eq!(after.len(), 4);
    assert!(repo.join("README.md").exists());
    assert!(wt_active.exists());
}

#[test]
fn budget_guardrails_enforce_429_atomic_batch_rollover_and_fuzz_resilience() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<PrPreview>();
    assert_send_sync::<PrCreateRequest>();
    assert_send_sync::<PrCreateResult>();
    assert_send_sync::<WorktreeEntry>();
    assert_send_sync::<BudgetConfig>();
    assert_send_sync::<BudgetStatus>();
    assert_send_sync::<BudgetTracker>();

    let tmp = TempDirGuard::new("budget");
    let day1: u64 = 1_795_305_600; // 2026-11-22T00:00:00Z
    let day2: u64 = day1 + 86_400; // 2026-11-23T00:00:00Z
    assert_eq!(utc_day_string(day1), "2026-11-22");
    assert_eq!(utc_day_string(day2), "2026-11-23");

    let cfg = BudgetConfig {
        max_session_mins: 20,
        daily_session_limit: 5,
        max_heal_attempts: 2,
    };
    cfg.validate().unwrap();
    assert_eq!(cfg.effective_timeout_secs(1800), 1200);
    assert_eq!(cfg.effective_timeout_secs(600), 600);
    assert_eq!(cfg.effective_heal_budget(4), 2);

    let mut tracker = BudgetTracker::load_at(tmp.path(), day1);
    let s1 = tracker.try_reserve_sessions_at(&cfg, 2, day1 + 10).unwrap();
    assert_eq!(s1.sessions_today, 2);
    assert_eq!(s1.remaining_today, Some(3));
    assert_eq!(s1.usage_pct, 40);
    assert!(!s1.daily_limit_reached);

    // Batch of 4 exceeds remaining 3 -> HTTP 429 atomically, counters unchanged!
    let batch_err = tracker
        .try_reserve_sessions_at(&cfg, 4, day1 + 20)
        .unwrap_err();
    assert_eq!(batch_err.status, 429);
    assert_eq!(batch_err.code, "daily-budget-exceeded");
    assert!(batch_err.message.contains("3 remaining"));
    assert_eq!(tracker.status_at(&cfg, day1 + 20).sessions_today, 2);

    // Reserve exact remaining 3 -> hits 5/5 cleanly.
    let s2 = tracker.try_reserve_sessions_at(&cfg, 3, day1 + 30).unwrap();
    assert_eq!(s2.sessions_today, 5);
    assert_eq!(s2.remaining_today, Some(0));
    assert_eq!(s2.usage_pct, 100);
    assert!(s2.daily_limit_reached);

    // Next single dispatch refused with 429.
    let single_err = tracker
        .try_reserve_sessions_at(&cfg, 1, day1 + 40)
        .unwrap_err();
    assert_eq!(single_err.status, 429);
    assert!(single_err.message.contains("5/5"));

    // Record heal attempt and verify persistence across restart on same day.
    tracker.record_heal_attempt_at(day1 + 50);
    let reloaded = BudgetTracker::load_at(tmp.path(), day1 + 100);
    let snap = reloaded.status_at(&cfg, day1 + 100);
    assert_eq!(snap.sessions_today, 5);
    assert_eq!(snap.total_heal_attempts_today, 1);

    // Next UTC day automatically rolls counters over to 0 and allows dispatch!
    let mut tracker_day2 = reloaded;
    let rolled = tracker_day2.status_at(&cfg, day2 + 5);
    assert_eq!(rolled.day_utc, "2026-11-23");
    assert_eq!(rolled.sessions_today, 0);
    assert_eq!(rolled.remaining_today, Some(5));
    assert!(!rolled.daily_limit_reached);
    let after_roll = tracker_day2
        .try_reserve_sessions_at(&cfg, 1, day2 + 10)
        .unwrap();
    assert_eq!(after_roll.sessions_today, 1);

    // Unlimited daily limit (`daily_session_limit == 0`) always allows dispatch.
    let unlimited = BudgetConfig {
        max_session_mins: 0,
        daily_session_limit: 0,
        max_heal_attempts: 3,
    };
    let ok_unlim = check_dispatch_allowance(&unlimited, 999_999, 500, 0, day1).unwrap();
    assert_eq!(ok_unlim.remaining_today, None);
    assert!(!ok_unlim.daily_limit_reached);
    assert_eq!(unlimited.effective_timeout_secs(1800), 1800);

    // Boundary & fuzz inputs: zero panics, zero integer overflows.
    let extreme_cfg = BudgetConfig {
        max_session_mins: u32::MAX,
        daily_session_limit: u32::MAX,
        max_heal_attempts: u32::MAX,
    };
    assert!(extreme_cfg.validate().is_err());
    let clamped = extreme_cfg.sanitized();
    assert_eq!(clamped.max_session_mins, MAX_ALLOWED_SESSION_MINS);
    assert_eq!(clamped.daily_session_limit, MAX_ALLOWED_DAILY_SESSIONS);
    assert_eq!(clamped.max_heal_attempts, MAX_ALLOWED_HEAL_ATTEMPTS);
    let _ = evaluate_budget(&extreme_cfg, u32::MAX, u32::MAX, u64::MAX - 10);
    let _ = check_dispatch_allowance(&cfg, u32::MAX, u32::MAX, u32::MAX, u64::MAX - 10);
}
