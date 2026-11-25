//! Autonomous Auto-Heal / Auto-Steer feedback loop for `fleet`.
//!
//! When a session's verification check fails, this module:
//! - Decides whether an automatic repair attempt is allowed under the configured
//!   `auto_steer_budget` and operator stop flag ([`should_auto_heal`], [`evaluate_auto_heal`]).
//! - Guards against infinite identical-error loops by fingerprinting normalized stderr/output
//!   diagnostics per `(trigger_step, exit_code)` across prior attempts.
//! - Builds deterministic, crisp diagnostic steering prompts ([`build_heal_prompt`]) that
//!   preserve file-scope boundaries and instruct the agent to fix the root cause without
//!   weakening checks.

use crate::checks::{CheckStepReceipt, PipelineReceipt, StepStatus};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

/// Hard safety ceiling on automatic repair attempts per session.
pub const MAX_AUTO_HEAL_BUDGET: u32 = 10;
/// Maximum lines included in a diagnostic failure tail.
pub const MAX_TAIL_LINES: usize = 40;
/// Maximum characters included in a diagnostic failure tail.
pub const MAX_TAIL_CHARS: usize = 3500;
/// Maximum characters of original task text echoed in a heal prompt.
const MAX_TASK_ECHO_CHARS: usize = 1200;

/// Recorded telemetry for a single autonomous repair pass.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HealAttempt {
    pub attempt: u32,
    pub trigger_step: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub stderr_tail: String,
    pub prompt_sent: String,
    pub started_ms: u64,
    pub elapsed_ms: u64,
    pub healed: bool,
}

impl HealAttempt {
    /// Current Unix timestamp in milliseconds for stamping `started_ms`.
    pub fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Compute the normalized error fingerprint for this attempt's failure.
    pub fn fingerprint(&self) -> String {
        error_fingerprint(&self.trigger_step, self.exit_code, &self.stderr_tail)
    }
}

/// Session context supplied to [`build_heal_prompt`].
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HealSessionContext {
    pub session_id: String,
    pub task: String,
    pub repo: String,
    pub branch: String,
    #[serde(default)]
    pub allowed_globs: Vec<String>,
    #[serde(default)]
    pub forbidden_globs: Vec<String>,
    #[serde(default)]
    pub attempt: u32,
    #[serde(default)]
    pub budget: u32,
    #[serde(default)]
    pub changed_files: Vec<String>,
    #[serde(default)]
    pub diff_excerpt: String,
    #[serde(default)]
    pub prior_attempts_summary: Vec<String>,
}

/// Failing verification step details supplied to [`build_heal_prompt`] and [`evaluate_auto_heal`].
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FailedCheckContext {
    pub step_name: String,
    pub cmd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<StepStatus>,
    pub output: String,
    #[serde(default)]
    pub tail_line: String,
}

impl FailedCheckContext {
    /// Build a failure context directly from a failing [`CheckStepReceipt`].
    pub fn from_step_receipt(step: &CheckStepReceipt) -> Self {
        Self {
            step_name: step.name.clone(),
            cmd: step.cmd.clone(),
            exit_code: step.exit_code,
            status: Some(step.status),
            output: step.output.clone(),
            tail_line: step.tail_line.clone(),
        }
    }

    /// Extract the failing step from a [`PipelineReceipt`]. Returns `None` if the pipeline passed.
    pub fn from_pipeline_receipt(
        receipt: &PipelineReceipt,
        fallback_cmd: &str,
    ) -> Option<Self> {
        if receipt.passed {
            return None;
        }
        if let Some(idx) = receipt.failed_step_index {
            if let Some(step) = receipt.steps.get(idx) {
                return Some(Self::from_step_receipt(step));
            }
        }
        if let Some(step) = receipt
            .steps
            .iter()
            .find(|s| !s.passed && s.status != StepStatus::Skipped)
        {
            return Some(Self::from_step_receipt(step));
        }
        Some(Self {
            step_name: receipt
                .failed_step_name
                .clone()
                .unwrap_or_else(|| "check".to_string()),
            cmd: fallback_cmd.to_string(),
            exit_code: receipt.exit_code,
            status: Some(if receipt.stopped {
                StepStatus::Stopped
            } else if receipt.timed_out {
                StepStatus::TimedOut
            } else if receipt.pipes_held {
                StepStatus::PipesHeld
            } else if !receipt.ran {
                StepStatus::SpawnFailed
            } else {
                StepStatus::Failed
            }),
            output: receipt.combined_output.clone(),
            tail_line: extract_diagnostic_tail(&receipt.combined_output, 1, 512),
        })
    }

    /// Build a failure context for a legacy single-command check.
    pub fn from_legacy(cmd: &str, exit_code: Option<i32>, output: &str) -> Self {
        Self {
            step_name: "check".to_string(),
            cmd: cmd.to_string(),
            exit_code,
            status: Some(StepStatus::Failed),
            output: output.to_string(),
            tail_line: extract_diagnostic_tail(output, 1, 512),
        }
    }

    /// Normalized stderr/output tail for prompt rendering and attempt history storage.
    pub fn diagnostic_tail(&self) -> String {
        let source = if self.output.trim().is_empty() {
            &self.tail_line
        } else {
            &self.output
        };
        extract_diagnostic_tail(source, MAX_TAIL_LINES, MAX_TAIL_CHARS)
    }

    /// True if this failure class can reasonably be repaired by steering the coding agent.
    pub fn is_healable_failure(&self) -> bool {
        !matches!(
            self.status,
            Some(StepStatus::Stopped | StepStatus::SpawnFailed | StepStatus::PipesHeld | StepStatus::Passed)
        )
    }
}

/// Why auto-heal stopped rather than launching another steering pass.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HealStopReason {
    OperatorStopped,
    BudgetDisabled,
    BudgetExhausted,
    NonHealableFailure,
    IdenticalErrorLoop,
}

/// Decision returned by [`evaluate_auto_heal`].
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "decision", rename_all = "kebab-case")]
pub enum HealDecision {
    Proceed {
        next_attempt: u32,
        remaining_after: u32,
        fingerprint: String,
    },
    Stop {
        reason: HealStopReason,
        message: String,
    },
}

impl HealDecision {
    pub fn should_proceed(&self) -> bool {
        matches!(self, Self::Proceed { .. })
    }
}

/// Budget and stop-flag gate for autonomous check repair.
///
/// Use [`evaluate_auto_heal`] when prior [`HealAttempt`] history is available so the
/// identical-error loop-guard is enforced as well.
pub fn should_auto_heal(attempts_used: u32, budget: u32, stop_requested: bool) -> bool {
    if stop_requested {
        return false;
    }
    let effective_budget = budget.min(MAX_AUTO_HEAL_BUDGET);
    effective_budget > 0 && attempts_used < effective_budget
}

/// Full auto-heal gate combining budget, operator stop flag, healability check, and
/// identical-error loop guard across previous attempts.
pub fn evaluate_auto_heal(
    attempts_used: u32,
    budget: u32,
    stop_requested: bool,
    previous_attempts: &[HealAttempt],
    failed_step: &FailedCheckContext,
) -> HealDecision {
    if stop_requested {
        return HealDecision::Stop {
            reason: HealStopReason::OperatorStopped,
            message: "Auto-heal halted: stop requested by operator.".to_string(),
        };
    }

    if !failed_step.is_healable_failure() {
        return HealDecision::Stop {
            reason: HealStopReason::NonHealableFailure,
            message: format!(
                "Auto-heal skipped: step '{}' ended with non-healable status ({:?}).",
                step_label(failed_step),
                failed_step.status
            ),
        };
    }

    let effective_budget = budget.min(MAX_AUTO_HEAL_BUDGET);
    if effective_budget == 0 {
        return HealDecision::Stop {
            reason: HealStopReason::BudgetDisabled,
            message: "Auto-heal disabled (auto_steer_budget = 0).".to_string(),
        };
    }

    if !should_auto_heal(attempts_used, effective_budget, false) {
        return HealDecision::Stop {
            reason: HealStopReason::BudgetExhausted,
            message: format!(
                "Auto-heal budget exhausted ({attempts_used}/{effective_budget} attempts used) — handing back to you."
            ),
        };
    }

    let tail = failed_step.diagnostic_tail();
    let fp = error_fingerprint(step_label(failed_step), failed_step.exit_code, &tail);
    let repeated = previous_attempts
        .iter()
        .any(|prev| !prev.healed && prev.fingerprint() == fp);
    if repeated {
        let code_desc = match failed_step.exit_code {
            Some(c) => format!("exit {c}"),
            None => "no exit code".to_string(),
        };
        return HealDecision::Stop {
            reason: HealStopReason::IdenticalErrorLoop,
            message: format!(
                "Auto-heal halted after attempt {attempts_used}: check step '{}' failed with the identical error ({code_desc}) — handing back to you instead of looping.",
                step_label(failed_step)
            ),
        };
    }

    let next_attempt = attempts_used.saturating_add(1);
    let remaining_after = effective_budget.saturating_sub(next_attempt);
    HealDecision::Proceed {
        next_attempt,
        remaining_after,
        fingerprint: fp,
    }
}

/// Produce a crisp, deterministic steering prompt instructing the agent how to fix
/// the failing verification step inside its existing worktree.
pub fn build_heal_prompt(
    session: &HealSessionContext,
    failed_step: &FailedCheckContext,
) -> String {
    let step_name = step_label(failed_step);
    let attempt_tag = if session.attempt > 0 && session.budget > 0 {
        format!("attempt {}/{}", session.attempt, session.budget)
    } else if session.attempt > 0 {
        format!("attempt {}", session.attempt)
    } else {
        "repair pass".to_string()
    };

    let outcome_desc = match (failed_step.status, failed_step.exit_code) {
        (Some(StepStatus::TimedOut), _) => "timed out before completing".to_string(),
        (_, Some(code)) => format!("exited with status {code}"),
        (_, None) => "failed without an exit code".to_string(),
    };

    let task_excerpt = trim_chars(session.task.trim(), MAX_TASK_ECHO_CHARS);
    let tail = failed_step.diagnostic_tail();
    let tail_block = if tail.is_empty() {
        "(the verification command produced no output)".to_string()
    } else {
        tail
    };

    let mut prompt = String::with_capacity(512 + tail_block.len());
    prompt.push_str(&format!(
        "Verification check failed ({attempt_tag}). Fix the issue in this worktree so the check passes.\n"
    ));
    if !task_excerpt.is_empty() {
        prompt.push_str(&format!("\nOriginal task: {task_excerpt}\n"));
    }
    prompt.push_str(&format!(
        "\nFailed step: {step_name}\nCommand: {}\nResult: {outcome_desc}\n",
        failed_step.cmd.trim()
    ));
    prompt.push_str("\nDiagnostic output tail:\n```\n");
    prompt.push_str(&tail_block);
    prompt.push_str("\n```\n");

    if !session.prior_attempts_summary.is_empty() {
        prompt.push_str("\nPrevious failed repair passes (try a different fix):\n");
        for item in &session.prior_attempts_summary {
            let clean = item.trim();
            if !clean.is_empty() {
                prompt.push_str(&format!("- {clean}\n"));
            }
        }
    }

    if !session.changed_files.is_empty() {
        prompt.push_str(&format!(
            "\nModified files in this worktree: {}\n",
            session.changed_files.join(", ")
        ));
    }
    let diff_trimmed = session.diff_excerpt.trim();
    if !diff_trimmed.is_empty() {
        prompt.push_str("\nCurrent diff excerpt:\n```diff\n");
        prompt.push_str(diff_trimmed);
        prompt.push_str("\n```\n");
    }

    let allowed: Vec<&str> = session
        .allowed_globs
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let forbidden: Vec<&str> = session
        .forbidden_globs
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if !allowed.is_empty() || !forbidden.is_empty() {
        prompt.push_str("\nFile-scope boundaries (enforced before Done):\n");
        if !allowed.is_empty() {
            prompt.push_str(&format!("- Allowed paths: {}\n", allowed.join(", ")));
        }
        if !forbidden.is_empty() {
            prompt.push_str(&format!("- Forbidden paths: {}\n", forbidden.join(", ")));
        }
    }

    prompt.push_str(
        "\nInstructions:\n\
         1. Diagnose and fix the root cause of the failure above.\n\
         2. Do not skip, delete, or weaken tests or checks to make them pass.\n\
         3. Re-run the failing check locally if possible to confirm exit 0 before finishing.",
    );
    prompt
}

/// Extract modified file paths and a bounded diff excerpt from unified `git diff` output
/// so auto-heal steering prompts give the agent immediate edit context without extra `git diff` calls.
pub fn extract_changed_files_and_diff_excerpt(
    diff: &str,
    max_files: usize,
    max_chars: usize,
) -> (Vec<String>, String) {
    let mut files: Vec<String> = Vec::new();
    let mut excerpt_lines: Vec<&str> = Vec::new();
    let mut chars_used = 0usize;
    let mut truncated = false;

    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            if let Some((_, b_part)) = rest.split_once(" b/") {
                let path = b_part.trim();
                if !path.is_empty()
                    && files.len() < max_files
                    && !files.iter().any(|f| f == path)
                {
                    files.push(path.to_string());
                }
            }
        }
        if !truncated && max_chars > 0 {
            let line_chars = line.chars().count() + 1;
            if chars_used + line_chars <= max_chars {
                excerpt_lines.push(line);
                chars_used += line_chars;
            } else {
                truncated = true;
            }
        }
    }

    let mut excerpt = excerpt_lines.join("\n");
    if truncated && !excerpt.is_empty() {
        excerpt.push_str("\n... (diff truncated)");
    }
    (files, excerpt)
}

/// Produce a short human-readable badge label summarizing a session's auto-heal history.
pub fn heal_badge_label(attempts: &[HealAttempt], budget: u32) -> Option<String> {
    if attempts.is_empty() {
        return None;
    }
    let denom = budget.max(attempts.len() as u32);
    if let Some(winning) = attempts.iter().rev().find(|a| a.healed) {
        return Some(format!("Healed on attempt {}/{denom}", winning.attempt));
    }
    Some(format!(
        "Auto-heal tried {}/{denom}",
        attempts.len()
    ))
}

/// Strip ANSI escape codes and extract the last `max_lines` / `max_chars` of meaningful output.
pub fn extract_diagnostic_tail(output: &str, max_lines: usize, max_chars: usize) -> String {
    if max_lines == 0 || max_chars == 0 {
        return String::new();
    }
    let clean = strip_ansi_codes(output);
    let non_empty: Vec<&str> = clean
        .lines()
        .map(|l| l.trim_end())
        .filter(|l| !l.trim().is_empty())
        .collect();
    if non_empty.is_empty() {
        return String::new();
    }
    let start = non_empty.len().saturating_sub(max_lines);
    let joined = non_empty[start..].join("\n");
    let count = joined.chars().count();
    if count <= max_chars {
        joined
    } else {
        joined.chars().skip(count - max_chars).collect()
    }
}

/// Strip CSI / OSC ANSI terminal escape sequences from command output.
pub fn strip_ansi_codes(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    for ch in chars.by_ref() {
                        if ('@'..='~').contains(&ch) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(ch) = chars.next() {
                        if ch == '\x07' {
                            break;
                        }
                        if ch == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Deterministic SHA-256 fingerprint of a failure after stripping volatile numbers
/// (durations, timestamps, hex addresses, line-local temp IDs) so identical recurring
/// errors are detected reliably even when timing changes across retries.
pub fn error_fingerprint(step_name: &str, exit_code: Option<i32>, output: &str) -> String {
    let clean = strip_ansi_codes(output);
    let normalized = normalize_volatile_tokens(&clean);
    let mut hasher = Sha256::new();
    hasher.update(step_name.trim().to_ascii_lowercase().as_bytes());
    hasher.update(b"\0");
    match exit_code {
        Some(c) => hasher.update(c.to_string().as_bytes()),
        None => hasher.update(b"none"),
    }
    hasher.update(b"\0");
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(32);
    for b in &digest[..16] {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

fn normalize_volatile_tokens(text: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.lines() {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut tokens: Vec<String> = Vec::new();
        for tok in trimmed.split_whitespace() {
            let norm = if looks_like_duration(tok) {
                "<DUR>".to_string()
            } else if looks_like_iso_timestamp(tok) {
                "<TS>".to_string()
            } else if looks_like_hex_addr(tok) {
                "<HEX>".to_string()
            } else {
                tok.to_string()
            };
            tokens.push(norm);
        }
        lines.push(tokens.join(" "));
    }
    // Keep up to the last 25 normalized lines so banner/duration noise does not dominate.
    let start = lines.len().saturating_sub(25);
    lines[start..].join("\n")
}

fn looks_like_duration(tok: &str) -> bool {
    let t = tok.trim_matches(|c: char| matches!(c, '(' | ')' | ',' | ';' | '[' | ']'));
    for suffix in ["ms", "µs", "us", "ns", "s"] {
        if let Some(num) = t.strip_suffix(suffix) {
            if !num.is_empty()
                && num.chars().all(|c| c.is_ascii_digit() || c == '.')
                && num.chars().any(|c| c.is_ascii_digit())
            {
                return true;
            }
        }
    }
    false
}

fn looks_like_iso_timestamp(tok: &str) -> bool {
    let t = tok.trim_matches(|c: char| matches!(c, '[' | ']' | '(' | ')' | ','));
    t.len() >= 19
        && t.as_bytes().get(4) == Some(&b'-')
        && t.as_bytes().get(7) == Some(&b'-')
        && matches!(t.as_bytes().get(10), Some(b'T' | b' '))
        && t.as_bytes().get(13) == Some(&b':')
}

fn looks_like_hex_addr(tok: &str) -> bool {
    let t = tok.trim_matches(|c: char| matches!(c, '(' | ')' | ',' | ';' | ':'));
    if let Some(rest) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return rest.len() >= 6 && rest.chars().all(|c| c.is_ascii_hexdigit());
    }
    false
}

fn step_label(ctx: &FailedCheckContext) -> &str {
    let s = ctx.step_name.trim();
    if s.is_empty() {
        "check"
    } else {
        s
    }
}

fn trim_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max_chars).collect();
        out.push('…');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_auto_heal_respects_budget_and_stop_flag() {
        assert!(should_auto_heal(0, 2, false));
        assert!(should_auto_heal(1, 2, false));
        assert!(!should_auto_heal(2, 2, false));
        assert!(!should_auto_heal(0, 0, false));
        assert!(!should_auto_heal(0, 3, true));
        assert!(!should_auto_heal(MAX_AUTO_HEAL_BUDGET, 999, false));
    }

    #[test]
    fn loop_guard_halts_identical_error_despite_changing_durations() {
        let prev = vec![HealAttempt {
            attempt: 1,
            trigger_step: "pytest".to_string(),
            exit_code: Some(1),
            stderr_tail: "FAILED tests/test_math.py::test_sum - AssertionError: 3 != 4\n1 failed in 0.14s".to_string(),
            prompt_sent: "fix".to_string(),
            started_ms: 1000,
            elapsed_ms: 420,
            healed: false,
        }];

        // Same error with a different timing number -> loop guard triggers!
        let same_err = FailedCheckContext {
            step_name: "pytest".to_string(),
            cmd: "pytest -q".to_string(),
            exit_code: Some(1),
            status: Some(StepStatus::Failed),
            output: "\x1b[31mFAILED tests/test_math.py::test_sum - AssertionError: 3 != 4\x1b[0m\n1 failed in 0.89s".to_string(),
            tail_line: String::new(),
        };
        let dec = evaluate_auto_heal(1, 3, false, &prev, &same_err);
        assert!(matches!(
            dec,
            HealDecision::Stop {
                reason: HealStopReason::IdenticalErrorLoop,
                ..
            }
        ));

        // Different error on retry -> allowed to proceed to attempt 2!
        let new_err = FailedCheckContext {
            step_name: "pytest".to_string(),
            cmd: "pytest -q".to_string(),
            exit_code: Some(1),
            status: Some(StepStatus::Failed),
            output: "FAILED tests/test_math.py::test_mul - AssertionError: 6 != 9".to_string(),
            tail_line: String::new(),
        };
        let dec2 = evaluate_auto_heal(1, 3, false, &prev, &new_err);
        assert!(matches!(
            dec2,
            HealDecision::Proceed {
                next_attempt: 2,
                remaining_after: 1,
                ..
            }
        ));
    }

    #[test]
    fn build_heal_prompt_is_deterministic_and_strips_ansi() {
        let session = HealSessionContext {
            session_id: "s1".to_string(),
            task: "Fix discount rounding".to_string(),
            repo: "/repos/billing".to_string(),
            branch: "fleet/s1".to_string(),
            allowed_globs: vec!["src/**".to_string()],
            forbidden_globs: vec![".env".to_string()],
            attempt: 1,
            budget: 2,
            ..Default::default()
        };
        let failed = FailedCheckContext {
            step_name: "unit-tests".to_string(),
            cmd: "cargo test".to_string(),
            exit_code: Some(101),
            status: Some(StepStatus::Failed),
            output: "\x1b[1;31merror[E0308]\x1b[0m: mismatched types at src/lib.rs:14".to_string(),
            tail_line: String::new(),
        };
        let p1 = build_heal_prompt(&session, &failed);
        let p2 = build_heal_prompt(&session, &failed);
        assert_eq!(p1, p2);
        assert!(p1.contains("attempt 1/2"));
        assert!(p1.contains("unit-tests"));
        assert!(p1.contains("cargo test"));
        assert!(p1.contains("exited with status 101"));
        assert!(p1.contains("error[E0308]: mismatched types"));
        assert!(!p1.contains("\x1b["), "ANSI codes must be stripped");
        assert!(p1.contains("Allowed paths: src/**"));
        assert!(p1.contains("Forbidden paths: .env"));
    }

    #[test]
    fn build_heal_prompt_enriches_diff_files_and_prior_attempts() {
        let diff = "\
diff --git a/src/math.rs b/src/math.rs
index 111..222 100644
--- a/src/math.rs
+++ b/src/math.rs
@@ -1,3 +1,3 @@
-pub fn add(a: i32, b: i32) -> i32 { a - b }
+pub fn add(a: i32, b: i32) -> i32 { a + b }
";
        let (files, excerpt) = extract_changed_files_and_diff_excerpt(diff, 10, 500);
        assert_eq!(files, vec!["src/math.rs"]);
        assert!(excerpt.contains("+pub fn add"));

        let session = HealSessionContext {
            session_id: "s2".to_string(),
            task: "Fix math".to_string(),
            attempt: 2,
            budget: 3,
            changed_files: files,
            diff_excerpt: excerpt,
            prior_attempts_summary: vec!["attempt 1 (unit-tests): exit 101".to_string()],
            ..Default::default()
        };
        let failed = FailedCheckContext::from_legacy("cargo test", Some(101), "expected 5 got 4");
        let prompt = build_heal_prompt(&session, &failed);
        assert!(prompt.contains("Modified files in this worktree: src/math.rs"));
        assert!(prompt.contains("Current diff excerpt:"));
        assert!(prompt.contains("Previous failed repair passes"));
        assert!(prompt.contains("attempt 1 (unit-tests): exit 101"));
    }
}
