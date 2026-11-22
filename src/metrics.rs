//! Live Board Telemetry for `fleet`.
//!
//! Computes honest pass-rate, auto-heal effectiveness, median verification latency,
//! active/queued slot utilization, and per-repository breakdowns in a single linear pass
//! over the session slice (sub-millisecond even at 2,000+ sessions).

use crate::autoheal::HealAttempt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// Read-only projection of a session used by [`compute_metrics`].
///
/// Implemented for [`SessionMetricInput`] and trivially implementable for `fleet`'s
/// internal `Session` struct with zero allocation or cloning.
pub trait SessionMetricView {
    fn status(&self) -> &str;
    fn repo(&self) -> &str;
    fn project(&self) -> &str;
    fn check_passed(&self) -> Option<bool>;
    fn check_elapsed_ms(&self) -> Option<u64>;
    fn heal_attempts(&self) -> &[HealAttempt];
}

/// Concrete serializable metric input for standalone callers, APIs, and tests.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionMetricInput {
    pub status: String,
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub check_passed: Option<bool>,
    #[serde(default)]
    pub check_elapsed_ms: Option<u64>,
    #[serde(default)]
    pub heal_attempts: Vec<HealAttempt>,
}

impl SessionMetricView for SessionMetricInput {
    fn status(&self) -> &str {
        &self.status
    }

    fn repo(&self) -> &str {
        &self.repo
    }

    fn project(&self) -> &str {
        &self.project
    }

    fn check_passed(&self) -> Option<bool> {
        self.check_passed
    }

    fn check_elapsed_ms(&self) -> Option<u64> {
        self.check_elapsed_ms
    }

    fn heal_attempts(&self) -> &[HealAttempt] {
        &self.heal_attempts
    }
}

/// Telemetry rollup for one repository.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RepoMetrics {
    pub repo: String,
    pub project: String,
    pub total: usize,
    pub first_pass_count: usize,
    pub auto_healed_count: usize,
    pub passed_count: usize,
    pub needs_you_count: usize,
    pub active_count: usize,
    pub queued_count: usize,
    pub first_pass_rate_pct: f64,
    pub effective_pass_rate_pct: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub median_check_ms: Option<u64>,
}

/// Board-wide telemetry returned by `GET /api/metrics`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BoardMetrics {
    pub total: usize,
    pub first_pass_count: usize,
    pub auto_healed_count: usize,
    pub needs_you_count: usize,
    pub done_count: usize,
    pub merged_count: usize,
    pub archived_count: usize,
    pub settled_count: usize,
    pub first_pass_rate_pct: f64,
    pub effective_pass_rate_pct: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub median_check_ms: Option<u64>,
    pub active_slots: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_slots: Option<usize>,
    pub queued_count: usize,
    pub blocked_count: usize,
    pub total_heal_attempts: usize,
    pub per_repo_breakdown: Vec<RepoMetrics>,
}

/// Compute live telemetry across a slice of sessions.
pub fn compute_metrics<S: SessionMetricView>(sessions: &[S]) -> BoardMetrics {
    compute_metrics_inner(sessions, None)
}

/// Compute live telemetry across a slice of sessions, attaching the current `max_slots` cap.
pub fn compute_metrics_with_capacity<S: SessionMetricView>(
    sessions: &[S],
    max_slots: usize,
) -> BoardMetrics {
    compute_metrics_inner(sessions, Some(max_slots))
}

#[derive(Default)]
struct RepoAcc {
    project: String,
    total: usize,
    first_pass_count: usize,
    auto_healed_count: usize,
    needs_you_count: usize,
    archived_count: usize,
    active_count: usize,
    queued_count: usize,
    check_durations_ms: Vec<u64>,
}

fn compute_metrics_inner<S: SessionMetricView>(
    sessions: &[S],
    max_slots: Option<usize>,
) -> BoardMetrics {
    let mut first_pass_count = 0usize;
    let mut auto_healed_count = 0usize;
    let mut needs_you_count = 0usize;
    let mut done_count = 0usize;
    let mut merged_count = 0usize;
    let mut archived_count = 0usize;
    let mut active_slots = 0usize;
    let mut queued_count = 0usize;
    let mut blocked_count = 0usize;
    let mut total_heal_attempts = 0usize;
    let mut all_durations: Vec<u64> = Vec::new();
    let mut repos: HashMap<String, RepoAcc> = HashMap::new();

    for s in sessions {
        let status = s.status().trim().to_ascii_lowercase();
        let attempts = s.heal_attempts();
        total_heal_attempts += attempts.len();

        let repo_key = normalize_repo_key(s.repo());
        let acc = repos.entry(repo_key.clone()).or_insert_with(|| RepoAcc {
            project: derive_project_label(s.project(), &repo_key),
            ..RepoAcc::default()
        });
        acc.total += 1;

        if let Some(ms) = s.check_elapsed_ms() {
            all_durations.push(ms);
            acc.check_durations_ms.push(ms);
        }

        let was_auto_healed = !attempts.is_empty();
        match status.as_str() {
            "working" | "checking" => {
                active_slots += 1;
                acc.active_count += 1;
            }
            "queued" => {
                queued_count += 1;
                acc.queued_count += 1;
            }
            "blocked" => {
                queued_count += 1;
                blocked_count += 1;
                acc.queued_count += 1;
            }
            "done" => {
                done_count += 1;
                if was_auto_healed {
                    auto_healed_count += 1;
                    acc.auto_healed_count += 1;
                } else {
                    first_pass_count += 1;
                    acc.first_pass_count += 1;
                }
            }
            "merged" => {
                merged_count += 1;
                if was_auto_healed {
                    auto_healed_count += 1;
                    acc.auto_healed_count += 1;
                } else {
                    first_pass_count += 1;
                    acc.first_pass_count += 1;
                }
            }
            "needs-you" | "needs_you" | "needs you" => {
                needs_you_count += 1;
                acc.needs_you_count += 1;
            }
            "archived" | "dismissed" => {
                archived_count += 1;
                acc.archived_count += 1;
            }
            _ => {
                // Unknown status: fall back to check_passed if explicitly recorded.
                if s.check_passed() == Some(true) {
                    if was_auto_healed {
                        auto_healed_count += 1;
                        acc.auto_healed_count += 1;
                    } else {
                        first_pass_count += 1;
                        acc.first_pass_count += 1;
                    }
                }
            }
        }
    }

    let settled_count = first_pass_count + auto_healed_count + needs_you_count + archived_count;
    let first_pass_rate_pct = rate_pct(first_pass_count, settled_count);
    let effective_pass_rate_pct = rate_pct(first_pass_count + auto_healed_count, settled_count);
    let median_check_ms = median_u64(&mut all_durations);

    let mut per_repo_breakdown: Vec<RepoMetrics> = repos
        .into_iter()
        .map(|(repo, mut acc)| {
            let passed = acc.first_pass_count + acc.auto_healed_count;
            let repo_settled = passed + acc.needs_you_count + acc.archived_count;
            RepoMetrics {
                repo,
                project: acc.project,
                total: acc.total,
                first_pass_count: acc.first_pass_count,
                auto_healed_count: acc.auto_healed_count,
                passed_count: passed,
                needs_you_count: acc.needs_you_count,
                active_count: acc.active_count,
                queued_count: acc.queued_count,
                first_pass_rate_pct: rate_pct(acc.first_pass_count, repo_settled),
                effective_pass_rate_pct: rate_pct(passed, repo_settled),
                median_check_ms: median_u64(&mut acc.check_durations_ms),
            }
        })
        .collect();

    per_repo_breakdown.sort_by(|a, b| {
        b.total
            .cmp(&a.total)
            .then_with(|| a.project.to_lowercase().cmp(&b.project.to_lowercase()))
            .then_with(|| a.repo.cmp(&b.repo))
    });

    BoardMetrics {
        total: sessions.len(),
        first_pass_count,
        auto_healed_count,
        needs_you_count,
        done_count,
        merged_count,
        archived_count,
        settled_count,
        first_pass_rate_pct,
        effective_pass_rate_pct,
        median_check_ms,
        active_slots,
        max_slots,
        queued_count,
        blocked_count,
        total_heal_attempts,
        per_repo_breakdown,
    }
}

fn rate_pct(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        return 0.0;
    }
    let raw = (numerator as f64) * 100.0 / (denominator as f64);
    (raw * 10.0).round() / 10.0
}

fn median_u64(values: &mut [u64]) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let mid = values.len() / 2;
    if values.len() % 2 == 1 {
        Some(values[mid])
    } else {
        let lo = values[mid - 1];
        let hi = values[mid];
        Some(lo + (hi - lo) / 2)
    }
}

fn normalize_repo_key(repo: &str) -> String {
    let trimmed = repo.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        "(unassigned)".to_string()
    } else {
        trimmed.to_string()
    }
}

fn derive_project_label(project: &str, repo: &str) -> String {
    let p = project.trim();
    if !p.is_empty() {
        return p.to_string();
    }
    Path::new(repo)
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("default")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_attempt(attempt: u32, healed: bool) -> HealAttempt {
        HealAttempt {
            attempt,
            trigger_step: "test".to_string(),
            exit_code: Some(1),
            stderr_tail: "err".to_string(),
            prompt_sent: "fix".to_string(),
            started_ms: 0,
            elapsed_ms: 100,
            healed,
        }
    }

    #[test]
    fn empty_board_returns_zero_rates_and_no_median() {
        let empty: Vec<SessionMetricInput> = Vec::new();
        let m = compute_metrics(&empty);
        assert_eq!(m.total, 0);
        assert_eq!(m.first_pass_rate_pct, 0.0);
        assert_eq!(m.effective_pass_rate_pct, 0.0);
        assert_eq!(m.median_check_ms, None);
        assert!(m.per_repo_breakdown.is_empty());
    }

    #[test]
    fn mixed_outcomes_compute_exact_pass_rates_median_and_repo_breakdown() {
        let sessions = vec![
            // Repo A: 1 first-pass done (100ms), 1 auto-healed merged (300ms), 1 needs-you (500ms)
            SessionMetricInput {
                status: "done".to_string(),
                repo: "/repos/alpha".to_string(),
                project: "alpha".to_string(),
                check_passed: Some(true),
                check_elapsed_ms: Some(100),
                heal_attempts: vec![],
            },
            SessionMetricInput {
                status: "merged".to_string(),
                repo: "/repos/alpha".to_string(),
                project: "alpha".to_string(),
                check_passed: Some(true),
                check_elapsed_ms: Some(300),
                heal_attempts: vec![mk_attempt(1, true)],
            },
            SessionMetricInput {
                status: "needs-you".to_string(),
                repo: "/repos/alpha".to_string(),
                project: "alpha".to_string(),
                check_passed: Some(false),
                check_elapsed_ms: Some(500),
                heal_attempts: vec![mk_attempt(1, false), mk_attempt(2, false)],
            },
            // Repo B: 1 first-pass done (900ms), 1 working, 1 queued
            SessionMetricInput {
                status: "done".to_string(),
                repo: "/repos/beta".to_string(),
                project: "beta".to_string(),
                check_passed: Some(true),
                check_elapsed_ms: Some(900),
                heal_attempts: vec![],
            },
            SessionMetricInput {
                status: "working".to_string(),
                repo: "/repos/beta".to_string(),
                project: "beta".to_string(),
                check_passed: None,
                check_elapsed_ms: None,
                heal_attempts: vec![],
            },
            SessionMetricInput {
                status: "queued".to_string(),
                repo: "/repos/beta".to_string(),
                project: "beta".to_string(),
                check_passed: None,
                check_elapsed_ms: None,
                heal_attempts: vec![],
            },
        ];

        let m = compute_metrics_with_capacity(&sessions, 4);
        assert_eq!(m.total, 6);
        assert_eq!(m.first_pass_count, 2);
        assert_eq!(m.auto_healed_count, 1);
        assert_eq!(m.needs_you_count, 1);
        assert_eq!(m.settled_count, 4);
        assert_eq!(m.first_pass_rate_pct, 50.0);
        assert_eq!(m.effective_pass_rate_pct, 75.0);
        // Durations: [100, 300, 500, 900] -> median = (300 + 500) / 2 = 400.
        assert_eq!(m.median_check_ms, Some(400));
        assert_eq!(m.active_slots, 1);
        assert_eq!(m.max_slots, Some(4));
        assert_eq!(m.queued_count, 1);
        assert_eq!(m.total_heal_attempts, 3);
        assert_eq!(m.per_repo_breakdown.len(), 2);
        assert_eq!(m.per_repo_breakdown[0].project, "alpha");
        assert_eq!(m.per_repo_breakdown[0].first_pass_rate_pct, 33.3);
        assert_eq!(m.per_repo_breakdown[0].effective_pass_rate_pct, 66.7);
        assert_eq!(m.per_repo_breakdown[0].median_check_ms, Some(300));
    }
}
