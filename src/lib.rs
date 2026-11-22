//! Modular orchestration, policy, verification, and merge-check engines for `fleet-rs`.
//!
//! - [`dag`]: Task dependency DAG scheduler with cycle detection, topological readiness,
//!   upstream-failure propagation, and multi-repo batch/matrix dispatch.
//! - [`checks`]: Multi-step timed check pipelines (backwards-compatible with single
//!   `check_cmd`) and git diff file-scope guardrail verification.
//! - [`merge_check`]: Non-destructive `git merge-tree` dry-run conflict detection,
//!   `.patch` export (`git format-patch` / unified diff), and strategy-aware merging.
//! - [`policy`]: Rune-backed policy evaluator with repo/path/engine routing, timeouts,
//!   auto-retry/auto-steer budgets, and live `test_policy` dry-run evaluation.

pub mod checks;
pub mod dag;
pub mod merge_check;
pub mod policy;
