import type { SwarmSnapshot, SwarmSummary, ThemeMode, WorktreeDiffPayload, WorktreesPayload } from "./types";

interface AntigravitySidecarBridge {
  conversationId?: string | null;
  standalone?: boolean;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  getWorkspaceUris?: () => Promise<string[]>;
  onWorkspaceChange?: (cb: (uris: string[]) => void) => () => void;
  agent?: {
    sendMessage?: (message: string, convId?: string) => Promise<unknown>;
    startConversation?: (message: string, title?: string) => Promise<unknown>;
  } | null;
  ui?: {
    toggleAuxPane?: (req: Record<string, unknown>) => void;
    toggleConversation?: (conversationId: string, opts?: Record<string, unknown>) => void;
  };
}

declare global {
  interface Window {
    sidecar?: AntigravitySidecarBridge;
    __FLEET_LIVE_WEB__?: boolean;
  }
}

export function isEmbeddedHost(): boolean {
  try {
    return typeof window !== "undefined" && window.parent !== window && !window.sidecar?.standalone;
  } catch {
    return false;
  }
}

function sidecarFetch(url: string, init?: RequestInit): Promise<Response> {
  if (typeof window !== "undefined" && window.sidecar?.fetch) {
    return window.sidecar.fetch(url, init);
  }
  return fetch(url, init);
}

async function apiJson<T>(url: string, errLabel: string): Promise<T> {
  const res = await sidecarFetch(url);
  if (!res.ok) throw new Error(`${errLabel} (${res.status})`);
  return res.json();
}

export const fetchSwarms = (): Promise<{ swarms: SwarmSummary[]; defaultConversationId: string | null }> =>
  apiJson("/api/swarms", "List swarms failed");

export function fetchSwarmSnapshot(conversationId?: string | null, etag?: string): Promise<SwarmSnapshot> {
  const q = new URLSearchParams();
  if (conversationId) q.set("conversationId", conversationId);
  if (etag) q.set("etag", etag);
  const qs = q.toString();
  return apiJson(`/api/swarm${qs ? `?${qs}` : ""}`, "Load swarm failed");
}

export function fetchWorktrees(roots: string[]): Promise<WorktreesPayload> {
  const q = new URLSearchParams();
  if (roots.length) q.set("roots", roots.join(","));
  return apiJson(`/api/worktrees?${q.toString()}`, "Worktrees failed");
}

export async function fetchWorktreeDiff(root: string, worktree: string, file: string): Promise<WorktreeDiffPayload> {
  const q = new URLSearchParams({ root, worktree, file });
  const res = await sidecarFetch(`/api/worktrees/diff?${q.toString()}`);
  const data = (await res.json().catch(() => ({}))) as Partial<WorktreeDiffPayload>;
  if (!res.ok) throw new Error(data.error || `Diff peek failed (${res.status})`);
  return data as WorktreeDiffPayload;
}

export async function sendConfirmedNudge(conversationId: string, message: string): Promise<void> {
  if (window.sidecar?.agent?.sendMessage) {
    await window.sidecar.agent.sendMessage(message, conversationId);
    return;
  }
  const res = await sidecarFetch("/api/nudge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true, conversationId, message }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Nudge failed (${res.status})`);
  }
}

export async function startSwarmPreset(prompt: string, title: string): Promise<boolean> {
  if (window.sidecar?.agent?.startConversation) {
    await window.sidecar.agent.startConversation(prompt, title);
    return true;
  }
  return false;
}

export function openWorkerConversation(conversationId: string): boolean {
  if (!conversationId || !window.sidecar?.ui?.toggleConversation) return false;
  window.sidecar.ui.toggleConversation(conversationId);
  return true;
}

export function openFileInAuxPane(uriOrPath: string): boolean {
  if (!uriOrPath || !window.sidecar?.ui?.toggleAuxPane) return false;
  const uri = uriOrPath.startsWith("file://") ? uriOrPath : `file://${uriOrPath}`;
  window.sidecar.ui.toggleAuxPane({ tabType: "fileView", uri });
  return true;
}

export function parseScreenshotLines(text: string): {
  cleanText: string;
  shots: Array<{ path: string; fileName: string; caption: string }>;
} {
  const shots: Array<{ path: string; fileName: string; caption: string }> = [];
  const re = /(?:^|\n)\s*(?:[-*]\s*)?Screenshot:\s*`?(\/[^\s`|]+\.(?:png|jpe?g|webp))`?\s*(?:\|\s*([^\n]+?))?(?=\n|$)/gi;
  const cleanText = String(text || "")
    .replace(re, (_m, path: string, caption?: string) => {
      const fileName = path.split("/").pop() || "screenshot.png";
      shots.push({ path, fileName, caption: String(caption || "").trim() });
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanText, shots };
}

export function extractLocalFilePaths(text: string): string[] {
  const seen = new Set<string>();
  const re = /(?:^|[\s`("'])(\/[a-zA-Z0-9._/-]+\.[a-zA-Z0-9]{1,12})(?=$|[\s`)"',:])/g;
  for (const m of String(text || "").matchAll(re)) {
    const p = m[1];
    if (p.length > 4 && !p.includes("..")) seen.add(p);
    if (seen.size >= 3) break;
  }
  return [...seen];
}

export function inferThemeFromCssColor(color: string): ThemeMode | null {
  const m = String(color || "").trim().match(/^#([0-9a-f]{6})$|^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return null;
  const [r, g, b] = m[1]
    ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)]
    : [Number(m[2]), Number(m[3]), Number(m[4])];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.45 ? "dark" : "light";
}

export function applyTheme(theme: ThemeMode, persist = true): void {
  document.documentElement.setAttribute("data-theme", theme);
  if (persist) {
    try {
      localStorage.setItem("fleet-theme", theme);
    } catch {
      // ignore storage failure
    }
  }
}

export function readStoredTheme(): ThemeMode {
  try {
    const v = localStorage.getItem("fleet-theme");
    if (v === "dark" || v === "light") return v;
  } catch {
    // ignore
  }
  return "light";
}
