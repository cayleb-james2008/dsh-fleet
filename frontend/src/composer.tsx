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
  Trash2,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  MorphingDialog,
  MorphingDialogClose,
  MorphingDialogContainer,
  MorphingDialogContent,
  MorphingDialogDescription,
  MorphingDialogTitle,
  MorphingDialogTrigger,
} from "@/components/ui/morphing-dialog";
import { Expandable, ExpandableContent, ExpandableTrigger } from "@/components/ui/expandable";
import { glide } from "@/motion";
import { cn } from "@/lib/utils";
import {
  deletePlaybook,
  dispatchBatchSessions,
  getJson,
  isWebEngineMode,
  normalizeRepos,
  normalizeSessions,
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
import { toast } from "sonner";

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
  onHanded: (s: Session) => void;
  onHandedBatch: (created: Session[]) => void;
  onPlaybooksChanged: () => void;
  thing?: string;
  className?: string;
}) {
  const wrap = useRef<HTMLSpanElement>(null);
  const returnFocus = () => wrap.current?.querySelector<HTMLElement>("button")?.focus();
  return (
    <span ref={wrap} className="contents">
      <MorphingDialog transition={glide}>
        <MorphingDialogTrigger
          thing={thing}
          className={cn(
            "inline-flex h-9 cursor-pointer items-center gap-2 whitespace-nowrap rounded-control bg-blue px-3.5 text-sm font-medium text-blue-fg outline-none transition-colors duration-(--dur-press) ease-(--ease-house) hover:bg-blue-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface max-md:min-h-11",
            className,
          )}
        >
          <Plus className="size-4" strokeWidth={1.5} aria-hidden />
          <span>New session</span>
        </MorphingDialogTrigger>
        <MorphingDialogContainer>
          <MorphingDialogContent className="relative flex max-h-[calc(100dvh-32px)] w-full max-w-[660px] flex-col overflow-hidden rounded-dialog border border-hairline bg-surface text-ink">
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
              onClosed={() => {
                initialModeRef.current = "single";
                initialPlaybookRef.current = null;
                returnFocus();
              }}
            />
          </MorphingDialogContent>
        </MorphingDialogContainer>
      </MorphingDialog>
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
  const items = ["", ...agents.filter((a) => a.found).map((a) => a.name)];
  const label = (v: string) => (v ? v : testDefault ? "Test script" : "Default");
  if (items.length === 1) {
    return <p className="rounded-control border border-hairline bg-canvas px-3 py-2 text-sm text-ink">{label("")}</p>;
  }
  if (items.length <= 3) {
    return (
      <SegmentedControl aria-label={ariaLabel} size="sm">
        {items.map((v) => (
          <SegmentedControlItem
            key={v || "default"}
            aria-pressed={value === v}
            data-checked={value === v ? "" : undefined}
            onClick={() => onChange(v)}
            className="max-md:!min-h-11"
          >
            {label(v)}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    );
  }
  return (
    <Popover>
      <PopoverTrigger className="inline-flex h-9 w-full cursor-pointer items-center justify-between rounded-control border border-input bg-canvas px-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11">
        {label(value)}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 rounded-control border border-hairline bg-surface p-1 text-ink">
        {items.map((v) => (
          <Button
            key={v || "default"}
            type="button"
            variant="ghost"
            aria-pressed={value === v}
            onClick={() => onChange(v)}
            className={cn("h-9 w-full justify-start px-2.5 text-sm max-md:min-h-11", value === v && "font-medium")}
          >
            {label(v)}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
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
  onClosed,
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
  onClosed: () => void;
}) {
  useEffect(() => () => onClosed(), []); // eslint-disable-line react-hooks/exhaustive-deps
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
    document.querySelector<HTMLButtonElement>(".new-cancel")?.click();
    onHanded(norm);
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
    document.querySelector<HTMLButtonElement>(".new-cancel")?.click();
    onHandedBatch(res.created);
  };

  const upstreamCandidates = sessions.filter((s) => s.status !== "archived").slice(0, 12);

  return (
    <form
      className="flex min-h-0 flex-col"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (mode === "single") void submitSingle();
        else void submitBatch();
      }}
    >
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <MorphingDialogTitle className="font-heading text-xl font-medium text-ink">
              {mode === "single" ? "New session" : "Batch fan-out dispatch"}
            </MorphingDialogTitle>
            <MorphingDialogDescription className="mt-1 text-sm leading-relaxed text-ink-2">
              {mode === "single"
                ? "Fleet runs the agent in its own git worktree of this repo. When the agent stops, Fleet runs your check. The session is done only when that check passes."
                : `Fan out parallel tasks across one or multiple repos (up to ${policy?.max_parallel ?? 4} concurrent slots) and link depends_on DAG stages.`}
            </MorphingDialogDescription>
          </div>
          <SegmentedControl aria-label="Dispatch mode" size="sm">
            <SegmentedControlItem
              aria-pressed={mode === "single"}
              data-checked={mode === "single" ? "" : undefined}
              onClick={() => {
                setMode("single");
                setFormErr("");
              }}
              className="text-xs max-md:!min-h-11"
            >
              Single task
            </SegmentedControlItem>
            <SegmentedControlItem
              aria-pressed={mode === "batch"}
              data-checked={mode === "batch" ? "" : undefined}
              onClick={() => {
                setMode("batch");
                setFormErr("");
              }}
              className="gap-1 text-xs max-md:!min-h-11"
            >
              <Layers className="size-3.5" strokeWidth={1.5} aria-hidden />
              <span>Batch fan-out</span>
            </SegmentedControlItem>
          </SegmentedControl>
        </div>

        <section aria-label="Playbooks" className="space-y-2 rounded-card border border-hairline bg-canvas p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink">
              <BookMarked className="size-3.5 text-icon" strokeWidth={1.5} aria-hidden />
              <span>Playbooks</span>
            </span>
            <Button
              type="button"
              size="sm"
              variant={saveOpen ? "default" : "outline"}
              onClick={() => setSaveOpen((v) => !v)}
              className="h-7 px-2.5 text-xs max-md:min-h-11"
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
                    variant={active ? "default" : "outline"}
                    title={tpl.description}
                    onClick={() => applyPlaybook(tpl)}
                    className="h-7 px-2.5 text-xs max-md:min-h-11"
                  >
                    {tpl.name}
                  </Button>
                  {!tpl.builtin && (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Delete playbook ${tpl.name}`}
                      onClick={() => void handleDeletePlaybook(tpl)}
                      className="size-7 max-md:size-11"
                    >
                      <Trash2 className="size-3.5 text-ink-3" strokeWidth={1.5} aria-hidden />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>

          {saveOpen && (
            <div className="mt-2 space-y-2 border-t border-hairline pt-2.5" data-testid="save-playbook-form">
              <div className="grid gap-2 sm:grid-cols-2">
                <InputGroup>
                  <InputGroupInput
                    id="playbook-name"
                    aria-label="Playbook name"
                    value={tplName}
                    onChange={(e) => setTplName(e.target.value)}
                    placeholder="Playbook name (e.g. API Security Fix)"
                    className="text-xs max-md:!h-11"
                  />
                </InputGroup>
                <InputGroup>
                  <InputGroupInput
                    id="playbook-desc"
                    aria-label="Playbook description"
                    value={tplDesc}
                    onChange={(e) => setTplDesc(e.target.value)}
                    placeholder="Short description (optional)"
                    className="text-xs max-md:!h-11"
                  />
                </InputGroup>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setSaveOpen(false)}
                  className="h-7 px-2.5 text-xs max-md:min-h-11"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={savingTpl}
                  onClick={() => void handleSavePlaybook()}
                  className="h-7 px-3 text-xs max-md:min-h-11"
                >
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
              <InputGroup>
                <InputGroupInput
                  ref={repoRef}
                  id="repo"
                  value={repo}
                  onChange={(e) => onRepoChange(e.target.value)}
                  placeholder={repos[0]?.path || "/home/you/projects/app"}
                  autoComplete="off"
                  aria-invalid={repoErr ? true : undefined}
                />
              </InputGroup>
              {filteredRepos.length > 0 && (
                <div
                  aria-label="Discovered repositories"
                  className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-card border border-hairline bg-canvas p-1.5"
                >
                  {filteredRepos.map((r) => {
                    const active = repo.trim() === r.path;
                    return (
                      <button
                        key={r.path}
                        type="button"
                        onClick={() => pickRepo(r)}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-2 rounded-control px-2.5 py-2 text-left text-sm transition-colors duration-(--dur-press) ease-(--ease-house) outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11",
                          active ? "bg-raised text-ink font-medium" : "text-ink-2 hover:bg-surface hover:text-ink",
                        )}
                      >
                        <FolderGit2 className="size-4 shrink-0 text-icon" strokeWidth={1.5} aria-hidden />
                        <span className="min-w-0 flex-1 truncate font-medium text-ink">{r.name}</span>
                        {r.branch && (
                          <span className="shrink-0 rounded-chip bg-track px-1.5 py-0.5 font-mono text-xs text-ink-2">
                            {r.branch}
                          </span>
                        )}
                        <span className="hidden max-w-[42%] truncate font-mono text-xs text-ink-3 sm:inline">
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
              <InputGroup>
                <InputGroupInput
                  id="project"
                  value={project}
                  placeholder={repoBasename(repo) || "default"}
                  onChange={(e) => {
                    setProjectTouched(true);
                    setProject(e.target.value);
                  }}
                  autoComplete="off"
                />
              </InputGroup>
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
                  ? "Executed inside an isolated Web Worker against the branch's real files (e.g. npm test, or a JS assertion over files['src/ledger.js'])."
                  : "Leave it empty to use the project’s check from the policy file. Its output becomes the receipt."
              }
            >
              <InputGroup>
                <InputGroupInput
                  id="check"
                  value={check}
                  onChange={(e) => setCheck(e.target.value)}
                  autoComplete="off"
                  placeholder={webEngine ? "npm test" : "cargo test"}
                />
              </InputGroup>
              <p className="text-xs text-ink-3">
                Example: <Kbd>{webEngine ? "npm test" : "cargo test"}</Kbd>
              </p>
            </Field>

            {upstreamCandidates.length > 0 && (
              <div className="space-y-2 rounded-card border border-hairline bg-canvas p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink">
                    <GitBranch className="size-3.5 text-icon" strokeWidth={1.5} aria-hidden />
                    <span>Depends on upstream sessions (DAG)</span>
                  </span>
                  {dependsOn.length > 0 && (
                    <span className="rounded-chip bg-track px-1.5 py-0.5 font-mono text-xs text-ink-2">
                      {dependsOn.length} selected
                    </span>
                  )}
                </div>
                <p className="text-xs text-ink-3">
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
                        variant={checked ? "default" : "outline"}
                        aria-pressed={checked}
                        onClick={() => toggleSingleDep(cand.id)}
                        className="h-7 max-w-full px-2 font-mono text-xs max-md:min-h-11"
                      >
                        <span className="shrink-0">{cand.id}</span>
                        <span className="truncate font-sans font-normal">· {cand.task.slice(0, 26)}</span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}

            <Field id="next" label="Then (optional)" hint="Starts on its own only when this session is verified done.">
              <InputGroup>
                <InputGroupInput
                  id="next"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  placeholder="The next task in the chain"
                  autoComplete="off"
                />
              </InputGroup>
            </Field>
          </>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-ink-2">
                {batchRows.length} parallel task {batchRows.length === 1 ? "row" : "rows"} · reference earlier rows as{" "}
                <span className="font-mono text-ink">#1</span>, <span className="font-mono text-ink">#2</span> in{" "}
                <span className="font-mono text-ink">depends_on</span>.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {repos.length > 1 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={fanOutAllRepos}
                    className="h-8 px-2.5 text-xs max-md:min-h-11"
                  >
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
                  className="h-8 px-2.5 text-xs max-md:min-h-11"
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
                  <div key={row.id} className="space-y-2.5 rounded-card border border-hairline bg-canvas p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="rounded-chip bg-track px-2 py-0.5 font-mono text-xs font-medium text-ink">
                        Task #{idx + 1}
                      </span>
                      {batchRows.length > 1 && (
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Remove batch task #${idx + 1}`}
                          onClick={() => setBatchRows((rows) => rows.filter((r) => r.id !== row.id))}
                          className="size-7 max-md:size-11"
                        >
                          <Trash2 className="size-3.5 text-ink-3" strokeWidth={1.5} aria-hidden />
                        </Button>
                      )}
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label htmlFor={`batch-repo-${idx}`} className="block text-xs font-medium text-ink-2">
                          Repository path
                        </label>
                        <InputGroup>
                          <InputGroupInput
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
                            className="font-mono text-xs max-md:!h-11"
                          />
                        </InputGroup>
                      </div>
                      <div className="space-y-1">
                        <label htmlFor={`batch-check-${idx}`} className="block text-xs font-medium text-ink-2">
                          Check command (optional)
                        </label>
                        <InputGroup>
                          <InputGroupInput
                            id={`batch-check-${idx}`}
                            value={row.check}
                            placeholder={webEngine ? "npm test" : "cargo test"}
                            onChange={(e) => {
                              const val = e.target.value;
                              setBatchRows((rows) =>
                                rows.map((r) => (r.id === row.id ? { ...r, check: val } : r)),
                              );
                            }}
                            className="font-mono text-xs max-md:!h-11"
                          />
                        </InputGroup>
                      </div>
                    </div>

                    {repos.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {repos.slice(0, 5).map((r) => (
                          <Button
                            key={r.path}
                            type="button"
                            size="sm"
                            variant={row.repo === r.path ? "default" : "outline"}
                            onClick={() =>
                              setBatchRows((rows) =>
                                rows.map((item) =>
                                  item.id === row.id ? { ...item, repo: r.path, project: r.name } : item,
                                ),
                              )
                            }
                            className="h-7 px-2 font-mono text-xs max-md:min-h-11"
                          >
                            {r.name}
                          </Button>
                        ))}
                      </div>
                    )}

                    <div className="space-y-1">
                      <label htmlFor={`batch-task-${idx}`} className="block text-xs font-medium text-ink-2">
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
                        className="text-sm"
                      />
                    </div>

                    {depChoices.length > 0 && (
                      <div className="space-y-1">
                        <span className="block text-xs text-ink-3">Depends on (optional DAG links):</span>
                        <div className="flex flex-wrap gap-1">
                          {depChoices.map((dep) => {
                            const active = row.dependsOn.includes(dep);
                            return (
                              <Button
                                key={dep}
                                type="button"
                                size="sm"
                                variant={active ? "default" : "outline"}
                                aria-pressed={active}
                                onClick={() => toggleRowDep(dep)}
                                className="h-7 px-2 font-mono text-xs max-md:min-h-11"
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

        <Expandable expandDirection="vertical" expandBehavior="push" className="rounded-card border border-hairline bg-canvas p-3">
          {({ isExpanded }) => (
            <>
              <ExpandableTrigger
                aria-label="Multi-step check pipeline, auto-heal budget, and file-scope guardrails"
                className="flex w-full cursor-pointer items-center justify-between gap-2 text-left text-sm font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
              >
                <span className="inline-flex items-center gap-1.5">
                  <ListChecks className="size-4 text-icon" strokeWidth={1.5} aria-hidden />
                  <span>Check pipeline, auto-heal &amp; file-scope guardrails</span>
                  {(steps.length > 0 || allowedGlobsText.trim() || forbiddenGlobsText.trim()) && (
                    <span className="rounded-chip bg-track px-1.5 py-0.5 font-mono text-xs text-ink-2">
                      {steps.length} {steps.length === 1 ? "step" : "steps"}
                    </span>
                  )}
                </span>
                <span className="text-xs font-normal text-ink-3">{isExpanded ? "Hide" : "Configure"}</span>
              </ExpandableTrigger>
              <ExpandableContent preset="fade">
                <div className="mt-3 space-y-4 border-t border-hairline pt-3">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-ink-2">Ordered check pipeline steps</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={addStepRow}
                        className="h-7 px-2.5 text-xs max-md:min-h-11"
                      >
                        <Plus className="size-3.5" strokeWidth={1.5} aria-hidden />
                        <span>Add check step</span>
                      </Button>
                    </div>
                    {steps.length === 0 ? (
                      <p className="text-xs text-ink-3">
                        Add named pipeline stages (e.g. typecheck, lint, unit tests) to record timed per-step receipts. Stops on first failure.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {steps.map((st, idx) => (
                          <div key={st.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_72px_auto] items-center gap-1.5">
                            <InputGroup>
                              <InputGroupInput
                                aria-label={`Check step ${idx + 1} name`}
                                value={st.name}
                                placeholder="name"
                                onChange={(e) =>
                                  setSteps((prev) =>
                                    prev.map((x) => (x.id === st.id ? { ...x, name: e.target.value } : x)),
                                  )
                                }
                                className="font-mono text-xs max-md:!h-11"
                              />
                            </InputGroup>
                            <InputGroup>
                              <InputGroupInput
                                aria-label={`Check step ${idx + 1} command`}
                                value={st.cmd}
                                placeholder="npm test"
                                onChange={(e) =>
                                  setSteps((prev) =>
                                    prev.map((x) => (x.id === st.id ? { ...x, cmd: e.target.value } : x)),
                                  )
                                }
                                className="font-mono text-xs max-md:!h-11"
                              />
                            </InputGroup>
                            <InputGroup>
                              <InputGroupInput
                                aria-label={`Check step ${idx + 1} timeout seconds`}
                                value={st.timeoutSecs}
                                placeholder="300"
                                onChange={(e) =>
                                  setSteps((prev) =>
                                    prev.map((x) => (x.id === st.id ? { ...x, timeoutSecs: e.target.value } : x)),
                                  )
                                }
                                className="font-mono text-xs tabular-nums max-md:!h-11"
                              />
                            </InputGroup>
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Remove check step ${idx + 1}`}
                              onClick={() => setSteps((prev) => prev.filter((x) => x.id !== st.id))}
                              className="size-8 max-md:size-11"
                            >
                              <Trash2 className="size-3.5 text-ink-3" strokeWidth={1.5} aria-hidden />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="space-y-2 border-t border-hairline pt-3">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-2">
                      <Wrench className="size-3.5 text-icon" strokeWidth={1.5} aria-hidden />
                      <span>Autonomous auto-heal budget</span>
                    </span>
                    <div className="flex flex-wrap items-center gap-3">
                      <InputGroup className="w-24">
                        <InputGroupInput
                          id="auto-heal-budget"
                          type="number"
                          min={0}
                          max={5}
                          aria-label="Auto-heal retry budget"
                          value={healBudget}
                          onChange={(e) => setHealBudget(e.target.value)}
                          className="font-mono text-xs tabular-nums max-md:!h-11"
                        />
                      </InputGroup>
                      <p className="min-w-0 flex-1 text-xs text-ink-3">
                        Maximum diagnostic auto-steer attempts when a check step fails (`0` disables auto-heal).
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2 border-t border-hairline pt-3">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-2">
                      <Shield className="size-3.5 text-icon" strokeWidth={1.5} aria-hidden />
                      <span>File-scope guardrails</span>
                    </span>
                    <div className="grid gap-2.5 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label htmlFor="allowed-globs" className="block text-xs text-ink-2">
                          Allowed file globs (comma-separated)
                        </label>
                        <InputGroup>
                          <InputGroupInput
                            id="allowed-globs"
                            value={allowedGlobsText}
                            onChange={(e) => setAllowedGlobsText(e.target.value)}
                            placeholder="src/**, tests/**"
                            className="font-mono text-xs max-md:!h-11"
                          />
                        </InputGroup>
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="forbidden-globs" className="block text-xs text-ink-2">
                          Forbidden globs (optional)
                        </label>
                        <InputGroup>
                          <InputGroupInput
                            id="forbidden-globs"
                            value={forbiddenGlobsText}
                            onChange={(e) => setForbiddenGlobsText(e.target.value)}
                            placeholder=".env*, Cargo.lock"
                            className="font-mono text-xs max-md:!h-11"
                          />
                        </InputGroup>
                      </div>
                    </div>
                  </div>
                </div>
              </ExpandableContent>
            </>
          )}
        </Expandable>
      </div>

      <div className="flex flex-col gap-3 border-t border-hairline bg-surface px-6 py-4">
        {formErr && (
          <p role="alert" className="text-sm text-destructive-foreground">
            {formErr}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <MorphingDialogClose className="new-cancel static inline-flex h-9 cursor-pointer items-center rounded-control border border-hairline px-3.5 text-sm font-medium text-ink outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11">
            Cancel
          </MorphingDialogClose>
          <Button type="submit" disabled={busy} className="max-md:min-h-11 max-md:px-4">
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
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      <p className="text-xs leading-relaxed text-ink-3">{hint}</p>
      {err && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {err}
        </p>
      )}
    </div>
  );
}
