import { useEffect, useRef, useState } from "../hooks";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  ExternalLink,
  Image as ImageIcon,
  Layers,
  MessageSquare,
  Pin,
  PinOff,
  Radio,
  RefreshCw,
  Send,
  ShieldAlert,
  Wrench,
  X,
} from "../icons";
import {
  PlanConflictError,
  extractLocalFilePaths,
  openWorkerConversation,
  parseScreenshotLines,
  saveSwarmPlan,
} from "../sidecar";
import type {
  NormalizedPlan,
  PlanMilestoneStatus,
  PlanWorkstreamStatus,
  SwarmMember,
  SwarmSnapshot,
  TriageItem,
} from "../types";
import {
  ActivityPeek,
  Badge,
  Button,
  Card,
  GateReadinessCard,
  InlineComposer,
  Input,
  MediaPathChips,
  MemberActivityLine,
  Pill,
  PinnedList,
  SegBar,
  StatusDot,
  Textarea,
  TokenBurnStrip,
  buildRecoverPrompt,
  canLiveNudge,
  cn,
  copyText,
  fmtTimeAgo,
  formatBlockerContext,
  hasControlChars,
  humanizeStatus,
  maskHome,
  memberMeta,
  normalizePlan,
  openOrCopyPath,
  safePlanText,
  submitNudge,
  toast,
  useNowMs,
} from "../ui";

const SEVERITY_BADGE: Record<TriageItem["severity"], { tone: "danger" | "warning" | "info"; label: string; Icon: typeof AlertTriangle }> = {
  urgent: { tone: "danger", label: "Urgent", Icon: ShieldAlert },
  attention: { tone: "warning", label: "Needs reply", Icon: AlertTriangle },
  verify: { tone: "info", label: "Verify", Icon: CheckCircle2 },
};

const WORKSTREAM_TONE: Record<string, "success" | "info" | "danger" | "neutral"> = {
  done: "success", verified: "success", completed: "success",
  running: "info", in_progress: "info", blocked: "danger", failed: "danger",
};

const WORKSTREAM_STATUS_OPTIONS: PlanWorkstreamStatus[] = ["pending", "running", "done", "verified", "blocked"];
const MILESTONE_STATUS_CYCLE: PlanMilestoneStatus[] = ["pending", "in_progress", "done", "blocked"];

function NarratorViewSection({ snap }: { snap: SwarmSnapshot }) {
  const vj = snap.view?.json;
  if (snap.view?.exists && snap.view?.jsonError && (!vj || typeof vj !== "object")) {
    return (
      <section aria-labelledby="narrator-heading" className="space-y-2">
        <div className="f1">
          <Radio className="text-warn" />
          <h2 id="narrator-heading" className="h2">Narrator view</h2>
        </div>
        <Card className="p-3 border-warn bg-warn-soft text-[12px] text-ink" role="alert" data-testid="narrator-view-error">
          <p className="font-medium text-warn">Unable to parse narrator view.json</p>
          <p className="text-ink-2 break-words">{maskHome(snap.view.jsonError)}</p>
        </Card>
      </section>
    );
  }
  if (!vj || typeof vj !== "object" || Array.isArray(vj)) return null;

  const headline = maskHome(safePlanText(vj.headline)).trim();
  const phase = safePlanText(vj.phase).trim();
  const summary = maskHome(safePlanText(vj.running_summary)).trim();
  const ack = maskHome(safePlanText(vj.feedback_ack)).trim();

  const nowEntries =
    vj.now && typeof vj.now === "object" && !Array.isArray(vj.now)
      ? Object.entries(vj.now)
          .map(([member, val]) => [String(member).trim(), maskHome(safePlanText(val)).trim()] as const)
          .filter(([member, val]) => Boolean(member && val))
      : [];

  const attentionItems = Array.isArray(vj.attention)
    ? vj.attention
        .map((item) => {
          if (typeof item === "string") return { text: maskHome(item).trim(), member: "" };
          if (item && typeof item === "object" && !Array.isArray(item)) {
            const obj = item as { member?: unknown; title?: unknown; detail?: unknown; text?: unknown };
            const member = safePlanText(obj.member).trim();
            const text = maskHome(
              safePlanText(obj.title) || safePlanText(obj.text) || safePlanText(obj.detail) || safePlanText(obj),
            ).trim();
            return text ? { text, member } : null;
          }
          const scalar = maskHome(safePlanText(item)).trim();
          return scalar ? { text: scalar, member: "" } : null;
        })
        .filter((x): x is { text: string; member: string } => Boolean(x && x.text))
    : [];

  if (!headline && !phase && !summary && !ack && nowEntries.length === 0 && attentionItems.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="narrator-heading" className="space-y-2">
      <div className="row flex-wrap gap-2">
        <div className="f1">
          <Radio className="text-info" />
          <h2 id="narrator-heading" className="h2">Narrator view</h2>
        </div>
        {phase && <Badge tone="info">{humanizeStatus(phase)}</Badge>}
      </div>
      <Card className="p-3 space-y-2" data-testid="narrator-view-card">
        {headline && <p className="text-[13px] font-medium text-ink break-words">{headline}</p>}
        {summary && <p className="text-[12px] text-ink-2 break-words leading-snug">{summary}</p>}
        {ack && <p className="text-[12px] text-ink-3 break-words">Ack: {ack}</p>}
        {attentionItems.length > 0 && (
          <ul className="space-y-1" aria-label="Narrator attention items">
            {attentionItems.map((it, idx) => (
              <li key={idx} className="flex items-start gap-1.5 rounded-chip bg-warn-soft px-2 py-1 text-[12px] text-ink">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warn mt-0.5" />
                <span className="min-w-0 break-words">
                  {it.member ? <span className="font-medium">@{it.member}: </span> : null}
                  {it.text}
                </span>
              </li>
            ))}
          </ul>
        )}
        {nowEntries.length > 0 && (
          <ul className="divide-y divide-hairline" aria-label="Narrator member activity">
            {nowEntries.map(([member, statusText]) => (
              <li key={member} className="py-1.5 first:pt-0 last:pb-0 text-[12px] flex items-baseline gap-2 min-w-0">
                <span className="font-medium text-ink shrink-0">@{member}</span>
                <span className="text-ink-2 break-words min-w-0">{statusText}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

interface DraftWorkstream {
  id: string;
  title: string;
  owner: string;
  status: PlanWorkstreamStatus;
  note?: string;
  threadId?: string;
}

interface DraftTask {
  owner: string;
  desc: string;
}

interface DraftMilestone {
  title: string;
  status: PlanMilestoneStatus;
}

function SwarmPlanSection({
  snap,
  plan,
  onRefresh,
}: {
  snap: SwarmSnapshot;
  plan: NormalizedPlan | null;
  onRefresh: () => void;
}) {
  const swarmId = snap.swarm || snap.conversationId || "";
  const [editing, setEditing] = useState(false);
  const [baseEtag, setBaseEtag] = useState("");
  const [draftGoalTitle, setDraftGoalTitle] = useState("");
  const [draftGoal, setDraftGoal] = useState("");
  const [draftGate, setDraftGate] = useState("");
  const [draftWorkstreams, setDraftWorkstreams] = useState<DraftWorkstream[]>([]);
  const [draftTasks, setDraftTasks] = useState<DraftTask[]>([]);
  const [draftMilestones, setDraftMilestones] = useState<DraftMilestone[]>([]);
  const [notifyCoordinator, setNotifyCoordinator] = useState(false);
  const [saving, setSaving] = useState(false);
  const [planError, setPlanError] = useState("");
  const [conflictPlan, setConflictPlan] = useState<NormalizedPlan | null>(null);
  const openedPlanRef = useRef<NormalizedPlan | null>(null);
  const saveLockRef = useRef(false);

  useEffect(() => {
    setEditing(false);
    setConflictPlan(null);
    setPlanError("");
    openedPlanRef.current = null;
  }, [swarmId]);

  useEffect(() => {
    if (conflictPlan && !conflictPlan.etag && plan?.etag && plan.etag !== baseEtag) {
      setConflictPlan({ ...conflictPlan, etag: plan.etag });
    }
  }, [conflictPlan, plan?.etag, baseEtag]);

  const hydrateDraft = (source: NormalizedPlan | null) => {
    openedPlanRef.current = source;
    setBaseEtag(source?.etag || "");
    setDraftGoalTitle(source?.goalTitle || "");
    setDraftGoal(source?.goalLine || source?.goal || "");
    setDraftGate(source?.gate || "");
    setDraftWorkstreams((source?.workstreams || []).map((w) => ({ ...w })));
    setDraftTasks(Object.entries(source?.tasks || {}).map(([owner, desc]) => ({ owner, desc })));
    setDraftMilestones((source?.milestones || []).map((m) => ({ ...m })));
    setNotifyCoordinator(false);
    setPlanError("");
    setConflictPlan(null);
  };

  const mergePlanWithLatest = (latest: NormalizedPlan) => {
    const orig = openedPlanRef.current;
    const origGoalTitle = orig?.goalTitle || "";
    const origGoal = orig?.goalLine || orig?.goal || "";
    const origGate = orig?.gate || "";

    const nextGoalTitle = latest.goalTitle || "";
    const nextGoal = latest.goalLine || latest.goal || "";
    const nextGate = latest.gate || "";

    if (draftGoalTitle === origGoalTitle && nextGoalTitle !== origGoalTitle) setDraftGoalTitle(nextGoalTitle);
    if (draftGoal === origGoal && nextGoal !== origGoal) setDraftGoal(nextGoal);
    if (draftGate === origGate && nextGate !== origGate) setDraftGate(nextGate);

    const origWsIds = new Set((orig?.workstreams || []).map((w) => w.id));
    setDraftWorkstreams((cur) => {
      const curIds = new Set(cur.map((w) => w.id));
      const addedOnDisk = latest.workstreams.filter((w) => !origWsIds.has(w.id) && !curIds.has(w.id));
      return [...cur, ...addedOnDisk.map((w) => ({ ...w }))];
    });

    const origTaskOwners = new Set(Object.keys(orig?.tasks || {}));
    setDraftTasks((cur) => {
      const curOwners = new Set(cur.map((t) => t.owner.trim()));
      const addedTasks = Object.entries(latest.tasks || {})
        .filter(([owner]) => !origTaskOwners.has(owner) && !curOwners.has(owner))
        .map(([owner, desc]) => ({ owner, desc }));
      return [...cur, ...addedTasks];
    });

    const origMsTitles = new Set((orig?.milestones || []).map((m) => m.title));
    setDraftMilestones((cur) => {
      const curTitles = new Set(cur.map((m) => m.title.trim()));
      const addedMs = latest.milestones.filter((m) => !origMsTitles.has(m.title) && !curTitles.has(m.title));
      return [...cur, ...addedMs.map((m) => ({ ...m }))];
    });

    openedPlanRef.current = latest;
    setBaseEtag(latest.etag || plan?.etag || "");
    setConflictPlan(null);
    setPlanError("");
    toast.success("Merged latest disk plan with your edits");
  };

  const openEditor = () => {
    hydrateDraft(plan);
    setEditing(true);
  };

  const hasInvalidChars =
    hasControlChars(draftGoalTitle) ||
    hasControlChars(draftGoal) ||
    hasControlChars(draftGate) ||
    draftWorkstreams.some((w) => hasControlChars(w.title) || hasControlChars(w.owner)) ||
    draftTasks.some((t) => hasControlChars(t.owner) || hasControlChars(t.desc));

  const handleSave = async () => {
    if (saveLockRef.current || !swarmId) return;
    if (hasInvalidChars) {
      setPlanError("Control characters are not allowed.");
      toast.error("Control characters not permitted");
      return;
    }

    const cleanGoal = draftGoal.trim();
    const cleanGoalTitle = draftGoalTitle.trim();
    const cleanGate = draftGate.trim();
    const cleanWorkstreams = draftWorkstreams
      .map((w, idx) => ({
        id: w.id.trim() || `ws-${idx + 1}`,
        title: w.title.trim(),
        owner: w.owner.trim().replace(/^@/, ""),
        status: w.status,
        ...(w.note ? { note: w.note } : {}),
        ...(w.threadId ? { threadId: w.threadId } : {}),
      }))
      .filter((w) => Boolean(w.title));

    const cleanTasks: Record<string, string> = {};
    for (const row of draftTasks) {
      const k = row.owner.trim().replace(/^@/, "");
      const v = row.desc.trim();
      if (k && v) cleanTasks[k] = v;
    }

    const cleanMilestones = draftMilestones
      .map((m) => ({ title: m.title.trim(), status: m.status }))
      .filter((m) => Boolean(m.title));

    if (!cleanGoal && !cleanGoalTitle && cleanWorkstreams.length === 0 && Object.keys(cleanTasks).length === 0) {
      setPlanError("Enter a goal, task, or workstream before saving.");
      return;
    }

    saveLockRef.current = true;
    setSaving(true);
    setPlanError("");
    try {
      const patch: Parameters<typeof saveSwarmPlan>[0]["patch"] = {
        goal: cleanGoal || cleanGoalTitle,
        gate: cleanGate,
        workstreams: cleanWorkstreams,
        tasks: cleanTasks,
        milestones: cleanMilestones,
      };
      if (cleanGoalTitle || plan?.goalTitle) {
        patch.goalTitle = cleanGoalTitle || cleanGoal;
        patch.goalLine = cleanGoal || cleanGoalTitle;
      }
      const res = await saveSwarmPlan({
        conversationId: swarmId,
        ifMatch: baseEtag,
        mode: "patch",
        notifyCoordinator,
        patch,
      });
      setEditing(false);
      setConflictPlan(null);
      toast.success(res.notified ? "Plan saved and coordinator notified" : "Plan saved");
      onRefresh();
    } catch (err) {
      if (err instanceof PlanConflictError) {
        const latest = normalizePlan(err.latestPlan) || plan;
        setConflictPlan(latest);
        setPlanError("");
        onRefresh();
      } else {
        setPlanError(err instanceof Error ? err.message : "Failed to save plan");
      }
    } finally {
      saveLockRef.current = false;
      setSaving(false);
    }
  };

  if (!plan && !swarmId) return null;

  const taskEntries = Object.entries(plan?.tasks || {});
  const memberNames = (snap.members || []).filter((m) => !m.killed).map((m) => m.name);

  return (
    <section aria-labelledby="plan-heading" className="space-y-2">
      <div className="row flex-wrap gap-2">
        <div className="f1">
          <Layers className="text-ink-3" />
          <h2 id="plan-heading" className="h2">Swarm plan</h2>
          {plan && (plan.schema === "native" || plan.schema === "hybrid") && (
            <Badge tone="neutral">{plan.schema === "native" ? "Native" : "Hybrid"}</Badge>
          )}
        </div>
        {swarmId && !editing && (
          <Button variant="outline" data-testid="edit-plan-btn" onClick={openEditor}>
            <Wrench />
            {plan ? "Edit plan" : "Create plan"}
          </Button>
        )}
      </div>

      {editing ? (
        <Card className="p-3 space-y-3" data-testid="plan-editor">
          {conflictPlan !== null && (
            <div role="alert" className="rounded-chip border border-danger bg-bad-soft p-2.5 space-y-2 text-[12px]" data-testid="plan-conflict-banner">
              <div className="space-y-0.5">
                <p className="font-medium text-danger">Plan changed on disk since you opened it (409 Conflict).</p>
                {(conflictPlan.goalLine || conflictPlan.goal) && (
                  <p className="text-ink-2 break-words">
                    Latest disk goal: {maskHome(conflictPlan.goalLine || conflictPlan.goal)}
                  </p>
                )}
              </div>
              <div className="wrap gap-1.5">
                <Button
                  variant="primary"
                  data-testid="plan-conflict-merge"
                  onClick={() => mergePlanWithLatest(conflictPlan)}
                >
                  <RefreshCw />
                  Reload & merge
                </Button>
                <Button
                  variant="outline"
                  data-testid="plan-conflict-reload"
                  onClick={() => hydrateDraft(conflictPlan)}
                >
                  <RefreshCw />
                  Reload latest plan
                </Button>
              </div>
            </div>
          )}

          {(planError || hasInvalidChars) && (
            <p className="text-[12px] text-danger" role="alert">
              {hasInvalidChars ? "Control characters are not allowed." : planError}
            </p>
          )}

          {(draftGoalTitle || plan?.schema === "native" || plan?.schema === "hybrid") && (
            <div className="space-y-1">
              <label htmlFor="plan-goal-title" className="text-[12px] font-medium text-ink-2">
                Goal title
              </label>
              <Input
                id="plan-goal-title"
                data-testid="plan-goal-title-input"
                value={draftGoalTitle}
                onChange={(e) => setDraftGoalTitle(e.target.value)}
                placeholder="Short plan title"
              />
            </div>
          )}

          <div className="space-y-1">
            <label htmlFor="plan-goal-input" className="text-[12px] font-medium text-ink-2">
              Goal
            </label>
            <Textarea
              id="plan-goal-input"
              data-testid="plan-goal-input"
              rows={2}
              value={draftGoal}
              onChange={(e) => setDraftGoal(e.target.value)}
              placeholder="Primary swarm goal"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="plan-gate-input" className="text-[12px] font-medium text-ink-2">
              Verification gate
            </label>
            <Input
              id="plan-gate-input"
              data-testid="plan-gate-input"
              value={draftGate}
              onChange={(e) => setDraftGate(e.target.value)}
              placeholder="npm test && npm run check:ui"
              className="mono text-[13px]"
            />
          </div>

          <div className="space-y-1.5">
            <div className="row">
              <span className="text-[12px] font-medium text-ink-2">Workstreams ({draftWorkstreams.length})</span>
              <Button
                variant="ghost"
                data-testid="plan-add-workstream"
                onClick={() =>
                  setDraftWorkstreams((prev) => [
                    ...prev,
                    { id: `ws-${prev.length + 1}`, title: "", owner: "", status: "pending" },
                  ])
                }
              >
                + Add workstream
              </Button>
            </div>
            {draftWorkstreams.map((ws, idx) => (
              <div key={ws.id || idx} className="rounded-chip border border-hairline bg-board p-2 space-y-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Input
                    aria-label={`Workstream ${idx + 1} title`}
                    data-testid={`plan-ws-title-${idx}`}
                    value={ws.title}
                    placeholder="Workstream title"
                    onChange={(e) =>
                      setDraftWorkstreams((prev) =>
                        prev.map((row, i) => (i === idx ? { ...row, title: e.target.value } : row)),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove workstream ${idx + 1}`}
                    onClick={() => setDraftWorkstreams((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    <X />
                  </Button>
                </div>
                <div className="flex items-center gap-1.5 min-w-0">
                  <Input
                    aria-label={`Workstream ${idx + 1} owner`}
                    data-testid={`plan-ws-owner-${idx}`}
                    value={ws.owner}
                    list="plan-member-suggestions"
                    placeholder="owner"
                    onChange={(e) =>
                      setDraftWorkstreams((prev) =>
                        prev.map((row, i) => (i === idx ? { ...row, owner: e.target.value } : row)),
                      )
                    }
                  />
                  <select
                    aria-label={`Workstream ${idx + 1} status`}
                    data-testid={`plan-ws-status-${idx}`}
                    value={ws.status}
                    onChange={(e) =>
                      setDraftWorkstreams((prev) =>
                        prev.map((row, i) =>
                          i === idx ? { ...row, status: e.target.value as PlanWorkstreamStatus } : row,
                        ),
                      )
                    }
                    className="h-8 shrink-0 rounded-chip border border-hairline-s bg-surface px-2 text-[12px] text-ink cursor-pointer"
                  >
                    {WORKSTREAM_STATUS_OPTIONS.map((st) => (
                      <option key={st} value={st}>
                        {humanizeStatus(st)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1.5">
            <div className="row">
              <span className="text-[12px] font-medium text-ink-2">Tasks ({draftTasks.length})</span>
              <Button
                variant="ghost"
                data-testid="plan-add-task"
                onClick={() => setDraftTasks((prev) => [...prev, { owner: "", desc: "" }])}
              >
                + Add task
              </Button>
            </div>
            {draftTasks.map((task, idx) => (
              <div key={idx} className="rounded-chip border border-hairline bg-board p-2 space-y-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Input
                    aria-label={`Task ${idx + 1} worker`}
                    data-testid={`plan-task-owner-${idx}`}
                    value={task.owner}
                    list="plan-member-suggestions"
                    placeholder="worker"
                    onChange={(e) =>
                      setDraftTasks((prev) =>
                        prev.map((row, i) => (i === idx ? { ...row, owner: e.target.value } : row)),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove task ${idx + 1}`}
                    onClick={() => setDraftTasks((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    <X />
                  </Button>
                </div>
                <Input
                  aria-label={`Task ${idx + 1} description`}
                  data-testid={`plan-task-desc-${idx}`}
                  value={task.desc}
                  placeholder="Task description"
                  onChange={(e) =>
                    setDraftTasks((prev) =>
                      prev.map((row, i) => (i === idx ? { ...row, desc: e.target.value } : row)),
                    )
                  }
                />
              </div>
            ))}
          </div>

          {draftMilestones.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-[12px] font-medium text-ink-2">Milestones (tap to cycle status)</span>
              <div className="flex flex-wrap gap-1">
                {draftMilestones.map((ms, idx) => {
                  const tone = WORKSTREAM_TONE[String(ms.status || "").toLowerCase()] || "neutral";
                  return (
                    <Pill
                      key={idx}
                      onClick={() =>
                        setDraftMilestones((prev) =>
                          prev.map((row, i) =>
                            i === idx
                              ? {
                                  ...row,
                                  status:
                                    MILESTONE_STATUS_CYCLE[
                                      (MILESTONE_STATUS_CYCLE.indexOf(row.status) + 1) % MILESTONE_STATUS_CYCLE.length
                                    ],
                                }
                              : row,
                          ),
                        )
                      }
                      className={cn(
                        tone === "success"
                          ? "bg-ok-soft text-ok"
                          : tone === "info"
                            ? "bg-blue-soft text-info"
                            : tone === "danger"
                              ? "bg-bad-soft text-danger"
                              : "bg-track text-ink-2",
                      )}
                    >
                      {ms.title} ({humanizeStatus(ms.status)})
                    </Pill>
                  );
                })}
              </div>
            </div>
          )}

          {memberNames.length > 0 && (
            <datalist id="plan-member-suggestions">
              {memberNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          )}

          <div className="pt-2 border-t border-hairline space-y-2">
            <label className="inline-flex items-center gap-2 text-[12px] text-ink-2 cursor-pointer">
              <input
                type="checkbox"
                data-testid="plan-notify-coord"
                checked={notifyCoordinator}
                onChange={(e) => setNotifyCoordinator(e.target.checked)}
                className="h-4 w-4 accent-[var(--blue)]"
              />
              Notify coordinator on save
            </label>
            <div className="row justify-end gap-2">
              <Button variant="ghost" data-testid="plan-cancel-btn" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                data-testid="plan-save-btn"
                disabled={saving || hasInvalidChars}
                onClick={handleSave}
              >
                <CheckCircle2 />
                {saving ? "Saving..." : "Confirm & save"}
              </Button>
            </div>
          </div>
        </Card>
      ) : !plan ? (
        <Card className="p-3 bg-board">
          <p className="text-[13px] text-ink-2">No plan.json yet. Create one to track goal, gate, tasks, and workstreams.</p>
        </Card>
      ) : (
        <Card className="p-3 space-y-2" data-testid="swarm-plan-card">
          {plan.goalTitle && plan.goalLine && plan.goalTitle !== plan.goalLine ? (
            <div className="space-y-0.5">
              <p className="text-[14px] font-medium text-ink break-words">{maskHome(plan.goalTitle)}</p>
              <p className="text-[13px] text-ink-2 break-words leading-snug">{maskHome(plan.goalLine)}</p>
            </div>
          ) : (
            plan.goal && <p className="text-[14px] font-medium text-ink break-words">{maskHome(plan.goal)}</p>
          )}
          {plan.gate && (
            <div className="rounded-chip bg-board px-2 py-1 text-[12px] text-ink-2">
              <span className="font-medium text-ink">Gate: </span>
              <code className="mono break-all">{maskHome(plan.gate)}</code>
            </div>
          )}
          {plan.threads.length > 0 && (
            <ul className="divide-y divide-hairline" aria-label="Plan threads" data-testid="plan-threads-list">
              {plan.threads.map((th, i) => (
                <li key={th.id || i} className="py-1.5 first:pt-0 last:pb-0 space-y-1">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-ink break-words">{maskHome(th.title || th.id)}</p>
                    {th.goal && th.goal !== th.title && (
                      <p className="t2 break-words">{maskHome(th.goal)}</p>
                    )}
                  </div>
                  {th.tasks.length > 0 && (
                    <div className="wrap gap-1">
                      {th.tasks.map((tk, tIdx) => (
                        <Badge key={`${tk}-${tIdx}`} tone="neutral">@{tk}</Badge>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {taskEntries.length > 0 && (
            <ul className="divide-y divide-hairline" aria-label="Plan tasks" data-testid="plan-tasks-list">
              {taskEntries.map(([owner, desc]) => (
                <li key={owner} className="py-1.5 first:pt-0 last:pb-0 text-[12px] flex items-baseline gap-2 min-w-0">
                  <span className="font-medium text-ink shrink-0">@{owner}</span>
                  <span className="text-ink-2 break-words min-w-0">{maskHome(desc)}</span>
                </li>
              ))}
            </ul>
          )}
          {plan.workstreams.length > 0 && (
            <ul className="divide-y divide-hairline" aria-label="Workstreams">
              {plan.workstreams.map((ws, i) => (
                <li key={ws.id || i} className="row py-2 first:pt-1 last:pb-0">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-ink truncate">{maskHome(ws.title)}</p>
                    {ws.owner && <p className="t3">@{ws.owner}</p>}
                    {ws.note && <p className="t3 break-words">{maskHome(ws.note)}</p>}
                  </div>
                  <Badge tone={WORKSTREAM_TONE[String(ws.status || "pending").toLowerCase()] || "neutral"}>
                    {humanizeStatus(ws.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          {plan.milestones.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {plan.milestones.map((ms, idx) => {
                const tone = WORKSTREAM_TONE[String(ms.status || "").toLowerCase()] || "neutral";
                return (
                  <Badge key={idx} tone={tone}>
                    <StatusDot state={tone === "success" ? "ok" : "waiting"} />
                    {maskHome(ms.title)} ({humanizeStatus(ms.status)})
                  </Badge>
                );
              })}
            </div>
          )}
          {plan.risks.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {plan.risks.map((risk, idx) => (
                <Badge key={idx} tone={risk.severity === "high" ? "danger" : risk.severity === "med" ? "warning" : "neutral"}>
                  <AlertTriangle />
                  {maskHome(risk.title)}
                </Badge>
              ))}
            </div>
          )}
        </Card>
      )}
    </section>
  );
}

function unstickPresetFor(item: TriageItem): Array<{ label: string; prompt: string }> {
  const ref = item.seq > 0 ? ` (#${item.seq})` : "";
  if (item.kind === "quota") return [
    { label: "Resume", prompt: `@${item.member} Quota clear${ref}. Resume.` },
    { label: "Handoff", prompt: `@${item.member} Summarize status${ref}.` },
  ];
  if (item.kind !== "question" && item.kind !== "verify") return [
    { label: "Unstick", prompt: `@${item.member} ${item.kind}${ref}: isolate failure or continue.` },
    { label: "Status", prompt: `@${item.member} Share error and files touched${ref}.` },
  ];
  return [
    { label: "Follow up", prompt: item.suggestedPrompt },
    { label: "Proceed", prompt: `@${item.member} Approved${ref}. Proceed and post [done].` },
  ];
}

export function TriageView({
  snap,
  pinnedSeqs,
  selectedIdx = 0,
  replyNonce = 0,
  onSelectIdx,
  onTogglePin,
  onJumpToBoardSeq,
  onCopyHandoffDigest,
  onExportArchive,
  onRefresh,
}: {
  snap: SwarmSnapshot;
  pinnedSeqs: number[];
  selectedIdx?: number;
  replyNonce?: number;
  onSelectIdx?: (idx: number) => void;
  onTogglePin: (seq: number) => void;
  onJumpToBoardSeq: (seq: number, agent?: string) => void;
  onCopyHandoffDigest?: () => void;
  onExportArchive?: (format: "md" | "json") => void;
  onRefresh: () => void;
}) {
  const [nudgeTarget, setNudgeTarget] = useState<{ id: string; member: string; conversationId: string; kind?: string } | null>(null);
  const [nudgeDraft, setNudgeDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [peekId, setPeekId] = useState<string | null>(null);
  const nudgeLockRef = useRef(false);
  const nowMs = useNowMs();
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);

  const triage = snap.triage || [];
  const plan = normalizePlan(snap.plan);
  const frames = snap.frames || [];
  const pinnedSet = new Set(pinnedSeqs);
  const pinnedMsgs = (snap.messages || []).filter((m) => !m.control && pinnedSet.has(m.seq));
  const memberByName = new Map((snap.members || []).map((m) => [m.name, m]));
  const canNudge = canLiveNudge(snap);

  useEffect(() => {
    const el = cardRefs.current[selectedIdx];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  useEffect(() => {
    if (!replyNonce) return;
    const item = triage[selectedIdx];
    if (!item) return;
    const prefix = `@${item.member}${item.seq > 0 ? ` Re #${item.seq}` : ""}: `;
    if (canNudge && item.conversationId) {
      setNudgeTarget(item);
      setNudgeDraft(prefix);
    } else {
      handleCopy(prefix, `Copied reply prefix for @${item.member}`);
    }
  }, [replyNonce]);

  const renderComposer = (headerRight?: React.ReactNode) =>
    nudgeTarget ? (
      <InlineComposer
        id={nudgeTarget.id}
        label={nudgeTarget.kind === "recover" ? `Recover @${nudgeTarget.member}` : `@${nudgeTarget.member}`}
        value={nudgeDraft}
        onChange={setNudgeDraft}
        onCancel={() => setNudgeTarget(null)}
        onSubmit={handleConfirmNudge}
        submitLabel={sending ? "Sending..." : "Confirm & send"}
        disabled={sending}
        headerRight={headerRight}
      />
    ) : null;

  const openNudge = (item: TriageItem, customPrompt?: string) => {
    setNudgeTarget(item);
    setNudgeDraft(customPrompt ?? item.suggestedPrompt);
  };

  const handleConfirmNudge = async () => {
    if (nudgeLockRef.current || !nudgeTarget) return;
    nudgeLockRef.current = true;
    try {
      await submitNudge(nudgeTarget.conversationId, nudgeDraft, `Sent nudge to ${nudgeTarget.member}`, setSending, () => {
        setNudgeTarget(null);
        setNudgeDraft("");
        onRefresh();
      });
    } finally {
      nudgeLockRef.current = false;
    }
  };

  const handleCopy = (text: string, label = "Copied") => {
    void copyText(text, label);
  };

  const liveMembers = (snap.members || []).filter((m) => !m.killed);
  const blockedNames = new Set(
    triage.filter((t) => t.severity === "urgent" || t.kind === "blocked" || t.kind === "stuck").map((t) => t.member),
  );
  const blockedCount = Math.max(blockedNames.size, triage.filter((t) => t.severity === "urgent" || t.kind === "blocked").length);
  const workingCount = liveMembers.filter((m) => m.status === "working" && !blockedNames.has(m.name)).length;
  const waitingCount = liveMembers.filter((m) => m.status === "waiting" && !blockedNames.has(m.name)).length;
  const heatTotal = Math.max(1, workingCount + waitingCount + blockedCount);
  const topBlocker = triage.find((t) => (t.severity === "urgent" || t.kind === "blocked") && t.seq > 0) || triage.find((t) => t.seq > 0);
  const buckets = [
    { label: "working", count: workingCount, cls: "bg-blue" },
    { label: "waiting", count: waitingCount, cls: "bg-warn" },
    { label: "blocked", count: blockedCount, cls: "bg-danger" },
  ];
  const recoveryMembers = liveMembers.filter((m) => {
    if (m.roleWorker || m.narrator || m.role === "coordinator") return false;
    const { isStalled } = memberMeta(m, nowMs);
    return isStalled || Boolean(m.failure) || (m.status === "waiting" && m.unread > 0);
  });

  const triggerMemberRecover = (m: SwarmMember) => {
    const prompt = buildRecoverPrompt(m);
    if (canNudge && m.conversation_id) {
      const id = `recover-${m.name}`;
      setNudgeTarget((cur) => (cur?.id === id ? null : { id, member: m.name, conversationId: m.conversation_id, kind: "recover" }));
      setNudgeDraft(prompt);
    } else {
      handleCopy(prompt, `Copied recovery prompt for @${m.name}`);
    }
  };

  return (
    <div className="space-y-4">
      {/* Needs-You Triage Inbox */}
      <section aria-labelledby="triage-heading" className="space-y-2">
        <div className="space-y-1.5">
          <div className="row flex-wrap gap-2">
            <h2 id="triage-heading" className="h2">
              Needs you ({triage.length})
            </h2>
            {triage.length === 0 ? (
              <Badge tone="success">
                <CheckCircle2 />
                All clear
              </Badge>
            ) : (
              <div className="hidden sm:flex items-center gap-2 t3 mono">
                {["j/k move", "o chat", "p pin", "r reply", "? help"].map((k) => <span key={k}>{k}</span>)}
              </div>
            )}
          </div>
          {(onCopyHandoffDigest || onExportArchive) && (
            <div className="f1 flex-wrap">
              {onCopyHandoffDigest && (
                <Button variant="outline" data-testid="copy-handoff-digest" onClick={onCopyHandoffDigest}>
                  <ClipboardCopy />
                  Handoff Digest
                </Button>
              )}
              {onExportArchive && (
                <>
                  <Button variant="outline" data-testid="export-archive-md" onClick={() => onExportArchive("md")}>
                    <ArrowDown />
                    Archive .md
                  </Button>
                  <Button variant="outline" data-testid="export-archive-json" onClick={() => onExportArchive("json")}>
                    <ArrowDown />
                    Archive .json
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        {(liveMembers.length > 0 || triage.length > 0) && (
          <Card className="p-2 space-y-1" data-testid="bottleneck-heat-bar">
            <div className="row flex-wrap text-[12px]">
              <div className="wrap gap-2 text-ink-2">
                {buckets.map((b) => (
                  <span key={b.label} className="inline-flex items-center gap-1">
                    <span className={cn("h-2 w-2 rounded-full", b.cls)} aria-hidden="true" />
                    <span className="num">{b.count}</span> {b.label}
                  </span>
                ))}
              </div>
              {topBlocker && (
                <Button data-testid="top-blocker-jump" onClick={() => onJumpToBoardSeq(topBlocker.seq)} className="bg-board num">
                  Top #{topBlocker.seq}
                  <ArrowUpRight className="h-3 w-3" />
                </Button>
              )}
            </div>
            <SegBar
              segments={buckets.map((b) => ({ key: b.label, pct: (b.count / heatTotal) * 100, cls: b.cls }))}
              label={`Swarm activity: ${workingCount} working, ${waitingCount} waiting, ${blockedCount} blocked`}
            />
          </Card>
        )}

        <TokenBurnStrip snap={snap} />

        {recoveryMembers.length > 0 && (
          <Card className="p-2 space-y-1" data-testid="worker-recovery-strip">
            <div className="row flex-wrap t2">
              <span className="font-semibold text-ink">Worker attention ({recoveryMembers.length})</span>
              <span className="t3">Idle, unread, or stalled</span>
            </div>
            <div className="space-y-1">
              {recoveryMembers.slice(0, 4).map((m) => {
                const { isStalled } = memberMeta(m, nowMs);
                const issue = m.failure ? m.failure.kind : isStalled ? "stalled" : `${m.unread} unread`;
                return (
                  <div key={m.name} className="space-y-1">
                    <div className="f1">
                      <Button
                        variant={m.failure || isStalled ? "danger" : "info"}
                        data-testid={`recover-worker-${m.name}`}
                        onClick={() => triggerMemberRecover(m)}
                      >
                        {canNudge && m.conversation_id ? <Wrench /> : <ClipboardCopy />}
                        Recover @{m.name} · {issue}
                      </Button>
                      <Button
                        variant="ghost"
                        data-testid={`jump-worker-${m.name}`}
                        onClick={() => onJumpToBoardSeq(m.lastPostSeq || 0, m.name)}
                        className="bg-board num"
                      >
                        {m.lastPostSeq > 0 ? `#${m.lastPostSeq}` : `@${m.name}`}
                        <ArrowUpRight />
                      </Button>
                    </div>
                    <MemberActivityLine member={m} testId={`triage-activity-peek-${m.name}`} />
                  </div>
                );
              })}
            </div>
            {nudgeTarget?.kind === "recover" && renderComposer()}
          </Card>
        )}

        <GateReadinessCard snap={snap} onJump={onJumpToBoardSeq} onRefresh={onRefresh} />

        {triage.length === 0 ? (
          <Card className="p-3 bg-board">
            <p className="text-[14px] text-ink-2">No blockers or unverified items.</p>
          </Card>
        ) : (
          <div className="space-y-2">
            {triage.map((item, idx) => {
              const isSelected = idx === selectedIdx;
              const isPinned = item.seq > 0 && pinnedSet.has(item.seq);
              const sev = SEVERITY_BADGE[item.severity] || SEVERITY_BADGE.attention;
              const editingThis = nudgeTarget?.id === item.id;
              const worker: SwarmMember | undefined = memberByName.get(item.member);
              const peeking = peekId === item.id;
              const tools = worker?.recentTools || [];
              const presets = unstickPresetFor(item);
              const { cleanText: cleanDetail, shots: detailShots } = parseScreenshotLines(safePlanText(item.detail));
              const paths = extractLocalFilePaths(cleanDetail);
              const { elapsed, isStalled: memberStalled } = memberMeta(worker, nowMs);
              const isStalled = item.kind === "stuck" || memberStalled;
              const askStatusPrompt = `@${item.member} Status & blockers${item.seq > 0 ? ` (#${item.seq})` : ""}?`;

              return (
                <Card
                  key={item.id}
                  ref={(el) => {
                    cardRefs.current[idx] = el;
                  }}
                  data-selected={isSelected ? "true" : undefined}
                  onClick={() => onSelectIdx?.(idx)}
                  className={cn("p-3 space-y-2", isSelected && "border-blue outline-1 outline-blue")}
                >
                  <div className="space-y-1">
                    <div className="wrap">
                      <Badge tone={sev.tone}>
                        <sev.Icon />
                        {sev.label}
                      </Badge>
                      {worker && !worker.killed && (
                        <Badge tone={worker.status === "working" ? "success" : "neutral"}>
                          {worker.status}{elapsed ? ` ${elapsed}` : ""}
                        </Badge>
                      )}
                      {isStalled && <Badge tone="danger">stalled</Badge>}
                      <span className="text-[12px] font-medium text-ink-2 num">{item.timestamp ? fmtTimeAgo(item.timestamp) : "now"}</span>
                    </div>
                    <p className="text-[14px] font-medium text-ink break-words">{item.title}</p>
                  </div>

                  {cleanDetail && <p className="text-[13px] text-ink-2 break-words leading-snug">{cleanDetail}</p>}

                  <MediaPathChips shots={detailShots} paths={paths} onOpen={openOrCopyPath} />

                  {(() => {
                    const live = Boolean(canNudge && item.conversationId);
                    const urgent = item.severity === "urgent";
                    return (
                  <div className="wrap pt-1">
                    {item.conversationId && window.sidecar?.ui?.toggleConversation && (
                      <Button variant="primary" onClick={() => openWorkerConversation(item.conversationId)}>
                        <MessageSquare />
                        Open chat
                      </Button>
                    )}
                    <Button onClick={() => live ? openNudge(item, presets[0].prompt) : handleCopy(presets[0].prompt, "Follow-up prompt copied")}>
                      {!live ? <ClipboardCopy /> : urgent ? <Wrench /> : <Send />}
                      {live ? (urgent ? presets[0].label : "Nudge") : `Copy ${urgent ? presets[0].label.toLowerCase() : "follow-up"}`}
                    </Button>
                    <Button variant="ghost" onClick={() => live ? openNudge(item, askStatusPrompt) : handleCopy(askStatusPrompt, "Status prompt copied")}>
                      Ask status
                    </Button>
                    {item.kind !== "question" && (
                      <Button variant="ghost" data-testid={`copy-blocker-${item.id}`} onClick={() => handleCopy(formatBlockerContext(item, worker, snap), "Blocker context copied")}>
                        <ClipboardCopy />
                        Copy blocker
                      </Button>
                    )}
                    {worker && (tools.length > 0 || worker.thinkingHeading) && (
                      <Button variant="ghost" aria-expanded={peeking} onClick={() => setPeekId(peeking ? null : item.id)}>
                        {peeking ? <ChevronUp /> : <ChevronDown />}
                        Peek
                      </Button>
                    )}
                    {item.seq > 0 && (
                      <div className="f1 ml-auto">
                        <Button variant="ghost" aria-pressed={isPinned} aria-label={isPinned ? `Unpin #${item.seq}` : `Pin #${item.seq}`} onClick={() => onTogglePin(item.seq)} className="px-2">
                          {isPinned ? <PinOff /> : <Pin />}
                        </Button>
                        <Button variant="ghost" onClick={() => onJumpToBoardSeq(item.seq)} className="num">
                          #{item.seq}
                          <ArrowUpRight />
                        </Button>
                      </div>
                    )}
                  </div>
                    );
                  })()}

                  {peeking && worker && <ActivityPeek member={worker} mode="triage" />}

                  {editingThis && renderComposer(
                    <div className="wrap gap-1">
                      {presets.map((p) => (
                        <Pill key={p.label} onClick={() => setNudgeDraft(p.prompt)} className="text-ink hover:bg-hairline">
                          {p.label}
                        </Pill>
                      ))}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* Narrator View Summary */}
      <NarratorViewSection snap={snap} />

      {/* Pinned Board Posts */}
      {pinnedMsgs.length > 0 && (
        <section aria-labelledby="pinned-triage-heading" className="space-y-2">
          <div className="f1">
            <Pin className="text-info" />
            <h2 id="pinned-triage-heading" className="h2">Pinned posts ({pinnedMsgs.length})</h2>
          </div>
          <Card className="p-2"><PinnedList messages={pinnedMsgs} onJump={onJumpToBoardSeq} onUnpin={onTogglePin} /></Card>
        </section>
      )}

      {/* Coordinator Plan, Threads, Tasks & Live Editor */}
      <SwarmPlanSection snap={snap} plan={plan} onRefresh={onRefresh} />

      {/* Screenshot Reel */}
      {frames.length > 0 && (
        <section aria-labelledby="reel-heading" className="space-y-2">
          <div className="f1">
            <ImageIcon className="text-ink-3" />
            <h2 id="reel-heading" className="h2">Verified captures ({frames.length})</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {frames.map((frame) => (
              <Card key={frame.path} className="overflow-hidden">
                <div className="bg-board border-b border-hairline aspect-video flex items-center justify-center overflow-hidden">
                  <img
                    src={`/api/frame?conversationId=${encodeURIComponent(snap.swarm || snap.conversationId || "")}&path=${encodeURIComponent(frame.path)}`}
                    alt={frame.caption || `Screenshot from #${frame.seq}`}
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="row px-2 py-2">
                  <span className="text-[12px] text-ink-2 truncate">{frame.caption || frame.path.split("/").pop()}</span>
                  <div className="f1 shrink-0">
                    <Button aria-label={`Open ${frame.caption || "capture"} file`} onClick={() => openOrCopyPath(frame.path, frame.path)}>
                      <ExternalLink />
                      Open file
                    </Button>
                    <Button variant="ghost" className="num" onClick={() => onJumpToBoardSeq(frame.seq)}>#{frame.seq}</Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
