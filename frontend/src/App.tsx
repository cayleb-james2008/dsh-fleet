// Fleet: the board. Top bar (wordmark, version, search, New session, engines, theme), the update strip, the scan strip
// (four readings and the recent sessions), the hero receipt, three lanes (Needs you, Working, Done), and the session
// detail (a column on wide screens, a drawer on narrow ones). Data: /api/policy, /api/sessions, /api/update, polled.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Toaster, toast } from "sonner";
import { Drawer } from "vaul";
import { Search, Plus, Sun, Moon, Cpu, ScanLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SlidingNumber } from "@/components/ui/sliding-number";
import {
  MorphingDialog, MorphingDialogClose, MorphingDialogContainer, MorphingDialogContent,
  MorphingDialogDescription, MorphingDialogTitle, MorphingDialogTrigger,
} from "@/components/ui/morphing-dialog";
import { Tracker } from "@/components/Tracker/Tracker";
import { Pill } from "@/components/kibo-ui/pill";
import { AvatarStack } from "@/components/kibo-ui/avatar-stack";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { layout, glide } from "@/motion";
import { cn } from "@/lib/utils";
import { getJson, isVerified, type Policy, type Session, statusText } from "./api";
import { DetailBody } from "./detail";
import { HeroReceipt, ReceiptCard } from "./receipt";
import { resultLine as resultLineOf, UpdateStrip, useUpdate } from "./update";

type Theme = "dark" | "light";
const THEME_KEY = "fleet-theme";

function readTheme(): Theme {
  try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; } catch { return "dark"; }
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
  const wide = useMediaQuery("(min-width: 1100px)");
  const upd = useUpdate();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* theme still applies for this view */ }
  }, [theme]);

  const refresh = useCallback(async () => {
    const [pol, list] = await Promise.all([getJson<Policy>("/api/policy"), getJson<Session[]>("/api/sessions")]);
    if (pol && Array.isArray(pol.agents)) setPolicy(pol);
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
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
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
  const lanes = {
    needs: shown.filter((s) => s.bucket === "needs-you"),
    working: shown.filter((s) => s.bucket === "working"),
    done: shown.filter((s) => s.bucket === "done"),
  };
  const current = selected ? all.find((s) => s.id === selected) ?? null : null;
  useEffect(() => { if (selected && sessions && !current) setSelected(null); }, [selected, sessions, current]);
  const verifiedCount = all.filter(isVerified).length;
  const needsCount = all.filter((s) => s.bucket === "needs-you").length;
  const workingCount = all.filter((s) => s.bucket === "working").length;
  const hero = lanes.done[0] ?? null;

  const open = (id: string) => { setSelected(id); };

  const detailBody = current && (
    <DetailBody s={current} onClose={() => setSelected(null)} onChanged={refresh} />
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
            {upd.hidden && upd.snap?.available && upd.dismissed && (
              <Button size="sm" variant="ghost" onClick={upd.show}>Show update</Button>
            )}
          </div>
          <InputGroup className="order-last w-full md:order-none md:ml-auto md:w-72">
            <InputGroupAddon><Search className="size-4 text-icon" strokeWidth={1.5} aria-hidden /></InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              type="search"
              aria-label="Search sessions"
              placeholder="Search tasks, projects, branches"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <InputGroupAddon align="inline-end"><Kbd>/</Kbd></InputGroupAddon>
          </InputGroup>
          <div className="ml-auto flex items-center gap-2 md:ml-0">
            <span data-answers-via="4">
              <NewSession policy={policy} onHanded={(id) => { setSelected(id); refresh(); }} />
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon"
                    id="settings-open"
                    aria-label="Engines and settings"
                    onClick={() => setSettingsOpen(true)}
                  />
                }
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
          <div className="flex items-center justify-between gap-3 border-r border-hairline px-4 py-3 md:block">
            <Reading label="Working" value={workingCount} inline />
            <span className="md:mt-2 md:block">
              <AvatarStack>
                {all.filter((s) => s.bucket === "working").slice(0, 4).map((s) => (
                  <Avatar key={s.id} className="size-6 ring-2 ring-surface">
                    <AvatarFallback className="text-xs">{(s.engine || s.agent || "a").slice(0, 1).toUpperCase()}</AvatarFallback>
                  </Avatar>
                ))}
              </AvatarStack>
            </span>
          </div>
          <Reading label="Verified" value={verifiedCount} tone={verifiedCount ? "good" : undefined} />
          <div className="col-span-2 flex min-w-0 flex-col justify-center gap-2 px-4 py-3 md:col-span-1">
            <p className="text-sm text-ink-2">Recent sessions</p>
            {all.length ? (
              <Tracker
                className="h-6"
                data={all.slice(0, 32).map((s) => ({
                  key: s.id,
                  color: isVerified(s) ? "bg-blue" : s.bucket === "needs-you" ? "bg-unread" : s.status === "queued" ? "bg-dot-amber" : s.bucket === "working" ? "bg-ink-3" : "bg-track",
                  tooltip: `${s.task}: ${statusText(s)}`,
                }))}
              />
            ) : (
              <div className="h-6 rounded-control bg-track" aria-hidden />
            )}
          </div>
        </section>

        {unreachable && (
          <p role="status" className="border-b border-hairline bg-pill-pro-bg px-4 py-2 text-sm text-unread md:px-6">
            {lastGood
              ? `Cannot reach Fleet. Showing the last list from ${lastGood.toLocaleTimeString()}. Retrying.`
              : "Cannot reach Fleet. Retrying."}
          </p>
        )}

        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <div className="p-4 md:p-6">
              <HeroReceipt s={hero} onOpen={open} newSession={<NewSession policy={policy} onHanded={(id) => { setSelected(id); refresh(); }} />} />
            </div>

            <div className="grid gap-px border-y border-hairline bg-hairline md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
                <Lane id="needs" label="Needs you" count={lanes.needs.length} empty="Nothing needs you. Failed checks and stopped runs land here with the reason." answers="1">
                  {lanes.needs.map((s) => <Card key={s.id} s={s} selected={selected === s.id} onOpen={() => open(s.id)} />)}
                </Lane>
                <Lane id="working" label="Working" count={lanes.working.length} empty="No agent is running right now." answers="2">
                  {lanes.working.map((s) => <Card key={s.id} s={s} selected={selected === s.id} onOpen={() => open(s.id)} />)}
                </Lane>
                <Lane id="done" label="Done" count={lanes.done.length} empty="Work appears here once its check passes, with the check line as its receipt." answers="3">
                  {lanes.done.map((s) => <Card key={s.id} s={s} selected={selected === s.id} onOpen={() => open(s.id)} />)}
                </Lane>
            </div>
            {sessions === null && <p className="px-4 pt-3 text-sm text-ink-2 md:px-6">Loading the board.</p>}
          </div>

          {wide && current && (
            <aside aria-label="Session details" className="sticky top-14 hidden h-[calc(100dvh-56px)] w-[460px] shrink-0 overflow-y-auto border-l border-hairline bg-surface p-6 min-[1100px]:block">
              {detailBody}
            </aside>
          )}
        </div>

        {!wide && (
          <Drawer.Root open={!!current} onOpenChange={(o) => { if (!o) setSelected(null); }}>
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
                  <p className="mt-2 text-xs text-ink-3">Test mode: a script stands in for a coding agent, so nothing here used a real model.</p>
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

        <Toaster position="bottom-right" theme={theme} style={{ "--normal-bg": "var(--surface)", "--normal-text": "var(--ink)", "--normal-border": "var(--hairline)", "--border-radius": "10px", fontSize: "14px" } as React.CSSProperties} />
      </div>
    </TooltipProvider>
  );
}

function Reading({ label, value, tone, inline }: { label: string; value: number; tone?: "bad" | "good"; inline?: boolean }) {
  return (
    <div className={cn("border-r border-hairline px-4 py-3", inline && "border-r-0 p-0")}>
      <p className="text-sm text-ink-2">{label}</p>
      <div className={cn("mt-1 border-l-2 font-heading text-[28px] font-light leading-none tabular-nums", tone === "bad" ? "border-unread pl-2 text-unread" : tone === "good" ? "border-blue pl-2 text-ink" : "border-transparent pl-0 text-ink")}>
        <SlidingNumber value={value} />
      </div>
    </div>
  );
}

function Lane({ id, label, count, empty, answers, children }: { id: string; label: string; count: number; empty: string; answers: string; children: React.ReactNode }) {
  return (
    <section id={`lane-${id}`} aria-labelledby={`lane-${id}-h`} data-answers={answers} className="flex min-w-0 flex-col gap-3 bg-canvas p-4 md:p-5">
      <div className="flex items-center gap-2">
        <h2 id={`lane-${id}-h`} className="text-base font-medium text-ink">{label}</h2>
        <Pill className="ml-auto bg-track px-2 py-0.5 font-mono text-xs tabular-nums text-ink-2">{count}</Pill>
      </div>
      {count === 0 ? (
        <p className="rounded-card border border-dashed border-hairline p-4 text-sm leading-relaxed text-ink-3">{empty}</p>
      ) : (
        <div className="flex flex-col gap-2.5">{children}</div>
      )}
    </section>
  );
}

function Card({ s, selected, onOpen }: { s: Session; selected: boolean; onOpen: () => void }) {
  return (
    <motion.div layout layoutId={s.id} transition={layout} className="min-w-0">
      <ReceiptCard s={s} selected={selected} onOpen={onOpen} />
    </motion.div>
  );
}

function NewSession({ policy, onHanded }: { policy: Policy | null; onHanded: (id: string) => void }) {
  return (
    <MorphingDialog transition={glide}>
      <MorphingDialogTrigger
        className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-control bg-blue px-3.5 text-sm font-medium text-blue-fg outline-none transition-colors duration-(--dur-press) ease-(--ease-house) hover:bg-blue-hover focus-visible:ring-2 focus-visible:ring-blue focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      >
        <Plus className="size-4" strokeWidth={1.5} aria-hidden />
        <span>New session</span>
      </MorphingDialogTrigger>
      <MorphingDialogContainer>
        <MorphingDialogContent className="relative flex max-h-[calc(100dvh-32px)] w-[min(560px,calc(100vw-24px))] flex-col overflow-hidden rounded-dialog border border-hairline bg-surface text-ink">
          <Composer policy={policy} onHanded={onHanded} />
        </MorphingDialogContent>
      </MorphingDialogContainer>
    </MorphingDialog>
  );
}

function Composer({ policy, onHanded }: { policy: Policy | null; onHanded: (id: string) => void }) {
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
    <form
      className="flex min-h-0 flex-col"
      noValidate
      onSubmit={(e) => { e.preventDefault(); submit(); }}
    >
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
        <MorphingDialogTitle className="font-heading text-xl font-light text-ink">New session</MorphingDialogTitle>
        <MorphingDialogDescription className="text-sm leading-relaxed text-ink-2">
          Fleet runs the agent in its own git worktree of this repo. When the agent stops, Fleet runs your check. The session is done only when that check passes.
        </MorphingDialogDescription>

        <Field id="repo" label="Repo path" hint="The folder of a git repository, for example /home/you/projects/app." err={repoErr}>
          <Input ref={repoRef} id="repo" value={repo} onChange={(e) => setRepo(e.target.value)} autoComplete="off" aria-invalid={!!repoErr} />
        </Field>
        <Field id="project" label="Project" hint="The policy file names this project and its check. Leave it as it is unless your policy names another.">
          <Input id="project" value={project} onChange={(e) => setProject(e.target.value)} autoComplete="off" />
        </Field>
        <Field id="agent" label="Agent" hint={testDefault ? "Default agent: a test script (no real model). Engines lists what is installed." : "Only agents found on this machine are listed. Engines shows what is installed."}>
          <select
            id="agent"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            className="block h-9 w-full rounded-control border border-input bg-canvas px-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue"
          >
            <option value="">{testDefault ? "Default agent: a test script (no real model)" : "Default agent"}</option>
            {(policy?.agents ?? []).filter((a) => a.found).map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
          </select>
        </Field>
        <Field id="task" label="Task" hint="Say what the agent should change, in one or two sentences. Ctrl+Enter or Cmd+Enter hands it out.">
          <Textarea ref={taskRef} id="task" rows={3} value={task} onChange={(e) => setTask(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }} aria-invalid={!task.trim() && !!formErr} />
        </Field>
        <Field id="check" label="Check command (optional)" hint="Leave it empty to use the project’s check from the policy file. Its output becomes the receipt.">
          <Input id="check" value={check} onChange={(e) => setCheck(e.target.value)} autoComplete="off" />
        </Field>
        <Field id="next" label="Then (optional)" hint="Starts on its own only when this session is verified done.">
          <Input id="next" value={next} onChange={(e) => setNext(e.target.value)} placeholder="The next task in the chain" autoComplete="off" />
        </Field>
      </div>
      <div className="flex flex-col gap-3 border-t border-hairline bg-surface px-6 py-4">
        {formErr && <p role="alert" className="text-sm text-unread">{formErr}</p>}
        <div className="flex justify-end gap-2">
          <MorphingDialogClose className="new-cancel static inline-flex h-9 cursor-pointer items-center rounded-control border border-hairline px-3.5 text-sm font-medium text-ink outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-blue">Cancel</MorphingDialogClose>
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
      {err && <p role="alert" className="text-sm text-unread">{err}</p>}
    </div>
  );
}
