//! Modular orchestration, policy, verification, auto-heal, playbook, telemetry, and merge-check
//! engines for `fleet-rs`.
//!
//! - [`dag`]: Task dependency DAG scheduler with cycle detection, topological readiness,
//!   upstream-failure propagation, and multi-repo batch/matrix dispatch.
//! - [`checks`]: Multi-step timed check pipelines (backwards-compatible with single
//!   `check_cmd`) and git diff file-scope guardrail verification.
//! - [`merge_check`]: Non-destructive `git merge-tree` dry-run conflict detection,
//!   `.patch` export (`git format-patch` / unified diff), and strategy-aware merging.
//! - [`policy`]: Policy evaluator with repo/path/engine routing, timeouts,
//!   auto-retry/auto-steer budgets, and live `test_policy` dry-run evaluation.
//! - [`autoheal`]: Autonomous check-failure repair loop with deterministic diagnostic
//!   prompts, budget enforcement, and identical-error loop-guard.
//! - [`templates`]: Reusable engineering playbook templates with atomic persistence.
//! - [`metrics`]: Live board telemetry (first-pass rate, auto-heal lift, median check
//!   latency, slot utilization, and per-repo breakdown).

pub mod autoheal;
pub mod checks;
pub mod dag;
pub mod merge_check;
pub mod metrics;
pub mod policy;
pub mod templates;
