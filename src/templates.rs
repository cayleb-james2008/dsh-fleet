//! Reusable Playbook Templates with atomic persistence and default engineering playbooks.
//!
//! Operators can select a built-in playbook or save their own repeatable session/batch
//! workflows (check steps, file-scope guardrails, auto-heal budget, and task templates)
//! under `<data_dir>/templates.json`.

use crate::autoheal::MAX_AUTO_HEAL_BUDGET;
use crate::checks::CheckStep;
use crate::dag::{BatchSpec, BatchTaskSpec};
use serde::{Deserialize, Deserializer, Serialize};
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_NAME_CHARS: usize = 120;
const MAX_DESC_CHARS: usize = 1000;
const MAX_ID_CHARS: usize = 64;
const MAX_TASKS_PER_PLAYBOOK: usize = 64;
const MAX_GLOBS_PER_PLAYBOOK: usize = 64;
const MAX_STEPS_PER_PLAYBOOK: usize = 32;

/// One task entry inside a [`PlaybookTemplate`].
///
/// Accepts either a plain task string (`"Fix lint warnings"`) or a full structured object
/// when deserialized from JSON.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlaybookTask {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub task: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
}

impl PlaybookTask {
    pub fn simple(task: impl Into<String>) -> Self {
        Self {
            key: None,
            task: task.into(),
            depends_on: Vec::new(),
            agent: None,
            repo: None,
        }
    }

    pub fn keyed(key: impl Into<String>, task: impl Into<String>, depends_on: Vec<String>) -> Self {
        Self {
            key: Some(key.into()),
            task: task.into(),
            depends_on,
            agent: None,
            repo: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawPlaybookTask {
    Simple(String),
    Full(PlaybookTask),
}

fn deserialize_playbook_tasks<'de, D>(deserializer: D) -> Result<Vec<PlaybookTask>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw: Option<Vec<RawPlaybookTask>> = Option::deserialize(deserializer)?;
    Ok(raw
        .unwrap_or_default()
        .into_iter()
        .map(|item| match item {
            RawPlaybookTask::Simple(s) => PlaybookTask::simple(s),
            RawPlaybookTask::Full(t) => t,
        })
        .collect())
}

/// Reusable engineering playbook capturing verification steps, file-scope guardrails,
/// auto-heal budget, and task templates.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlaybookTemplate {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub check_steps: Vec<CheckStep>,
    #[serde(default)]
    pub allowed_globs: Vec<String>,
    #[serde(default)]
    pub forbidden_globs: Vec<String>,
    #[serde(default)]
    pub auto_steer_budget: u32,
    #[serde(default, deserialize_with = "deserialize_playbook_tasks")]
    pub tasks: Vec<PlaybookTask>,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

/// Request payload for creating or updating a [`PlaybookTemplate`] via `POST /api/templates`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlaybookInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub check_steps: Vec<CheckStep>,
    #[serde(default)]
    pub allowed_globs: Vec<String>,
    #[serde(default)]
    pub forbidden_globs: Vec<String>,
    #[serde(default)]
    pub auto_steer_budget: u32,
    #[serde(default, deserialize_with = "deserialize_playbook_tasks")]
    pub tasks: Vec<PlaybookTask>,
}

impl PlaybookTemplate {
    /// Convert this playbook into a [`BatchSpec`] ready for [`BatchSpec::expand`].
    pub fn to_batch_spec(&self, repo_override: Option<&str>) -> BatchSpec {
        let target_repo = repo_override
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .or_else(|| {
                let r = self.repo.trim();
                (!r.is_empty()).then_some(r)
            })
            .map(str::to_string);

        let tasks: Vec<BatchTaskSpec> = self
            .tasks
            .iter()
            .map(|t| BatchTaskSpec {
                key: t.key.clone(),
                task: t.task.clone(),
                repo: t.repo.clone(),
                project: None,
                agent: t.agent.clone(),
                model: None,
                check_cmd: None,
                check_steps: self.check_steps.clone(),
                depends_on: t.depends_on.clone(),
                allowed_globs: self.allowed_globs.clone(),
                forbidden_globs: self.forbidden_globs.clone(),
            })
            .collect();

        BatchSpec {
            name: Some(self.name.clone()),
            repo: target_repo,
            repos: Vec::new(),
            tasks,
            max_parallel: None,
            default_check: self.check_steps.first().map(|s| s.cmd.clone()),
            default_agent: None,
            allowed_globs: self.allowed_globs.clone(),
            forbidden_globs: self.forbidden_globs.clone(),
        }
    }
}

/// Four clean built-in engineering playbooks shipped with every Fleet installation.
pub fn default_templates() -> Vec<PlaybookTemplate> {
    vec![
        PlaybookTemplate {
            id: "rust-lint-test".to_string(),
            name: "Rust Lint & Test Suite".to_string(),
            description: "Run Clippy with warnings denied and execute the full Cargo test suite before marking changes done.".to_string(),
            repo: String::new(),
            check_steps: vec![
                CheckStep::with_timeout(
                    "clippy",
                    "cargo clippy --all-targets -- -D warnings",
                    300,
                ),
                CheckStep::with_timeout("test", "cargo test", 600),
            ],
            allowed_globs: vec![
                "src/**".to_string(),
                "tests/**".to_string(),
                "Cargo.toml".to_string(),
            ],
            forbidden_globs: default_secret_globs(),
            auto_steer_budget: 2,
            tasks: vec![
                PlaybookTask::keyed(
                    "implement",
                    "Implement the requested change cleanly with unit tests",
                    vec![],
                ),
                PlaybookTask::keyed(
                    "verify",
                    "Add integration coverage and verify edge cases",
                    vec!["implement".to_string()],
                ),
            ],
            builtin: true,
            created_at: 0,
            updated_at: 0,
        },
        PlaybookTemplate {
            id: "web-typecheck-build".to_string(),
            name: "Web Typecheck & Production Build".to_string(),
            description: "Verify TypeScript types and run a clean production bundle build for frontend packages.".to_string(),
            repo: String::new(),
            check_steps: vec![
                CheckStep::with_timeout("typecheck", "npx tsc --noEmit", 180),
                CheckStep::with_timeout("build", "npm run build", 300),
            ],
            allowed_globs: vec!["src/**".to_string(), "package.json".to_string()],
            forbidden_globs: default_secret_globs(),
            auto_steer_budget: 2,
            tasks: vec![
                PlaybookTask::keyed(
                    "ui-change",
                    "Update the UI components with keyboard accessibility and responsive layout",
                    vec![],
                ),
                PlaybookTask::keyed(
                    "ui-tests",
                    "Add automated verification for the updated UI flows",
                    vec!["ui-change".to_string()],
                ),
            ],
            builtin: true,
            created_at: 0,
            updated_at: 0,
        },
        PlaybookTemplate {
            id: "python-pytest-guard".to_string(),
            name: "Python Pytest & Scope Guard".to_string(),
            description: "Compile-check Python modules and run pytest with automatic repair on test failures.".to_string(),
            repo: String::new(),
            check_steps: vec![
                CheckStep::with_timeout("compile", "python3 -m compileall -q .", 60),
                CheckStep::with_timeout("pytest", "pytest -q", 300),
            ],
            allowed_globs: vec![
                "src/**".to_string(),
                "tests/**".to_string(),
                "pyproject.toml".to_string(),
            ],
            forbidden_globs: default_secret_globs(),
            auto_steer_budget: 2,
            tasks: vec![PlaybookTask::keyed(
                "implement",
                "Implement the Python module update and cover edge cases with pytest",
                vec![],
            )],
            builtin: true,
            created_at: 0,
            updated_at: 0,
        },
        PlaybookTemplate {
            id: "docs-safe-update".to_string(),
            name: "Documentation-Only Safe Update".to_string(),
            description: "Edit Markdown documentation with a strict file-scope guardrail that blocks all source code modifications.".to_string(),
            repo: String::new(),
            check_steps: vec![CheckStep::with_timeout(
                "non-empty-diff",
                "git diff --stat HEAD | grep -q .",
                30,
            )],
            allowed_globs: vec!["**/*.md".to_string(), "docs/**".to_string()],
            forbidden_globs: vec![
                "src/**".to_string(),
                "tests/**".to_string(),
                ".env".to_string(),
                ".env.*".to_string(),
            ],
            auto_steer_budget: 1,
            tasks: vec![PlaybookTask::keyed(
                "docs",
                "Update README and user guides to match current behavior",
                vec![],
            )],
            builtin: true,
            created_at: 0,
            updated_at: 0,
        },
    ]
}

fn default_secret_globs() -> Vec<String> {
    vec![
        ".env".to_string(),
        ".env.*".to_string(),
        "**/*.pem".to_string(),
        "**/*.key".to_string(),
    ]
}

#[derive(Serialize, Deserialize)]
struct PersistedTemplatesFile {
    version: u32,
    templates: Vec<PlaybookTemplate>,
}

/// Atomic file-backed playbook template store (`<data_dir>/templates.json`).
#[derive(Clone, Debug)]
pub struct TemplateStore {
    data_dir: PathBuf,
    templates: Vec<PlaybookTemplate>,
}

impl TemplateStore {
    /// Load persisted playbooks from `<data_dir>/templates.json`, seeding the 4 default
    /// engineering templates on a fresh data directory.
    pub fn load(data_dir: impl Into<PathBuf>) -> Self {
        let data_dir = data_dir.into();
        let path = data_dir.join("templates.json");
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(parsed) = serde_json::from_str::<PersistedTemplatesFile>(&text) {
                return Self {
                    data_dir,
                    templates: parsed.templates,
                };
            }
            if let Ok(raw_list) = serde_json::from_str::<Vec<PlaybookTemplate>>(&text) {
                return Self {
                    data_dir,
                    templates: raw_list,
                };
            }
            // Keep corrupt file aside as evidence rather than silently overwriting it.
            let aside = data_dir.join(format!("templates.json.corrupt-{}", now_secs()));
            let _ = std::fs::rename(&path, &aside);
        }
        Self {
            data_dir,
            templates: default_templates(),
        }
    }

    /// Return all templates currently in the store.
    pub fn list(&self) -> Vec<PlaybookTemplate> {
        self.templates.clone()
    }

    /// Find one template by ID.
    pub fn get(&self, id: &str) -> Option<PlaybookTemplate> {
        self.templates.iter().find(|t| t.id == id).cloned()
    }

    /// Create or update a playbook template and persist atomically to disk.
    pub fn upsert(&mut self, input: PlaybookInput) -> Result<PlaybookTemplate, String> {
        let validated = validate_playbook_input(input, &self.templates)?;
        let ts = now_secs();
        let saved = if let Some(existing) = self.templates.iter_mut().find(|t| t.id == validated.id)
        {
            existing.name = validated.name;
            existing.description = validated.description;
            existing.repo = validated.repo;
            existing.check_steps = validated.check_steps;
            existing.allowed_globs = validated.allowed_globs;
            existing.forbidden_globs = validated.forbidden_globs;
            existing.auto_steer_budget = validated.auto_steer_budget;
            existing.tasks = validated.tasks;
            existing.builtin = false;
            existing.updated_at = ts;
            existing.clone()
        } else {
            let mut created = validated;
            created.builtin = false;
            created.created_at = ts;
            created.updated_at = ts;
            self.templates.push(created.clone());
            created
        };
        self.save()?;
        Ok(saved)
    }

    /// Delete a template by ID and persist atomically.
    pub fn delete(&mut self, id: &str) -> Result<PlaybookTemplate, String> {
        let trimmed = id.trim();
        let Some(pos) = self.templates.iter().position(|t| t.id == trimmed) else {
            return Err("no such playbook template".to_string());
        };
        let removed = self.templates.remove(pos);
        self.save()?;
        Ok(removed)
    }

    /// Restore the 4 built-in default engineering templates (preserving custom playbooks).
    pub fn restore_defaults(&mut self) -> Result<(), String> {
        for def in default_templates() {
            if !self.templates.iter().any(|t| t.id == def.id) {
                self.templates.push(def);
            }
        }
        self.save()
    }

    /// Atomically write `<data_dir>/templates.json` via temp file + `sync_all` + rename.
    pub fn save(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.data_dir)
            .map_err(|e| format!("could not create template data dir: {e}"))?;
        let payload = PersistedTemplatesFile {
            version: 1,
            templates: self.templates.clone(),
        };
        let json = serde_json::to_string_pretty(&payload)
            .map_err(|e| format!("could not serialize playbook templates: {e}"))?;

        static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SAVE_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp = self.data_dir.join(format!(
            "templates.json.tmp.{}-{seq}",
            std::process::id()
        ));
        let dst = self.data_dir.join("templates.json");
        {
            let mut f = File::create(&tmp)
                .map_err(|e| format!("could not create temp template file: {e}"))?;
            f.write_all(json.as_bytes())
                .map_err(|e| format!("could not write temp template file: {e}"))?;
            let _ = f.sync_all();
        }
        std::fs::rename(&tmp, &dst)
            .map_err(|e| format!("could not finalize templates.json: {e}"))?;
        Ok(())
    }
}

fn validate_playbook_input(
    input: PlaybookInput,
    existing: &[PlaybookTemplate],
) -> Result<PlaybookTemplate, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("playbook name is required".to_string());
    }
    if name.contains('\0') || name.chars().count() > MAX_NAME_CHARS {
        return Err(format!(
            "playbook name must be at most {MAX_NAME_CHARS} characters with no NUL bytes"
        ));
    }

    let description = input.description.trim().to_string();
    if description.contains('\0') || description.chars().count() > MAX_DESC_CHARS {
        return Err(format!(
            "playbook description must be at most {MAX_DESC_CHARS} characters with no NUL bytes"
        ));
    }

    let repo = input.repo.trim().to_string();
    if repo.contains('\0') {
        return Err("playbook repo path contains a NUL byte".to_string());
    }

    if input.check_steps.len() > MAX_STEPS_PER_PLAYBOOK {
        return Err(format!(
            "playbook may define at most {MAX_STEPS_PER_PLAYBOOK} check steps"
        ));
    }
    for step in &input.check_steps {
        step.validate()?;
    }

    let allowed_globs = clean_globs(input.allowed_globs, "allowed_globs")?;
    let forbidden_globs = clean_globs(input.forbidden_globs, "forbidden_globs")?;

    if input.tasks.len() > MAX_TASKS_PER_PLAYBOOK {
        return Err(format!(
            "playbook may contain at most {MAX_TASKS_PER_PLAYBOOK} tasks"
        ));
    }
    let mut tasks = Vec::with_capacity(input.tasks.len());
    for (idx, mut t) in input.tasks.into_iter().enumerate() {
        t.task = t.task.trim().to_string();
        if t.task.is_empty() || t.task.contains('\0') {
            return Err(format!(
                "playbook task #{} must be non-empty and contain no NUL bytes",
                idx + 1
            ));
        }
        t.key = t
            .key
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty());
        t.depends_on = t
            .depends_on
            .into_iter()
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .collect();
        tasks.push(t);
    }

    let id = match input.id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw_id) => sanitize_explicit_id(raw_id)?,
        None => mint_unique_slug(&name, existing),
    };

    Ok(PlaybookTemplate {
        id,
        name,
        description,
        repo,
        check_steps: input.check_steps,
        allowed_globs,
        forbidden_globs,
        auto_steer_budget: input.auto_steer_budget.min(MAX_AUTO_HEAL_BUDGET),
        tasks,
        builtin: false,
        created_at: 0,
        updated_at: 0,
    })
}

fn clean_globs(globs: Vec<String>, field: &str) -> Result<Vec<String>, String> {
    if globs.len() > MAX_GLOBS_PER_PLAYBOOK {
        return Err(format!(
            "playbook {field} may contain at most {MAX_GLOBS_PER_PLAYBOOK} patterns"
        ));
    }
    let mut out = Vec::with_capacity(globs.len());
    for g in globs {
        let trimmed = g.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.contains('\0') {
            return Err(format!("playbook {field} contains a NUL byte"));
        }
        if !out.contains(&trimmed) {
            out.push(trimmed);
        }
    }
    Ok(out)
}

fn sanitize_explicit_id(raw: &str) -> Result<String, String> {
    if raw.len() > MAX_ID_CHARS {
        return Err(format!("playbook id must be at most {MAX_ID_CHARS} characters"));
    }
    if !raw
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        || !raw
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
    {
        return Err(
            "playbook id must start with an ASCII letter or digit and contain only letters, digits, '-' or '_'"
                .to_string(),
        );
    }
    Ok(raw.to_ascii_lowercase())
}

fn mint_unique_slug(name: &str, existing: &[PlaybookTemplate]) -> String {
    let mut base = String::new();
    let mut prev_dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            base.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !base.is_empty() {
            base.push('-');
            prev_dash = true;
        }
        if base.len() >= 48 {
            break;
        }
    }
    let base = base.trim_matches('-').to_string();
    let base = if base.is_empty() {
        "playbook".to_string()
    } else {
        base
    };
    if !existing.iter().any(|t| t.id == base) {
        return base;
    }
    for n in 2..=9999 {
        let cand = format!("{base}-{n}");
        if !existing.iter().any(|t| t.id == cand) {
            return cand;
        }
    }
    format!("{base}-{}", now_secs())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_contain_four_clean_engineering_playbooks_with_zero_internal_jargon() {
        let defs = default_templates();
        assert_eq!(defs.len(), 4);
        let serialized = serde_json::to_string(&defs).unwrap().to_lowercase();
        assert!(
            !serialized.contains("rune"),
            "playbooks must not leak internal 'Rune' wording: {serialized}"
        );
        for t in &defs {
            assert!(!t.id.is_empty());
            assert!(!t.name.is_empty());
            assert!(!t.check_steps.is_empty());
            assert!(t.builtin);
        }
    }

    #[test]
    fn template_store_persists_crud_atomically_and_accepts_string_or_object_tasks() {
        let dir = std::env::temp_dir().join(format!(
            "fleet-templates-unit-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);

        let mut store = TemplateStore::load(&dir);
        assert_eq!(store.list().len(), 4);

        let input: PlaybookInput = serde_json::from_value(serde_json::json!({
            "name": "API Smoke Check",
            "description": "Fast smoke verification for HTTP API repos",
            "repo": "/repos/api",
            "check_steps": [{ "name": "smoke", "cmd": "pytest tests/smoke.py", "timeout_secs": 120 }],
            "allowed_globs": ["src/**"],
            "forbidden_globs": [".env"],
            "auto_steer_budget": 3,
            "tasks": ["Add health endpoint", { "key": "docs", "task": "Document endpoint", "depends_on": [] }]
        }))
        .unwrap();

        let created = store.upsert(input).unwrap();
        assert_eq!(created.id, "api-smoke-check");
        assert_eq!(created.tasks.len(), 2);
        assert_eq!(created.tasks[0].task, "Add health endpoint");
        assert_eq!(created.tasks[1].key.as_deref(), Some("docs"));

        // Reload fresh from disk.
        let reloaded = TemplateStore::load(&dir);
        assert_eq!(reloaded.list().len(), 5);
        assert_eq!(reloaded.get("api-smoke-check").unwrap().auto_steer_budget, 3);

        // Delete persists across reload.
        let mut store2 = reloaded;
        store2.delete("api-smoke-check").unwrap();
        let reloaded2 = TemplateStore::load(&dir);
        assert_eq!(reloaded2.list().len(), 4);
        assert!(reloaded2.get("api-smoke-check").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
