// Live SSE Event Stream (`EventSource('/api/events/stream')`) with automatic polling fallback.
// Gracefully connects when the backend supports v0.5.0 SSE (or in standalone Browser Worktree mode),
// incrementally patching active sessions, transcript lines, and check step receipts in real time.
import { useEffect, useRef, useState } from "react";
import {
  isWebEngineMode,
  normalizeHealAttempt,
  normalizeSession,
  normalizeSessions,
  type CheckStepReceipt,
  type Session,
} from "./api";

export type StreamState = "sse" | "polling" | "browser" | "offline";

type StreamHandlers = {
  enabled: boolean;
  onRefresh: () => void | Promise<void>;
  onPatchSessions: (updater: (prev: Session[] | null) => Session[] | null) => void;
  onConnected?: () => void;
};

function mergeSessionIntoList(prev: Session[] | null, next: Session): Session[] {
  if (!prev) return [next];
  const idx = prev.findIndex((s) => s.id === next.id);
  if (idx === -1) return [next, ...prev];
  const copy = prev.slice();
  copy[idx] = next;
  return copy;
}

function appendTranscriptLines(
  prev: Session[] | null,
  sessionId: string,
  lines: string[],
): Session[] | null {
  if (!prev || !lines.length) return prev;
  const idx = prev.findIndex((s) => s.id === sessionId);
  if (idx === -1) return prev;
  const cur = prev[idx];
  const merged = cur.transcript.concat(lines);
  const capped = merged.length > 60000 ? merged.slice(merged.length - 60000) : merged;
  const copy = prev.slice();
  copy[idx] = {
    ...cur,
    transcript: capped,
    transcript_total:
      typeof cur.transcript_total === "number"
        ? cur.transcript_total + lines.length
        : capped.length,
  };
  return copy;
}

function applyCheckStepUpdate(
  prev: Session[] | null,
  sessionId: string,
  stepRaw: Record<string, unknown>,
): Session[] | null {
  if (!prev) return prev;
  const idx = prev.findIndex((s) => s.id === sessionId);
  if (idx === -1) return prev;
  const cur = prev[idx];
  const name = String(stepRaw.name || stepRaw.cmd || `step-${(cur.check_steps?.length ?? 0) + 1}`);
  const cmd = String(stepRaw.cmd || stepRaw.command || name);
  const exitCode = typeof stepRaw.exit_code === "number" ? stepRaw.exit_code : null;
  const elapsedMs = typeof stepRaw.elapsed_ms === "number" ? stepRaw.elapsed_ms : null;
  const passed =
    typeof stepRaw.passed === "boolean"
      ? stepRaw.passed
      : exitCode !== null
        ? exitCode === 0
        : null;
  const output = typeof stepRaw.output === "string" ? stepRaw.output : "";
  const tailLine =
    typeof stepRaw.tail_line === "string"
      ? stepRaw.tail_line
      : output
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .pop() || "";
  const status: CheckStepReceipt["status"] =
    stepRaw.status === "running" ||
    stepRaw.status === "passed" ||
    stepRaw.status === "failed" ||
    stepRaw.status === "skipped"
      ? stepRaw.status
      : passed === true
        ? "passed"
        : passed === false
          ? "failed"
          : "pending";

  const nextStep: CheckStepReceipt = {
    name,
    cmd,
    exit_code: exitCode,
    elapsed_ms: elapsedMs,
    passed,
    tail_line: tailLine,
    output,
    status,
  };

  const existing = cur.check_steps ? cur.check_steps.slice() : [];
  const matchIdx = existing.findIndex((st) => st.name === nextStep.name && st.cmd === nextStep.cmd);
  if (matchIdx >= 0) existing[matchIdx] = nextStep;
  else existing.push(nextStep);

  const copy = prev.slice();
  copy[idx] = { ...cur, check_steps: existing };
  return copy;
}

function applyHealAttemptUpdate(
  prev: Session[] | null,
  sessionId: string,
  rawAttempt: unknown,
): Session[] | null {
  if (!prev) return prev;
  const idx = prev.findIndex((s) => s.id === sessionId);
  if (idx === -1) return prev;
  const cur = prev[idx];
  const existing = cur.heal_attempts ? cur.heal_attempts.slice() : [];
  const next = normalizeHealAttempt(rawAttempt, existing.length);
  if (!next) return prev;
  const matchIdx = existing.findIndex((a) => a.attempt === next.attempt);
  if (matchIdx >= 0) existing[matchIdx] = next;
  else existing.push(next);
  const copy = prev.slice();
  copy[idx] = {
    ...cur,
    heal_attempts: existing,
    auto_healed: cur.auto_healed || next.healed || undefined,
  };
  return copy;
}

export function useFleetStream({
  enabled,
  onRefresh,
  onPatchSessions,
  onConnected,
}: StreamHandlers): { streamState: StreamState; lastEventAt: Date | null } {
  const webEngine = isWebEngineMode();
  const [streamState, setStreamState] = useState<StreamState>(webEngine ? "browser" : "polling");
  const [lastEventAt, setLastEventAt] = useState<Date | null>(null);
  const refreshRef = useRef(onRefresh);
  const patchRef = useRef(onPatchSessions);
  const connectedRef = useRef(onConnected);

  refreshRef.current = onRefresh;
  patchRef.current = onPatchSessions;
  connectedRef.current = onConnected;

  useEffect(() => {
    let alive = true;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let syncTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 2500;
    let sseOpen = false;

    const scheduleSync = () => {
      if (syncTimer) return;
      syncTimer = setTimeout(() => {
        syncTimer = null;
        if (alive) refreshRef.current();
      }, 250);
    };

    const handlePayload = (rawText: string, eventName = "message") => {
      if (!alive || !rawText) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        return;
      }
      setLastEventAt(new Date());
      if (!parsed || typeof parsed !== "object") return;
      const obj = parsed as Record<string, unknown>;
      const kind = String(obj.type || obj.event || eventName || "").toLowerCase();

      if (kind === "heartbeat" || kind === "ping") return;

      if (kind === "sessions" && Array.isArray(obj.sessions)) {
        const list = normalizeSessions(obj.sessions);
        if (list) patchRef.current(() => list);
        return;
      }

      if (
        kind === "session" ||
        kind === "session_created" ||
        kind === "session_status" ||
        kind === "session_update" ||
        kind === "status"
      ) {
        const candidate = obj.session ?? obj.data ?? obj;
        const norm = normalizeSession(candidate);
        if (norm) {
          patchRef.current((prev) => mergeSessionIntoList(prev, norm));
          if (norm.bucket === "needs-you" || norm.bucket === "done") scheduleSync();
        } else {
          scheduleSync();
        }
        return;
      }

      if (kind === "transcript" || kind === "transcript_line" || kind === "line" || kind === "log") {
        const sid = String(obj.session_id || obj.id || "").trim();
        const lines: string[] = [];
        if (typeof obj.line === "string") lines.push(obj.line);
        if (typeof obj.text === "string") lines.push(obj.text);
        if (Array.isArray(obj.lines)) {
          for (const l of obj.lines) {
            if (typeof l === "string") lines.push(l);
          }
        }
        if (sid && lines.length) {
          patchRef.current((prev) => appendTranscriptLines(prev, sid, lines));
        }
        return;
      }

      if (kind === "check_step" || kind === "check_progress" || kind === "receipt") {
        const sid = String(obj.session_id || obj.id || "").trim();
        const stepObj =
          obj.step && typeof obj.step === "object"
            ? (obj.step as Record<string, unknown>)
            : typeof obj.name === "string" || typeof obj.cmd === "string"
              ? obj
              : null;
        if (sid && stepObj) {
          patchRef.current((prev) => applyCheckStepUpdate(prev, sid, stepObj));
        } else {
          scheduleSync();
        }
        return;
      }

      if (kind === "auto_heal_attempt" || kind === "heal_attempt") {
        const sid = String(obj.session_id || obj.id || "").trim();
        const attemptObj = obj.attempt && typeof obj.attempt === "object" ? obj.attempt : obj;
        if (sid) {
          patchRef.current((prev) => applyHealAttemptUpdate(prev, sid, attemptObj));
          scheduleSync();
        }
        return;
      }

      if (
        kind === "queue" ||
        kind === "queue_depth" ||
        kind === "config_updated" ||
        kind === "worktrees_pruned" ||
        kind === "templates_updated" ||
        kind === "metrics_updated" ||
        kind === "refresh" ||
        kind === "inbox"
      ) {
        scheduleSync();
        return;
      }

      // Generic session object fallback
      if (typeof obj.id === "string" && typeof obj.task === "string") {
        const norm = normalizeSession(obj);
        if (norm) patchRef.current((prev) => mergeSessionIntoList(prev, norm));
      }
    };

    const connect = () => {
      if (!alive || !enabled || typeof window === "undefined" || typeof window.EventSource !== "function") {
        setStreamState(webEngine ? "browser" : "polling");
        return;
      }
      try {
        es = new window.EventSource("/api/events/stream");
      } catch {
        setStreamState(webEngine ? "browser" : "polling");
        return;
      }

      es.onopen = () => {
        if (!alive) return;
        sseOpen = true;
        backoffMs = 2500;
        setStreamState(webEngine ? "browser" : "sse");
        connectedRef.current?.();
      };

      es.onmessage = (ev) => handlePayload(ev.data, "message");
      for (const name of [
        "sessions",
        "session",
        "session_created",
        "session_status",
        "session_update",
        "status",
        "transcript",
        "transcript_line",
        "line",
        "check_step",
        "check_progress",
        "auto_heal_attempt",
        "heal_attempt",
        "receipt",
        "queue",
        "queue_depth",
        "config_updated",
        "worktrees_pruned",
        "templates_updated",
        "metrics_updated",
        "refresh",
      ]) {
        es.addEventListener(name, (ev) => handlePayload((ev as MessageEvent).data, name));
      }

      es.onerror = () => {
        if (!alive) return;
        sseOpen = false;
        es?.close();
        es = null;
        setStreamState(webEngine ? "browser" : "polling");
        if (!retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            backoffMs = Math.min(backoffMs * 1.8, 30_000);
            connect();
          }, backoffMs);
        }
      };
    };

    if (enabled) connect();
    else setStreamState(webEngine ? "browser" : "polling");

    // Polling loop: 2s when SSE is not connected, 4s safety reconcile when SSE is live
    const poll = setInterval(() => {
      if (!alive) return;
      if (!sseOpen) {
        refreshRef.current();
      }
    }, 2000);

    const reconcile = setInterval(() => {
      if (!alive) return;
      if (sseOpen) {
        refreshRef.current();
      }
    }, 4000);

    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(reconcile);
      if (retryTimer) clearTimeout(retryTimer);
      if (syncTimer) clearTimeout(syncTimer);
      es?.close();
    };
  }, [enabled, webEngine]);

  return { streamState, lastEventAt };
}
