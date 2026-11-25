//! Integration, edge-case, and scale tests for `v0.6.0` Fleet engines:
//! - `autoheal`: autonomous repair loop, diagnostic prompts, budget & identical-error loop guard
//! - `templates`: reusable engineering playbooks, atomic persistence, corrupt-store recovery, DAG expansion
//! - `metrics`: live board telemetry, pass-rate lift math, median latency, 2,000-session benchmark

use fleet::autoheal::{
    build_heal_prompt, error_fingerprint, evaluate_auto_heal, heal_badge_label, should_auto_heal,
    strip_ansi_codes, FailedCheckContext, HealAttempt, HealDecision, HealSessionContext,
    HealStopReason,
};
use fleet::checks::{CheckPipeline, CheckStep, StepStatus};
use fleet::metrics::{
    compute_metrics, compute_metrics_with_capacity, BoardMetrics, RepoMetrics, SessionMetricInput,
};
use fleet::templates::{default_templates, PlaybookInput, PlaybookTemplate, TemplateStore};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

struct TempDirGuard(PathBuf);

impl TempDirGuard {
    fn new(tag: &str) -> Self {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "fleet-v060-eng-{tag}-{}-{n}",
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

#[test]
fn autoheal_end_to_end_pipeline_recovers_and_formats_badge() {
    let tmp = TempDirGuard::new("autoheal-e2e");
    let flag_file = tmp.path().join("fixed.txt");
    let pipe = CheckPipeline::from_steps(
        vec![
            CheckStep::with_timeout("lint", "printf 'lint ok\\n'", 30),
            CheckStep::with_timeout(
                "unit-tests",
                format!(
                    "if test -f '{}'; then printf 'all 12 tests passed\\n'; else printf '\\033[31mFAIL test_invoice: expected 42 got 0\\033[0m\\n' >&2; exit 1; fi",
                    flag_file.display()
                ),
                30,
            ),
        ],
        30,
    )
    .unwrap();

    // Pass 1 fails on step 2.
    let receipt1 = pipe.run(tmp.path(), None);
    assert!(!receipt1.passed);
    let failed = FailedCheckContext::from_pipeline_receipt(&receipt1, &pipe.display_cmd())
        .expect("failed pipeline must yield failure context");
    assert_eq!(failed.step_name, "unit-tests");
    assert_eq!(failed.exit_code, Some(1));

    let mut history: Vec<HealAttempt> = Vec::new();
    let dec = evaluate_auto_heal(0, 2, false, &history, &failed);
    let next_attempt = match dec {
        HealDecision::Proceed {
            next_attempt,
            remaining_after,
            ..
        } => {
            assert_eq!(next_attempt, 1);
            assert_eq!(remaining_after, 1);
            next_attempt
        }
        other => panic!("expected Proceed, got {other:?}"),
    };

    let ctx = HealSessionContext {
        session_id: "s-heal-1".to_string(),
        task: "Fix invoice total calculation".to_string(),
        repo: "/repos/py-ledger-api".to_string(),
        branch: "fleet/s-heal-1".to_string(),
        allowed_globs: vec!["src/**".to_string()],
        forbidden_globs: vec![".env".to_string()],
        attempt: next_attempt,
        budget: 2,
        ..Default::default()
    };
    let prompt = build_heal_prompt(&ctx, &failed);
    assert!(prompt.contains("FAIL test_invoice: expected 42 got 0"), "{prompt}");
    assert!(!prompt.contains("\x1b["), "ANSI must be stripped from prompt");
    assert!(!prompt.to_lowercase().contains("rune"), "zero internal jargon in heal prompt");

    // Simulate agent applying the fix, then re-verify!
    std::fs::write(&flag_file, "fixed\n").unwrap();
    let receipt2 = pipe.run(tmp.path(), None);
    assert!(receipt2.passed, "{receipt2:?}");
    assert!(FailedCheckContext::from_pipeline_receipt(&receipt2, &pipe.display_cmd()).is_none());

    let stderr_tail = failed.diagnostic_tail();
    history.push(HealAttempt {
        attempt: 1,
        trigger_step: failed.step_name,
        exit_code: failed.exit_code,
        stderr_tail,
        prompt_sent: prompt,
        started_ms: HealAttempt::now_ms(),
        elapsed_ms: receipt2.total_elapsed_ms,
        healed: true,
    });
    assert_eq!(
        heal_badge_label(&history, 2).as_deref(),
        Some("Healed on attempt 1/2")
    );
}

#[test]
fn autoheal_guards_against_loops_stops_nonhealable_and_exhausted_budgets() {
    let err_a = FailedCheckContext {
        step_name: "cargo-test".to_string(),
        cmd: "cargo test".to_string(),
        exit_code: Some(101),
        status: Some(StepStatus::Failed),
        output: "2026-11-22T02:10:01Z test ledger::adds_tax ... FAILED (0x7f1234abcd) in 14ms"
            .to_string(),
        tail_line: String::new(),
    };
    let err_a_again = FailedCheckContext {
        step_name: "cargo-test".to_string(),
        cmd: "cargo test".to_string(),
        exit_code: Some(101),
        status: Some(StepStatus::Failed),
        output: "2026-11-22T02:11:44Z test ledger::adds_tax ... FAILED (0x7f9988dead) in 298ms"
            .to_string(),
        tail_line: String::new(),
    };
    assert_eq!(
        error_fingerprint("cargo-test", Some(101), &err_a.output),
        error_fingerprint("cargo-test", Some(101), &err_a_again.output)
    );

    let history = vec![HealAttempt {
        attempt: 1,
        trigger_step: "cargo-test".to_string(),
        exit_code: Some(101),
        stderr_tail: err_a.diagnostic_tail(),
        prompt_sent: "fix".to_string(),
        started_ms: 100,
        elapsed_ms: 250,
        healed: false,
    }];

    // Identical error despite timestamp/address/duration drift -> IdenticalErrorLoop!
    let loop_dec = evaluate_auto_heal(1, 5, false, &history, &err_a_again);
    match loop_dec {
        HealDecision::Stop { reason, message } => {
            assert_eq!(reason, HealStopReason::IdenticalErrorLoop);
            assert!(message.contains("identical error"), "{message}");
        }
        other => panic!("expected IdenticalErrorLoop stop, got {other:?}"),
    }

    // Operator stop always wins.
    assert!(!should_auto_heal(0, 3, true));
    let stop_dec = evaluate_auto_heal(0, 3, true, &[], &err_a);
    assert!(matches!(
        stop_dec,
        HealDecision::Stop {
            reason: HealStopReason::OperatorStopped,
            ..
        }
    ));

    // Budget = 0 disables auto-heal.
    let disabled = evaluate_auto_heal(0, 0, false, &[], &err_a);
    assert!(matches!(
        disabled,
        HealDecision::Stop {
            reason: HealStopReason::BudgetDisabled,
            ..
        }
    ));

    // Exhausted budget stops cleanly.
    let exhausted = evaluate_auto_heal(2, 2, false, &[], &err_a);
    assert!(matches!(
        exhausted,
        HealDecision::Stop {
            reason: HealStopReason::BudgetExhausted,
            ..
        }
    ));

    // SpawnFailed / Stopped / PipesHeld are not healable by nudging the agent.
    for non_healable in [StepStatus::SpawnFailed, StepStatus::Stopped, StepStatus::PipesHeld] {
        let ctx = FailedCheckContext {
            step_name: "check".to_string(),
            cmd: "false".to_string(),
            exit_code: None,
            status: Some(non_healable),
            output: "err".to_string(),
            tail_line: String::new(),
        };
        let dec = evaluate_auto_heal(0, 3, false, &[], &ctx);
        assert!(matches!(
            dec,
            HealDecision::Stop {
                reason: HealStopReason::NonHealableFailure,
                ..
            }
        ));
    }

    assert_eq!(
        strip_ansi_codes("\x1b]0;window title\x07\x1b[32mok\x1b[0m"),
        "ok"
    );
}

#[test]
fn templates_expand_to_valid_dags_validate_inputs_and_recover_from_corrupt_file() {
    let tmp = TempDirGuard::new("templates");

    // All 4 default playbooks must convert cleanly into acyclic DAG batches.
    for tpl in default_templates() {
        let batch = tpl.to_batch_spec(Some("/repos/demo-repo"));
        let mut seq = 0u64;
        let expanded = batch
            .expand(&HashMap::new(), 4, || {
                seq += 1;
                format!("t-{seq}")
            })
            .unwrap_or_else(|e| panic!("default playbook '{}' failed DAG expand: {e}", tpl.id));
        assert!(!expanded.sessions.is_empty());
        assert!(!expanded.immediate_ready.is_empty());
    }

    // Corrupt templates.json must be set aside and cleanly recovered with 4 defaults.
    let corrupt_path = tmp.path().join("templates.json");
    std::fs::write(&corrupt_path, "{ not valid json !!!").unwrap();
    let mut store = TemplateStore::load(tmp.path());
    assert_eq!(store.list().len(), 4);
    let moved_corrupt = std::fs::read_dir(tmp.path())
        .unwrap()
        .flatten()
        .any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("templates.json.corrupt-")
        });
    assert!(moved_corrupt, "corrupt templates.json should be preserved aside");

    // Security validation: reject path-traversal IDs, NUL bytes, empty names, empty check cmd.
    let bad_id = PlaybookInput {
        id: Some("../escape".to_string()),
        name: "Bad".to_string(),
        ..PlaybookInput::default()
    };
    assert!(store.upsert(bad_id).is_err());

    let empty_name = PlaybookInput {
        name: "   ".to_string(),
        ..PlaybookInput::default()
    };
    assert!(store.upsert(empty_name).is_err());

    let bad_step = PlaybookInput {
        name: "Broken Step".to_string(),
        check_steps: vec![CheckStep::new("bad", "   ")],
        ..PlaybookInput::default()
    };
    assert!(store.upsert(bad_step).is_err());

    // Duplicate names without explicit ID auto-slug cleanly (`my-flow`, `my-flow-2`).
    let first = store
        .upsert(PlaybookInput {
            name: "My Flow".to_string(),
            description: "First copy".to_string(),
            auto_steer_budget: 99, // clamped to MAX_AUTO_HEAL_BUDGET (10)
            ..PlaybookInput::default()
        })
        .unwrap();
    assert_eq!(first.id, "my-flow");
    assert_eq!(first.auto_steer_budget, 10);

    let second = store
        .upsert(PlaybookInput {
            name: "My Flow".to_string(),
            description: "Second copy".to_string(),
            auto_steer_budget: 2,
            ..PlaybookInput::default()
        })
        .unwrap();
    assert_eq!(second.id, "my-flow-2");

    // Delete + restore_defaults restores missing built-ins without losing custom playbooks.
    store.delete("rust-lint-test").unwrap();
    assert!(store.get("rust-lint-test").is_none());
    store.restore_defaults().unwrap();
    assert!(store.get("rust-lint-test").is_some());
    assert!(store.get("my-flow").is_some());
    assert!(store.get("my-flow-2").is_some());
    assert!(store.delete("nonexistent-id").is_err());
}

#[test]
fn metrics_2000_session_benchmark_and_send_sync_guarantees() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<HealAttempt>();
    assert_send_sync::<HealDecision>();
    assert_send_sync::<PlaybookTemplate>();
    assert_send_sync::<TemplateStore>();
    assert_send_sync::<BoardMetrics>();
    assert_send_sync::<RepoMetrics>();

    // Build 2,000 mixed-outcome sessions across 20 repositories.
    let mut sessions = Vec::with_capacity(2_000);
    for i in 0..2_000usize {
        let repo_idx = i % 20;
        let (status, check_passed, elapsed, attempts) = match i % 10 {
            0..=4 => ("done", Some(true), Some(100 + (i as u64 % 400)), vec![]),
            5 => ("merged", Some(true), Some(250), vec![]),
            6 => (
                "done",
                Some(true),
                Some(600),
                vec![HealAttempt {
                    attempt: 1,
                    trigger_step: "test".to_string(),
                    exit_code: Some(1),
                    stderr_tail: "failed".to_string(),
                    prompt_sent: "fix".to_string(),
                    started_ms: 1,
                    elapsed_ms: 300,
                    healed: true,
                }],
            ),
            7 => (
                "needs-you",
                Some(false),
                Some(800),
                vec![HealAttempt {
                    attempt: 1,
                    trigger_step: "test".to_string(),
                    exit_code: Some(1),
                    stderr_tail: "still failing".to_string(),
                    prompt_sent: "fix".to_string(),
                    started_ms: 1,
                    elapsed_ms: 300,
                    healed: false,
                }],
            ),
            8 => ("working", None, None, vec![]),
            _ => ("queued", None, None, vec![]),
        };
        sessions.push(SessionMetricInput {
            status: status.to_string(),
            repo: format!("/repos/service-{repo_idx:02}"),
            project: format!("service-{repo_idx:02}"),
            check_passed,
            check_elapsed_ms: elapsed,
            heal_attempts: attempts,
        });
    }

    let t0 = Instant::now();
    let m = compute_metrics_with_capacity(&sessions, 8);
    let elapsed_ms = t0.elapsed().as_millis();
    eprintln!("[bench] 2000-session compute_metrics: {elapsed_ms}ms");

    assert_eq!(m.total, 2_000);
    assert_eq!(m.first_pass_count, 1_200); // 6/10
    assert_eq!(m.auto_healed_count, 200); // 1/10
    assert_eq!(m.needs_you_count, 200); // 1/10
    assert_eq!(m.active_slots, 200); // 1/10
    assert_eq!(m.queued_count, 200); // 1/10
    assert_eq!(m.settled_count, 1_600);
    assert_eq!(m.first_pass_rate_pct, 75.0);
    assert_eq!(m.effective_pass_rate_pct, 87.5);
    assert_eq!(m.per_repo_breakdown.len(), 20);
    assert_eq!(m.total_heal_attempts, 400);
    assert!(m.median_check_ms.is_some());
    assert!(elapsed_ms < 500, "2000-session metrics took {elapsed_ms}ms");

    // Verify clean JSON serialization (zero NaN/null errors).
    let json = serde_json::to_value(&m).unwrap();
    assert_eq!(json["first_pass_rate_pct"], 75.0);
    assert_eq!(json["effective_pass_rate_pct"], 87.5);
    assert_eq!(json["max_slots"], 8);

    // Ensure compute_metrics without capacity also works cleanly.
    let m_no_cap = compute_metrics(&sessions);
    assert_eq!(m_no_cap.max_slots, None);
    assert_eq!(m_no_cap.total, 2_000);
}
