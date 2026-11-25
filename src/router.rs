//! Smart Cross-CLI Router and Per-Repo Failure Lesson Memory for `fleet`.
//!
//! - [`recommend_cli`]: scores installed CLI runners (`opencode`, `claude`, `codex`, ...)
//!   using persisted session pass rates, first-pass cleanliness, median wall time, and
//!   lightweight task-keyword affinity.
//! - [`LessonStore`]: atomically persists verified auto-heal repairs per repository and
//!   failure fingerprint (`<data_dir>/lessons.json`) so recurring check failures get a
//!   matched repair recipe on attempt 1.

use crate::autoheal::FailureCategory;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const LESSONS_FILE: &str = "lessons.json";
const MAX_LESSONS: usize = 200;

/// Minimal borrowed projection of a session used by [`recommend_cli`].
pub trait RouterSessionView {
    fn repo(&self) -> &str;
    fn agent(&self) -> &str;
    fn status(&self) -> &str;
    fn check_passed(&self) -> Option<bool>;
    fn auto_healed(&self) -> bool;
    fn elapsed_ms(&self) -> Option<u64>;
    fn heal_attempts_used(&self) -> usize;
}

/// Per-runner live telemetry scorecard returned by `GET /api/router/recommend`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RunnerScore {
    pub name: String,
    pub engine: String,
    pub found: bool,
    pub total_runs: usize,
    pub first_pass_count: usize,
    pub healed_count: usize,
    pub failed_count: usize,
    pub pass_rate_pct: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub median_elapsed_ms: Option<u64>,
    pub heal_efficiency_pct: f64,
    pub score: f64,
}

/// A verified check-failure -> repair lesson persisted across runs.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FailureLesson {
    pub id: String,
    pub repo: String,
    pub category: FailureCategory,
    pub trigger_step: String,
    pub fingerprint: String,
    pub symptom: String,
    pub fix_summary: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_files: Vec<String>,
    pub hits: u32,
    pub updated_ms: u64,
}

/// Recommendation payload returned by [`recommend_cli`] and `GET /api/router/recommend`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CliRecommendation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended_engine: Option<String>,
    pub confidence: String,
    pub reason: String,
    pub runners: Vec<RunnerScore>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub matching_lessons: Vec<FailureLesson>,
}

/// Atomic file-backed per-repo failure lesson store (`<data_dir>/lessons.json`).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LessonStore {
    #[serde(default)]
    lessons: Vec<FailureLesson>,
}

impl LessonStore {
    /// Load lessons from `<data_dir>/lessons.json`. Corrupt or missing files fall back cleanly.
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join(LESSONS_FILE);
        let Ok(text) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        serde_json::from_str::<Self>(&text).unwrap_or_default()
    }

    fn persist(&self, data_dir: &Path) {
        let path = data_dir.join(LESSONS_FILE);
        let tmp = data_dir.join(format!("{LESSONS_FILE}.tmp-{}", std::process::id()));
        if let Ok(json) = serde_json::to_string_pretty(self) {
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            } else {
                let _ = std::fs::remove_file(&tmp);
            }
        }
    }

    /// Record or reinforce a verified auto-heal repair lesson and persist atomically.
    #[allow(clippy::too_many_arguments)]
    pub fn record_healed_lesson(
        &mut self,
        data_dir: &Path,
        repo: &str,
        category: FailureCategory,
        trigger_step: &str,
        fingerprint: &str,
        symptom: &str,
        fix_summary: &str,
        changed_files: &[String],
    ) {
        let clean_repo = repo.trim();
        let clean_fp = fingerprint.trim();
        let clean_fix = fix_summary.trim();
        if clean_fp.is_empty() || clean_fix.is_empty() {
            return;
        }
        let now = now_ms();
        if let Some(existing) = self
            .lessons
            .iter_mut()
            .find(|l| l.repo == clean_repo && l.fingerprint == clean_fp)
        {
            existing.hits = existing.hits.saturating_add(1);
            existing.updated_ms = now;
            if existing.fix_summary.len() < clean_fix.len() {
                existing.fix_summary = trim_chars(clean_fix, 260);
            }
            for f in changed_files {
                if existing.changed_files.len() < 8 && !existing.changed_files.contains(f) {
                    existing.changed_files.push(f.clone());
                }
            }
            self.persist(data_dir);
            return;
        }

        let id = format!("lsn-{}", &clean_fp.chars().take(12).collect::<String>());
        self.lessons.push(FailureLesson {
            id,
            repo: clean_repo.to_string(),
            category,
            trigger_step: trigger_step.trim().to_string(),
            fingerprint: clean_fp.to_string(),
            symptom: trim_chars(symptom.trim(), 220),
            fix_summary: trim_chars(clean_fix, 260),
            changed_files: changed_files.iter().take(8).cloned().collect(),
            hits: 1,
            updated_ms: now,
        });
        if self.lessons.len() > MAX_LESSONS {
            self.lessons
                .sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms).then_with(|| b.hits.cmp(&a.hits)));
            self.lessons.truncate(MAX_LESSONS);
        }
        self.persist(data_dir);
    }

    /// Return up to `limit` learned lessons matching the repo, failure category, or step name.
    pub fn matching_lessons(
        &self,
        repo: &str,
        category: Option<FailureCategory>,
        trigger_step: &str,
        limit: usize,
    ) -> Vec<FailureLesson> {
        if limit == 0 || self.lessons.is_empty() {
            return Vec::new();
        }
        let step_l = trigger_step.trim().to_ascii_lowercase();
        let mut scored: Vec<(u32, &FailureLesson)> = self
            .lessons
            .iter()
            .filter_map(|l| {
                let mut rank = 0u32;
                if !repo.is_empty() && l.repo == repo {
                    rank += 4;
                } else if !repo.is_empty() && !l.repo.is_empty() {
                    return None;
                }
                if let Some(cat) = category {
                    if l.category == cat {
                        rank += 3;
                    }
                }
                if !step_l.is_empty() && l.trigger_step.to_ascii_lowercase() == step_l {
                    rank += 2;
                }
                if rank == 0 && category.is_some() {
                    return None;
                }
                Some((rank.saturating_mul(100).saturating_add(l.hits), l))
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.updated_ms.cmp(&a.1.updated_ms)));
        scored.into_iter().take(limit).map(|(_, l)| l.clone()).collect()
    }

    /// List persisted lessons optionally filtered by repository path.
    pub fn list(&self, repo_filter: Option<&str>) -> Vec<FailureLesson> {
        let mut out: Vec<FailureLesson> = self
            .lessons
            .iter()
            .filter(|l| repo_filter.is_none_or(|r| l.repo == r))
            .cloned()
            .collect();
        out.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms).then_with(|| b.hits.cmp(&a.hits)));
        out
    }
}

/// Score installed CLIs from persisted session telemetry and task context.
pub fn recommend_cli(
    sessions: &[&dyn RouterSessionView],
    agents: &[(String, bool)],
    default_agent: Option<&str>,
    lessons: &LessonStore,
    repo: Option<&str>,
    task: &str,
) -> CliRecommendation {
    let mut by_engine: HashMap<String, RouterAcc> = HashMap::new();
    let repo_filter = repo.map(str::trim).filter(|s| !s.is_empty());

    for s in sessions {
        if let Some(rf) = repo_filter {
            if s.repo() != rf && !s.repo().is_empty() {
                // Keep global stats with reduced influence only when repo has none; filter on exact pass first.
                continue;
            }
        }
        accumulate(&mut by_engine, *s);
    }
    if repo_filter.is_some() && by_engine.is_empty() {
        for s in sessions {
            accumulate(&mut by_engine, *s);
        }
    }

    let task_l = task.to_ascii_lowercase();
    let is_ui_task = contains_any(&task_l, &["ui", "ux", "react", "css", "frontend", "modal", "tailwind"]);
    let is_systems_task = contains_any(&task_l, &["rust", "cargo", "security", "perf", "refactor", "git", "sql"]);

    let mut runners: Vec<RunnerScore> = agents
        .iter()
        .map(|(name, found)| {
            let engine = classify_engine(name);
            let acc = by_engine.get(engine);
            let total_runs = acc.map_or(0, |a| a.total_runs);
            let first_pass = acc.map_or(0, |a| a.first_pass);
            let healed = acc.map_or(0, |a| a.healed);
            let failed = acc.map_or(0, |a| a.failed);
            let pass_count = first_pass + healed;
            let settled = pass_count + failed;
            let pass_rate_pct = if settled > 0 {
                (pass_count as f64 / settled as f64) * 100.0
            } else {
                0.0
            };
            let heal_attempts_total = healed + failed;
            let heal_efficiency_pct = if heal_attempts_total > 0 {
                (healed as f64 / heal_attempts_total as f64) * 100.0
            } else {
                0.0
            };
            let median_elapsed_ms = acc.and_then(|a| median(&a.elapsed));

            let mut score = if settled > 0 {
                let first_pass_pct = (first_pass as f64 / settled as f64) * 100.0;
                let speed_pts = median_elapsed_ms.map_or(10.0, |ms| {
                    let secs = (ms as f64) / 1000.0;
                    (20.0 - secs.min(20.0)).max(2.0)
                });
                (pass_rate_pct * 0.62) + (first_pass_pct * 0.20) + speed_pts
            } else {
                50.0
            };

            if (is_ui_task && engine == "claude")
                || (is_systems_task && matches!(engine, "codex" | "opencode"))
            {
                score += 3.0;
            }
            if default_agent == Some(name.as_str()) {
                score += 1.5;
            }
            if !*found {
                score = -1.0;
            }

            RunnerScore {
                name: name.clone(),
                engine: engine.to_string(),
                found: *found,
                total_runs,
                first_pass_count: first_pass,
                healed_count: healed,
                failed_count: failed,
                pass_rate_pct: round1(pass_rate_pct),
                median_elapsed_ms,
                heal_efficiency_pct: round1(heal_efficiency_pct),
                score: round1(score),
            }
        })
        .collect();

    runners.sort_by(|a, b| {
        b.found
            .cmp(&a.found)
            .then_with(|| b.score.total_cmp(&a.score))
            .then_with(|| b.total_runs.cmp(&a.total_runs))
            .then_with(|| a.name.cmp(&b.name))
    });

    let best = runners.iter().find(|r| r.found);
    let recommended_agent = best.map(|r| r.name.clone()).or_else(|| default_agent.map(str::to_string));
    let recommended_engine = best.map(|r| r.engine.clone());

    let (confidence, reason) = match best {
        Some(r) if r.total_runs > 0 => (
            "telemetry".to_string(),
            format!(
                "{} leads with {:.0}% pass rate across {} runs{}.",
                r.name,
                r.pass_rate_pct,
                r.total_runs,
                r.median_elapsed_ms
                    .map(|ms| format!(" ({ms}ms median)"))
                    .unwrap_or_default()
            ),
        ),
        Some(r) if is_ui_task || is_systems_task => (
            "heuristic".to_string(),
            format!(
                "{} selected for task affinity (no prior repo telemetry yet).",
                r.name
            ),
        ),
        Some(r) => (
            "default".to_string(),
            format!("{} selected as default installed CLI runner.", r.name),
        ),
        None => (
            "default".to_string(),
            "No CLI runner detected on PATH; custom script or browser worker will run.".to_string(),
        ),
    };

    let matching_lessons = lessons.matching_lessons(repo_filter.unwrap_or(""), None, "", 3);

    CliRecommendation {
        recommended_agent,
        recommended_engine,
        confidence,
        reason,
        runners,
        matching_lessons,
    }
}

fn accumulate(
    by_engine: &mut HashMap<String, RouterAcc>,
    s: &dyn RouterSessionView,
) {
    let settled = matches!(s.status(), "done" | "merged" | "needs-you");
    if !settled && s.check_passed().is_none() {
        return;
    }
    let eng = classify_engine(s.agent()).to_string();
    let entry = by_engine.entry(eng).or_default();
    entry.total_runs += 1;
    let passed = s.check_passed() == Some(true) || matches!(s.status(), "done" | "merged");
    if passed {
        if s.auto_healed() || s.heal_attempts_used() > 0 {
            entry.healed += 1;
        } else {
            entry.first_pass += 1;
        }
    } else if s.check_passed() == Some(false) || s.status() == "needs-you" {
        entry.failed += 1;
    }
    if let Some(ms) = s.elapsed_ms() {
        entry.elapsed.push(ms);
    }
}

#[derive(Default)]
struct RouterAcc {
    total_runs: usize,
    first_pass: usize,
    healed: usize,
    failed: usize,
    elapsed: Vec<u64>,
}

fn classify_engine(agent: &str) -> &'static str {
    let base = Path::new(agent.trim())
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(agent.trim())
        .to_ascii_lowercase();
    if base.starts_with("opencode") {
        "opencode"
    } else if base.starts_with("claude") {
        "claude"
    } else if base.starts_with("codex") {
        "codex"
    } else {
        "custom"
    }
}

fn median(values: &[u64]) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    Some(sorted[sorted.len() / 2])
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| haystack.contains(n))
}

fn trim_chars(s: &str, max_chars: usize) -> String {
    let count = s.chars().count();
    if count <= max_chars {
        s.to_string()
    } else {
        format!("{}...", s.chars().take(max_chars.saturating_sub(3)).collect::<String>())
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockSess {
        repo: &'static str,
        agent: &'static str,
        status: &'static str,
        check_passed: Option<bool>,
        auto_healed: bool,
        elapsed_ms: Option<u64>,
        heal_attempts: usize,
    }

    impl RouterSessionView for MockSess {
        fn repo(&self) -> &str { self.repo }
        fn agent(&self) -> &str { self.agent }
        fn status(&self) -> &str { self.status }
        fn check_passed(&self) -> Option<bool> { self.check_passed }
        fn auto_healed(&self) -> bool { self.auto_healed }
        fn elapsed_ms(&self) -> Option<u64> { self.elapsed_ms }
        fn heal_attempts_used(&self) -> usize { self.heal_attempts }
    }

    #[test]
    fn recommend_cli_ranks_installed_agents_by_telemetry_and_skips_missing() {
        let s1 = MockSess { repo: "/r/a", agent: "codex", status: "done", check_passed: Some(true), auto_healed: false, elapsed_ms: Some(900), heal_attempts: 0 };
        let s2 = MockSess { repo: "/r/a", agent: "codex", status: "done", check_passed: Some(true), auto_healed: false, elapsed_ms: Some(1100), heal_attempts: 0 };
        let s3 = MockSess { repo: "/r/a", agent: "claude", status: "needs-you", check_passed: Some(false), auto_healed: false, elapsed_ms: Some(8000), heal_attempts: 1 };
        let s4 = MockSess { repo: "/r/a", agent: "opencode", status: "done", check_passed: Some(true), auto_healed: false, elapsed_ms: Some(1500), heal_attempts: 0 };
        let views: Vec<&dyn RouterSessionView> = vec![&s1, &s2, &s3, &s4];
        let agents = vec![
            ("opencode".to_string(), false),
            ("claude".to_string(), true),
            ("codex".to_string(), true),
        ];
        let lessons = LessonStore::default();
        let rec = recommend_cli(&views, &agents, Some("claude"), &lessons, Some("/r/a"), "Fix auth middleware");
        assert_eq!(rec.recommended_agent.as_deref(), Some("codex"));
        assert_eq!(rec.confidence, "telemetry");
        assert_eq!(rec.runners[0].name, "codex");
        assert_eq!(rec.runners[0].first_pass_count, 2);
        assert!(!rec.runners.last().unwrap().found);
    }

    #[test]
    fn lesson_store_persists_atomically_and_matches_by_repo_and_category() {
        let dir = std::env::temp_dir().join(format!("fleet-router-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let mut store = LessonStore::load(&dir);
        store.record_healed_lesson(
            &dir,
            "/repos/api",
            FailureCategory::CompileError,
            "cargo test",
            "fp-compile-1",
            "error[E0308]: expected u64 found i32",
            "Fixed type mismatch in src/lib.rs; updated 1 file",
            &["src/lib.rs".to_string()],
        );
        // Second identical hit increments hits instead of duplicating
        store.record_healed_lesson(
            &dir,
            "/repos/api",
            FailureCategory::CompileError,
            "cargo test",
            "fp-compile-1",
            "error[E0308]: expected u64 found i32",
            "Fixed type mismatch in src/lib.rs; updated 1 file cleanly",
            &["src/lib.rs".to_string()],
        );

        let reloaded = LessonStore::load(&dir);
        let hits = reloaded.matching_lessons("/repos/api", Some(FailureCategory::CompileError), "cargo test", 3);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].hits, 2);
        assert_eq!(hits[0].changed_files, vec!["src/lib.rs"]);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
