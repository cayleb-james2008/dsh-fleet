//! Rich Policy Rules Evaluator for `fleet`.
//!
//! Executes `policies.rn` inside the Rune VM to drive:
//! - Parallel concurrency caps (`max_parallel`)
//! - Repo / path / task / engine routing (`route_engine`, `route_model`, `agent_model`)
//! - Per-task timeout enforcement (`timeout_for`, `timeout_secs`)
//! - Automatic retry & steering budgets (`auto_retry_budget`, `auto_steer_budget`)
//! - Default verification commands and multi-step check pipelines (`default_check`, `check_steps`)
//! - Default file-scope guardrails (`allowed_globs`, `forbidden_globs`)
//! - Live dry-run evaluation via [`Policy::test_policy`] / [`test_policy`] / [`test_policy_script`]
//!
//! 100% backwards-compatible with v0.4.0 policy scripts that only define `max_parallel()`
//! and `default_check(project)`.

use crate::checks::{CheckStep, FileScope};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;

/// Default agent/check timeout in seconds when `timeout_secs()` is omitted.
pub const DEFAULT_TIMEOUT_SECS: u64 = 1800;
/// Maximum timeout a policy may set (one week).
pub const MAX_TIMEOUT_SECS: u64 = 604_800;
/// Default auto-retry budget when `auto_retry_budget` is omitted.
pub const DEFAULT_AUTO_RETRY_BUDGET: u32 = 0;
/// Hard ceiling on automatic retries per session.
pub const MAX_AUTO_RETRY_BUDGET: u32 = 10;
/// Default auto-steer budget when `auto_steer_budget` is omitted.
pub const DEFAULT_AUTO_STEER_BUDGET: u32 = 3;
/// Hard ceiling on automatic steering turns per session.
pub const MAX_AUTO_STEER_BUDGET: u32 = 10;
/// Default free OpenCode model route.
pub const DEFAULT_FREE_MODEL: &str = "opencode/deepseek-v4.1-flash-free";
/// Maximum input string length passed into Rune policy hooks during dry-run evaluation.
const MAX_POLICY_INPUT_BYTES: usize = 16 * 1024;

/// Compiled Rune policy loaded from `policies.rn`.
#[derive(Clone)]
pub struct Policy {
    unit: Arc<rune::Unit>,
    runtime: Arc<rune::runtime::RuntimeContext>,
    pub max_parallel: i64,
    pub timeout_secs: u64,
    pub model: Option<String>,
    pub default_auto_retry_budget: u32,
    pub default_auto_steer_budget: u32,
}

/// Request payload for `POST /api/policies/test`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PolicyTestRequest {
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub task: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// Optional candidate Rune script to dry-run instead of the active policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
}

/// Complete live routing and guardrail decision produced by [`Policy::test_policy`].
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PolicyDecision {
    pub repo: String,
    pub project: String,
    pub task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_engine: Option<String>,
    pub engine: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub check_cmd: String,
    pub check_steps: Vec<CheckStep>,
    pub timeout_secs: u64,
    pub max_parallel: i64,
    pub auto_retry_budget: u32,
    pub auto_steer_budget: u32,
    pub allowed_globs: Vec<String>,
    pub forbidden_globs: Vec<String>,
    pub trace: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Runtime enforcement helper for per-session automatic retry and steering budgets.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PolicyBudget {
    pub max_auto_retries: u32,
    pub used_auto_retries: u32,
    pub max_auto_steers: u32,
    pub used_auto_steers: u32,
}

impl PolicyBudget {
    pub fn from_decision(decision: &PolicyDecision) -> Self {
        Self {
            max_auto_retries: decision.auto_retry_budget,
            used_auto_retries: 0,
            max_auto_steers: decision.auto_steer_budget,
            used_auto_steers: 0,
        }
    }

    pub fn can_auto_retry(&self) -> bool {
        self.used_auto_retries < self.max_auto_retries
    }

    pub fn remaining_auto_retries(&self) -> u32 {
        self.max_auto_retries.saturating_sub(self.used_auto_retries)
    }

    pub fn consume_auto_retry(&mut self) -> Result<u32, String> {
        if !self.can_auto_retry() {
            return Err(format!(
                "auto-retry budget exhausted ({}/{})",
                self.used_auto_retries, self.max_auto_retries
            ));
        }
        self.used_auto_retries += 1;
        Ok(self.remaining_auto_retries())
    }

    pub fn can_auto_steer(&self) -> bool {
        self.used_auto_steers < self.max_auto_steers
    }

    pub fn remaining_auto_steers(&self) -> u32 {
        self.max_auto_steers.saturating_sub(self.used_auto_steers)
    }

    pub fn consume_auto_steer(&mut self) -> Result<u32, String> {
        if !self.can_auto_steer() {
            return Err(format!(
                "auto-steer budget exhausted ({}/{})",
                self.used_auto_steers, self.max_auto_steers
            ));
        }
        self.used_auto_steers += 1;
        Ok(self.remaining_auto_steers())
    }
}

/// Derive a clean project name from a repo path or bare project name.
pub fn derive_project_name(repo: &str) -> String {
    let trimmed = repo.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return "default".to_string();
    }
    Path::new(trimmed)
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("default")
        .to_string()
}

/// Normalize a requested engine label. Preserves known engines and executable paths.
fn normalize_engine_arg(engine: Option<&str>) -> String {
    match engine.map(str::trim) {
        Some(e) if !e.is_empty() => {
            if e.contains('/') {
                e.to_string()
            } else {
                match e.to_ascii_lowercase().as_str() {
                    "auto" => String::new(),
                    other => other.to_string(),
                }
            }
        }
        _ => String::new(),
    }
}

fn sanitize_policy_input(raw: &str, field: &str, warnings: &mut Vec<String>) -> String {
    let cleaned = raw.replace('\0', "");
    if cleaned.len() != raw.len() {
        warnings.push(format!("stripped NUL bytes from {field}"));
    }
    let trimmed = cleaned.trim();
    if trimmed.len() <= MAX_POLICY_INPUT_BYTES {
        return trimmed.to_string();
    }
    warnings.push(format!(
        "truncated {field} to {MAX_POLICY_INPUT_BYTES} bytes for policy evaluation"
    ));
    let mut end = MAX_POLICY_INPUT_BYTES;
    while end > 0 && !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    trimmed[..end].to_string()
}

fn is_missing_fn_error(err: &rune::runtime::VmError) -> bool {
    let msg = err.to_string();
    msg.contains("missing entry") || msg.contains("Missing entry") || msg.contains("not found")
}

impl Policy {
    /// Compile and initialize a Rune policy script.
    pub fn load(script: &str) -> Result<Policy, String> {
        let context = rune::Context::with_default_modules().map_err(|e| e.to_string())?;
        let runtime = Arc::new(context.runtime().map_err(|e| e.to_string())?);
        let mut sources = rune::Sources::new();
        sources
            .insert(rune::Source::memory(script).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let mut diagnostics = rune::Diagnostics::new();
        let unit = match rune::prepare(&mut sources)
            .with_context(&context)
            .with_diagnostics(&mut diagnostics)
            .build()
        {
            Ok(u) => u,
            Err(e) => {
                let mut detail = rune::termcolor::Buffer::no_color();
                let _ = diagnostics.emit(&mut detail, &sources);
                let text = String::from_utf8_lossy(detail.as_slice())
                    .trim()
                    .to_string();
                return if text.is_empty() {
                    Err(format!("policy script failed to build: {e}"))
                } else {
                    Err(format!("policy script failed to build: {e}\n{text}"))
                };
            }
        };
        let unit = Arc::new(unit);

        let mut policy = Policy {
            unit,
            runtime,
            max_parallel: 1,
            timeout_secs: DEFAULT_TIMEOUT_SECS,
            model: None,
            default_auto_retry_budget: DEFAULT_AUTO_RETRY_BUDGET,
            default_auto_steer_budget: DEFAULT_AUTO_STEER_BUDGET,
        };

        if let Some(Ok(m)) = policy.call_optional_string("agent_model", ()) {
            let trimmed = m.trim();
            if !trimmed.is_empty() {
                policy.model = Some(trimmed.to_string());
            }
        }

        policy.max_parallel = policy.call_i64("max_parallel", ())?;
        if policy.max_parallel < 1 {
            policy.max_parallel = 1;
        }

        if let Some(Ok(secs)) = policy.call_optional_i64("timeout_secs", ()) {
            if secs > 0 {
                policy.timeout_secs = (secs as u64).min(MAX_TIMEOUT_SECS);
            }
        }

        if let Some(Ok(retries)) =
            policy.call_optional_i64("auto_retry_budget", ("".to_string(), "".to_string(), "opencode".to_string()))
        {
            policy.default_auto_retry_budget =
                retries.clamp(0, i64::from(MAX_AUTO_RETRY_BUDGET)) as u32;
        }

        if let Some(Ok(steers)) =
            policy.call_optional_i64("auto_steer_budget", ("".to_string(), "".to_string(), "opencode".to_string()))
        {
            policy.default_auto_steer_budget =
                steers.clamp(0, i64::from(MAX_AUTO_STEER_BUDGET)) as u32;
        }

        Ok(policy)
    }

    fn vm(&self) -> rune::Vm {
        rune::Vm::new(self.runtime.clone(), self.unit.clone())
    }

    fn call_i64<A>(&self, name: &str, args: A) -> Result<i64, String>
    where
        A: rune::runtime::Args + rune::runtime::GuardedArgs,
    {
        let value = self
            .vm()
            .call([name], args)
            .map_err(|e| format!("policy call {name} failed: {e}"))?;
        rune::from_value::<i64>(value)
            .map_err(|e| format!("policy {name} returned non-integer: {e}"))
    }

    fn call_optional_i64<A>(&self, name: &str, args: A) -> Option<Result<i64, String>>
    where
        A: rune::runtime::Args + rune::runtime::GuardedArgs,
    {
        match self.vm().call([name], args) {
            Ok(value) => Some(
                rune::from_value::<i64>(value)
                    .map_err(|e| format!("policy {name} returned non-integer: {e}")),
            ),
            Err(e) if is_missing_fn_error(&e) => None,
            Err(e) => Some(Err(format!("policy call {name} failed: {e}"))),
        }
    }

    fn call_optional_string<A>(&self, name: &str, args: A) -> Option<Result<String, String>>
    where
        A: rune::runtime::Args + rune::runtime::GuardedArgs,
    {
        match self.vm().call([name], args) {
            Ok(value) => Some(
                rune::from_value::<String>(value)
                    .map_err(|e| format!("policy {name} returned non-string: {e}")),
            ),
            Err(e) if is_missing_fn_error(&e) => None,
            Err(e) => Some(Err(format!("policy call {name} failed: {e}"))),
        }
    }

    fn call_optional_string_vec<A>(&self, name: &str, args: A) -> Option<Result<Vec<String>, String>>
    where
        A: rune::runtime::Args + rune::runtime::GuardedArgs,
    {
        match self.vm().call([name], args) {
            Ok(value) => Some(
                rune::from_value::<Vec<String>>(value)
                    .map_err(|e| format!("policy {name} returned non-string-list: {e}")),
            ),
            Err(e) if is_missing_fn_error(&e) => None,
            Err(e) => Some(Err(format!("policy call {name} failed: {e}"))),
        }
    }

    /// Evaluate the required `default_check(project)` policy function.
    pub fn default_check(&self, project: &str) -> Result<String, String> {
        let value = self
            .vm()
            .call(["default_check"], (project.to_string(),))
            .map_err(|e| format!("policy call default_check failed: {e}"))?;
        rune::from_value::<String>(value)
            .map_err(|e| format!("policy default_check returned non-string: {e}"))
    }

    /// Resolve which CLI engine (`opencode`, `claude`, `codex`, or custom path) handles this task.
    pub fn route_engine(&self, repo: &str, task: &str, requested_engine: Option<&str>) -> String {
        let mut warnings = Vec::new();
        let (engine, _) = self.route_engine_traced(repo, task, requested_engine, &mut warnings);
        engine
    }

    fn route_engine_traced(
        &self,
        repo: &str,
        task: &str,
        requested_engine: Option<&str>,
        warnings: &mut Vec<String>,
    ) -> (String, String) {
        let req = normalize_engine_arg(requested_engine);
        // Custom executable path is passed through verbatim (fixture/test mode).
        if req.contains('/') {
            return (
                req.clone(),
                format!("engine: explicit custom executable '{req}'"),
            );
        }
        match self.call_optional_string(
            "route_engine",
            (repo.to_string(), task.to_string(), req.clone()),
        ) {
            Some(Ok(routed)) => {
                let trimmed = routed.trim().to_ascii_lowercase();
                if matches!(trimmed.as_str(), "opencode" | "claude" | "codex") {
                    let trace = if req.is_empty() {
                        format!("engine: routed to '{trimmed}' by policies.rn::route_engine")
                    } else if trimmed == req {
                        format!("engine: honored requested '{trimmed}' via policies.rn::route_engine")
                    } else {
                        format!(
                            "engine: policies.rn::route_engine overrode '{req}' -> '{trimmed}'"
                        )
                    };
                    (trimmed, trace)
                } else if trimmed.is_empty() {
                    let fallback = if !req.is_empty() {
                        req
                    } else {
                        "opencode".to_string()
                    };
                    (
                        fallback.clone(),
                        format!("engine: route_engine returned empty, fell back to '{fallback}'"),
                    )
                } else {
                    warnings.push(format!(
                        "route_engine returned unknown engine '{trimmed}', falling back to 'opencode'"
                    ));
                    (
                        "opencode".to_string(),
                        "engine: fell back to 'opencode' after unrecognized engine name"
                            .to_string(),
                    )
                }
            }
            Some(Err(e)) => {
                warnings.push(e);
                let fallback = if matches!(req.as_str(), "opencode" | "claude" | "codex") {
                    req
                } else {
                    "opencode".to_string()
                };
                (
                    fallback.clone(),
                    format!("engine: fallback '{fallback}' (route_engine error)"),
                )
            }
            None => {
                let fallback = if !req.is_empty() {
                    req
                } else {
                    "opencode".to_string()
                };
                (
                    fallback.clone(),
                    format!("engine: default '{fallback}' (route_engine not defined)"),
                )
            }
        }
    }

    /// Resolve model route for `(repo, task, engine)`.
    /// Preserves default free model `opencode/deepseek-v4.1-flash-free` for OpenCode when `agent_model()` is set.
    pub fn route_model(&self, repo: &str, task: &str, engine: &str) -> Option<String> {
        let mut warnings = Vec::new();
        let (model, _) = self.route_model_traced(repo, task, engine, &mut warnings);
        model
    }

    fn route_model_traced(
        &self,
        repo: &str,
        task: &str,
        engine: &str,
        warnings: &mut Vec<String>,
    ) -> (Option<String>, String) {
        if engine.contains('/') {
            return (
                None,
                "model: none (custom executable handles its own model)".to_string(),
            );
        }
        match self.call_optional_string(
            "route_model",
            (repo.to_string(), task.to_string(), engine.to_string()),
        ) {
            Some(Ok(m)) => {
                let trimmed = m.trim().to_string();
                if !trimmed.is_empty() {
                    (
                        Some(trimmed.clone()),
                        format!("model: '{trimmed}' from policies.rn::route_model"),
                    )
                } else if engine == "opencode" {
                    let fallback = self.model.clone();
                    let note = match &fallback {
                        Some(fm) => format!("model: '{fm}' from policies.rn::agent_model"),
                        None => "model: engine default".to_string(),
                    };
                    (fallback, note)
                } else {
                    (None, format!("model: {engine} engine default"))
                }
            }
            Some(Err(e)) => {
                warnings.push(e);
                let fallback = if engine == "opencode" {
                    self.model.clone()
                } else {
                    None
                };
                (fallback, "model: fallback after route_model error".to_string())
            }
            None => {
                if engine == "opencode" {
                    let fallback = self.model.clone();
                    let note = match &fallback {
                        Some(fm) => format!("model: '{fm}' from policies.rn::agent_model"),
                        None => "model: engine default".to_string(),
                    };
                    (fallback, note)
                } else {
                    (None, format!("model: {engine} engine default"))
                }
            }
        }
    }

    /// Resolve execution timeout (seconds) for `(repo, task, engine)`, safely clamped.
    pub fn timeout_for(&self, repo: &str, task: &str, engine: &str) -> u64 {
        let mut warnings = Vec::new();
        let (secs, _) = self.timeout_for_traced(repo, task, engine, &mut warnings);
        secs
    }

    fn timeout_for_traced(
        &self,
        repo: &str,
        task: &str,
        engine: &str,
        warnings: &mut Vec<String>,
    ) -> (u64, String) {
        match self.call_optional_i64(
            "timeout_for",
            (repo.to_string(), task.to_string(), engine.to_string()),
        ) {
            Some(Ok(secs)) if secs > 0 => {
                let clamped = (secs as u64).min(MAX_TIMEOUT_SECS);
                (
                    clamped,
                    format!("timeout: {clamped}s from policies.rn::timeout_for"),
                )
            }
            Some(Ok(bad)) => {
                warnings.push(format!(
                    "timeout_for returned non-positive {bad}; using policy default {}s",
                    self.timeout_secs
                ));
                (
                    self.timeout_secs,
                    format!("timeout: {}s (policy default)", self.timeout_secs),
                )
            }
            Some(Err(e)) => {
                warnings.push(e);
                (
                    self.timeout_secs,
                    format!("timeout: {}s (fallback after timeout_for error)", self.timeout_secs),
                )
            }
            None => (
                self.timeout_secs,
                format!("timeout: {}s from policies.rn::timeout_secs", self.timeout_secs),
            ),
        }
    }

    /// Resolve max automatic retries on check failure for `(repo, task, engine)`.
    pub fn auto_retry_budget(&self, repo: &str, task: &str, engine: &str) -> u32 {
        let mut warnings = Vec::new();
        self.auto_retry_budget_traced(repo, task, engine, &mut warnings)
    }

    fn auto_retry_budget_traced(
        &self,
        repo: &str,
        task: &str,
        engine: &str,
        warnings: &mut Vec<String>,
    ) -> u32 {
        match self.call_optional_i64(
            "auto_retry_budget",
            (repo.to_string(), task.to_string(), engine.to_string()),
        ) {
            Some(Ok(v)) => v.clamp(0, i64::from(MAX_AUTO_RETRY_BUDGET)) as u32,
            Some(Err(e)) => {
                warnings.push(e);
                self.default_auto_retry_budget
            }
            None => self.default_auto_retry_budget,
        }
    }

    /// Resolve max automatic steering turns for `(repo, task, engine)`.
    pub fn auto_steer_budget(&self, repo: &str, task: &str, engine: &str) -> u32 {
        let mut warnings = Vec::new();
        self.auto_steer_budget_traced(repo, task, engine, &mut warnings)
    }

    fn auto_steer_budget_traced(
        &self,
        repo: &str,
        task: &str,
        engine: &str,
        warnings: &mut Vec<String>,
    ) -> u32 {
        match self.call_optional_i64(
            "auto_steer_budget",
            (repo.to_string(), task.to_string(), engine.to_string()),
        ) {
            Some(Ok(v)) => v.clamp(0, i64::from(MAX_AUTO_STEER_BUDGET)) as u32,
            Some(Err(e)) => {
                warnings.push(e);
                self.default_auto_steer_budget
            }
            None => self.default_auto_steer_budget,
        }
    }

    /// Resolve default file-scope guardrails (`allowed_globs`, `forbidden_globs`) for `(repo, task)`.
    pub fn file_scope_for(&self, repo: &str, task: &str) -> FileScope {
        let mut warnings = Vec::new();
        self.file_scope_traced(repo, task, &mut warnings)
    }

    fn file_scope_traced(&self, repo: &str, task: &str, warnings: &mut Vec<String>) -> FileScope {
        let allowed = match self.call_optional_string_vec(
            "allowed_globs",
            (repo.to_string(), task.to_string()),
        ) {
            Some(Ok(v)) => v,
            Some(Err(e)) => {
                warnings.push(e);
                Vec::new()
            }
            None => Vec::new(),
        };
        let forbidden = match self.call_optional_string_vec(
            "forbidden_globs",
            (repo.to_string(), task.to_string()),
        ) {
            Some(Ok(v)) => v,
            Some(Err(e)) => {
                warnings.push(e);
                Vec::new()
            }
            None => Vec::new(),
        };
        FileScope::new(allowed, forbidden)
    }

    /// Resolve ordered check steps for `(project, repo)`.
    ///
    /// Optional Rune hook `check_steps(project, repo)` returns strings formatted as either
    /// `"name::cmd"` or plain `"cmd"`. When omitted or empty, wraps `default_check(project)`.
    pub fn check_steps_for(&self, project: &str, repo: &str, timeout_secs: u64) -> Vec<CheckStep> {
        let mut warnings = Vec::new();
        let (_, steps) = self.check_steps_traced(project, repo, timeout_secs, &mut warnings);
        steps
    }

    fn check_steps_traced(
        &self,
        project: &str,
        repo: &str,
        timeout_secs: u64,
        warnings: &mut Vec<String>,
    ) -> (String, Vec<CheckStep>) {
        let default_cmd = match self.default_check(project) {
            Ok(c) if !c.trim().is_empty() => c.trim().to_string(),
            Ok(_) => "cargo test".to_string(),
            Err(e) => {
                warnings.push(e);
                "cargo test".to_string()
            }
        };

        let raw_steps = match self.call_optional_string_vec(
            "check_steps",
            (project.to_string(), repo.to_string()),
        ) {
            Some(Ok(list)) => list,
            Some(Err(e)) => {
                warnings.push(e);
                Vec::new()
            }
            None => Vec::new(),
        };

        let mut parsed_steps = Vec::new();
        for (idx, item) in raw_steps.into_iter().enumerate() {
            let trimmed = item.trim();
            if trimmed.is_empty() {
                continue;
            }
            let (name, cmd) = match trimmed.split_once("::") {
                Some((n, c)) if !c.trim().is_empty() => {
                    let step_name = if n.trim().is_empty() {
                        format!("step-{}", idx + 1)
                    } else {
                        n.trim().to_string()
                    };
                    (step_name, c.trim().to_string())
                }
                _ => (format!("step-{}", idx + 1), trimmed.to_string()),
            };
            parsed_steps.push(CheckStep::with_timeout(name, cmd, timeout_secs));
        }

        if parsed_steps.is_empty() {
            parsed_steps.push(CheckStep::with_timeout(
                "check",
                default_cmd.clone(),
                timeout_secs,
            ));
        }

        (default_cmd, parsed_steps)
    }

    /// Live dry-run policy evaluation for `(repo, task, engine)`.
    ///
    /// Safe against fuzz/untrusted inputs: sanitizes NUL bytes, bounds length, and never panics.
    pub fn test_policy(&self, repo: &str, task: &str, engine: Option<&str>) -> PolicyDecision {
        let mut warnings = Vec::new();
        let clean_repo = sanitize_policy_input(repo, "repo", &mut warnings);
        let clean_task = sanitize_policy_input(task, "task", &mut warnings);
        let clean_req_engine = engine.map(|e| sanitize_policy_input(e, "engine", &mut warnings));
        let clean_req_ref = clean_req_engine
            .as_deref()
            .filter(|s| !s.is_empty());
        let project = derive_project_name(&clean_repo);

        let (resolved_engine, engine_trace) =
            self.route_engine_traced(&clean_repo, &clean_task, clean_req_ref, &mut warnings);
        let (resolved_model, model_trace) =
            self.route_model_traced(&clean_repo, &clean_task, &resolved_engine, &mut warnings);
        let (timeout_secs, timeout_trace) =
            self.timeout_for_traced(&clean_repo, &clean_task, &resolved_engine, &mut warnings);
        let auto_retry_budget =
            self.auto_retry_budget_traced(&clean_repo, &clean_task, &resolved_engine, &mut warnings);
        let auto_steer_budget =
            self.auto_steer_budget_traced(&clean_repo, &clean_task, &resolved_engine, &mut warnings);
        let scope = self.file_scope_traced(&clean_repo, &clean_task, &mut warnings);
        let (check_cmd, check_steps) =
            self.check_steps_traced(&project, &clean_repo, timeout_secs, &mut warnings);

        let mut trace = vec![
            engine_trace,
            model_trace,
            timeout_trace,
            format!(
                "budgets: auto_retry={auto_retry_budget}, auto_steer={auto_steer_budget}, max_parallel={}",
                self.max_parallel
            ),
            format!("check: project='{project}' -> '{check_cmd}' ({} step(s))", check_steps.len()),
        ];
        if !scope.allowed_globs.is_empty() || !scope.forbidden_globs.is_empty() {
            trace.push(format!(
                "file-scope: {} allowed glob(s), {} forbidden glob(s)",
                scope.allowed_globs.len(),
                scope.forbidden_globs.len()
            ));
        }

        PolicyDecision {
            repo: clean_repo,
            project,
            task: clean_task,
            requested_engine: clean_req_ref.map(str::to_string),
            engine: resolved_engine,
            model: resolved_model,
            check_cmd,
            check_steps,
            timeout_secs,
            max_parallel: self.max_parallel,
            auto_retry_budget,
            auto_steer_budget,
            allowed_globs: scope.allowed_globs,
            forbidden_globs: scope.forbidden_globs,
            trace,
            warnings,
        }
    }
}

/// Top-level convenience wrapper for live dry-run policy testing.
pub fn test_policy(
    policy: &Policy,
    repo: &str,
    task: &str,
    engine: Option<&str>,
) -> PolicyDecision {
    policy.test_policy(repo, task, engine)
}

/// Compile and dry-run an arbitrary Rune policy script in memory without mutating disk state.
pub fn test_policy_script(
    script: &str,
    repo: &str,
    task: &str,
    engine: Option<&str>,
) -> Result<PolicyDecision, String> {
    let policy = Policy::load(script)?;
    Ok(policy.test_policy(repo, task, engine))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHIPPED_POLICY: &str = include_str!("../policies.rn");

    #[test]
    fn shipped_policy_routes_engines_models_timeouts_and_budgets() {
        let policy = Policy::load(SHIPPED_POLICY).unwrap();
        assert_eq!(policy.max_parallel, 4);
        assert_eq!(policy.timeout_secs, 1800);
        assert_eq!(policy.model.as_deref(), Some(DEFAULT_FREE_MODEL));
        assert_eq!(policy.default_check("fixture").unwrap(), "test -s output.txt");
        assert_eq!(policy.default_check("anything-else").unwrap(), "cargo test");

        // Default task routes to opencode with the free DeepSeek model.
        let general = policy.test_policy("/home/dev/my-crate", "add unit tests", None);
        assert_eq!(general.engine, "opencode");
        assert_eq!(general.model.as_deref(), Some(DEFAULT_FREE_MODEL));
        assert_eq!(general.timeout_secs, 1800);
        assert_eq!(general.auto_retry_budget, 2);
        assert_eq!(general.auto_steer_budget, 3);
        assert!(general.forbidden_globs.iter().any(|g| g == ".env"));

        // Security audit routes to claude.
        let sec = policy.test_policy("/home/dev/api", "security audit of auth flow", None);
        assert_eq!(sec.engine, "claude");
        assert_eq!(sec.model.as_deref(), Some("claude-sonnet-4-5"));

        // Migration/benchmark task routes to codex with higher timeout and zero auto-retry on migration.
        let mig = policy.test_policy("/home/dev/db", "run schema migration script", None);
        assert_eq!(mig.engine, "codex");
        assert_eq!(mig.timeout_secs, 3600);
        assert_eq!(mig.auto_retry_budget, 0);

        // Explicit engine override is honored.
        let explicit = policy.test_policy("/home/dev/api", "security audit", Some("opencode"));
        assert_eq!(explicit.engine, "opencode");
        assert_eq!(explicit.model.as_deref(), Some(DEFAULT_FREE_MODEL));
    }

    #[test]
    fn legacy_minimal_policy_still_loads_and_evaluates_cleanly() {
        let minimal = r#"
            pub fn max_parallel() { 2 }
            pub fn default_check(project) { "true" }
        "#;
        let decision = test_policy_script(minimal, "/tmp/demo", "fix bug", None).unwrap();
        assert_eq!(decision.max_parallel, 2);
        assert_eq!(decision.timeout_secs, DEFAULT_TIMEOUT_SECS);
        assert_eq!(decision.engine, "opencode");
        assert_eq!(decision.model, None);
        assert_eq!(decision.check_cmd, "true");
        assert!(decision.warnings.is_empty(), "{:?}", decision.warnings);
    }

    #[test]
    fn budget_tracker_enforces_retry_and_steer_limits() {
        let mut budget = PolicyBudget {
            max_auto_retries: 2,
            used_auto_retries: 0,
            max_auto_steers: 1,
            used_auto_steers: 0,
        };
        assert!(budget.can_auto_retry());
        assert_eq!(budget.consume_auto_retry().unwrap(), 1);
        assert_eq!(budget.consume_auto_retry().unwrap(), 0);
        assert!(!budget.can_auto_retry());
        assert!(budget.consume_auto_retry().is_err());

        assert_eq!(budget.consume_auto_steer().unwrap(), 0);
        assert!(budget.consume_auto_steer().is_err());
    }
}
