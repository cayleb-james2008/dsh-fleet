// Fleet v0.3.0: Parallel Coding-Agent Mission Control Board.
// Top Command Bar -> Update Strip -> Scan Strip & Hero Verified Receipt -> Three-Lane Board + Split-Pane Session Inspector.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { Drawer } from "vaul";
import { Search, Plus, Sun, Moon, Cpu, ScanLine, RefreshCw, X } from "lucide-react";
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
import { Pill, PillIndicator } from "@/components/kibo-ui/pill";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { glide } from "@/motion";
import { cn } from "@/lib/utils";
import {
  getJson,
  isDemoMode,
  isFailed,
  isVerified,
  normalizePolicy,
  normalizeSessions,
  postJson,
  statusText,
  type Agent,
  type Policy,
  type Session,
  type TabId,
} from "./api";
import { HeroVerifiedReceipt, ThreeLaneBoard } from "./board";
import { DetailBody } from "./detail";
import { onThisMachine, resultLine as resultLineOf, UpdateStrip, useUpdate } from "./update";

type Theme = "dark" | "light";
const THEME_KEY = "fleet-theme";
const TEST_NOTE = "Example fixture / test mode: a stand-in script runs in place of a live coding model.";

const AVATAR_SKINS = [
  "bg-av-sky-bg text-av-sky-fg",
  "bg-av-violet-bg text-av-violet-fg",
  "bg-av-rose-bg text-av-rose-fg",
  "bg-av-grey-bg text-av-grey-fg",
];

function agentAvatarLabel(s: Session, idx: number): string {
  const raw = (s.engine || s.agent || "").trim();
  if (/opencode/i.test(raw)) return "OC";
  if (/claude/i.test(raw)) return "CL";
  if (/codex/i.test(raw)) return "CX";
  if (s.test_mode || !raw || /agent\.sh|custom/i.test(raw)) return `S${idx + 1}`;
  return raw.slice(0, 2).toUpperCase();
}

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
  const [requestedTab, setRequestedTab] = useState<TabId>("tr");
  const [openSeq, setOpenSeq] = useState(0);
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inboxOpenDesktop, setInboxOpenDesktop] = useState(false);
  const [inboxOpenMobile, setInboxOpenMobile] = useState(false);
  const [inbox, setInbox] = useState<Session[]>([]);
  const [inboxErr, setInboxErr] = useState<Record<string, string>>({});

  const wide = useMediaQuery("(min-width: 1100px)");
  const md = useMediaQuery("(min-width: 768px)");
  const closeOverlaysForUpdate = useCallback(() => {
    setSettingsOpen(false);
    setInboxOpenDesktop(false);
    setInboxOpenMobile(false);
  }, []);
  const upd = useUpdate(closeOverlaysForUpdate);
  const searchRef = useRef<HTMLInputElement>(null);
  const demo = isDemoMode();
  const localHost = onThisMachine();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* in-memory fallback */ }
  }, [theme]);

  const refresh = useCallback(async () => {
    const [polRaw, listRaw, inbRaw] = await Promise.all([
      getJson<unknown>("/api/policy"),
      getJson<unknown>("/api/sessions"),
      getJson<unknown>("/api/inbox"),
    ]);
    const pol = normalizePolicy(polRaw);
    if (pol) setPolicy(pol);
    const inb = normalizeSessions(inbRaw);
    if (inb) setInbox(inb);
    const list = normalizeSessions(listRaw);
    if (list) {
      setSessions(list);
      setLastGood(new Date());
      setUnreachable(false);
    } else {
      setUnreachable(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const closeDetail = useCallback(() => {
    const id = selected;
    setSelected(null);
    requestAnimationFrame(() => {
      (document.querySelector<HTMLElement>(`[data-open="${id}"]`) ?? document.getElementById("lane-needs-h"))?.focus();
    });
  }, [selected]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape" && selected && !document.querySelector('[role="dialog"]')) {
        closeDetail();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [selected, closeDetail]);

  const all = sessions ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((s) => [s.task, s.project, s.branch].some((v) => (v || "").toLowerCase().includes(q)));
  }, [all, query]);

  const current = selected ? all.find((s) => s.id === selected) ?? null : null;
  useEffect(() => {
    if (selected && sessions && !current) setSelected(null);
  }, [selected, sessions, current]);

  const verifiedAll = all.filter(isVerified);
  const verifiedCount = verifiedAll.length;
  const latestVerified = verifiedAll[0] ?? null;
  const needsAll = all.filter((s) => s.bucket === "needs-you");
  const workingAll = all.filter((s) => s.bucket === "working" && s.status !== "queued");
  const needsCount = needsAll.length;
  const workingCount = all.filter((s) => s.bucket === "working").length;
  const testMode = !demo && (policy?.default_agent_engine === "custom" || all.some((s) => s.test_mode));

  const openSession = (id: string, tab: TabId = "tr") => {
    setSelected(id);
    setRequestedTab(tab);
    setOpenSeq((n) => n + 1);
  };

  const focusNeedsLane = () => {
    requestAnimationFrame(() => {
      const el = document.getElementById("lane-needs-h");
      el?.scrollIntoView({ block: "nearest" });
      el?.focus();
    });
  };

  const retry = async (id: string) => {
    const e = await postJson(`/api/sessions/${id}/retry`);
    setInboxErr((m) => ({ ...m, [id]: e || "" }));
    if (e) toast.error(e); else toast.success("Retrying the session");
    refresh();
  };

  const dismiss = async (id: string) => {
    const e = await postJson(`/api/sessions/${id}/dismiss`);
    if (e) {
      toast.error(e);
    } else {
      toast.success("Dismissed. Its log stays on disk.");
      if (selected === id) setSelected(null);
    }
    refresh();
    focusNeedsLane();
  };

  const mergeFromHero = async (s: Session) => {
    try {
      const r = await fetch(`/api/sessions/${s.id}/merge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        toast.success(`Merged ${s.branch} into ${j.branch || s.merge_target || "the target branch"}.`);
      } else {
        const j = await r.json().catch(() => ({}));
        toast.error(j.error || "The merge was refused.");
        openSession(s.id, "rc");
      }
    } catch {
      toast.error("Could not reach Fleet. Is it running?");
    }
    refresh();
  };

  const detailBody = current && (
    <DetailBody
      s={current}
      requestedTab={requestedTab}
      openSeq={openSeq}
      onClose={closeDetail}
      onChanged={refresh}
      onDismissed={() => dismiss(current.id)}
    />
  );

  return (
    <TooltipProvider>
      <div className="flex min-h-dvh flex-col bg-canvas text-ink">
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline bg-surface px-4 py-2.5 md:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ScanLine className="size-5 shrink-0 text-ink" strokeWidth={1.5} aria-hidden />
            <h1 className="font-heading text-[20px] font-medium tracking-[-0.025em] text-ink">Fleet</h1>
            {upd.version && (
              <a
                href={`https://github.com/cayleb-james2008/dsh-fleet/releases/tag/v${upd.version}`}
                target="_blank"
                rel="noopener"
                className="hidden min-h-8 items-center rounded-chip bg-track px-2 font-mono text-xs text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
              >
                v{upd.version}
              </a>
            )}
            {localHost && upd.snap?.mode !== "off" && !demo && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Check for updates"
                      disabled={upd.checking}
                      onClick={upd.check}
                      className="hidden md:inline-flex"
                    />
                  }
                >
                  <RefreshCw className={cn("size-3.5 text-ink-2 motion-reduce:animate-none", upd.checking && "animate-spin")} strokeWidth={1.5} aria-hidden />
                </TooltipTrigger>
                <TooltipPopup>Check for updates</TooltipPopup>
              </Tooltip>
            )}
            {demo && (
              <Pill variant="info" className="px-2.5 py-0.5 font-mono text-xs font-medium" title="Interactive static fixture demo with in-browser /api/* mock state.">
                <PillIndicator variant="info" />
                <span>fixture demo</span>
              </Pill>
            )}
            {testMode && (
              <Badge variant="warning" size="sm" title={TEST_NOTE} className="shrink-0">
                fixture · test mode
              </Badge>
            )}
            {upd.hidden && upd.snap?.available && upd.dismissed && (
              <Button id="show-update" size="sm" variant="outline" onClick={upd.show} className="max-md:min-h-11 max-md:px-3">
                Show update
              </Button>
            )}
          </div>

          <InputGroup className="order-last flex h-11 w-full md:order-none md:ml-auto md:h-9 md:w-52 lg:w-72">
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
            <InboxPopover
              open={inboxOpenDesktop}
              onOpenChange={setInboxOpenDesktop}
              inbox={inbox}
              errs={inboxErr}
              onView={(id) => openSession(id, "tr")}
              onRetry={retry}
              onGo={focusNeedsLane}
              side="bottom"
              className="hidden md:inline-flex"
            />
            <span data-answers-via="4" className="hidden md:inline-flex">
              <NewSession policy={policy} onHanded={(id) => { openSession(id, "tr"); refresh(); }} />
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon"
                    id="settings-open"
                    className="max-md:size-11"
                    aria-label="Engines and settings"
                    onClick={() => {
                      setInboxOpenDesktop(false);
                      setInboxOpenMobile(false);
                      setSettingsOpen(true);
                    }}
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
                  aria-label={t === "light" ? "Light" : "Dark"}
                  className="max-md:!h-11 max-md:!min-w-11"
                >
                  {t === "light" ? <Sun className="size-4" strokeWidth={1.5} aria-hidden /> : <Moon className="size-4" strokeWidth={1.5} aria-hidden />}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </div>
        </header>

        <UpdateStrip u={upd} />

        <section aria-label="Scan" className="grid grid-cols-2 border-b border-hairline bg-surface/60 md:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.7fr)]">
          <Reading label="Sessions" value={sessions ? all.length : null} className="max-md:border-b max-md:border-hairline" />
          <Reading label="Needs you" value={sessions ? needsCount : null} tone={needsCount ? "bad" : undefined} answers="1" className="max-md:border-b max-md:border-r-0 max-md:border-hairline" />
          <div className="min-w-0 border-r border-hairline max-md:border-b" data-answers="2">
            <Reading label="Working" value={sessions ? workingCount : null} bare />
            <div className="flex min-h-7 items-center gap-2 px-4 pb-3">
              {workingAll.length >= 1 ? (
                <>
                  <AvatarStack size={24}>
                    {workingAll.slice(0, 4).map((s, idx) => (
                      <Avatar key={s.id} className="size-6 ring-2 ring-surface" title={`${s.engine || s.agent || "agent"}: ${s.task}`}>
                        <AvatarFallback className={cn("font-mono text-xs font-medium", AVATAR_SKINS[idx % AVATAR_SKINS.length])}>
                          {agentAvatarLabel(s, idx)}
                        </AvatarFallback>
                      </Avatar>
                    ))}
                  </AvatarStack>
                  <span className="min-w-0 truncate text-xs text-ink-2">
                    {workingAll.length === 1
                      ? `running ${workingAll[0].test_mode ? "fixture" : workingAll[0].engine || workingAll[0].agent || "agent"}`
                      : `${workingAll.length} running`}
                  </span>
                </>
              ) : (
                <span className="text-xs text-ink-3">{sessions ? "idle" : ""}</span>
              )}
            </div>
          </div>
          <Reading label="Verified" value={sessions ? verifiedCount : null} tone={verifiedCount ? "good" : undefined} className="max-md:border-b max-md:border-r-0 max-md:border-hairline" />
          <div className="col-span-2 flex min-w-0 flex-col justify-center gap-2 px-4 py-3 md:col-span-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-ink-2">Recent sessions</p>
              {sessions && <span className="font-mono text-xs text-ink-3 tabular-nums">{Math.min(all.length, 32)} / 32</span>}
            </div>
            {all.length ? (
              <Tracker
                className="h-6"
                data={all.slice(0, 32).map((s) => ({
                  key: s.id,
                  color: isVerified(s)
                    ? "bg-dot-green"
                    : isFailed(s)
                      ? "bg-unread"
                      : s.bucket === "needs-you"
                        ? "bg-dot-clay"
                        : s.status === "queued"
                          ? "bg-dot-amber"
                          : s.bucket === "working"
                            ? "bg-ink-3"
                            : "bg-track",
                  tooltip: `${s.task}: ${statusText(s)}`,
                }))}
              />
            ) : (
              <div className="flex h-6 items-center rounded-control bg-track px-2.5 font-mono text-xs text-ink-3">
                {sessions ? "No session outcomes yet" : ""}
              </div>
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

        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 pb-28 md:pb-0">
            {sessions !== null && (
              <HeroVerifiedReceipt
                latest={latestVerified}
                needsTop={needsAll[0] ?? null}
                workingCount={workingCount}
                totalCount={all.length}
                onInspect={openSession}
                onMerge={mergeFromHero}
                onRetry={retry}
              />
            )}

            <ThreeLaneBoard
              sessions={sessions === null ? null : shown}
              unreachable={unreachable}
              selected={selected}
              latestHeroId={latestVerified?.id ?? null}
              onOpen={openSession}
              onRetry={retry}
              onDismiss={dismiss}
            />

            {sessions !== null && all.length > 0 && shown.length === 0 && (
              <p role="status" className="px-4 py-4 text-sm text-ink-2 md:px-6">
                No session matches “{query.trim()}”.
              </p>
            )}
          </main>

          {wide && current && (
            <aside
              aria-label="Session inspector"
              className="sticky top-14 hidden h-[calc(100dvh-56px)] w-[460px] shrink-0 overflow-y-auto border-l border-hairline bg-surface p-6 xl:w-[500px] min-[1100px]:block"
            >
              {detailBody}
            </aside>
          )}
        </div>

        {!wide && (
          <Drawer.Root open={Boolean(current)} onOpenChange={(o) => { if (!o) closeDetail(); }}>
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
                <Drawer.Title className="font-heading text-xl font-medium text-ink">Engines and Rune policy</Drawer.Title>
                <Drawer.Close asChild>
                  <Button variant="ghost" size="icon" className="max-md:size-11" aria-label="Close settings">
                    <X className="size-4" strokeWidth={1.5} aria-hidden />
                  </Button>
                </Drawer.Close>
              </div>
              <div className="flex-1 space-y-6 overflow-y-auto p-5">
                <Drawer.Description className="text-sm leading-relaxed text-ink-2">
                  {policy
                    ? `Up to ${policy.max_parallel} sessions run in parallel. Any agent or check exceeding ${policy.timeout_secs}s returns to Needs you. Policy source: ${policy.source}.${policy.model ? ` Model route: ${policy.model}.` : ""} ${policy.default_agent ? `Default agent: ${policy.default_agent_engine === "custom" ? "custom command (test mode)" : policy.default_agent}.` : "No default agent is set."}`
                    : "Loading Rune policy..."}
                </Drawer.Description>

                <section>
                  <h3 className="mb-2 text-sm font-medium text-ink">CLI engines detected on PATH</h3>
                  <ul className="divide-y divide-hairline rounded-card border border-hairline bg-canvas">
                    {(policy?.agents ?? []).length === 0 && (
                      <li className="p-3 text-sm text-ink-2">No CLI agents configured. Test mode runs the custom script from the policy file.</li>
                    )}
                    {(policy?.agents ?? []).map((a) => (
                      <li key={a.name} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                        <span className="min-w-0 truncate font-mono text-ink">{a.name}</span>
                        <Pill variant={a.found ? "success" : "secondary"} className="px-2.5 py-0.5 text-xs">
                          <PillIndicator variant={a.found ? "success" : "warning"} />
                          <span>{a.found ? "found on this machine" : "not installed"}</span>
                        </Pill>
                      </li>
                    ))}
                  </ul>
                  {(testMode || demo) && <p className="mt-2 text-xs text-ink-3">{TEST_NOTE}</p>}
                </section>

                <section className="border-t border-hairline pt-5">
                  <h3 className="mb-2 text-sm font-medium text-ink">Version and updates</h3>
                  <div className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
                    {upd.version && <span className="font-mono text-ink">Fleet {upd.version}</span>}
                    {localHost ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="max-md:min-h-11 max-md:px-4"
                        onClick={upd.check}
                        disabled={upd.checking || upd.snap?.mode === "off"}
                      >
                        {upd.checking ? "Checking..." : "Check for updates"}
                      </Button>
                    ) : (
                      <span className="text-xs text-ink-2">To update, open Fleet on the computer it runs on.</span>
                    )}
                  </div>
                  <p className="mt-2 text-sm text-ink-2 [overflow-wrap:anywhere]" role="status">
                    {upd.snap && !upd.live ? resultLineOf(upd.snap) : upd.live}
                  </p>
                </section>
              </div>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>

        <nav
          aria-label="Board actions"
          className="fixed inset-x-0 bottom-0 z-30 flex gap-2 border-t border-hairline bg-surface px-4 pt-2 md:hidden"
          style={{ paddingBottom: "max(8px, env(safe-area-inset-bottom))" }}
        >
          <InboxPopover
            open={inboxOpenMobile}
            onOpenChange={setInboxOpenMobile}
            inbox={inbox}
            errs={inboxErr}
            onView={(id) => openSession(id, "tr")}
            onRetry={retry}
            onGo={focusNeedsLane}
            side="top"
            className="h-11 flex-1 justify-center"
          />
          <span data-answers-via="4" className="flex flex-1">
            <NewSession policy={policy} onHanded={(id) => { openSession(id, "tr"); refresh(); }} className="h-11 flex-1 justify-center" />
          </span>
        </nav>

        <Toaster
          position={md ? "bottom-right" : "top-center"}
          theme={theme}
          style={{
            "--normal-bg": "var(--surface)",
            "--normal-text": "var(--ink)",
            "--normal-border": "var(--hairline)",
            "--border-radius": "10px",
            fontSize: "14px",
          } as React.CSSProperties}
        />
      </div>
    </TooltipProvider>
  );
}

function Reading({
  label,
  value,
  tone,
  bare,
  answers,
  className,
}: {
  label: string;
  value: number | null;
  tone?: "bad" | "good";
  bare?: boolean;
  answers?: string;
  className?: string;
}) {
  return (
    <div
      data-answers={answers}
      className={cn("px-4 py-3", !bare && "border-r border-hairline last:border-r-0", className)}
    >
      <p className="text-sm text-ink-2">{label}</p>
      <div
        className={cn(
          "mt-1 border-l-2 font-mono text-[26px] font-medium leading-none tabular-nums",
          tone === "bad"
            ? "border-unread pl-2 text-destructive-foreground"
            : tone === "good"
              ? "border-dot-green pl-2 text-ink"
              : "border-transparent pl-0 text-ink",
        )}
      >
        {value === null ? (
          <span className="block h-7 w-10 rounded-control bg-track" aria-label="not loaded yet" />
        ) : (
          <SlidingNumber value={value} />
        )}
      </div>
    </div>
  );
}

function NewSession({ policy, onHanded, className }: { policy: Policy | null; onHanded: (id: string) => void; className?: string }) {
  const wrap = useRef<HTMLSpanElement>(null);
  const returnFocus = () => wrap.current?.querySelector<HTMLElement>("button")?.focus();
  return (
    <span ref={wrap} className="contents">
      <MorphingDialog transition={glide}>
        <MorphingDialogTrigger
          className={cn(
            "inline-flex h-9 cursor-pointer items-center gap-2 whitespace-nowrap rounded-control bg-blue px-3.5 text-sm font-medium text-blue-fg outline-none transition-colors duration-(--dur-press) ease-(--ease-house) hover:bg-blue-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface max-md:min-h-11",
            className,
          )}
        >
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

function AgentPicker({ agents, value, onChange, testDefault }: { agents: Agent[]; value: string; onChange: (v: string) => void; testDefault: boolean }) {
  const items = ["", ...agents.filter((a) => a.found).map((a) => a.name)];
  const label = (v: string) => (v ? v : testDefault ? "Test script" : "Default");
  if (items.length === 1) {
    return <p className="rounded-control border border-hairline bg-canvas px-3 py-2 text-sm text-ink">{label("")}</p>;
  }
  if (items.length <= 3) {
    return (
      <SegmentedControl aria-label="Agent" size="sm">
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

function Composer({ policy, onHanded, onClosed }: { policy: Policy | null; onHanded: (id: string) => void; onClosed: () => void }) {
  useEffect(() => () => onClosed(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const demo = isDemoMode();
  const [repo, setRepo] = useState(demo ? "/workspace/dsh-fleet" : "");
  const [project, setProject] = useState(demo ? "dsh-fleet" : "fixture");
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

  useEffect(() => {
    (demo ? taskRef.current : repoRef.current)?.focus();
  }, [demo]);

  const submit = async () => {
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
      try { msg = (await r.json()).error || msg; } catch { /* fallback */ }
      if (/repo|folder|git/i.test(msg)) {
        setRepoErr(msg);
        repoRef.current?.focus();
      } else {
        setFormErr(msg);
      }
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
        <MorphingDialogTitle className="font-heading text-xl font-medium text-ink">New session</MorphingDialogTitle>
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
          <Textarea
            ref={taskRef}
            id="task"
            rows={3}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}
            aria-invalid={!task.trim() && Boolean(formErr) ? true : undefined}
          />
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
          <MorphingDialogClose className="new-cancel static inline-flex h-9 cursor-pointer items-center rounded-control border border-hairline px-3.5 text-sm font-medium text-ink outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11">
            Cancel
          </MorphingDialogClose>
          <Button type="submit" disabled={busy} className="max-md:min-h-11 max-md:px-4">
            Hand it out
          </Button>
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

function InboxPopover({
  open,
  onOpenChange,
  inbox,
  errs,
  onView,
  onRetry,
  onGo,
  side,
  className,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  inbox: Session[];
  errs: Record<string, string>;
  onView: (id: string) => void;
  onRetry: (id: string) => void;
  onGo: () => void;
  side: "top" | "bottom";
  className?: string;
}) {
  const n = inbox.length;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        aria-label={`Needs you, ${n}`}
        className={cn(
          "inline-flex h-9 cursor-pointer items-center gap-2 whitespace-nowrap rounded-control border px-3 text-sm font-medium outline-none transition-colors duration-(--dur-press) ease-(--ease-house) focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11",
          n ? "border-unread text-destructive-foreground hover:bg-pill-pro-bg" : "border-hairline text-ink hover:bg-raised",
          className,
        )}
      >
        <span>Needs you</span>
        <span className={cn("rounded-chip px-1.5 py-0.5 font-mono text-xs tabular-nums", n ? "bg-pill-pro-bg text-destructive-foreground" : "bg-track text-ink-2")}>
          {n}
        </span>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={side === "top" ? "center" : "end"}
        sideOffset={8}
        className="z-30 w-full max-w-[380px] rounded-dialog border border-hairline bg-surface p-0 text-ink shadow-lift"
      >
        <div className="p-4">
          <h2 className="font-heading text-lg font-medium text-ink">Needs you</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">
            Sessions that need a person: a failed check, a refused merge, a stopped or timed-out run.
          </p>
        </div>
        <div className="max-h-[55dvh] overflow-y-auto border-t border-hairline">
          {n === 0 && (
            <p className="p-4 text-sm text-ink-2">
              Nothing needs you right now. Failed checks and stopped runs appear here with the reason.
            </p>
          )}
          {inbox.map((s) => (
            <div key={s.id} className="border-t border-hairline p-4 first:border-t-0">
              <p className="font-medium text-ink [overflow-wrap:anywhere]">{s.task}</p>
              <p className={cn("mt-1 text-sm leading-relaxed [overflow-wrap:anywhere]", isFailed(s) ? "text-destructive-foreground" : "text-info-foreground")}>
                {s.reason || "needs you"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" className="max-md:min-h-11 max-md:px-3.5" onClick={() => { onOpenChange(false); onView(s.id); }}>
                  View session
                </Button>
                <Button size="sm" className="max-md:min-h-11 max-md:px-3.5" onClick={() => onRetry(s.id)}>
                  Retry
                </Button>
              </div>
              {errs[s.id] && <p role="alert" className="mt-2 text-sm text-destructive-foreground [overflow-wrap:anywhere]">{errs[s.id]}</p>}
            </div>
          ))}
        </div>
        <div className="border-t border-hairline p-3 text-right">
          <Button size="sm" variant="ghost" className="max-md:min-h-11 max-md:px-3.5" onClick={() => { onOpenChange(false); onGo(); }}>
            Go to Needs you
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
