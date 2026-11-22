//! Comprehensive integration, scale, security, and real-git tests for the `v0.5.0`
//! Fleet orchestration engines (`dag`, `checks`, `merge_check`, `policy`).

use fleet::checks::{
    changed_files_between, glob_matches, verify_git_scope, verify_worktree_scope, CheckPipeline,
    CheckStep, FileScope, StepStatus,
};
use fleet::dag::{BatchSpec, BatchTaskSpec, DagError, DagGraph, DagNodeState, DagReadiness, TaskNode};
use fleet::merge_check::{
    dry_run_merge, execute_merge, export_patch, MergeStrategy, PatchFormat,
};
use fleet::policy::{test_policy, test_policy_script, Policy, DEFAULT_FREE_MODEL};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const SHIPPED_POLICY: &str = include_str!("../policies.rn");

struct TempDirGuard(PathBuf);

impl TempDirGuard {
    fn new(tag: &str) -> Self {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "fleet-v050-eng-{tag}-{}-{n}",
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
        .args(["-c", "user.email=fleet-test@localhost", "-c", "user.name=Fleet Test"])
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

fn seed_git_repo(dir: &Path) -> PathBuf {
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git_ok(&repo, &["init", "-b", "main"]);
    git_ok(&repo, &["config", "user.email", "fleet-test@localhost"]);
    git_ok(&repo, &["config", "user.name", "Fleet Test"]);
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(repo.join("README.md"), "# Demo\nline 1\n").unwrap();
    std::fs::write(repo.join("src/lib.rs"), "pub fn base() -> i32 { 1 }\n").unwrap();
    git_ok(&repo, &["add", "-A"]);
    git_ok(&repo, &["commit", "-m", "initial commit"]);
    repo
}

// ---------------------------------------------------------------------------
// 1. DAG Scale Benchmark (2,000 nodes), Cycle Rejection & Batch Dispatch
// ---------------------------------------------------------------------------

#[test]
fn dag_2000_node_topological_scheduling_benchmark() {
    // 2,000 nodes arranged in 50 layers of 40 nodes with multi-parent fan-in + skip edges (~5,800 edges).
    const TOTAL: usize = 2_000;
    const LAYER_WIDTH: usize = 40;
    let mut nodes = Vec::with_capacity(TOTAL);
    for i in 0..TOTAL {
        let layer = i / LAYER_WIDTH;
        let col = i % LAYER_WIDTH;
        let mut deps = Vec::new();
        if layer > 0 {
            let prev_base = (layer - 1) * LAYER_WIDTH;
            deps.push(format!("n-{:04}", prev_base + col));
            deps.push(format!("n-{:04}", prev_base + ((col + 1) % LAYER_WIDTH)));
            if layer >= 2 && col % 2 == 0 {
                let skip_base = (layer - 2) * LAYER_WIDTH;
                deps.push(format!("n-{:04}", skip_base + ((col + 7) % LAYER_WIDTH)));
            }
        }
        nodes.push(TaskNode::new(
            format!("n-{i:04}"),
            deps,
            if layer == 0 {
                DagNodeState::Queued
            } else {
                DagNodeState::Blocked
            },
        ));
    }

    let t0 = Instant::now();
    let dag = DagGraph::from_nodes(nodes.clone()).expect("2,000-node DAG must be acyclic");
    let topo = dag.topological_order();
    let plan0 = dag.evaluate(16);
    let depths = dag.wave_depths();
    let build_and_eval_ms = t0.elapsed().as_millis();
    eprintln!(
        "[bench] 2000-node DAG (build + topo + wave_depths + evaluate): {build_and_eval_ms}ms"
    );

    assert_eq!(topo.len(), TOTAL);
    // Verify strict topological invariant: every dependency precedes its dependent.
    let pos: HashMap<&str, usize> = topo
        .iter()
        .enumerate()
        .map(|(idx, id)| (id.as_str(), idx))
        .collect();
    for node in &nodes {
        let p = pos[node.id.as_str()];
        for dep in &node.depends_on {
            assert!(
                pos[dep.as_str()] < p,
                "topological order violated: {} ({}) should precede {} ({})",
                dep,
                pos[dep.as_str()],
                node.id,
                p
            );
        }
    }

    // Layer 0 has 40 ready nodes, concurrency cap 16 => 16 to start, 24 waiting for slot, 1,960 blocked.
    assert_eq!(plan0.to_start.len(), 16);
    assert_eq!(plan0.ready_waiting_for_slot.len(), 24);
    assert_eq!(plan0.blocked.len(), TOTAL - LAYER_WIDTH);
    assert!(plan0.upstream_failed.is_empty());
    assert_eq!(depths["n-0000"], 0);
    assert_eq!(depths["n-1999"], (TOTAL / LAYER_WIDTH) - 1);

    // Full build + topo sort + wave depths + scheduling must be super fast even in debug mode.
    assert!(
        build_and_eval_ms < 2000,
        "2,000-node DAG build+eval took {build_and_eval_ms}ms (expected < 2000ms)"
    );

    // Simulate full execution in parallel waves of 64 until all 2,000 nodes reach Done.
    let sim_start = Instant::now();
    let mut state_by_id: HashMap<String, DagNodeState> = nodes
        .iter()
        .map(|n| (n.id.clone(), n.state))
        .collect();
    let mut completed = 0usize;
    let mut ticks = 0usize;
    while completed < TOTAL {
        ticks += 1;
        assert!(ticks <= 200, "scheduler stalled at {completed}/{TOTAL}");
        let cur_nodes: Vec<TaskNode> = nodes
            .iter()
            .map(|n| TaskNode::new(n.id.clone(), n.depends_on.clone(), state_by_id[&n.id]))
            .collect();
        let g = DagGraph::from_nodes(cur_nodes).unwrap();
        let plan = g.evaluate(64);
        assert!(
            !plan.to_start.is_empty(),
            "deadlock at tick {ticks}: completed={completed}"
        );
        for id in plan.to_start {
            state_by_id.insert(id, DagNodeState::Done);
            completed += 1;
        }
    }
    let sim_ms = sim_start.elapsed().as_millis();
    assert_eq!(completed, TOTAL);
    assert!(
        sim_ms < 10_000,
        "2,000-node full wave simulation took {sim_ms}ms"
    );
}

#[test]
fn dag_2000_node_deep_chain_and_cycle_rejection_no_stack_overflow() {
    // 2,000-node linear chain: depth 2,000 tests iterative DFS/Kahn with zero recursion.
    const N: usize = 2_000;
    let mut nodes: Vec<TaskNode> = (0..N)
        .map(|i| {
            let deps = if i == 0 {
                vec![]
            } else {
                vec![format!("c-{:04}", i - 1)]
            };
            TaskNode::new(format!("c-{i:04}"), deps, DagNodeState::Blocked)
        })
        .collect();

    let acyclic = DagGraph::from_nodes(nodes.clone()).unwrap();
    assert_eq!(acyclic.wave_depths()["c-1999"], N - 1);
    assert_eq!(acyclic.downstream_of("c-0000").len(), N - 1);
    // Incremental edge validation catches closing the 2,000-node loop!
    let edge_err = acyclic.validate_edge_addition("c-0000", "c-1999");
    assert!(
        matches!(edge_err, Err(DagError::CycleDetected { ref cycle }) if cycle.len() == N + 1),
        "expected full-chain cycle rejection, got {edge_err:?}"
    );

    // Direct cyclic DAG construction rejects cleanly with closed cycle.
    nodes[0].depends_on.push(format!("c-{:04}", N - 1));
    match DagGraph::from_nodes(nodes) {
        Err(DagError::CycleDetected { cycle }) => {
            assert_eq!(cycle.first(), cycle.last());
            assert_eq!(cycle.len(), N + 1);
        }
        other => panic!("expected CycleDetected on 2000-node loop, got {other:?}"),
    }
}

#[test]
fn dag_merged_upstream_satisfies_downstream_and_dismissed_upstream_blocks() {
    let dag = DagGraph::from_nodes(vec![
        TaskNode::new("upstream-merged", vec![], DagNodeState::Merged),
        TaskNode::new("upstream-dismissed", vec![], DagNodeState::Archived),
        TaskNode::new(
            "child-of-merged",
            vec!["upstream-merged".to_string()],
            DagNodeState::Blocked,
        ),
        TaskNode::new(
            "child-of-dismissed",
            vec!["upstream-dismissed".to_string()],
            DagNodeState::Blocked,
        ),
        TaskNode::new(
            "grandchild-of-dismissed",
            vec!["child-of-dismissed".to_string()],
            DagNodeState::Queued,
        ),
    ])
    .unwrap();

    assert_eq!(dag.readiness_of("child-of-merged"), Some(DagReadiness::Ready));
    match dag.readiness_of("child-of-dismissed") {
        Some(DagReadiness::UpstreamFailed { failed_deps, reason }) => {
            assert_eq!(failed_deps, vec!["upstream-dismissed"]);
            assert!(reason.contains("Needs you: upstream failed"), "{reason}");
            assert!(reason.contains("archived"), "{reason}");
        }
        other => panic!("expected UpstreamFailed, got {other:?}"),
    }
    let plan = dag.evaluate(4);
    assert_eq!(plan.to_start, vec!["child-of-merged"]);
    let failed_ids: HashSet<&str> = plan.upstream_failed.iter().map(|u| u.id.as_str()).collect();
    assert!(failed_ids.contains("child-of-dismissed"));
    assert!(failed_ids.contains("grandchild-of-dismissed"));
}

#[test]
fn batch_spec_rejects_cyclic_and_unknown_deps_atomically_and_supports_fan_in() {
    // Cyclic batch rejected atomically.
    let cyclic = BatchSpec {
        name: Some("bad-cycle".to_string()),
        repo: None,
        repos: vec!["/repos/a".to_string()],
        tasks: vec![
            BatchTaskSpec {
                key: Some("step1".to_string()),
                task: "First".to_string(),
                repo: None,
                project: None,
                agent: None,
                model: None,
                check_cmd: None,
                check_steps: vec![],
                depends_on: vec!["step2".to_string()],
                allowed_globs: vec![],
                forbidden_globs: vec![],
            },
            BatchTaskSpec {
                key: Some("step2".to_string()),
                task: "Second".to_string(),
                repo: None,
                project: None,
                agent: None,
                model: None,
                check_cmd: None,
                check_steps: vec![],
                depends_on: vec!["step1".to_string()],
                allowed_globs: vec![],
                forbidden_globs: vec![],
            },
        ],
        max_parallel: Some(4),
        default_check: None,
        default_agent: None,
        allowed_globs: vec![],
        forbidden_globs: vec![],
    };
    let mut seq = 0u64;
    let err = cyclic.expand(&HashMap::new(), 4, || {
        seq += 1;
        format!("b-{seq}")
    });
    assert!(matches!(err, Err(DagError::CycleDetected { .. })), "{err:?}");

    // Multi-repo matrix fan-out + cross-repo join task waiting on all matrix build tasks.
    let fan_in = BatchSpec {
        name: Some("release-train".to_string()),
        repo: None,
        repos: vec!["/repos/core".to_string(), "/repos/cli".to_string()],
        tasks: vec![
            BatchTaskSpec {
                key: Some("build".to_string()),
                task: "Build crate".to_string(),
                repo: None,
                project: None,
                agent: None,
                model: None,
                check_cmd: Some("cargo test".to_string()),
                check_steps: vec![],
                depends_on: vec!["pre-existing-done".to_string()],
                allowed_globs: vec![],
                forbidden_globs: vec![],
            },
            BatchTaskSpec {
                key: Some("release-notes".to_string()),
                task: "Summarize release".to_string(),
                repo: Some("/repos/docs".to_string()),
                project: Some("docs".to_string()),
                agent: None,
                model: None,
                check_cmd: Some("true".to_string()),
                check_steps: vec![],
                depends_on: vec!["build".to_string()],
                allowed_globs: vec!["**/*.md".to_string()],
                forbidden_globs: vec![],
            },
        ],
        max_parallel: Some(10), // clamped down to policy cap 3
        default_check: None,
        default_agent: Some("opencode".to_string()),
        allowed_globs: vec![],
        forbidden_globs: vec![".env".to_string()],
    };
    let mut existing = HashMap::new();
    existing.insert("pre-existing-done".to_string(), DagNodeState::Done);
    let mut seq2 = 0u64;
    let expanded = fan_in
        .expand(&existing, 3, || {
            seq2 += 1;
            format!("rel-{seq2}")
        })
        .unwrap();
    assert_eq!(expanded.effective_max_parallel, 3);
    assert_eq!(expanded.sessions.len(), 3);
    // Both matrix build tasks are immediately ready because pre-existing-done is Done!
    assert_eq!(expanded.immediate_ready, vec!["rel-1", "rel-2"]);
    // Cross-repo docs summary waits for BOTH matrix build tasks!
    let join_task = expanded.sessions.iter().find(|s| s.id == "rel-3").unwrap();
    assert_eq!(join_task.repo, "/repos/docs");
    assert_eq!(join_task.depends_on, vec!["rel-1", "rel-2"]);
    assert_eq!(join_task.initial_state, DagNodeState::Blocked);
}

// ---------------------------------------------------------------------------
// 2. Real Temp-Git-Repo Merge-Tree Dry-Run, Patch Export & Merge Strategies
// ---------------------------------------------------------------------------

#[test]
fn real_git_merge_tree_detects_clean_and_conflicting_merges_nondestructively() {
    let tmp = TempDirGuard::new("merge-tree");
    let repo = seed_git_repo(tmp.path());

    // Branch 1: clean diverged branch (2 commits ahead, 1 behind after main advances).
    git_ok(&repo, &["checkout", "-b", "fleet/clean"]);
    std::fs::write(repo.join("src/new_mod.rs"), "pub fn extra() -> i32 { 42 }\n").unwrap();
    git_ok(&repo, &["add", "-A"]);
    git_ok(&repo, &["commit", "-m", "add new_mod"]);
    std::fs::write(repo.join("src/extra2.rs"), "pub const K: usize = 7;\n").unwrap();
    git_ok(&repo, &["add", "-A"]);
    git_ok(&repo, &["commit", "-m", "add extra2"]);
    let clean_tip = git_ok(&repo, &["rev-parse", "HEAD"]);

    // Branch 2: conflicting branch touching README.md AND a filename with spaces.
    git_ok(&repo, &["checkout", "main"]);
    git_ok(&repo, &["checkout", "-b", "fleet/conflict"]);
    std::fs::write(repo.join("README.md"), "# Branch version\nline 1\n").unwrap();
    std::fs::write(repo.join("src/my module.rs"), "pub fn branch_ver() {}\n").unwrap();
    git_ok(&repo, &["add", "-A"]);
    git_ok(&repo, &["commit", "-m", "branch conflicting edits"]);
    let conflict_tip = git_ok(&repo, &["rev-parse", "HEAD"]);

    // Advance main on both conflicting paths.
    git_ok(&repo, &["checkout", "main"]);
    std::fs::write(repo.join("README.md"), "# Main version\nline 1\n").unwrap();
    std::fs::write(repo.join("src/my module.rs"), "pub fn main_ver() {}\n").unwrap();
    git_ok(&repo, &["add", "-A"]);
    git_ok(&repo, &["commit", "-m", "main conflicting edits"]);
    let main_before = git_ok(&repo, &["rev-parse", "HEAD"]);

    // Dry-run clean merge.
    let clean = dry_run_merge(&repo, "main", &clean_tip).unwrap();
    assert!(clean.clean, "{clean:?}");
    assert!(clean.conflicting_files.is_empty());
    assert_eq!(clean.commits_ahead, 2);
    assert_eq!(clean.commits_behind, 1);
    assert!(!clean.can_fast_forward);
    assert!(clean.merged_tree.is_some());
    assert!(clean.can_apply_strategy(MergeStrategy::MergeCommit).is_ok());
    assert!(clean.can_apply_strategy(MergeStrategy::Squash).is_ok());
    assert!(clean.can_apply_strategy(MergeStrategy::FastForwardOnly).is_err());

    // Dry-run conflicting merge.
    let conflict = dry_run_merge(&repo, "main", &conflict_tip).unwrap();
    assert!(!conflict.clean, "{conflict:?}");
    assert_eq!(conflict.commits_ahead, 1);
    assert_eq!(conflict.commits_behind, 1);
    assert!(!conflict.can_fast_forward);
    assert_eq!(
        conflict.conflicting_files,
        vec!["README.md".to_string(), "src/my module.rs".to_string()]
    );
    assert!(conflict.can_apply_strategy(MergeStrategy::MergeCommit).is_err());

    // Verify 100% non-destructive: HEAD, working tree, and MERGE_HEAD completely untouched!
    assert_eq!(git_ok(&repo, &["rev-parse", "HEAD"]), main_before);
    assert_eq!(git_ok(&repo, &["status", "--porcelain"]), "");
    assert!(!repo.join(".git/MERGE_HEAD").exists());
}

#[test]
fn real_git_patch_export_applies_cleanly_via_git_am_and_git_apply() {
    let tmp = TempDirGuard::new("patch-export");
    let repo = seed_git_repo(tmp.path());

    git_ok(&repo, &["checkout", "-b", "fleet/s42"]);
    std::fs::write(repo.join("src/feature.rs"), "pub fn feat() -> &'static str { \"ok\" }\n")
        .unwrap();
    git_ok(&repo, &["add", "-A"]);
    git_ok(&repo, &["commit", "-m", "feat: add feature module"]);
    std::fs::write(repo.join("README.md"), "# Demo\nline 1\nfeature docs\n").unwrap();
    git_ok(&repo, &["add", "-A"]);
    git_ok(&repo, &["commit", "-m", "docs: mention feature"]);
    let tip = git_ok(&repo, &["rev-parse", "HEAD"]);
    git_ok(&repo, &["checkout", "main"]);

    let mbox = export_patch(&repo, "main", &tip, "s42", PatchFormat::FormatPatch).unwrap();
    assert_eq!(mbox.filename, "s42.patch");
    assert_eq!(mbox.commits, 2);
    assert_eq!(mbox.files_changed, 2);
    assert_eq!(mbox.insertions, 2);
    assert_eq!(mbox.deletions, 0);
    assert!(mbox.content.contains("feat: add feature module"));
    assert!(mbox.content.contains("docs: mention feature"));

    let unified = export_patch(&repo, "main", &tip, "s42", PatchFormat::UnifiedDiff).unwrap();
    assert!(unified.content.contains("diff --git a/src/feature.rs b/src/feature.rs"));
    assert!(unified.content.contains("+pub fn feat()"));

    // Clone into two fresh repos and actually apply both exported patches!
    let clone_am = tmp.path().join("clone-am");
    git_ok(tmp.path(), &["clone", repo.to_str().unwrap(), clone_am.to_str().unwrap()]);
    let patch_file = tmp.path().join("s42.mbox.patch");
    std::fs::write(&patch_file, &mbox.content).unwrap();
    git_ok(&clone_am, &["am", patch_file.to_str().unwrap()]);
    assert!(clone_am.join("src/feature.rs").exists());

    let clone_apply = tmp.path().join("clone-apply");
    git_ok(
        tmp.path(),
        &["clone", repo.to_str().unwrap(), clone_apply.to_str().unwrap()],
    );
    let diff_file = tmp.path().join("s42.diff.patch");
    std::fs::write(&diff_file, &unified.content).unwrap();
    git_ok(&clone_apply, &["apply", diff_file.to_str().unwrap()]);
    assert!(clone_apply.join("src/feature.rs").exists());
}

#[test]
fn real_git_execute_merge_supports_all_three_strategies_and_aborts_cleanly_on_conflict() {
    // 1. FastForwardOnly succeeds when target did not diverge.
    {
        let tmp = TempDirGuard::new("merge-ff");
        let repo = seed_git_repo(tmp.path());
        git_ok(&repo, &["checkout", "-b", "fleet/ff"]);
        std::fs::write(repo.join("src/ff.rs"), "pub const FF: bool = true;\n").unwrap();
        git_ok(&repo, &["add", "-A"]);
        git_ok(&repo, &["commit", "-m", "ff commit"]);
        let pin = git_ok(&repo, &["rev-parse", "HEAD"]);
        git_ok(&repo, &["checkout", "main"]);

        let dry = dry_run_merge(&repo, "main", &pin).unwrap();
        assert!(dry.clean && dry.can_fast_forward && dry.commits_ahead == 1 && dry.commits_behind == 0);

        let outcome = execute_merge(&repo, &pin, "ff-1", MergeStrategy::FastForwardOnly).unwrap();
        assert_eq!(outcome.landed_commit, pin);
        assert_eq!(outcome.target_branch, "main");
        assert!(repo.join("src/ff.rs").exists());
    }

    // 2. Squash collapses 2 commits into 1 single-parent commit on main.
    {
        let tmp = TempDirGuard::new("merge-squash");
        let repo = seed_git_repo(tmp.path());
        git_ok(&repo, &["checkout", "-b", "fleet/sq"]);
        std::fs::write(repo.join("src/one.rs"), "pub const ONE: i32 = 1;\n").unwrap();
        git_ok(&repo, &["add", "-A"]);
        git_ok(&repo, &["commit", "-m", "one"]);
        std::fs::write(repo.join("src/two.rs"), "pub const TWO: i32 = 2;\n").unwrap();
        git_ok(&repo, &["add", "-A"]);
        git_ok(&repo, &["commit", "-m", "two"]);
        let pin = git_ok(&repo, &["rev-parse", "HEAD"]);
        git_ok(&repo, &["checkout", "main"]);
        std::fs::write(repo.join("main-only.txt"), "hello\n").unwrap();
        git_ok(&repo, &["add", "-A"]);
        git_ok(&repo, &["commit", "-m", "advance main"]);

        // FastForwardOnly must refuse cleanly because main advanced.
        let ff_err = execute_merge(&repo, &pin, "sq-1", MergeStrategy::FastForwardOnly).unwrap_err();
        assert_eq!(ff_err.status, 409);
        assert!(ff_err.message.contains("Fast-forward"), "{}", ff_err.message);

        // Squash lands both files in 1 single-parent commit!
        let outcome = execute_merge(&repo, &pin, "sq-1", MergeStrategy::Squash).unwrap();
        assert_eq!(outcome.strategy, MergeStrategy::Squash);
        assert!(repo.join("src/one.rs").exists());
        assert!(repo.join("src/two.rs").exists());
        let parents = git_ok(&repo, &["rev-list", "--parents", "-n", "1", "HEAD"]);
        assert_eq!(parents.split_whitespace().count(), 2, "squash must have 1 parent: {parents}");
    }

    // 3. MergeCommit creates 2-parent merge commit AND aborts cleanly on conflict.
    {
        let tmp = TempDirGuard::new("merge-commit");
        let repo = seed_git_repo(tmp.path());
        git_ok(&repo, &["checkout", "-b", "fleet/mc"]);
        std::fs::write(repo.join("src/mc.rs"), "pub const MC: i32 = 3;\n").unwrap();
        git_ok(&repo, &["add", "-A"]);
        git_ok(&repo, &["commit", "-m", "mc"]);
        let pin = git_ok(&repo, &["rev-parse", "HEAD"]);
        git_ok(&repo, &["checkout", "main"]);

        let outcome = execute_merge(&repo, &pin, "mc-1", MergeStrategy::MergeCommit).unwrap();
        assert_eq!(outcome.strategy, MergeStrategy::MergeCommit);
        let parents = git_ok(&repo, &["rev-list", "--parents", "-n", "1", "HEAD"]);
        assert_eq!(parents.split_whitespace().count(), 3, "no-ff merge must have 2 parents: {parents}");

        // Conflicting merge must abort cleanly leaving zero MERGE_HEAD.
        git_ok(&repo, &["checkout", "-b", "fleet/bad"]);
        std::fs::write(repo.join("README.md"), "branch\n").unwrap();
        git_ok(&repo, &["commit", "-am", "bad"]);
        let bad_pin = git_ok(&repo, &["rev-parse", "HEAD"]);
        git_ok(&repo, &["checkout", "main"]);
        std::fs::write(repo.join("README.md"), "main\n").unwrap();
        git_ok(&repo, &["commit", "-am", "main"]);

        let err = execute_merge(&repo, &bad_pin, "bad-1", MergeStrategy::MergeCommit).unwrap_err();
        assert_eq!(err.status, 409);
        assert!(err.message.contains("README.md"), "{}", err.message);
        assert!(!repo.join(".git/MERGE_HEAD").exists());
        assert_eq!(git_ok(&repo, &["status", "--porcelain"]), "");
    }
}

// ---------------------------------------------------------------------------
// 3. File-Scope Guardrails Against Real Git Repos (including hostile config!)
// ---------------------------------------------------------------------------

#[test]
fn file_scope_guardrail_blocks_out_of_scope_and_forbidden_files_in_real_git_repo() {
    let tmp = TempDirGuard::new("file-scope");
    let repo = seed_git_repo(tmp.path());

    // Plant a hostile external diff driver in .git/config to prove --no-ext-diff resists tampering!
    git_ok(&repo, &["config", "diff.external", "/bin/true"]);

    // Allowed branch: touches only src/**.
    git_ok(&repo, &["checkout", "-b", "fleet/good-scope"]);
    std::fs::write(repo.join("src/engine.rs"), "pub fn ok() {}\n").unwrap();
    git_ok(&repo, &["add", "-A"]);
    git_ok(&repo, &["commit", "-m", "in-scope edit"]);
    let good_tip = git_ok(&repo, &["rev-parse", "HEAD"]);

    // Violating branch: touches allowed src/** PLUS disallowed web/ AND forbidden .env!
    git_ok(&repo, &["checkout", "main"]);
    git_ok(&repo, &["checkout", "-b", "fleet/bad-scope"]);
    std::fs::create_dir_all(repo.join("web/src")).unwrap();
    std::fs::write(repo.join("src/engine.rs"), "pub fn ok() {}\n").unwrap();
    std::fs::write(repo.join("web/src/App.tsx"), "export default null;\n").unwrap();
    std::fs::write(repo.join("src/.env"), "SECRET=123\n").unwrap();
    git_ok(&repo, &["add", "-A"]);
    git_ok(&repo, &["commit", "-m", "out-of-scope edits"]);
    let bad_tip = git_ok(&repo, &["rev-parse", "HEAD"]);
    git_ok(&repo, &["checkout", "main"]);

    let scope = FileScope::new(
        vec!["src/**/*.rs".to_string()],
        vec!["**/.env".to_string(), ".env.*".to_string()],
    );

    let good_report = verify_git_scope(&repo, "main", &good_tip, &scope).unwrap();
    assert!(good_report.passed, "{good_report:?}");
    assert_eq!(good_report.changed_files, vec!["src/engine.rs"]);
    assert!(good_report.needs_you_reason.is_none());

    let bad_files = changed_files_between(&repo, "main", &bad_tip).unwrap();
    assert!(bad_files.contains(&"web/src/App.tsx".to_string()));
    assert!(bad_files.contains(&"src/.env".to_string()));

    let bad_report = verify_git_scope(&repo, "main", &bad_tip, &scope).unwrap();
    assert!(!bad_report.passed);
    assert_eq!(bad_report.violations.len(), 2, "{bad_report:?}");
    let reason = bad_report.needs_you_reason.unwrap();
    assert!(reason.contains("File-scope guardrail blocked"), "{reason}");
    assert!(reason.contains("web/src/App.tsx"), "{reason}");
    assert!(reason.contains("src/.env"), "{reason}");

    // Also test worktree scope verification catching uncommitted untracked violation.
    let wt = tmp.path().join("wt-scope");
    git_ok(
        &repo,
        &["worktree", "add", "-b", "fleet/wt-check", wt.to_str().unwrap(), "main"],
    );
    std::fs::write(wt.join("src/ok.rs"), "pub fn a() {}\n").unwrap();
    std::fs::write(wt.join("forbidden.pem"), "PRIVATE KEY\n").unwrap();
    let wt_scope = FileScope::new(vec!["src/**".to_string()], vec!["**/*.pem".to_string()]);
    let wt_report = verify_worktree_scope(&wt, "main", &wt_scope).unwrap();
    assert!(!wt_report.passed);
    assert_eq!(wt_report.violations.len(), 1);
    assert_eq!(wt_report.violations[0].path, "forbidden.pem");
    assert!(glob_matches("**/*.pem", "forbidden.pem"));

    // Absolute path injection is blocked even with unrestricted globs.
    let abs_report = FileScope::unrestricted().check_paths(&["/etc/passwd".to_string()]);
    assert!(!abs_report.passed);
    assert!(abs_report.needs_you_reason.unwrap().contains("/etc/passwd"));
}

// ---------------------------------------------------------------------------
// 4. Multi-Step Check Pipeline Receipts, Backwards Compat, Timeout & Stop
// ---------------------------------------------------------------------------

#[test]
fn multi_step_check_pipeline_receipts_callbacks_timeout_stop_and_legacy_compat() {
    let tmp = TempDirGuard::new("checks-pipe");

    // A. All 3 steps pass with timing, tail_line, and ordered callbacks.
    let pipe = CheckPipeline::from_steps(
        vec![
            CheckStep::with_timeout("fmt", "printf 'checking format\\nfmt clean\\n'", 30),
            CheckStep::with_timeout("clippy", "printf '0 warnings\\n'", 30),
            CheckStep::with_timeout("test", "printf 'running 42 tests\\n42 passed\\n'", 30),
        ],
        30,
    )
    .unwrap();
    let mut seen_steps = Vec::new();
    let receipt = pipe.run_with_callback(tmp.path(), None, &mut |idx, r| {
        seen_steps.push((idx, r.name.clone(), r.passed));
    });
    assert!(receipt.passed, "{receipt:?}");
    assert!(receipt.ran);
    assert_eq!(receipt.exit_code, Some(0));
    assert_eq!(receipt.executed_steps(), 3);
    assert_eq!(receipt.skipped_steps(), 0);
    assert!(receipt.summary_reason.is_none());
    assert_eq!(receipt.steps[0].tail_line, "fmt clean");
    assert_eq!(receipt.steps[1].tail_line, "0 warnings");
    assert_eq!(receipt.steps[2].tail_line, "42 passed");
    assert_eq!(
        seen_steps,
        vec![
            (0, "fmt".to_string(), true),
            (1, "clippy".to_string(), true),
            (2, "test".to_string(), true),
        ]
    );

    // B. Backwards-compatible legacy single `check_cmd: String`.
    let legacy_ok = CheckPipeline::resolve(&[], "printf 'all green\\n'", 30).unwrap();
    assert!(legacy_ok.is_legacy_single());
    assert_eq!(legacy_ok.display_cmd(), "printf 'all green\\n'");
    let ok_rcpt = legacy_ok.run(tmp.path(), None);
    assert!(ok_rcpt.passed);
    assert_eq!(ok_rcpt.combined_output, "all green");

    let legacy_fail = CheckPipeline::resolve(&[], "echo boom; exit 3", 30).unwrap();
    let fail_rcpt = legacy_fail.run(tmp.path(), None);
    assert!(!fail_rcpt.passed);
    assert_eq!(fail_rcpt.exit_code, Some(3));
    assert_eq!(
        fail_rcpt.summary_reason.as_deref(),
        Some("Check failed (exit 3): echo boom; exit 3. Output: boom")
    );

    // C. Per-step timeout kills entire process group cleanly in ~1s (never hangs 10s).
    let timeout_pipe = CheckPipeline::from_steps(
        vec![
            CheckStep::with_timeout("hang", "sleep 10 & sleep 10", 1),
            CheckStep::with_timeout("after-hang", "echo should-not-run", 10),
        ],
        10,
    )
    .unwrap();
    let t0 = Instant::now();
    let timeout_rcpt = timeout_pipe.run(tmp.path(), None);
    let elapsed = t0.elapsed();
    assert!(!timeout_rcpt.passed);
    assert!(timeout_rcpt.timed_out);
    assert_eq!(timeout_rcpt.steps[0].status, StepStatus::TimedOut);
    assert_eq!(timeout_rcpt.steps[1].status, StepStatus::Skipped);
    assert!(
        elapsed < Duration::from_secs(5),
        "timed-out process group took {elapsed:?} to terminate"
    );

    // D. Stop flag interrupts a running step cleanly.
    let stop_flag = Arc::new(AtomicBool::new(false));
    let flag_clone = stop_flag.clone();
    let stopper = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        flag_clone.store(true, Ordering::Relaxed);
    });
    let stop_pipe = CheckPipeline::from_steps(vec![CheckStep::with_timeout("slow", "sleep 10", 30)], 30).unwrap();
    let stop_rcpt = stop_pipe.run(tmp.path(), Some(&stop_flag));
    stopper.join().unwrap();
    assert!(!stop_rcpt.passed);
    assert!(stop_rcpt.stopped);
    assert_eq!(stop_rcpt.steps[0].status, StepStatus::Stopped);
}

// ---------------------------------------------------------------------------
// 5. Rich Rune Policy Evaluator, Live Dry-Run & Fuzz Resilience
// ---------------------------------------------------------------------------

#[test]
fn rune_policy_dry_run_routing_and_fuzz_resilience() {
    let policy = Policy::load(SHIPPED_POLICY).unwrap();

    // Docs-only task gets narrowed allowed_globs + shorter 600s timeout.
    let docs = test_policy(&policy, "/home/dev/fleet", "docs-only update README", None);
    assert_eq!(docs.engine, "opencode");
    assert_eq!(docs.model.as_deref(), Some(DEFAULT_FREE_MODEL));
    assert_eq!(docs.timeout_secs, 600);
    assert_eq!(docs.allowed_globs, vec!["**/*.md", "docs/**"]);
    assert!(!docs.trace.is_empty());

    // Frontend repo gets `npm test` default check.
    let fe = test_policy(&policy, "/home/dev/frontend", "fix button alignment", None);
    assert_eq!(fe.project, "frontend");
    assert_eq!(fe.check_cmd, "npm test");

    // Fixture project gets named check_steps from policies.rn.
    let fx = test_policy(&policy, "/tmp/fixture", "write output", None);
    assert_eq!(fx.check_cmd, "test -s output.txt");
    assert_eq!(fx.check_steps.len(), 1);
    assert_eq!(fx.check_steps[0].name, "output");
    assert_eq!(fx.check_steps[0].cmd, "test -s output.txt");

    // Release task gets zero auto-retry and 1 auto-steer budget.
    let rel = test_policy(&policy, "/home/dev/api", "prepare production release", Some("claude"));
    assert_eq!(rel.engine, "claude");
    assert_eq!(rel.auto_retry_budget, 0);
    assert_eq!(rel.auto_steer_budget, 1);

    // Invalid candidate script returns clear diagnostics with line info (no panic).
    let bad_err = test_policy_script("pub fn max_parallel( {", "/repo", "task", None).unwrap_err();
    assert!(bad_err.contains("policy script failed to build"), "{bad_err}");

    // Fuzz test: 200 nasty inputs must NEVER panic and must serialize cleanly to JSON.
    let huge = "x".repeat(40_000);
    let fuzz_cases: Vec<(&str, &str, Option<&str>)> = vec![
        ("", "", None),
        ("/", "\0\0\0", Some("\0")),
        ("../../../etc/passwd", "rm -rf /; $(whoami)", Some("unknown-engine")),
        (&huge, &huge, Some(&huge)),
        ("/repos/日本語-🚀", "修复 🐛 security audit", Some("AUTO")),
        ("/repos/custom", "run fixture", Some("/usr/local/bin/custom-agent")),
        ("   \t\n  ", "   \n\r\t ", Some("   ")),
    ];
    for i in 0..200 {
        let (r, t, e) = fuzz_cases[i % fuzz_cases.len()];
        let d = policy.test_policy(r, t, e);
        let json = serde_json::to_value(&d).expect("PolicyDecision must serialize to JSON");
        assert!(json["timeout_secs"].as_u64().unwrap() >= 1);
        assert!(json["max_parallel"].as_i64().unwrap() >= 1);
    }

    // Runtime-failing optional Rune hook must fall back gracefully with a warning, never panic.
    let buggy_hook = r#"
        pub fn max_parallel() { 4 }
        pub fn default_check(p) { "cargo test" }
        pub fn route_engine(repo, task, req) { 1 / 0 }
    "#;
    let fallback = test_policy_script(buggy_hook, "/repos/demo", "fix", None).unwrap();
    assert_eq!(fallback.engine, "opencode");
    assert!(!fallback.warnings.is_empty(), "expected runtime warning");
}

#[test]
fn single_repo_batch_and_send_sync_engine_types() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Policy>();
    assert_send_sync::<DagGraph>();
    assert_send_sync::<CheckPipeline>();
    assert_send_sync::<FileScope>();
    assert_send_sync::<fleet::merge_check::MergeCheckResult>();
    assert_send_sync::<fleet::merge_check::PatchExport>();
    assert_send_sync::<fleet::policy::PolicyDecision>();

    let raw = serde_json::json!({
        "name": "single-repo-fanout",
        "repo": "/repos/single",
        "tasks": [
            { "task": "blocked by failed ext", "depends_on": ["ext-failed"] },
            { "task": "independent ready" }
        ]
    });
    let spec: BatchSpec = serde_json::from_value(raw).unwrap();
    let mut ext = HashMap::new();
    ext.insert("ext-failed".to_string(), DagNodeState::NeedsYou);
    let mut n = 0;
    let expanded = spec
        .expand(&ext, 4, || {
            n += 1;
            format!("s-{n}")
        })
        .unwrap();
    assert_eq!(expanded.sessions.len(), 2);
    assert_eq!(expanded.sessions[0].initial_state, DagNodeState::NeedsYou);
    assert_eq!(expanded.sessions[1].initial_state, DagNodeState::Queued);
    assert_eq!(expanded.immediate_ready, vec!["s-2"]);
}
