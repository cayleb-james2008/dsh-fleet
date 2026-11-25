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

const sc = () => (typeof window !== "undefined" ? window.sidecar : undefined);

export function isEmbeddedHost(): boolean {
  try {
    return typeof window !== "undefined" && window.parent !== window && !sc()?.standalone;
  } catch {
    return false;
  }
}

const sidecarFetch = (url: string, init?: RequestInit): Promise<Response> =>
  sc()?.fetch?.(url, init) ?? fetch(url, init);

async function apiJson<T>(url: string, errLabel: string): Promise<T> {
  const res = await sidecarFetch(url);
  if (!res.ok) throw new Error(`${errLabel} (${res.status})`);
  return res.json();
}

const qs = (path: string, params: Record<string, string | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return `${path}${s ? `?${s}` : ""}`;
};

export const fetchSwarms = (): Promise<{ swarms: SwarmSummary[]; defaultConversationId: string | null }> =>
  apiJson("/api/swarms", "List swarms failed");

export const fetchSwarmSnapshot = (conversationId?: string | null, etag?: string): Promise<SwarmSnapshot> =>
  apiJson(qs("/api/swarm", { conversationId, etag }), "Load swarm failed");

export const fetchWorktrees = (roots: string[]): Promise<WorktreesPayload> =>
  apiJson(qs("/api/worktrees", { roots: roots.join(",") }), "Worktrees failed");

export async function fetchWorktreeDiff(root: string, worktree: string, file: string): Promise<WorktreeDiffPayload> {
  const res = await sidecarFetch(qs("/api/worktrees/diff", { root, worktree, file }));
  const data = (await res.json().catch(() => ({}))) as Partial<WorktreeDiffPayload>;
  if (!res.ok) throw new Error(data.error || `Diff peek failed (${res.status})`);
  return data as WorktreeDiffPayload;
}

export async function sendConfirmedNudge(target: string | string[], message: string): Promise<void> {
  const ids = Array.isArray(target) ? [...new Set(target.filter(Boolean))] : target ? [target] : [];
  if (!ids.length) throw new Error("No target");
  const send = sc()?.agent?.sendMessage;
  if (ids.length === 1 && send) {
    await send(message, ids[0]);
    return;
  }
  if (ids.length > 1 && !window.__FLEET_LIVE_WEB__ && send) {
    await Promise.all(ids.map((id) => send(message, id)));
    return;
  }
  const body = ids.length === 1 ? { confirm: true, conversationId: ids[0], message } : { confirm: true, conversationIds: ids, message };
  const res = await sidecarFetch("/api/nudge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Nudge failed (${res.status})`);
  }
}

export async function startSwarmPreset(prompt: string, title: string): Promise<boolean> {
  const start = sc()?.agent?.startConversation;
  if (!start) return false;
  await start(prompt, title);
  return true;
}

export function openWorkerConversation(conversationId: string): boolean {
  const fn = sc()?.ui?.toggleConversation;
  if (!conversationId || !fn) return false;
  fn(conversationId);
  return true;
}

export function openFileInAuxPane(uriOrPath: string): boolean {
  const fn = sc()?.ui?.toggleAuxPane;
  if (!uriOrPath || !fn) return false;
  fn({ tabType: "fileView", uri: uriOrPath.startsWith("file://") ? uriOrPath : `file://${uriOrPath}` });
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
  if (persist) try { localStorage.setItem("fleet-theme", theme); } catch {}
}

export function readStoredTheme(): ThemeMode {
  try {
    return localStorage.getItem("fleet-theme") === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}
