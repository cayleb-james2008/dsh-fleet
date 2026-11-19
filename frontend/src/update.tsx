// Version and updates (COMMON.md spec, items 1 to 8). The server checks GitHub in the background; this page asks it what it
// knows. Update now shows only on this machine; a dismissed version keeps a "Show update" control; raw error text
// lives in a Details disclosure only; focus moves to the banner status or the next button, never to nothing.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
  if (s.error) return plainUpdateError(s.error);
  if (s.staged) return `${s.staged} installed. Restart to use it.`;
  if (s.available) return `Version ${s.latest} is available.`;
  if (!s.checked_at) return "Not checked yet.";
  return `You are on the newest version (checked ${checkedWords(s.checked_at)}).`;
}

export function useUpdate() {
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
  const [raw, setRaw] = useState("");

  const load = useCallback(async () => {
    const s = await getJson<UpdateState>("/api/update");
    if (s) setSnap(s);
    const v = await getJson<{ version: string }>("/api/version");
    if (v?.version) setVersion(v.version);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, CHECK_MS);
    return () => clearInterval(t);
  }, [load]);

  const dismiss = () => {
    const v = snap?.latest || "";
    try { localStorage.setItem(DISMISS_KEY, v); } catch { /* keep it for this view only */ }
    setDismissed(v);
    setTimeout(() => document.getElementById("show-update")?.focus(), 60);
  };
  const show = () => {
    try { localStorage.removeItem(DISMISS_KEY); } catch { /* nothing stored */ }
    setDismissed("");
  };

  const check = async () => {
    setChecking(true);
    try {
      const r = await fetch("/api/update/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const s = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(s.error || "The check did not finish. Try again later.");
      setSnap(s);
      setLive(resultLine(s)); setLiveBad(!!s.error);
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      setRaw(m); setLive(plainUpdateError(m)); setLiveBad(true);
    }
    setChecking(false);
  };

  const apply = async (): Promise<void> => {
    if (!snap) return;
    const latest = snap.latest || "";
    setBusy(true); setLive("Downloading and checking..."); setLiveBad(false);
    try {
      const r = await fetch("/api/update/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "");
      setSnap({ ...snap, ...data, staged: data.staged || data.applied || latest });
      setLive(`Installed ${latest}. Restart when no session is running.`);
      toast.success(`Version ${latest} installed. Restart to use it.`);
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      setRaw(m); setLive(plainUpdateError(m)); setLiveBad(true);
    }
    setBusy(false);
  };

  const restart = async () => {
    const r = await postJson("/api/update/restart", {});
    if (r) {
      const m = /(\d+) session/.exec(r);
      const msg = m
        ? `${m[1]} session${m[1] === "1" ? " is" : "s are"} still running. Wait for ${m[1] === "1" ? "it" : "them"} to finish or stop ${m[1] === "1" ? "it" : "them"}, then restart.`
        : "Fleet could not restart. Try again later.";
      setRaw(r); setLive(msg); setLiveBad(true);
      return;
    }
    setRestarting(true);
    setLive("Restarting...");
    const started = Date.now();
    const tick = async () => {
      if (Date.now() - started > 60000) {
        setLive("Fleet did not come back within a minute. Start Fleet again: run fleet, or restart its service. Then reload this page.");
        setLiveBad(true);
        return;
      }
      const v = await getJson("/api/version");
      if (v) { location.reload(); return; }
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
  };

  const available = !!snap?.available && !!snap.latest;
  const staged = snap?.staged || "";
  const hidden = !staged && (!available || dismissed === snap?.latest);
  return { snap, version, dismissed, live, liveBad, raw, busy, checking, restarting, hidden, staged, available, dismiss, show, check, apply, restart };
}

type U = ReturnType<typeof useUpdate>;

/** The slim strip under the top bar. Results are read out through its live region; errors stay on screen. */
export function UpdateStrip({ u }: { u: U }) {
  const statusRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (u.busy || u.restarting) statusRef.current?.focus(); }, [u.busy, u.restarting]);
  if (u.hidden) return null;
  const s = u.snap || {};
  const canApply = !!s.can_apply && onThisMachine();
  return (
    <section aria-label="Fleet update" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline bg-surface px-4 py-2.5 md:px-6">
      {u.staged ? (
        <>
          <p ref={statusRef} tabIndex={-1} className="text-sm text-ink outline-none">{u.staged} installed. Restart to use it.</p>
          <Button size="sm" onClick={u.restart} className="ml-auto" disabled={u.restarting}>Restart now</Button>
        </>
      ) : (
        <>
          <p ref={statusRef} tabIndex={-1} className="text-sm text-ink outline-none">
            Version {s.latest} is available
            {s.notes && <span className="ml-2 text-ink-2">{String(s.notes).split("\n").find((l) => l.trim())?.trim()}</span>}
          </p>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {canApply ? (
              <div className="flex flex-col items-end gap-1"><Button size="sm" onClick={u.apply} disabled={u.busy}>Update now</Button><p className="max-w-xs text-right text-xs text-ink-3">Update now downloads it, checks it, and replaces this app. Restart to start using it.</p></div>
            ) : (
              <p className="text-sm text-ink-2">
                {onThisMachine()
                  ? (s.dev_build ? "This is a developer copy, so it does not update itself. Install a released version to get updates." : "Update Fleet from the terminal.")
                  : "To update, open Fleet on the computer it runs on."}
              </p>
            )}
            <a href={s.release_url || VERSION_URL + s.latest} target="_blank" rel="noopener" className="inline-flex h-8 items-center px-2 text-sm text-ink-2 underline-offset-4 hover:text-ink hover:underline">
              What&apos;s new<span className="sr-only"> (opens in a new tab)</span>
            </a>
            <Button size="sm" variant="ghost" onClick={u.dismiss}>Dismiss</Button>
          </div>
        </>
      )}
      {u.live && <p role="status" aria-live="polite" className={u.liveBad ? "w-full text-sm text-unread" : "sr-only"}>{u.live}</p>}
      {u.live && u.liveBad && u.raw && <details className="w-full text-xs text-ink-3"><summary className="cursor-pointer">Details</summary><p className="mt-1 break-all">{u.raw}</p></details>}
    </section>
  );
}
