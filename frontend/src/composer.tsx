// New Session & Batch Fan-Out / DAG Dependency Composer inside Motion Primitives MorphingDialog.
// Supports Single Task dispatch, Batch Fan-Out across repos with depends_on DAG chaining,
// Playbooks / Templates selector & Save-as-Playbook (GET/POST/DELETE /api/templates),
// multi-step check pipelines, auto-heal retry budget, and allowed/forbidden file globs.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookMarked,
  FolderGit2,
  GitBranch,
  Layers,
  ListChecks,
  Plus,
  Save,
  Shield,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import {
  Button,
  Dialog,
  Expandable,
  Input,
  Kbd,
  PopoverPanel,
  SegmentedControl,
  Textarea,
  cn,
  toast,
} from "./ui";
import {
  deletePlaybook,
  dispatchBatchSessions,
  getJson,
  isWebEngineMode,
  normalizeRepos,
  normalizeSessions,
  planGoal,
  repoBasename,
  savePlaybook,
  type Agent,
  type BatchDispatchItem,
  type CheckStepSpec,
  type PlaybookTemplate,
  type Policy,
  type RepoInfo,
  type Session,
} from "./api";

export type ComposerMode = "single" | "batch";

type StepDraft = {
  id: string;
  name: string;
  cmd: string;
  timeoutSecs: string;
};

type BatchRowDraft = {
  id: string;
  repo: string;
  project: string;
  task: string;
  agent: string;
  check: string;
  dependsOn: string[];
};

function parseGlobs(raw: string): string[] {
  return raw
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function NewSession({
  policy,
  sessions,
  playbooks,
  supportsServerV050,
  supportsServerV060,
  initialModeRef,
  initialPlaybookRef,
  openSignal,
  onHanded,
  onHandedBatch,
  onPlaybooksChanged,
  thing,
  className,
}: {
  policy: Policy | null;
  sessions: Session[];
  playbooks: PlaybookTemplate[];
  supportsServerV050: boolean;
  supportsServerV060: boolean;
  initialModeRef: React.MutableRefObject<ComposerMode>;
  initialPlaybookRef: React.MutableRefObject<PlaybookTemplate | null>;
  openSignal?: number;
  onHanded: (s: Session) => void;
  onHandedBatch: (created: Session[]) => void;
  onPlaybooksChanged: () => void;
  thing?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (openSignal && openSignal > 0) setOpen(true);
  }, [openSignal]);

  const handleClose = () => {
    setOpen(false);
    initialModeRef.current = "single";
    initialPlaybookRef.current = null;
  };

  return (
    <span className="contents">
      <Button
        ref={triggerRef}
        type="button"
        variant="primary"
        size="md"
        data-thing={thing}
        onClick={() => setOpen(true)}
        className={className}
      >
        <Plus className="size-4" strokeWidth={1.5} aria-hidden />
        <span>New session</span>
      </Button>
      <Dialog
        open={open}
        onClose={handleClose}
        title="New session or DAG batch"
        description="Launch an isolated worktree run, plan a multi-wave DAG from a plain goal, or reuse a playbook."
        maxWidth="max-w-[680px]"
        returnFocusTo={triggerRef.current}
      >
        <Composer
          policy={policy}
          sessions={sessions}
          playbooks={playbooks}
          supportsServerV050={supportsServerV050}
          supportsServerV060={supportsServerV060}
          initialModeRef={initialModeRef}
          initialPlaybookRef={initialPlaybookRef}
          onHanded={onHanded}
          onHandedBatch={onHandedBatch}
          onPlaybooksChanged={onPlaybooksChanged}
          onClose={handleClose}
        />
      </Dialog>
    </span>
  );
}

function AgentPicker({
  agents,
  value,
  onChange,
  testDefault,
  ariaLabel = "Agent",
}: {
  agents: Agent[];
  value: string;
  onChange: (v: string) => void;
  testDefault: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const items = ["", ...agents.filter((a) => a.found).map((a) => a.name)];
  const label = (v: string) => (v ? v : testDefault ? "Test script" : "Default");
  if (items.length === 1) {
    return (
      <p className="rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] px-3 py-2 text-[14px] text-[var(--ink)]">
        {label("")}
      </p>
    );
  }
  if (items.length <= 3) {
    return (
      <SegmentedControl
        label={ariaLabel}
        value={value}
        onChange={onChange}
        options={items.map((v) => ({ value: v, label: label(v) }))}
      />
    );
  }
  return (
    <PopoverPanel
      open={open}
      onClose={() => setOpen(false)}
      align="start"
      className="w-64"
      trigger={
        <Button type="button" variant="outline" onClick={() => setOpen((v) => !v)} className="w-full justify-between">
          <span>{label(value)}</span>
        </Button>
      }
    >
      <div className="space-y-1">
        {items.map((v) => (
          <Button
            key={v || "default"}
            type="button"
            variant="ghost"
            aria-pressed={value === v}
            onClick={() => {
              onChange(v);
              setOpen(false);
            }}
            className={cn("w-full justify-start", value === v && "bg-[var(--blue-soft)] text-[var(--ink)]")}
          >
            {label(v)}
          </Button>
        ))}
      </div>
    </PopoverPanel>
  );
}

function Composer({
  policy,
  sessions,
  playbooks,
  supportsServerV050,
  supportsServerV060,
  initialModeRef,
  initialPlaybookRef,
  onHanded,
  onHandedBatch,
  onPlaybooksChanged,
  onClose,
}: {
  policy: Policy | null;
  sessions: Session[];
  playbooks: PlaybookTemplate[];
  supportsServerV050: boolean;
  supportsServerV060: boolean;
  initialModeRef: React.MutableRefObject<ComposerMode>;
  initialPlaybookRef: React.MutableRefObject<PlaybookTemplate | null>;
  onHanded: (s: Session) => void;
  onHandedBatch: (created: Session[]) => void;
  onPlaybooksChanged: () => void;
  onClose: () => void;
}) {
  const [goalDraft, setGoalDraft] = useState("");
  const [planningGoal, setPlanningGoal] = useState(false);
  const webEngine = isWebEngineMode();
  const [mode, setMode] = useState<ComposerMode>(() => {
    const pre = initialPlaybookRef.current;
    if (pre && pre.tasks && pre.tasks.length > 1) return "batch";
    return initialModeRef.current;
  });
  const [repos, setRepos] = useState<RepoInfo[]>([]);

  // Single task state
  const [repo, setRepo] = useState("");
  const [project, setProject] = useState("");
  const [projectTouched, setProjectTouched] = useState(false);
  const [agent, setAgent] = useState("");
  const [task, setTask] = useState("");
  const [check, setCheck] = useState("");
  const [next, setNext] = useState("");
  const [dependsOn, setDependsOn] = useState<string[]>([]);

  // Shared multi-step checks, auto-heal budget & file-scope guardrails
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [allowedGlobsText, setAllowedGlobsText] = useState("");
  const [forbiddenGlobsText, setForbiddenGlobsText] = useState("");
  const [healBudget, setHealBudget] = useState<string>(() =>
    String(policy?.auto_steer_budget ?? 2),
  );

  // Playbook save drawer state
  const [activePlaybookId, setActivePlaybookId] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [tplName, setTplName] = useState("");
  const [tplDesc, setTplDesc] = useState("");
  const [savingTpl, setSavingTpl] = useState(false);

  // Batch fan-out rows
  const [batchRows, setBatchRows] = useState<BatchRowDraft[]>([
    { id: "row-1", repo: "", project: "", task: "", agent: "", check: "", dependsOn: [] },
    { id: "row-2", repo: "", project: "", task: "", agent: "", check: "", dependsOn: [] },
  ]);

  const [formErr, setFormErr] = useState("");
  const [repoErr, setRepoErr] = useState("");
  const [busy, setBusy] = useState(false);
  const repoRef = useRef<HTMLInputElement>(null);
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const testDefault = policy?.default_agent_engine === "custom";

  const applyPlaybook = (tpl: PlaybookTemplate, discovered: RepoInfo[] = repos, silent = false) => {
    setActivePlaybookId(tpl.id);
    setFormErr("");
    setRepoErr("");
    const fallbackRepo = tpl.repo || repo || discovered[0]?.path || "";
    const fallbackProj = repoBasename(fallbackRepo) || discovered[0]?.name || "";

    if (tpl.check_steps && tpl.check_steps.length > 0) {
      setSteps(
        tpl.check_steps.map((st, idx) => ({
          id: `tpl-step-${idx}-${Date.now()}`,
          name: st.name,
          cmd: st.cmd,
          timeoutSecs: String(st.timeout_secs ?? 300),
        })),
      );
      setCheck(tpl.check_steps[0]?.cmd || "");
    } else {
      setSteps([]);
    }
    setAllowedGlobsText((tpl.allowed_globs || []).join(", "));
    setForbiddenGlobsText((tpl.forbidden_globs || []).join(", "));
    if (typeof tpl.auto_steer_budget === "number") {
      setHealBudget(String(tpl.auto_steer_budget));
    }

    const tplTasks = tpl.tasks ?? [];
    if (tplTasks.length > 1) {
      setMode("batch");
      const keyToAlias = new Map<string, string>();
      tplTasks.forEach((t, idx) => {
        const slot = `#${idx + 1}`;
        if (t.key) keyToAlias.set(t.key, slot);
        if (t.alias) keyToAlias.set(t.alias, slot);
      });
      setBatchRows(
        tplTasks.map((t, idx) => {
          const rPath = t.repo || tpl.repo || discovered[idx % Math.max(discovered.length, 1)]?.path || fallbackRepo;
          return {
            id: `tpl-row-${idx}-${Date.now()}`,
            repo: rPath,
            project: t.project || repoBasename(rPath) || fallbackProj,
            task: t.task,
            agent: t.agent || "",
            check: t.check || tpl.check_steps?.[0]?.cmd || "",
            dependsOn: (t.depends_on || []).map((dep) => keyToAlias.get(dep) ?? dep),
          };
        }),
      );
    } else {
      setMode("single");
      const first = tplTasks[0];
      const rPath = first?.repo || tpl.repo || fallbackRepo;
      if (rPath) {
        setRepo(rPath);
        if (!projectTouched) setProject(first?.project || repoBasename(rPath));
      }
      if (first?.task) setTask(first.task);
      if (first?.check) setCheck(first.check);
      if (first?.agent) setAgent(first.agent);
    }
    if (!silent) toast.success(`Applied playbook: ${tpl.name}`);
  };

  useEffect(() => {
    let alive = true;
    getJson<unknown>("/api/repos").then((raw) => {
      if (!alive) return;
      const list = normalizeRepos(raw);
      setRepos(list);
      if (webEngine && list.length > 0) {
        setRepo((cur) => {
          if (cur) return cur;
          const first = list[0];
          setProject((p) => (p ? p : first.name));
          return first.path;
        });
      }
      if (list.length > 0) {
        setBatchRows((rows) =>
          rows.map((row, idx) => {
            if (row.repo) return row;
            const r = list[idx % list.length];
            return { ...row, repo: r.path, project: r.name };
          }),
        );
      }
      if (initialPlaybookRef.current) {
        applyPlaybook(initialPlaybookRef.current, list, true);
      }
    });
    return () => {
      alive = false;
    };
  }, [webEngine]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode === "single") {
      (webEngine ? taskRef.current : repoRef.current)?.focus();
    }
  }, [webEngine, mode]);

  const filteredRepos = useMemo(() => {
    const q = repo.trim().toLowerCase();
    if (!q) return repos.slice(0, 8);
    return repos
      .filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q))
      .slice(0, 8);
  }, [repos, repo]);

  const pickRepo = (r: RepoInfo) => {
    setRepo(r.path);
    setRepoErr("");
    if (!projectTouched) {
      setProject(r.name || repoBasename(r.path));
    }
    taskRef.current?.focus();
  };

  const onRepoChange = (val: string) => {
    setRepo(val);
    if (!projectTouched) {
      setProject(repoBasename(val));
    }
  };

  const toggleSingleDep = (id: string) => {
    setDependsOn((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const addStepRow = () => {
    setSteps((prev) => [
      ...prev,
      {
        id: `step-${Date.now()}-${prev.length}`,
        name: prev.length === 0 ? "lint" : `step-${prev.length + 1}`,
        cmd: webEngine ? "npm test" : "cargo test",
        timeoutSecs: "300",
      },
    ]);
  };

  const buildCheckSteps = (primaryCheck: string): CheckStepSpec[] => {
    const out: CheckStepSpec[] = [];
    const seen = new Set<string>();
    if (primaryCheck.trim() && steps.length === 0) {
      out.push({ name: "primary", cmd: primaryCheck.trim() });
      seen.add(primaryCheck.trim());
    }
    for (const st of steps) {
      if (!st.cmd.trim()) continue;
      const t = Number.parseInt(st.timeoutSecs, 10);
      out.push({
        name: st.name.trim() || st.cmd.trim(),
        cmd: st.cmd.trim(),
        timeout_secs: Number.isFinite(t) && t > 0 ? t : undefined,
      });
      seen.add(st.cmd.trim());
    }
    if (primaryCheck.trim() && steps.length > 0 && !seen.has(primaryCheck.trim())) {
      out.unshift({ name: "primary", cmd: primaryCheck.trim() });
    }
    return out;
  };

  const parsedHealBudget = (): number | undefined => {
    const n = Number.parseInt(healBudget.trim(), 10);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.min(n, 5);
  };

  const handleSavePlaybook = async () => {
    const cleanName = tplName.trim();
    if (!cleanName) {
      setFormErr("Give the playbook a short name before saving.");
      return;
    }
    const allowed = parseGlobs(allowedGlobsText);
    const forbidden = parseGlobs(forbiddenGlobsText);
    const checkSteps = buildCheckSteps(check);
    const tasksList =
      mode === "batch"
        ? batchRows
            .filter((r) => r.task.trim())
            .map((r, idx) => ({
              key: `#${idx + 1}`,
              alias: `#${idx + 1}`,
              repo: r.repo.trim() || undefined,
              project: r.project.trim() || undefined,
              task: r.task.trim(),
              agent: r.agent || undefined,
              check: r.check.trim() || undefined,
              depends_on: r.dependsOn.length ? r.dependsOn : undefined,
            }))
        : task.trim()
          ? [
              {
                repo: repo.trim() || undefined,
                project: derivedProject || undefined,
                task: task.trim(),
                agent: agent || undefined,
                check: check.trim() || undefined,
              },
            ]
          : [];

    setSavingTpl(true);
    const res = await savePlaybook(
      {
        name: cleanName,
        description: tplDesc.trim() || `${mode === "batch" ? "Batch" : "Single"} workflow playbook`,
        repo: repo.trim() || undefined,
        check_steps: checkSteps.length ? checkSteps : undefined,
        allowed_globs: allowed.length ? allowed : undefined,
        forbidden_globs: forbidden.length ? forbidden : undefined,
        auto_steer_budget: parsedHealBudget(),
        tasks: tasksList.length ? tasksList : undefined,
      },
      supportsServerV060,
    );
    setSavingTpl(false);
    if (res.ok) {
      toast.success(`Saved playbook: ${cleanName}`);
      setSaveOpen(false);
      setTplName("");
      setTplDesc("");
      setFormErr("");
      if (res.template) setActivePlaybookId(res.template.id);
      onPlaybooksChanged();
    } else {
      setFormErr(res.error || "Could not save playbook.");
      toast.error(res.error || "Could not save playbook.");
    }
  };

  const handleDeletePlaybook = async (tpl: PlaybookTemplate) => {
    const res = await deletePlaybook(tpl.id, supportsServerV060);
    if (res.ok) {
      toast.success(`Deleted playbook: ${tpl.name}`);
      if (activePlaybookId === tpl.id) setActivePlaybookId(null);
      onPlaybooksChanged();
    } else {
      toast.error(res.error || "Could not delete playbook.");
    }
  };

  const fanOutAllRepos = () => {
    if (repos.length === 0) return;
    const templateTask = batchRows[0]?.task || task || "";
    const templateCheck = batchRows[0]?.check || check || "";
    setBatchRows(
      repos.slice(0, 8).map((r, idx) => ({
        id: `repo-row-${idx}-${Date.now()}`,
        repo: r.path,
        project: r.name,
        task: templateTask,
        agent,
        check: templateCheck,
        dependsOn: [],
      })),
    );
  };

  const derivedProject = project.trim() || repoBasename(repo) || "default";
  const activeEngine = agent || policy?.default_agent_engine || policy?.default_agent || "default";
  const activeModel =
    activeEngine === "opencode"
      ? policy?.models?.opencode ?? policy?.model ?? null
      : activeEngine === "claude"
        ? policy?.models?.claude ?? null
        : activeEngine === "codex"
          ? policy?.models?.codex ?? null
          : null;

  const submitSingle = async () => {
    if (busy) return;
    setRepoErr("");
    setFormErr("");
    const problems: string[] = [];
    if (!repo.trim()) problems.push("Give the repo path: the folder of the git repository the agent works in.");
    if (!task.trim()) problems.push("Write the task: say what the agent should do.");
    if (problems.length) {
      setFormErr(problems.join(" "));
      (repo.trim() ? taskRef.current : repoRef.current)?.focus();
      return;
    }

    const allowed = parseGlobs(allowedGlobsText);
    const forbidden = parseGlobs(forbiddenGlobsText);
    const extraSteps = buildCheckSteps(check);
    const budget = parsedHealBudget();
    const body: Record<string, unknown> = {
      repo: repo.trim(),
      project: derivedProject,
      task: task.trim(),
      check,
    };
    if (next.trim()) body.next = next.trim();
    if (agent) body.agent = agent;
    if (dependsOn.length) body.depends_on = dependsOn;
    if (steps.length > 0 && extraSteps.length > 0) body.check_steps = extraSteps;
    if (allowed.length) body.allowed_globs = allowed;
    if (forbidden.length) body.forbidden_globs = forbidden;
    if (typeof budget === "number") body.auto_steer_budget = budget;

    setBusy(true);
    let r: Response;
    try {
      r = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      setFormErr("Could not reach the server. Your text is still here; try again when Fleet is running.");
      setBusy(false);
      return;
    }
    setBusy(false);
    if (!r.ok) {
      let msg = "Could not hand out the task.";
      try {
        msg = (await r.json()).error || msg;
      } catch {
        /* fallback */
      }
      if (/repo|folder|git/i.test(msg)) {
        setRepoErr(msg);
        repoRef.current?.focus();
      } else {
        setFormErr(msg);
      }
      return;
    }
    const raw = await r.json();
    const norm = normalizeSessions([raw])?.[0] ?? (raw as Session);
    toast.success(`Handed out: ${norm.task}`);
    onClose();
    onHanded(norm);
  };

  const runGoalPlan = async () => {
    if (!goalDraft.trim() || planningGoal) return;
    setPlanningGoal(true);
    setFormErr("");
    const targetRepo = repo.trim() || repos[0]?.path || "/workspace/ledger-kit";
    const res = await planGoal({ goal: goalDraft, repo: targetRepo, agent: agent || undefined });
    setPlanningGoal(false);
    setBatchRows(
      res.tasks.map((t, idx) => ({
        id: `plan-${idx}-${Date.now()}`,
        repo: t.repo || targetRepo,
        project: repoBasename(t.repo || targetRepo) || "default",
        task: t.task,
        agent: t.agent || "",
        check: t.check || res.check_cmd || "",
        dependsOn: t.depends_on || [],
      })),
    );
    toast.success(`Planned ${res.tasks.length} DAG ${res.tasks.length === 1 ? "task" : "tasks"}`);
  };

  const submitBatch = async () => {
    if (busy) return;
    setFormErr("");
    const nonEmpty = batchRows.filter((r) => r.repo.trim() || r.task.trim());
    if (nonEmpty.length === 0) {
      setFormErr("Add at least one task row with a repository path and task description.");
      return;
    }
    for (let i = 0; i < nonEmpty.length; i++) {
      if (!nonEmpty[i].repo.trim() || !nonEmpty[i].task.trim()) {
        setFormErr(`Batch task #${i + 1} needs both a repository path and a task description.`);
        return;
      }
    }

    const allowed = parseGlobs(allowedGlobsText);
    const forbidden = parseGlobs(forbiddenGlobsText);
    const budget = parsedHealBudget();
    const items: BatchDispatchItem[] = nonEmpty.map((row, idx) => {
      const rowSteps = steps.length > 0 ? buildCheckSteps(row.check) : undefined;
      return {
        alias: `#${idx + 1}`,
        repo: row.repo.trim(),
        project: row.project.trim() || repoBasename(row.repo) || "default",
        task: row.task.trim(),
        agent: row.agent || agent || undefined,
        check: row.check.trim() || undefined,
        check_steps: rowSteps && rowSteps.length > 0 ? rowSteps : undefined,
        depends_on: row.dependsOn.length ? row.dependsOn : undefined,
        allowed_globs: allowed.length ? allowed : undefined,
        forbidden_globs: forbidden.length ? forbidden : undefined,
        auto_steer_budget: budget,
      };
    });

    setBusy(true);
    const res = await dispatchBatchSessions(items, supportsServerV050);
    setBusy(false);

    if (res.created.length === 0) {
      setFormErr(res.errors.join(" ") || "Could not dispatch batch.");
      return;
    }
    if (res.errors.length > 0) {
      toast.warning(`Dispatched ${res.created.length}/${items.length} tasks (${res.errors.length} failed).`);
    } else {
      toast.success(`Batch dispatched ${res.created.length} ${res.created.length === 1 ? "session" : "sessions"} across worktrees.`);
    }
    onClose();
    onHandedBatch(res.created);
  };

  const upstreamCandidates = sessions.filter((s) => s.status !== "archived").slice(0, 12);

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (mode === "single") void submitSingle();
        else void submitBatch();
      }}
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-[var(--ink-2)]">
            {mode === "single"
              ? "Isolated git worktree run verified automatically by your check command."
              : `Parallel DAG fan-out across repos (up to ${policy?.max_parallel ?? 4} active slots).`}
          </p>
          <SegmentedControl
            label="Dispatch mode"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setFormErr("");
            }}
            options={[
              { value: "single", label: "Single task" },
              { value: "batch", label: "Batch fan-out" },
            ]}
          />
        </div>

        <section aria-label="Playbooks" className="space-y-2.5 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--ink)]">
              <BookMarked className="size-4 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
              <span>Playbooks</span>
            </span>
            <Button
              type="button"
              size="sm"
              variant={saveOpen ? "primary" : "outline"}
              onClick={() => setSaveOpen((v) => !v)}
            >
              <Save className="size-3.5" strokeWidth={1.5} aria-hidden />
              <span>Save as playbook</span>
            </Button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {playbooks.map((tpl) => {
              const active = activePlaybookId === tpl.id;
              return (
                <div key={tpl.id} className="inline-flex items-center gap-0.5">
                  <Button
                    type="button"
                    size="sm"
                    variant={active ? "primary" : "outline"}
                    title={tpl.description}
                    onClick={() => applyPlaybook(tpl)}
                  >
                    {tpl.name}
                  </Button>
                  {!tpl.builtin && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete playbook ${tpl.name}`}
                      onClick={() => void handleDeletePlaybook(tpl)}
                    >
                      <Trash2 className="size-3.5 text-[var(--ink-3)]" strokeWidth={1.5} aria-hidden />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>

          {saveOpen && (
            <div className="mt-2 space-y-2.5 border-t border-[var(--hairline)] pt-2.5" data-testid="save-playbook-form">
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  id="playbook-name"
                  aria-label="Playbook name"
                  value={tplName}
                  onChange={(e) => setTplName(e.target.value)}
                  placeholder="Playbook name (e.g. API Security Fix)"
                />
                <Input
                  id="playbook-desc"
                  aria-label="Playbook description"
                  value={tplDesc}
                  onChange={(e) => setTplDesc(e.target.value)}
                  placeholder="Short description (optional)"
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => setSaveOpen(false)}>
                  Cancel
                </Button>
                <Button type="button" size="sm" variant="primary" disabled={savingTpl} onClick={() => void handleSavePlaybook()}>
                  {savingTpl ? "Saving..." : "Save playbook"}
                </Button>
              </div>
            </div>
          )}
        </section>

        {mode === "single" ? (
          <>
            <Field
              id="repo"
              label="Repository"
              hint={
                repos.length > 0
                  ? "Pick a discovered git repository below or enter any local repo path."
                  : "The folder of a git repository, for example /home/you/projects/app."
              }
              err={repoErr}
            >
              <Input
                ref={repoRef}
                id="repo"
                value={repo}
                onChange={(e) => onRepoChange(e.target.value)}
                placeholder={repos[0]?.path || "/home/you/projects/app"}
                autoComplete="off"
                aria-invalid={repoErr ? true : undefined}
              />
              {filteredRepos.length > 0 && (
                <div
                  aria-label="Discovered repositories"
                  className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] p-1.5"
                >
                  {filteredRepos.map((r) => {
                    const active = repo.trim() === r.path;
                    return (
                      <button
                        key={r.path}
                        type="button"
                        onClick={() => pickRepo(r)}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-chip)] px-2.5 py-2 text-left text-[13px] transition outline-none focus-visible:outline-2 focus-visible:outline-[var(--ring)] max-md:min-h-11",
                          active ? "bg-[var(--blue-soft)] text-[var(--ink)] font-medium" : "text-[var(--ink-2)] hover:bg-[var(--surface)] hover:text-[var(--ink)]",
                        )}
                      >
                        <FolderGit2 className="size-4 shrink-0 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
                        <span className="min-w-0 flex-1 truncate font-medium text-[var(--ink)]">{r.name}</span>
                        {r.branch && (
                          <span className="shrink-0 rounded-[var(--radius-chip)] bg-[var(--track)] px-1.5 py-0.5 mono text-[12px] text-[var(--ink-2)]">
                            {r.branch}
                          </span>
                        )}
                        <span className="hidden max-w-[42%] truncate mono text-[12px] text-[var(--ink-3)] sm:inline">
                          {r.path}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </Field>

            <Field
              id="project"
              label="Project"
              hint="Derived automatically from the repository folder name. Edit if your routing rules match a custom project key."
            >
              <Input
                id="project"
                value={project}
                placeholder={repoBasename(repo) || "default"}
                onChange={(e) => {
                  setProjectTouched(true);
                  setProject(e.target.value);
                }}
                autoComplete="off"
              />
            </Field>

            <Field
              id="agent"
              label="Agent"
              hint={
                testDefault
                  ? "Default agent: custom script path. Open Engines and settings to configure CLI engines."
                  : activeModel
                    ? `Active model route for ${activeEngine}: ${activeModel}. Configure models in Engines and settings.`
                    : "Only agents available here are listed. Open Engines and settings to change default engine or model."
              }
            >
              <AgentPicker agents={policy?.agents ?? []} value={agent} onChange={setAgent} testDefault={testDefault} />
            </Field>

            <Field
              id="task"
              label="Task"
              hint="Say what the agent should change, in one or two sentences. Ctrl+Enter or Cmd+Enter hands it out."
            >
              <Textarea
                ref={taskRef}
                id="task"
                rows={3}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void submitSingle();
                  }
                }}
                aria-invalid={!task.trim() && Boolean(formErr) ? true : undefined}
              />
            </Field>

            <Field
              id="check"
              label="Check command (optional)"
              hint={
                webEngine
                  ? "Executed inside an isolated Web Worker against the branch's real files (e.g. npm test)."
                  : "Leave empty to use the project policy check. Its output becomes the receipt."
              }
            >
              <Input
                id="check"
                value={check}
                onChange={(e) => setCheck(e.target.value)}
                autoComplete="off"
                placeholder={webEngine ? "npm test" : "cargo test"}
              />
              <p className="text-[12px] text-[var(--ink-3)]">
                Example: <Kbd>{webEngine ? "npm test" : "cargo test"}</Kbd>
              </p>
            </Field>

            {upstreamCandidates.length > 0 && (
              <div className="space-y-2 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--ink)]">
                    <GitBranch className="size-3.5 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
                    <span>Depends on upstream sessions (DAG)</span>
                  </span>
                  {dependsOn.length > 0 && (
                    <span className="rounded-[var(--radius-chip)] bg-[var(--track)] px-1.5 py-0.5 mono text-[12px] text-[var(--ink-2)]">
                      {dependsOn.length} selected
                    </span>
                  )}
                </div>
                <p className="text-[12px] text-[var(--ink-3)]">
                  Waits until every selected upstream session reaches verified Done; marks Needs you if any fails.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {upstreamCandidates.map((cand) => {
                    const checked = dependsOn.includes(cand.id);
                    return (
                      <Button
                        key={cand.id}
                        type="button"
                        size="sm"
                        variant={checked ? "primary" : "outline"}
                        aria-pressed={checked}
                        onClick={() => toggleSingleDep(cand.id)}
                        className="max-w-full mono"
                      >
                        <span className="shrink-0">{cand.id}</span>
                        <span className="truncate font-sans font-normal">{cand.task.slice(0, 26)}</span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}

            <Field id="next" label="Then (optional)" hint="Starts automatically once this session is verified done.">
              <Input
                id="next"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder="The next task in the chain"
                autoComplete="off"
              />
            </Field>
          </>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--board)] p-3">
              <label htmlFor="goal-dag-input" className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--ink)]">
                <Sparkles className="size-4 text-[var(--blue)]" strokeWidth={1.5} aria-hidden />
                <span>Goal to DAG planner</span>
              </label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="goal-dag-input"
                  value={goalDraft}
                  onChange={(e) => setGoalDraft(e.target.value)}
                  placeholder="Describe a multi-step goal (separate steps with ';' or 'then')"
                  className="flex-1 min-w-[200px]"
                />
                <Button type="button" variant="secondary" size="sm" disabled={planningGoal || !goalDraft.trim()} onClick={() => void runGoalPlan()}>
                  <Sparkles className="size-3.5" strokeWidth={1.5} aria-hidden />
                  <span>{planningGoal ? "Planning..." : "Plan DAG"}</span>
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] text-[var(--ink-2)]">
                {batchRows.length} task {batchRows.length === 1 ? "row" : "rows"}, reference earlier rows as{" "}
                <span className="mono text-[var(--ink)]">#1</span>, <span className="mono text-[var(--ink)]">#2</span>.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {repos.length > 1 && (
                  <Button type="button" size="sm" variant="outline" onClick={fanOutAllRepos}>
                    <FolderGit2 className="size-3.5" strokeWidth={1.5} aria-hidden />
                    <span>Fan out {Math.min(repos.length, 8)} repos</span>
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const defaultRepo = repos[0];
                    setBatchRows((rows) => [
                      ...rows,
                      {
                        id: `row-${Date.now()}-${rows.length}`,
                        repo: defaultRepo?.path || "",
                        project: defaultRepo?.name || "",
                        task: "",
                        agent: "",
                        check: "",
                        dependsOn: [],
                      },
                    ]);
                  }}
                >
                  <Plus className="size-3.5" strokeWidth={1.5} aria-hidden />
                  <span>Add task</span>
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              {batchRows.map((row, idx) => {
                const priorRefs = Array.from({ length: idx }, (_, k) => `#${k + 1}`);
                const depChoices = [...priorRefs, ...upstreamCandidates.slice(0, 6).map((s) => s.id)];
                const toggleRowDep = (dep: string) => {
                  setBatchRows((rows) =>
                    rows.map((r) =>
                      r.id === row.id
                        ? {
                            ...r,
                            dependsOn: r.dependsOn.includes(dep)
                              ? r.dependsOn.filter((x) => x !== dep)
                              : [...r.dependsOn, dep],
                          }
                        : r,
                    ),
                  );
                };
                return (
                  <div key={row.id} className="space-y-2.5 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="rounded-[var(--radius-chip)] bg-[var(--track)] px-2 py-0.5 mono text-[12px] font-medium text-[var(--ink)]">
                        Task #{idx + 1}
                      </span>
                      {batchRows.length > 1 && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={`Remove batch task #${idx + 1}`}
                          onClick={() => setBatchRows((rows) => rows.filter((r) => r.id !== row.id))}
                        >
                          <Trash2 className="size-3.5 text-[var(--ink-3)]" strokeWidth={1.5} aria-hidden />
                        </Button>
                      )}
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label htmlFor={`batch-repo-${idx}`} className="block text-[12px] font-medium text-[var(--ink-2)]">
                          Repository path
                        </label>
                        <Input
                          id={`batch-repo-${idx}`}
                          value={row.repo}
                          placeholder={repos[0]?.path || "/workspace/ledger-kit"}
                          onChange={(e) => {
                            const val = e.target.value;
                            setBatchRows((rows) =>
                              rows.map((r) =>
                                r.id === row.id ? { ...r, repo: val, project: repoBasename(val) || r.project } : r,
                              ),
                            );
                          }}
                          className="mono text-[13px]"
                        />
                      </div>
                      <div className="space-y-1">
                        <label htmlFor={`batch-check-${idx}`} className="block text-[12px] font-medium text-[var(--ink-2)]">
                          Check command (optional)
                        </label>
                        <Input
                          id={`batch-check-${idx}`}
                          value={row.check}
                          placeholder={webEngine ? "npm test" : "cargo test"}
                          onChange={(e) => {
                            const val = e.target.value;
                            setBatchRows((rows) =>
                              rows.map((r) => (r.id === row.id ? { ...r, check: val } : r)),
                            );
                          }}
                          className="mono text-[13px]"
                        />
                      </div>
                    </div>

                    {repos.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {repos.slice(0, 5).map((r) => (
                          <Button
                            key={r.path}
                            type="button"
                            size="sm"
                            variant={row.repo === r.path ? "primary" : "outline"}
                            onClick={() =>
                              setBatchRows((rows) =>
                                rows.map((item) =>
                                  item.id === row.id ? { ...item, repo: r.path, project: r.name } : item,
                                ),
                              )
                            }
                            className="mono"
                          >
                            {r.name}
                          </Button>
                        ))}
                      </div>
                    )}

                    <div className="space-y-1">
                      <label htmlFor={`batch-task-${idx}`} className="block text-[12px] font-medium text-[var(--ink-2)]">
                        Task #{idx + 1} prompt
                      </label>
                      <Textarea
                        id={`batch-task-${idx}`}
                        rows={2}
                        value={row.task}
                        placeholder="Describe what this worktree session should build or fix"
                        onChange={(e) => {
                          const val = e.target.value;
                          setBatchRows((rows) => rows.map((r) => (r.id === row.id ? { ...r, task: val } : r)));
                        }}
                      />
                    </div>

                    {depChoices.length > 0 && (
                      <div className="space-y-1">
                        <span className="block text-[12px] text-[var(--ink-3)]">Depends on (optional DAG links):</span>
                        <div className="flex flex-wrap gap-1.5">
                          {depChoices.map((dep) => {
                            const active = row.dependsOn.includes(dep);
                            return (
                              <Button
                                key={dep}
                                type="button"
                                size="sm"
                                variant={active ? "primary" : "outline"}
                                aria-pressed={active}
                                onClick={() => toggleRowDep(dep)}
                                className="mono"
                              >
                                {dep}
                              </Button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <Expandable
          triggerLabel="Check pipeline, auto-heal & file-scope guardrails"
          openLabel="Hide check pipeline, auto-heal & guardrails"
        >
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--ink-2)]">
                  <ListChecks className="size-4 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
                  <span>Ordered check pipeline steps</span>
                </span>
                <Button type="button" size="sm" variant="outline" onClick={addStepRow}>
                  <Plus className="size-3.5" strokeWidth={1.5} aria-hidden />
                  <span>Add check step</span>
                </Button>
              </div>
              {steps.length === 0 ? (
                <p className="text-[12px] text-[var(--ink-3)]">
                  Add named pipeline stages (e.g. typecheck, lint, unit tests) to record timed per-step receipts. Stops on first failure.
                </p>
              ) : (
                <div className="space-y-2">
                  {steps.map((st, idx) => (
                    <div key={st.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_72px_auto] items-center gap-1.5">
                      <Input
                        aria-label={`Check step ${idx + 1} name`}
                        value={st.name}
                        placeholder="name"
                        onChange={(e) =>
                          setSteps((prev) =>
                            prev.map((x) => (x.id === st.id ? { ...x, name: e.target.value } : x)),
                          )
                        }
                        className="mono text-[13px]"
                      />
                      <Input
                        aria-label={`Check step ${idx + 1} command`}
                        value={st.cmd}
                        placeholder="npm test"
                        onChange={(e) =>
                          setSteps((prev) =>
                            prev.map((x) => (x.id === st.id ? { ...x, cmd: e.target.value } : x)),
                          )
                        }
                        className="mono text-[13px]"
                      />
                      <Input
                        aria-label={`Check step ${idx + 1} timeout seconds`}
                        value={st.timeoutSecs}
                        placeholder="300"
                        onChange={(e) =>
                          setSteps((prev) =>
                            prev.map((x) => (x.id === st.id ? { ...x, timeoutSecs: e.target.value } : x)),
                          )
                        }
                        className="mono text-[13px]"
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove check step ${idx + 1}`}
                        onClick={() => setSteps((prev) => prev.filter((x) => x.id !== st.id))}
                      >
                        <Trash2 className="size-3.5 text-[var(--ink-3)]" strokeWidth={1.5} aria-hidden />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2 border-t border-[var(--hairline)] pt-3">
              <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--ink-2)]">
                <Wrench className="size-3.5 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
                <span>Autonomous auto-heal budget</span>
              </span>
              <div className="flex flex-wrap items-center gap-3">
                <Input
                  id="auto-heal-budget"
                  type="number"
                  min={0}
                  max={5}
                  aria-label="Auto-heal retry budget"
                  value={healBudget}
                  onChange={(e) => setHealBudget(e.target.value)}
                  className="w-24 mono text-[13px]"
                />
                <p className="min-w-0 flex-1 text-[12px] text-[var(--ink-3)]">
                  Maximum diagnostic auto-steer attempts when a check step fails (0 disables auto-heal).
                </p>
              </div>
            </div>

            <div className="space-y-2 border-t border-[var(--hairline)] pt-3">
              <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--ink-2)]">
                <Shield className="size-3.5 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
                <span>File-scope guardrails</span>
              </span>
              <div className="grid gap-2.5 sm:grid-cols-2">
                <div className="space-y-1">
                  <label htmlFor="allowed-globs" className="block text-[12px] text-[var(--ink-2)]">
                    Allowed file globs (comma-separated)
                  </label>
                  <Input
                    id="allowed-globs"
                    value={allowedGlobsText}
                    onChange={(e) => setAllowedGlobsText(e.target.value)}
                    placeholder="src/**, tests/**"
                    className="mono text-[13px]"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="forbidden-globs" className="block text-[12px] text-[var(--ink-2)]">
                    Forbidden globs (optional)
                  </label>
                  <Input
                    id="forbidden-globs"
                    value={forbiddenGlobsText}
                    onChange={(e) => setForbiddenGlobsText(e.target.value)}
                    placeholder=".env*, Cargo.lock"
                    className="mono text-[13px]"
                  />
                </div>
              </div>
            </div>
          </div>
        </Expandable>
      </div>

      <div className="flex flex-col gap-3 border-t border-[var(--hairline)] pt-4">
        {formErr && (
          <p role="alert" className="text-[14px] text-[var(--destructive-foreground)]">
            {formErr}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {mode === "single"
              ? busy
                ? "Handing out..."
                : "Hand it out"
              : busy
                ? "Dispatching batch..."
                : `Dispatch ${batchRows.filter((r) => r.repo.trim() || r.task.trim()).length} tasks`}
          </Button>
        </div>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  hint,
  err,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  err?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium text-[var(--ink)]">
        {label}
      </label>
      {children}
      <p className="text-[12px] leading-relaxed text-[var(--ink-3)]">{hint}</p>
      {err && (
        <p role="alert" className="text-[13px] text-[var(--destructive-foreground)]">
          {err}
        </p>
      )}
    </div>
  );
}
