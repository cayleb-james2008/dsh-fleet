// Fleet: the board. Top bar (wordmark, version, search, Needs you inbox, New session, engines, theme), the update strip,
// the scan strip (readings and recent sessions), the control room wall (a live pane per running or waiting session,
// receipts docked below), and the session detail (pinned on the wall on wide screens, a drawer on narrow ones).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { Drawer } from "vaul";
import { Search, Plus, Sun, Moon, Cpu, ScanLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SlidingNumber } from "@/components/ui/sliding-number";
import {
  MorphingDialog, MorphingDialogClose, MorphingDialogContainer, MorphingDialogContent,
  MorphingDialogDescription, MorphingDialogTitle, MorphingDialogTrigger,
} from "@/components/ui/morphing-dialog";
import { Tracker } from "@/components/Tracker/Tracker";
import { AvatarStack } from "@/components/kibo-ui/avatar-stack";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { glide } from "@/motion";
import { cn } from "@/lib/utils";
import { getJson, isFailed, isVerified, postJson, type Agent, type Policy, type Session, statusText } from "./api";
import { DetailBody } from "./detail";
import { Wall } from "./wall";
import { resultLine as resultLineOf, UpdateStrip, useUpdate } from "./update";

type Theme = "dark" | "light";
const THEME_KEY = "fleet-theme";
const TEST_NOTE = "Test mode: a script stands in for a coding agent, so nothing here used a real model.";

// Light is the default (owner colour and theme alignment); dark is the full second theme.
function readTheme(): Theme {
  try { return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light"; } catch { return "light"; }
}

export function App() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [lastGood, setLastGood] = useState<Date | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inbox, setInbox] = useState<Session[]>([]);
  const [inboxErr, setInboxErr] = useState<Record<string, string>>({});
  const wide = useMediaQuery("(min-width: 1100px)");
  const md = useMediaQuery("(min-width: 768px)");
  const upd = useUpdate();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* theme still applies for this view */ }
  }, [theme]);

  const refresh = useCallback(async () => {
    // The same three reads the old page made every two seconds: policy, the session list and the Needs you inbox.
    const [pol, list, inb] = await Promise.all([getJson<Policy>("/api/policy"), getJson<Session[]>("/api/sessions"), getJson<Session[]>("/api/inbox")]);
    if (pol && Array.isArray(pol.agents)) setPolicy(pol);
    if (Array.isArray(inb)) setInbox(inb);
    if (Array.isArray(list)) { setSessions(list); setLastGood(new Date()); setUnreachable(false); }
    else setUnreachable(true);
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault(); searchRef.current?.focus();
      }
      if (e.key === "Escape" && selected && !document.querySelector('[role="dialog"]')) setSelected(null);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [selected]);

  const all = sessions ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((s) => [s.task, s.project, s.branch].some((v) => (v || "").toLowerCase().includes(q)));
  }, [all, query]);
  const current = selected ? all.find((s) => s.id === selected) ?? null : null;
  useEffect(() => { if (selected && sessions && !current) setSelected(null); }, [selected, sessions, current]);
  const verifiedCount = all.filter(isVerified).length;
  const needsAll = all.filter((s) => s.bucket === "needs-you");
  const workingAll = all.filter((s) => s.bucket === "working" && s.status !== "queued");
  const needsCount = needsAll.length;
  const workingCount = all.filter((s) => s.bucket === "working").length;
  const testMode = policy?.default_agent_engine === "custom" || all.some((s) => s.test_mode);

  const open = (id: string) => { setSelected(id); };
  // Focus goes to the first pane that waits on a person (the inbox's "go"), or back to the opener of a closed session.
  const focusLane = () => requestAnimationFrame(() => (document.querySelector<HTMLElement>('section[aria-label="Live panes"] article button') ?? document.getElementById("receipts-h"))?.focus());
  const closeDetail = () => {
    const id = selected;
    setSelected(null);
    requestAnimationFrame(() => (document.querySelector<HTMLElement>(`[data-open="${id}"]`) ?? document.getElementById("receipts-h"))?.focus());
  };
  const retry = async (id: string) => {
    const e = await postJson(`/api/sessions/${id}/retry`);
    setInboxErr((m) => ({ ...m, [id]: e || "" }));
    if (e) toast.error(e); else toast.success("Retrying the session");
    refresh();
  };
  const dismiss = async (id: string) => {
    const e = await postJson(`/api/sessions/${id}/dismiss`);
    if (e) toast.error(e); else { toast.success("Dismissed. Its log stays on disk."); if (selected === id) setSelected(null); }
    refresh();
    focusLane();
  };

  const detailBody = current && (
    <DetailBody s={current} onClose={closeDetail} onChanged={refresh} onDismissed={() => dismiss(current.id)} />
  );

  return (
    <TooltipProvider>
      <div className="flex min-h-dvh flex-col bg-canvas text-ink">
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline bg-surface px-4 py-2.5 md:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <ScanLine className="size-5 text-ink" strokeWidth={1.5} aria-hidden />
            <h1 className="font-heading text-[20px] font-light tracking-[-0.035em] text-ink">Fleet</h1>
            {upd.version && (
              <a
                href={`https://github.com/cayleb-james2008/dsh-fleet/releases/tag/v${upd.version}`}
                target="_blank"
                rel="noopener"
                className="ml-1 hidden min-h-9 items-center font-mono text-xs text-ink-3 hover:text-ink-2 md:inline-flex"
              >
                Fleet {upd.version}
              </a>
            )}
            {testMode && (
              <Badge variant="warning" size="sm" title={TEST_NOTE} className="shrink-0">test mode</Badge>
            )}
            {upd.hidden && upd.snap?.available && upd.dismissed && (
              <Button id="show-update" size="sm" variant="ghost" onClick={upd.show}>Show update</Button>
            )}
          </div>
          <InputGroup className="order-last flex h-11 w-full md:order-none md:ml-auto md:h-9 md:w-56 lg:w-72">
            <InputGroupAddon><Search className="size-4 text-icon" strokeWidth={1.5} aria-hidden /></InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              type="search"
              aria-label="Search sessions"
              placeholder="Search tasks, projects, branches"
              className="max-md:[&_input]:!h-11 max-md:!h-11"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <InputGroupAddon align="inline-end"><Kbd>/</Kbd></InputGroupAddon>
          </InputGroup>
          <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 md:ml-0">
            <InboxPopover inbox={inbox} errs={inboxErr} onView={open} onRetry={retry} onGo={focusLane} side="bottom" className="hidden md:inline-flex" />
            <span data-answers-via="4" className="hidden md:inline-flex">
              <NewSession policy={policy} onHanded={(id) => { setSelected(id); refresh(); }} />
            </span>
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="outline" size="icon" id="settings-open" className="max-md:size-11" aria-label="Engines and settings" onClick={() => setSettingsOpen(true)} />}
              >
                <Cpu className="size-4" strokeWidth={1.5} aria-hidden />
              </TooltipTrigger>
              <TooltipPopup>Engines and settings</TooltipPopup>
            </Tooltip>
            <SegmentedControl aria-label="Theme" size="sm" id="themeBtn">
              {(["light", "dark"] as const).map((t) => (
                <SegmentedControlItem
                  key={t}
                  aria-pressed={theme === t}
                  data-checked={theme === t ? "" : undefined}
                  onClick={() => setTheme(t)}
                  aria-label={t === "light" ? "Light theme" : "Dark theme"}
                  className="max-md:!h-11 max-md:!min-w-11"
                >
                  {t === "light" ? <Sun className="size-4" strokeWidth={1.5} aria-hidden /> : <Moon className="size-4" strokeWidth={1.5} aria-hidden />}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </div>
        </header>

        <UpdateStrip u={upd} />

        <section aria-label="Scan" className="grid grid-cols-2 border-b border-hairline md:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.7fr)]">
          <Reading label="Sessions" value={all.length} />
          <Reading label="Needs you" value={needsCount} tone={needsCount ? "bad" : undefined} />
          <div className="min-w-0 border-r border-hairline">
            <Reading label="Working" value={workingCount} />
            <div className="mt-2 min-h-6 px-4 pb-3">
              {workingAll.length >= 2 ? (
                <AvatarStack>
                  {workingAll.slice(0, 4).map((s) => (
                    <Avatar key={s.id} className="size-6 ring-2 ring-surface">
                      <AvatarFallback className="text-xs">{(s.engine || s.agent || "a").slice(0, 1).toUpperCase()}</AvatarFallback>
                    </Avatar>
                  ))}
                </AvatarStack>
              ) : workingAll.length === 1 ? (
                <p className="truncate font-mono text-xs text-ink-2">running {workingAll[0].engine || workingAll[0].agent || "agent"}</p>
              ) : null}
            </div>
          </div>
          <Reading label="Verified" value={verifiedCount} tone={verifiedCount ? "good" : undefined} />
          <div className="col-span-2 flex min-w-0 flex-col justify-center gap-2 px-4 py-3 md:col-span-1">
            <p className="text-sm text-ink-2">Recent sessions</p>
            {all.length ? (
              <Tracker
                className="h-6"
                data={all.slice(0, 32).map((s) => ({
                  key: s.id,
                  color: isVerified(s) ? "bg-dot-green" : isFailed(s) ? "bg-unread" : s.bucket === "needs-you" ? "bg-dot-clay" : s.status === "queued" ? "bg-dot-amber" : s.bucket === "working" ? "bg-ink-3" : "bg-track",
                  tooltip: `${s.task}: ${statusText(s)}`,
                }))}
              />
            ) : (
              <div className="h-6 rounded-control bg-track" aria-hidden />
            )}
          </div>
        </section>

        {unreachable && (
          <p role="status" className="border-b border-hairline bg-pill-pro-bg px-4 py-2 text-sm text-destructive-foreground md:px-6">
            {lastGood
              ? `Cannot reach Fleet. Showing the last list from ${lastGood.toLocaleTimeString()}. Retrying.`
              : "Cannot reach Fleet. Retrying."}
          </p>
        )}

        <div className="min-w-0 flex-1 pb-28 md:pb-0">
          <Wall sessions={sessions === null ? null : shown} selected={selected} pinWide={wide} detail={wide ? detailBody : null}
            onOpen={open} onRetry={retry} onDismiss={dismiss} />
          {sessions !== null && all.length > 0 && !shown.length && (
            <p role="status" className="px-4 pb-4 text-sm text-ink-2 md:px-6">No session matches “{query.trim()}”.</p>
          )}
        </div>

        {!wide && (
          <Drawer.Root open={!!current} onOpenChange={(o) => { if (!o) closeDetail(); }}>
            <Drawer.Portal>
              <Drawer.Overlay className="fixed inset-0 z-40 bg-canvas/60" />
              <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-panel border-t border-hairline bg-surface text-ink outline-none">
                <Drawer.Handle className="mx-auto mt-3 !h-1 !w-10 !bg-track" />
                <Drawer.Title className="sr-only">{current?.task || "Session details"}</Drawer.Title>
                <div className="flex-1 overflow-y-auto p-4">{detailBody}</div>
              </Drawer.Content>
            </Drawer.Portal>
          </Drawer.Root>
        )}

        <Drawer.Root direction="right" open={settingsOpen} onOpenChange={setSettingsOpen}>
          <Drawer.Portal>
            <Drawer.Overlay className="fixed inset-0 z-40 bg-canvas/60" />
            <Drawer.Content id="settings" className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[420px] flex-col border-l border-hairline bg-surface text-ink outline-none">
              <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
                <Drawer.Title className="font-heading text-xl font-light text-ink">Engines and settings</Drawer.Title>
                <Drawer.Close asChild>
                  <Button variant="ghost" size="icon" aria-label="Close settings"><X className="size-4" strokeWidth={1.5} aria-hidden /></Button>
                </Drawer.Close>
              </div>
              <div className="flex-1 space-y-6 overflow-y-auto p-5">
                <Drawer.Description className="text-sm leading-relaxed text-ink-2">
                  {policy
                    ? `Up to ${policy.max_parallel} sessions run at once. An agent or check that runs past ${policy.timeout_secs} seconds is handed back to Needs you. Checks come from ${policy.source}. ${policy.default_agent ? `Default agent: ${policy.default_agent_engine === "custom" ? "a custom command (test mode)" : policy.default_agent}.` : "No default agent is set."}`
                    : "Loading policy"}
                </Drawer.Description>
                <section>
                  <h2 className="mb-2 text-sm font-medium text-ink">What this machine can run</h2>
                  <ul className="divide-y divide-hairline rounded-card border border-hairline">
                    {(policy?.agents ?? []).length === 0 && <li className="p-3 text-sm text-ink-2">No agents are configured. Test mode runs a custom command from the policy file.</li>}
                    {(policy?.agents ?? []).map((a) => (
                      <li key={a.name} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                        <span className="min-w-0 truncate font-mono text-ink">{a.name}</span>
                        <span className={cn("shrink-0 text-xs", a.found ? "text-ink" : "text-ink-3")}>{a.found ? "found on this machine" : "not installed"}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-ink-3">{TEST_NOTE}</p>
                </section>
                <section className="border-t border-hairline pt-5">
                  <h2 className="mb-2 text-sm font-medium text-ink">Version and updates</h2>
                  <div className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
                    {upd.version && <span className="font-mono text-ink">Fleet {upd.version}</span>}
                    <Button variant="outline" size="sm" onClick={upd.check} disabled={upd.checking || upd.snap?.mode === "off"}>Check for updates</Button>
                  </div>
                  <p className="mt-2 text-sm text-ink-2" role="status">{upd.snap && !upd.live ? resultLineOf(upd.snap) : upd.live}</p>
                </section>
              </div>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>

        {/* Phone: the two board actions sit in a bottom bar; the lanes get bottom padding so nothing covers them. */}
        <nav aria-label="Board actions" className="fixed inset-x-0 bottom-0 z-30 flex gap-2 border-t border-hairline bg-surface px-4 pt-2 md:hidden" style={{ paddingBottom: "max(8px, env(safe-area-inset-bottom))" }}>
          <InboxPopover inbox={inbox} errs={inboxErr} onView={open} onRetry={retry} onGo={focusLane} side="top" className="h-11 flex-1 justify-center" />
          <NewSession policy={policy} onHanded={(id) => { setSelected(id); refresh(); }} className="h-11 flex-1 justify-center" />
        </nav>

        <Toaster position={md ? "bottom-right" : "top-center"} theme={theme} style={{ "--normal-bg": "var(--surface)", "--normal-text": "var(--ink)", "--normal-border": "var(--hairline)", "--border-radius": "10px", fontSize: "14px" } as React.CSSProperties} />
      </div>
    </TooltipProvider>
  );
}

function Reading({ label, value, tone }: { label: string; value: number; tone?: "bad" | "good" }) {
  return (
    <div className="border-r border-hairline px-4 py-3 last:border-r-0">
      <p className="text-sm text-ink-2">{label}</p>
      <div className={cn("mt-1 border-l-2 font-heading text-[28px] font-light leading-none tabular-nums", tone === "bad" ? "border-unread pl-2 text-destructive-foreground" : tone === "good" ? "border-dot-green pl-2 text-ink" : "border-transparent pl-0 text-ink")}>
        <SlidingNumber value={value} />
      </div>
    </div>
  );
}

function NewSession({ policy, onHanded, className }: { policy: Policy | null; onHanded: (id: string) => void; className?: string }) {
  const wrap = useRef<HTMLSpanElement>(null);
  // The dialog does not return focus to its trigger by itself; the form hands focus back when it closes.
  const returnFocus = () => wrap.current?.querySelector<HTMLElement>("button")?.focus();
  return (
    <span ref={wrap} className="contents">
    <MorphingDialog transition={glide}>
      <MorphingDialogTrigger className={cn("inline-flex h-9 cursor-pointer items-center gap-2 whitespace-nowrap rounded-control bg-blue px-3.5 text-sm font-medium text-blue-fg outline-none transition-colors duration-(--dur-press) ease-(--ease-house) hover:bg-blue-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface", className)}>
        <Plus className="size-4" strokeWidth={1.5} aria-hidden />
        <span>New session</span>
      </MorphingDialogTrigger>
      <MorphingDialogContainer>
        <MorphingDialogContent className="relative flex max-h-[calc(100dvh-32px)] w-full max-w-[560px] flex-col overflow-hidden rounded-dialog border border-hairline bg-surface text-ink">
          <Composer policy={policy} onHanded={onHanded} onClosed={returnFocus} />
        </MorphingDialogContent>
      </MorphingDialogContainer>
    </MorphingDialog>
    </span>
  );
}

/** Agent choice from the house parts: a SegmentedControl for up to three agents, else a popover list. */
function AgentPicker({ agents, value, onChange, testDefault }: { agents: Agent[]; value: string; onChange: (v: string) => void; testDefault: boolean }) {
  const items = ["", ...agents.filter((a) => a.found).map((a) => a.name)];
  const label = (v: string) => (v ? v : testDefault ? "Test script" : "Default");
  if (items.length === 1) {
    // Only the default agent is installed: there is no choice to make, so say what will run.
    return <p className="rounded-control border border-hairline bg-canvas px-3 py-2 text-sm text-ink">{label("")}</p>;
  }
  if (items.length <= 3) {
    return (
      <SegmentedControl aria-label="Agent" size="sm">
        {items.map((v) => (
          <SegmentedControlItem key={v || "default"} aria-pressed={value === v} data-checked={value === v ? "" : undefined} onClick={() => onChange(v)}>
            {label(v)}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    );
  }
  return (
    <Popover>
      <PopoverTrigger className="inline-flex h-9 w-full cursor-pointer items-center justify-between rounded-control border border-input bg-canvas px-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {label(value)}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 rounded-control border border-hairline bg-surface p-1 text-ink">
        {items.map((v) => (
          <button key={v || "default"} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={cn("flex h-9 w-full items-center rounded-sm px-2.5 text-left text-sm outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring", value === v && "font-medium")}>
            {label(v)}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function Composer({ policy, onHanded, onClosed }: { policy: Policy | null; onHanded: (id: string) => void; onClosed: () => void }) {
  useEffect(() => () => onClosed(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [repo, setRepo] = useState("");
  const [project, setProject] = useState("fixture");
  const [agent, setAgent] = useState("");
  const [task, setTask] = useState("");
  const [check, setCheck] = useState("");
  const [next, setNext] = useState("");
  const [formErr, setFormErr] = useState("");
  const [repoErr, setRepoErr] = useState("");
  const [busy, setBusy] = useState(false);
  const repoRef = useRef<HTMLInputElement>(null);
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const testDefault = policy?.default_agent_engine === "custom";

  useEffect(() => { repoRef.current?.focus(); }, []);

  const submit = async () => {
    if (busy) return;
    setRepoErr(""); setFormErr("");
    const problems: string[] = [];
    if (!repo.trim()) problems.push("Give the repo path: the folder of the git repository the agent works in.");
    if (!task.trim()) problems.push("Write the task: say what the agent should do.");
    if (problems.length) {
      setFormErr(problems.join(" "));
      (repo.trim() ? taskRef.current : repoRef.current)?.focus();
      return;
    }
    const body: Record<string, string> = { repo: repo.trim(), project, task: task.trim(), check };
    if (next.trim()) body.next = next.trim();
    if (agent) body.agent = agent;
    setBusy(true);
    let r: Response;
    try {
      r = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      setFormErr("Could not reach the server. Your text is still here; try again when Fleet is running.");
      setBusy(false);
      return;
    }
    setBusy(false);
    if (!r.ok) {
      let msg = "Could not hand out the task.";
      try { msg = (await r.json()).error || msg; } catch { /* keep the plain words */ }
      if (/repo|folder|git/i.test(msg)) { setRepoErr(msg); repoRef.current?.focus(); }
      else setFormErr(msg);
      return;
    }
    const s = (await r.json()) as Session;
    toast.success(`Handed out: ${s.task}`);
    document.querySelector<HTMLButtonElement>(".new-cancel")?.click();
    onHanded(s.id);
  };

  return (
    <form className="flex min-h-0 flex-col" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
        <MorphingDialogTitle className="font-heading text-xl font-light text-ink">New session</MorphingDialogTitle>
        <MorphingDialogDescription className="text-sm leading-relaxed text-ink-2">
          Fleet runs the agent in its own git worktree of this repo. When the agent stops, Fleet runs your check. The session is done only when that check passes.
        </MorphingDialogDescription>

        <Field id="repo" label="Repo path" hint="The folder of a git repository, for example /home/you/projects/app." err={repoErr}>
          <InputGroup>
            <InputGroupInput ref={repoRef} id="repo" value={repo} onChange={(e) => setRepo(e.target.value)} autoComplete="off" aria-invalid={repoErr ? true : undefined} />
          </InputGroup>
        </Field>
        <Field id="project" label="Project" hint="The policy file names this project and its check. Leave it as it is unless your policy names another.">
          <InputGroup>
            <InputGroupInput id="project" value={project} onChange={(e) => setProject(e.target.value)} autoComplete="off" />
          </InputGroup>
        </Field>
        <Field id="agent" label="Agent" hint={testDefault ? "Default agent: a test script (no real model). Engines lists what is installed." : "Only agents found on this machine are listed. Engines shows what is installed."}>
          <AgentPicker agents={policy?.agents ?? []} value={agent} onChange={setAgent} testDefault={testDefault} />
        </Field>
        <Field id="task" label="Task" hint="Say what the agent should change, in one or two sentences. Ctrl+Enter or Cmd+Enter hands it out.">
          <Textarea ref={taskRef} id="task" rows={3} value={task} onChange={(e) => setTask(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }} aria-invalid={!task.trim() && !!formErr ? true : undefined} />
        </Field>
        <Field id="check" label="Check command (optional)" hint="Leave it empty to use the project’s check from the policy file. Its output becomes the receipt.">
          <InputGroup>
            <InputGroupInput id="check" value={check} onChange={(e) => setCheck(e.target.value)} autoComplete="off" placeholder="cargo test" />
          </InputGroup>
          <p className="text-xs text-ink-3">Example: <Kbd>cargo test</Kbd></p>
        </Field>
        <Field id="next" label="Then (optional)" hint="Starts on its own only when this session is verified done.">
          <InputGroup>
            <InputGroupInput id="next" value={next} onChange={(e) => setNext(e.target.value)} placeholder="The next task in the chain" autoComplete="off" />
          </InputGroup>
        </Field>
      </div>
      <div className="flex flex-col gap-3 border-t border-hairline bg-surface px-6 py-4">
        {formErr && <p role="alert" className="text-sm text-destructive-foreground">{formErr}</p>}
        <div className="flex justify-end gap-2">
          <MorphingDialogClose className="new-cancel static inline-flex h-9 cursor-pointer items-center rounded-control border border-hairline px-3.5 text-sm font-medium text-ink outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring">Cancel</MorphingDialogClose>
          <Button type="submit" disabled={busy}>Hand it out</Button>
        </div>
      </div>
    </form>
  );
}

function Field({ id, label, hint, err, children }: { id: string; label: string; hint: string; err?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium text-ink">{label}</label>
      {children}
      <p className="text-xs leading-relaxed text-ink-3">{hint}</p>
      {err && <p role="alert" className="text-sm text-destructive-foreground">{err}</p>}
    </div>
  );
}

/** Needs you: the inbox from /api/inbox (the old page's source), in a popover. Each instance keeps its own open state. */
function InboxPopover({ inbox, errs, onView, onRetry, onGo, side, className }: {
  inbox: Session[]; errs: Record<string, string>; onView: (id: string) => void; onRetry: (id: string) => void; onGo: () => void; side: "top" | "bottom"; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const n = inbox.length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Needs you, ${n}`}
        className={cn(
          "inline-flex h-9 cursor-pointer items-center gap-2 whitespace-nowrap rounded-control border px-3 text-sm font-medium outline-none transition-colors duration-(--dur-press) ease-(--ease-house) focus-visible:ring-2 focus-visible:ring-ring",
          n ? "border-unread text-destructive-foreground hover:bg-pill-pro-bg" : "border-hairline text-ink hover:bg-raised",
          className,
        )}
      >
        Needs you
        <span className="font-mono text-xs tabular-nums">{n}</span>
      </PopoverTrigger>
      <PopoverContent side={side} align={side === "top" ? "center" : "end"} sideOffset={8} className="w-full max-w-[380px] rounded-dialog border border-hairline bg-surface p-0 text-ink shadow-lift">
        <div className="p-4">
          <h2 className="font-heading text-lg font-light text-ink">Needs you</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">Sessions that need a person: a failed check, a refused merge, a stopped or timed-out run.</p>
        </div>
        <div className="max-h-[60dvh] overflow-y-auto border-t border-hairline">
          {n === 0 && <p className="p-4 text-sm text-ink-2">Nothing needs you right now. Failed checks and stopped runs appear here with the reason.</p>}
          {inbox.map((s) => (
            <div key={s.id} className="border-t border-hairline p-4 first:border-t-0">
              <p className="font-medium text-ink">{s.task}</p>
              <p className={cn("mt-1 text-sm leading-relaxed", isFailed(s) ? "text-destructive-foreground" : "text-info-foreground")}>{s.reason || "needs you"}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => { setOpen(false); onView(s.id); }}>View session</Button>
                <Button size="sm" onClick={() => onRetry(s.id)}>Retry</Button>
              </div>
              {errs[s.id] && <p role="alert" className="mt-2 text-sm text-destructive-foreground">{errs[s.id]}</p>}
            </div>
          ))}
        </div>
        <div className="border-t border-hairline p-3 text-right">
          <Button size="sm" variant="ghost" onClick={() => { setOpen(false); onGo(); }}>Go to Needs you</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
