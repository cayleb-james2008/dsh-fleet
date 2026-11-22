// Version and updates (BANNER-FIX-BRIEF.md compliant).
// - Update now shows ONLY when can_apply is true AND hostname is loopback.
// - Manual check clears dismissal, closes open sheets/popovers, and shows plain failure messages even when no update was advertised.
// - Raw error text and multi-line release notes use Cult UI Expandable (zero native <details>).
// - Deterministic keyboard focus: busy -> status line; staged -> Restart now; dismiss -> Show update; refused restart -> status line.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Expandable, ExpandableContent, ExpandableTrigger } from "@/components/ui/expandable";
import { getJson, postJson, VERSION_URL, type UpdateState } from "./api";

const DISMISS_KEY = "fleet-update-dismissed";
const CHECK_MS = 30 * 60 * 1000;
const LOCAL = ["localhost", "127.0.0.1", "[::1]"];
export const onThisMachine = () => LOCAL.includes(location.hostname);

export function plainUpdateError(raw: string): string {
  const t = raw || "";
  if (/could not reach|connection/i.test(t)) return "Could not reach GitHub. Check your internet connection, then try again.";
  if (/checksum/i.test(t)) return "The download did not pass its safety check, so it was not installed. Nothing changed. Try again in a few minutes.";
  if (/answered HTTP/i.test(t)) return "GitHub had a problem. Nothing changed. Try again in a few minutes.";
  if (/only allowed from this machine/i.test(t)) return "Updating works only on the computer Fleet runs on. Open it there to update.";
  if (/does not run on this machine/i.test(t)) return "The new version does not run on this computer, so it was not installed. Nothing changed.";
  return "The update did not finish. Nothing changed. Try again in a few minutes.";
}

function checkedWords(secs?: number | null) {
  if (!secs) return "not yet";
  const mins = Math.round((Date.now() - secs * 1000) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

export function resultLine(s: UpdateState): string {
  if (s.mode === "off") return "Updates are off on this Fleet.";
  if (s.error) return plainUpdateError(String(s.error));
  if (s.staged) return `${s.staged} installed. Restart to use it.`;
  if (s.available) return `Version ${s.latest} is available.`;
  if (!s.checked_at) return "Not checked yet.";
  return `You are on the newest version (checked ${checkedWords(s.checked_at)}).`;
}

export function useUpdate(onBeforeManualCheck?: () => void) {
  const [snap, setSnap] = useState<UpdateState | null>(null);
  const [version, setVersion] = useState("");
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) || ""; } catch { return ""; }
  });
  const [live, setLive] = useState("");
  const [liveBad, setLiveBad] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [dismissSeq, setDismissSeq] = useState(0);
  const [restartSeq, setRestartSeq] = useState(0);
  const [stagedSeq, setStagedSeq] = useState(0);
  const [raw, setRaw] = useState("");

  const load = useCallback(async () => {
    const s = await getJson<UpdateState>("/api/update");
    if (s && typeof s === "object") setSnap(s);
    const v = await getJson<{ version?: string }>("/api/version");
    if (v && typeof v.version === "string" && v.version) setVersion(v.version);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, CHECK_MS);
    return () => clearInterval(t);
  }, [load]);

  // Focus moves to "Show update" immediately after Dismiss renders it.
  useEffect(() => {
    if (dismissSeq) requestAnimationFrame(() => document.getElementById("show-update")?.focus());
  }, [dismissSeq]);

  const dismiss = () => {
    const v = snap?.latest || "error";
    try { localStorage.setItem(DISMISS_KEY, v); } catch { /* keep in memory */ }
    setDismissed(v);
    setLiveBad(false);
    setDismissSeq((n) => n + 1);
  };

  const show = () => {
    try { localStorage.removeItem(DISMISS_KEY); } catch { /* nothing stored */ }
    setDismissed("");
  };

  const check = async () => {
    onBeforeManualCheck?.();
    // Manual check always clears any prior dismissal so an available update re-appears immediately.
    try { localStorage.removeItem(DISMISS_KEY); } catch { /* ignore */ }
    setDismissed("");
    if (!onThisMachine()) {
      setLive("To update, open Fleet on the computer it runs on.");
      setLiveBad(false);
      return;
    }
    setChecking(true);
    setRaw("");
    try {
      const r = await fetch("/api/update/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const s = (await r.json().catch(() => ({}))) as UpdateState;
      if (!r.ok) throw new Error(s.error || "The check did not finish. Try again later.");
      setSnap(s);
      if (s.error) setRaw(String(s.error));
      setLive(resultLine(s));
      setLiveBad(Boolean(s.error));
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      setRaw(m);
      setLive(plainUpdateError(m));
      setLiveBad(true);
    }
    setChecking(false);
  };

  const apply = async (): Promise<void> => {
    if (!snap) return;
    const latest = snap.latest || "";
    setBusy(true);
    setRaw("");
    setLive("Downloading and checking...");
    setLiveBad(false);
    try {
      const r = await fetch("/api/update/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "");
      const stagedVer = data.staged || data.applied || latest;
      setSnap({ ...snap, ...data, staged: stagedVer });
      setLive(`${stagedVer} installed. Restart to use it.`);
      setStagedSeq((n) => n + 1);
      toast.success(`Version ${stagedVer} installed. Restart to use it.`);
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      setRaw(m);
      setLive(plainUpdateError(m));
      setLiveBad(true);
    }
    setBusy(false);
  };

  const restart = async () => {
    setRestartSeq((n) => n + 1);
    const r = await postJson("/api/update/restart", {});
    if (r) {
      const m = /(\d+) session/.exec(r);
      const msg = m
        ? `${m[1]} session${m[1] === "1" ? " is" : "s are"} still running. Wait for ${m[1] === "1" ? "it" : "them"} to finish or stop ${m[1] === "1" ? "it" : "them"}, then restart.`
        : "Fleet could not restart. Try again later.";
      setRaw(r);
      setLive(msg);
      setLiveBad(true);
      return;
    }
    setRestarting(true);
    setLive("Restarting...");
    setLiveBad(false);
    const started = Date.now();
    const tick = async () => {
      if (Date.now() - started > 60000) {
        setLive("Fleet did not come back within a minute. Start Fleet again, then reload this page.");
        setLiveBad(true);
        return;
      }
      const v = await getJson("/api/version");
      if (v) { location.reload(); return; }
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
  };

  const available = Boolean(snap?.available && snap.latest);
  const staged = snap?.staged ? String(snap.staged) : "";
  const showErrorOnly = !staged && !available && liveBad && Boolean(live);
  const hidden = !staged && !showErrorOnly && (!available || dismissed === snap?.latest);

  return {
    snap, version, dismissed, live, liveBad, raw,
    restartSeq, stagedSeq, busy, checking, restarting,
    hidden, staged, available, showErrorOnly,
    dismiss, show, check, apply, restart,
  };
}

export type UpdateController = ReturnType<typeof useUpdate>;

export function UpdateStrip({ u }: { u: UpdateController }) {
  const statusRef = useRef<HTMLParagraphElement>(null);
  const restartBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (u.busy || u.restartSeq) statusRef.current?.focus();
  }, [u.busy, u.restartSeq]);

  useEffect(() => {
    if (u.stagedSeq) requestAnimationFrame(() => restartBtnRef.current?.focus());
  }, [u.stagedSeq]);

  if (u.hidden) return null;
  const s = u.snap || {};
  const local = onThisMachine();
  const canApply = Boolean(s.can_apply) && local;
  const noteLines = typeof s.notes === "string"
    ? s.notes.split("\n").map((l) => l.trim()).filter(Boolean)
    : [];
  const leadNote = noteLines[0] || "";
  const extraNotes = noteLines.slice(1).join("\n");

  return (
    <section aria-label="Fleet update" className="relative z-10 flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-hairline bg-surface px-4 py-3 md:px-6">
      {u.staged ? (
        <div className="flex w-full flex-wrap items-center gap-3">
          <p id="upd-status" ref={statusRef} tabIndex={-1} className="text-sm font-medium text-ink outline-none">
            {u.staged} installed. Restart to use it.
          </p>
          <Button
            ref={restartBtnRef}
            size="sm"
            onClick={u.restart}
            className="ml-auto max-md:min-h-11 max-md:px-4"
            disabled={u.restarting}
          >
            Restart now
          </Button>
        </div>
      ) : u.showErrorOnly ? (
        <div className="flex w-full flex-wrap items-center gap-3">
          <p ref={statusRef} tabIndex={-1} role="status" aria-live="polite" className="min-w-0 flex-1 text-sm text-destructive-foreground outline-none">
            {u.live}
          </p>
          {local && (
            <Button size="sm" variant="outline" onClick={u.check} disabled={u.checking} className="max-md:min-h-11 max-md:px-4">
              Try again
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => u.dismiss()} className="max-md:min-h-11 max-md:px-3">
            Dismiss
          </Button>
        </div>
      ) : (
        <>
          <div className="min-w-0 flex-1 space-y-1">
            <p ref={statusRef} tabIndex={-1} className="text-sm font-medium text-ink outline-none">
              Version <span className="font-mono">{s.latest}</span> is available
              {leadNote && <span className="ml-2 font-normal text-ink-2 [overflow-wrap:anywhere]">{leadNote}</span>}
            </p>
            {canApply && (
              <p className="text-xs leading-relaxed text-ink-3">
                Update now downloads it, checks it, and replaces this app. Restart to start using it.
              </p>
            )}
            {extraNotes && (
              <Expandable expandDirection="vertical" expandBehavior="push" className="pt-0.5">
                {({ isExpanded }) => (
                  <>
                    <ExpandableTrigger className="inline-flex cursor-pointer items-center rounded-control text-xs font-medium text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 max-md:px-2">
                      {isExpanded ? "Hide release notes" : "Release notes"}
                    </ExpandableTrigger>
                    <ExpandableContent preset="fade">
                      <pre className="mt-1.5 max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-control border border-hairline bg-canvas p-2.5 font-sans text-xs leading-relaxed text-ink-2">
                        {extraNotes}
                      </pre>
                    </ExpandableContent>
                  </>
                )}
              </Expandable>
            )}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {canApply ? (
              <Button size="sm" onClick={u.apply} disabled={u.busy} className="max-md:min-h-11 max-md:px-4">
                {u.busy ? "Updating..." : "Update now"}
              </Button>
            ) : (
              <p className="text-sm text-ink-2">
                {local
                  ? "This is a developer copy, so it does not update itself. Install a released version to get updates."
                  : "To update, open Fleet on the computer it runs on."}
              </p>
            )}
            <a
              href={s.release_url || VERSION_URL + (s.latest || "")}
              target="_blank"
              rel="noopener"
              className="inline-flex h-8 items-center rounded-control px-2.5 text-sm text-ink-2 underline-offset-4 outline-none hover:text-ink hover:underline focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 max-md:px-3"
            >
              What&apos;s new<span className="sr-only"> (opens in a new tab)</span>
            </a>
            <Button size="sm" variant="ghost" onClick={u.dismiss} className="max-md:min-h-11 max-md:px-3">
              Dismiss
            </Button>
          </div>
        </>
      )}

      {!u.showErrorOnly && u.live && (
        <div className={u.liveBad ? "flex w-full flex-wrap items-center gap-3 pt-1" : "sr-only"}>
          <p role="status" aria-live="polite" className={u.liveBad ? "min-w-0 flex-1 text-sm text-destructive-foreground" : ""}>
            {u.live}
          </p>
          {u.liveBad && local && (
            <Button size="sm" variant="outline" onClick={u.staged ? u.restart : u.apply} disabled={u.busy || u.restarting} className="max-md:min-h-11 max-md:px-4">
              Try again
            </Button>
          )}
        </div>
      )}

      {u.live && u.liveBad && u.raw && (
        <Expandable expandDirection="vertical" expandBehavior="push" className="w-full">
          {({ isExpanded }) => (
            <>
              <ExpandableTrigger aria-label="Details of the update failure" className="inline-flex cursor-pointer items-center rounded-control text-xs text-ink-3 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 max-md:px-2">
                {isExpanded ? "Hide details" : "Details"}
              </ExpandableTrigger>
              <ExpandableContent preset="fade">
                <pre className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded-control border border-hairline bg-canvas p-2 font-mono text-xs text-ink-2">
                  {u.raw}
                </pre>
              </ExpandableContent>
            </>
          )}
        </Expandable>
      )}
    </section>
  );
}
