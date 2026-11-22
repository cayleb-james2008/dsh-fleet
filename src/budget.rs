//! Session & Daily Dispatch Budget Guardrails for `fleet-rs`.
//!
//! Prevents runaway daily session dispatch loops, unbounded run durations, and excessive
//! autonomous repair attempts via [`BudgetConfig`], [`BudgetStatus`], and the atomically
//! persisted [`BudgetTracker`].

use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Default single-session runtime cap in minutes.
pub const DEFAULT_MAX_SESSION_MINS: u32 = 30;
/// Hard ceiling for single-session runtime cap (7 days = 10,080 minutes).
pub const MAX_ALLOWED_SESSION_MINS: u32 = 10_080;
/// Default maximum new sessions permitted per UTC day (`0` = unlimited).
pub const DEFAULT_DAILY_SESSION_LIMIT: u32 = 100;
/// Hard ceiling for configured daily session limit.
pub const MAX_ALLOWED_DAILY_SESSIONS: u32 = 100_000;
/// Default maximum autonomous auto-heal attempts per session.
pub const DEFAULT_MAX_HEAL_ATTEMPTS: u32 = 3;
/// Hard ceiling for autonomous auto-heal attempts per session.
pub const MAX_ALLOWED_HEAL_ATTEMPTS: u32 = 10;

fn default_max_session_mins() -> u32 {
    DEFAULT_MAX_SESSION_MINS
}
fn default_daily_session_limit() -> u32 {
    DEFAULT_DAILY_SESSION_LIMIT
}
fn default_max_heal_attempts() -> u32 {
    DEFAULT_MAX_HEAL_ATTEMPTS
}

/// Operator-configurable resource and runaway-loop guardrails.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BudgetConfig {
    /// Maximum runtime in minutes for any single session run (`0` = inherit policy timeout).
    #[serde(default = "default_max_session_mins")]
    pub max_session_mins: u32,
    /// Maximum new sessions allowed per UTC day (`0` = unlimited).
    #[serde(default = "default_daily_session_limit")]
    pub daily_session_limit: u32,
    /// Maximum autonomous auto-heal repair attempts per session (`0` = disabled).
    #[serde(default = "default_max_heal_attempts")]
    pub max_heal_attempts: u32,
}

impl Default for BudgetConfig {
    fn default() -> Self {
        Self {
            max_session_mins: DEFAULT_MAX_SESSION_MINS,
            daily_session_limit: DEFAULT_DAILY_SESSION_LIMIT,
            max_heal_attempts: DEFAULT_MAX_HEAL_ATTEMPTS,
        }
    }
}

impl BudgetConfig {
    /// Validate a candidate configuration strictly (used on `POST /api/config` mutations).
    pub fn validate(&self) -> Result<(), String> {
        if self.max_session_mins > MAX_ALLOWED_SESSION_MINS {
            return Err(format!(
                "max_session_mins must be between 0 and {MAX_ALLOWED_SESSION_MINS}"
            ));
        }
        if self.daily_session_limit > MAX_ALLOWED_DAILY_SESSIONS {
            return Err(format!(
                "daily_session_limit must be between 0 and {MAX_ALLOWED_DAILY_SESSIONS}"
            ));
        }
        if self.max_heal_attempts > MAX_ALLOWED_HEAL_ATTEMPTS {
            return Err(format!(
                "max_heal_attempts must be between 0 and {MAX_ALLOWED_HEAL_ATTEMPTS}"
            ));
        }
        Ok(())
    }

    /// Return a safely clamped copy (used when loading persisted state).
    pub fn sanitized(&self) -> Self {
        Self {
            max_session_mins: self.max_session_mins.min(MAX_ALLOWED_SESSION_MINS),
            daily_session_limit: self.daily_session_limit.min(MAX_ALLOWED_DAILY_SESSIONS),
            max_heal_attempts: self.max_heal_attempts.min(MAX_ALLOWED_HEAL_ATTEMPTS),
        }
    }

    /// Parse and validate an incoming JSON patch object (`POST /api/config`), rejecting
    /// negative, fractional, non-integer, or out-of-range values with clear 400 errors.
    pub fn apply_json_patch(
        &self,
        obj: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<Self, String> {
        let mut next = self.sanitized();
        if let Some(val) = obj.get("max_session_mins") {
            next.max_session_mins = parse_bounded_u32(
                val,
                "max_session_mins",
                0,
                MAX_ALLOWED_SESSION_MINS,
                DEFAULT_MAX_SESSION_MINS,
            )?;
        }
        if let Some(val) = obj.get("daily_session_limit") {
            next.daily_session_limit = parse_bounded_u32(
                val,
                "daily_session_limit",
                0,
                MAX_ALLOWED_DAILY_SESSIONS,
                DEFAULT_DAILY_SESSION_LIMIT,
            )?;
        }
        if let Some(val) = obj.get("max_heal_attempts") {
            next.max_heal_attempts = parse_bounded_u32(
                val,
                "max_heal_attempts",
                0,
                MAX_ALLOWED_HEAL_ATTEMPTS,
                DEFAULT_MAX_HEAL_ATTEMPTS,
            )?;
        }
        next.validate()?;
        Ok(next)
    }

    /// Compute effective run timeout in seconds, clamping `policy_timeout_secs` by `max_session_mins`.
    pub fn effective_timeout_secs(&self, policy_timeout_secs: u64) -> u64 {
        let base = policy_timeout_secs.clamp(1, u64::from(MAX_ALLOWED_SESSION_MINS) * 60);
        if self.max_session_mins == 0 {
            base
        } else {
            let cap_secs = u64::from(self.max_session_mins.min(MAX_ALLOWED_SESSION_MINS)) * 60;
            base.min(cap_secs).max(1)
        }
    }

    /// Clamp a session/policy auto-heal budget by `max_heal_attempts`.
    pub fn effective_heal_budget(&self, requested_budget: u32) -> u32 {
        requested_budget
            .min(self.max_heal_attempts)
            .min(MAX_ALLOWED_HEAL_ATTEMPTS)
    }
}

fn parse_bounded_u32(
    val: &serde_json::Value,
    field: &str,
    min: u32,
    max: u32,
    default_on_null: u32,
) -> Result<u32, String> {
    match val {
        serde_json::Value::Null => Ok(default_on_null),
        serde_json::Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                if u < u64::from(min) || u > u64::from(max) {
                    return Err(format!("{field} must be between {min} and {max}"));
                }
                Ok(u as u32)
            } else {
                Err(format!(
                    "{field} must be a non-negative whole integer between {min} and {max}"
                ))
            }
        }
        _ => Err(format!(
            "{field} must be a non-negative integer between {min} and {max}"
        )),
    }
}

/// Live budget utilization snapshot exposed in `GET /api/metrics` and `GET /api/config`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BudgetStatus {
    pub max_session_mins: u32,
    pub daily_session_limit: u32,
    pub max_heal_attempts: u32,
    /// UTC calendar day (`YYYY-MM-DD`) the daily counter applies to.
    pub day_utc: String,
    pub sessions_today: u32,
    /// Remaining dispatches allowed today (`None` when `daily_session_limit == 0` unlimited).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_today: Option<u32>,
    pub daily_limit_reached: bool,
    /// Percentage of the daily limit consumed (`0..=100`, or `0` when unlimited).
    pub usage_pct: u32,
    pub total_heal_attempts_today: u32,
    /// Unix timestamp (seconds) of next UTC midnight reset.
    pub resets_at_unix: u64,
}

/// Structured HTTP 429 refusal returned when a dispatch would exceed the daily budget.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BudgetError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub budget: Box<BudgetStatus>,
}

/// Pure evaluation of [`BudgetStatus`] at a given UTC timestamp.
pub fn evaluate_budget(
    config: &BudgetConfig,
    sessions_today: u32,
    total_heal_attempts_today: u32,
    now_unix_secs: u64,
) -> BudgetStatus {
    let cfg = config.sanitized();
    let day_utc = utc_day_string(now_unix_secs);
    let resets_at_unix = ((now_unix_secs / 86_400) + 1).saturating_mul(86_400);

    let (remaining_today, daily_limit_reached, usage_pct) = if cfg.daily_session_limit == 0 {
        (None, false, 0)
    } else {
        let rem = cfg.daily_session_limit.saturating_sub(sessions_today);
        let pct = ((u64::from(sessions_today) * 100) / u64::from(cfg.daily_session_limit))
            .min(100) as u32;
        (Some(rem), sessions_today >= cfg.daily_session_limit, pct)
    };

    BudgetStatus {
        max_session_mins: cfg.max_session_mins,
        daily_session_limit: cfg.daily_session_limit,
        max_heal_attempts: cfg.max_heal_attempts,
        day_utc,
        sessions_today,
        remaining_today,
        daily_limit_reached,
        usage_pct,
        total_heal_attempts_today,
        resets_at_unix,
    }
}

/// Check whether `requested_count` new sessions may be dispatched under `config`.
///
/// Rejects atomically with HTTP `429` if `sessions_today + requested_count > daily_session_limit`.
pub fn check_dispatch_allowance(
    config: &BudgetConfig,
    sessions_today: u32,
    requested_count: u32,
    total_heal_attempts_today: u32,
    now_unix_secs: u64,
) -> Result<BudgetStatus, BudgetError> {
    let cfg = config.sanitized();
    let status = evaluate_budget(&cfg, sessions_today, total_heal_attempts_today, now_unix_secs);
    if cfg.daily_session_limit == 0 || requested_count == 0 {
        return Ok(status);
    }
    let projected = sessions_today.saturating_add(requested_count);
    if projected > cfg.daily_session_limit {
        let rem = cfg.daily_session_limit.saturating_sub(sessions_today);
        let message = if requested_count == 1 {
            format!(
                "Daily session budget reached ({sessions_today}/{} sessions used on {} UTC). Raise daily_session_limit in Engines and settings or wait until UTC midnight reset.",
                cfg.daily_session_limit, status.day_utc
            )
        } else {
            format!(
                "Batch of {requested_count} sessions exceeds remaining daily budget ({rem} remaining of {} on {} UTC). Reduce batch size or raise daily_session_limit in Engines and settings.",
                cfg.daily_session_limit, status.day_utc
            )
        };
        return Err(BudgetError {
            status: 429,
            code: "daily-budget-exceeded".to_string(),
            message,
            budget: Box::new(status),
        });
    }
    Ok(status)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct PersistedBudgetState {
    day_utc: String,
    sessions_today: u32,
    total_heal_attempts_today: u32,
}

/// Atomic file-backed daily budget tracker (`<data_dir>/budget.json`) with automatic
/// UTC midnight rollover.
#[derive(Clone, Debug)]
pub struct BudgetTracker {
    data_dir: PathBuf,
    day_utc: String,
    sessions_today: u32,
    total_heal_attempts_today: u32,
}

impl BudgetTracker {
    /// Load persisted daily counters from `<data_dir>/budget.json`, resetting cleanly if the
    /// stored day has rolled past UTC midnight or the file does not exist yet.
    pub fn load(data_dir: impl Into<PathBuf>) -> Self {
        Self::load_at(data_dir, now_unix_secs())
    }

    pub fn load_at(data_dir: impl Into<PathBuf>, now_unix: u64) -> Self {
        let data_dir = data_dir.into();
        let today = utc_day_string(now_unix);
        let path = data_dir.join("budget.json");
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(state) = serde_json::from_str::<PersistedBudgetState>(&text) {
                if state.day_utc == today {
                    return Self {
                        data_dir,
                        day_utc: state.day_utc,
                        sessions_today: state.sessions_today,
                        total_heal_attempts_today: state.total_heal_attempts_today,
                    };
                }
            }
        }
        Self {
            data_dir,
            day_utc: today,
            sessions_today: 0,
            total_heal_attempts_today: 0,
        }
    }

    fn rollover_if_needed(&mut self, now_unix: u64) {
        let today = utc_day_string(now_unix);
        if self.day_utc != today {
            self.day_utc = today;
            self.sessions_today = 0;
            self.total_heal_attempts_today = 0;
        }
    }

    /// Current live [`BudgetStatus`] using wall-clock UTC time.
    pub fn status(&self, config: &BudgetConfig) -> BudgetStatus {
        self.status_at(config, now_unix_secs())
    }

    /// Pure status snapshot evaluated at `now_unix` (handles day rollover read-only).
    pub fn status_at(&self, config: &BudgetConfig, now_unix: u64) -> BudgetStatus {
        let today = utc_day_string(now_unix);
        let (sessions_today, heals_today) = if self.day_utc == today {
            (self.sessions_today, self.total_heal_attempts_today)
        } else {
            (0, 0)
        };
        evaluate_budget(config, sessions_today, heals_today, now_unix)
    }

    /// Check daily allowance and atomically reserve `count` session dispatches.
    ///
    /// On refusal returns HTTP `429` [`BudgetError`] without mutating counters or disk.
    pub fn try_reserve_sessions(
        &mut self,
        config: &BudgetConfig,
        count: u32,
    ) -> Result<BudgetStatus, BudgetError> {
        self.try_reserve_sessions_at(config, count, now_unix_secs())
    }

    pub fn try_reserve_sessions_at(
        &mut self,
        config: &BudgetConfig,
        count: u32,
        now_unix: u64,
    ) -> Result<BudgetStatus, BudgetError> {
        self.rollover_if_needed(now_unix);
        check_dispatch_allowance(
            config,
            self.sessions_today,
            count,
            self.total_heal_attempts_today,
            now_unix,
        )?;
        self.sessions_today = self.sessions_today.saturating_add(count);
        let _ = self.save();
        Ok(evaluate_budget(
            config,
            self.sessions_today,
            self.total_heal_attempts_today,
            now_unix,
        ))
    }

    /// Record one executed auto-heal attempt against today's counter and persist.
    pub fn record_heal_attempt(&mut self) {
        self.record_heal_attempt_at(now_unix_secs());
    }

    pub fn record_heal_attempt_at(&mut self, now_unix: u64) {
        self.rollover_if_needed(now_unix);
        self.total_heal_attempts_today = self.total_heal_attempts_today.saturating_add(1);
        let _ = self.save();
    }

    /// Atomically persist `<data_dir>/budget.json`.
    pub fn save(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.data_dir)
            .map_err(|e| format!("could not create budget data dir: {e}"))?;
        let state = PersistedBudgetState {
            day_utc: self.day_utc.clone(),
            sessions_today: self.sessions_today,
            total_heal_attempts_today: self.total_heal_attempts_today,
        };
        let json = serde_json::to_string_pretty(&state)
            .map_err(|e| format!("could not serialize budget state: {e}"))?;
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp = self
            .data_dir
            .join(format!("budget.json.tmp.{}-{seq}", std::process::id()));
        let dst = self.data_dir.join("budget.json");
        {
            let mut f = File::create(&tmp)
                .map_err(|e| format!("could not create temp budget file: {e}"))?;
            f.write_all(json.as_bytes())
                .map_err(|e| format!("could not write temp budget file: {e}"))?;
            let _ = f.sync_all();
        }
        std::fs::rename(&tmp, &dst)
            .map_err(|e| format!("could not finalize budget.json: {e}"))?;
        Ok(())
    }
}

/// Convert Unix epoch seconds into `YYYY-MM-DD` UTC calendar date (zero external crates).
pub fn utc_day_string(unix_secs: u64) -> String {
    let z = (unix_secs / 86_400) as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}")
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_day_string_handles_epoch_leap_year_and_modern_dates() {
        assert_eq!(utc_day_string(0), "1970-01-01");
        assert_eq!(utc_day_string(1_709_164_800), "2024-02-29");
        assert_eq!(utc_day_string(1_709_251_200), "2024-03-01");
        assert_eq!(utc_day_string(1_795_305_600), "2026-11-22");
    }

    #[test]
    fn budget_patch_rejects_negative_fractional_and_overflow_inputs() {
        let base = BudgetConfig::default();
        for bad in [
            serde_json::json!({ "daily_session_limit": -1 }),
            serde_json::json!({ "daily_session_limit": 1.5 }),
            serde_json::json!({ "daily_session_limit": "50" }),
            serde_json::json!({ "daily_session_limit": 999_999_999u64 }),
            serde_json::json!({ "max_session_mins": 99_999 }),
            serde_json::json!({ "max_heal_attempts": 11 }),
        ] {
            let obj = bad.as_object().unwrap();
            assert!(base.apply_json_patch(obj).is_err(), "expected error for {bad}");
        }

        let good = serde_json::json!({
            "max_session_mins": 45,
            "daily_session_limit": 25,
            "max_heal_attempts": 2
        });
        let updated = base.apply_json_patch(good.as_object().unwrap()).unwrap();
        assert_eq!(updated.max_session_mins, 45);
        assert_eq!(updated.daily_session_limit, 25);
        assert_eq!(updated.max_heal_attempts, 2);
        assert_eq!(updated.effective_timeout_secs(3600), 2700);
        assert_eq!(updated.effective_heal_budget(5), 2);
    }
}
