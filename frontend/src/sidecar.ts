import type { SwarmSnapshot, SwarmSummary, ThemeMode, WorktreesPayload } from "./types";

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

export async function fetchSwarms(): Promise<{ swarms: SwarmSummary[]; defaultConversationId: string | null }> {
  const res = await sidecarFetch("/api/swarms");
  if (!res.ok) throw new Error(`Failed to list swarms (${res.status})`);
  return res.json();
}

export async function fetchSwarmSnapshot(conversationId?: string | null, etag?: string): Promise<SwarmSnapshot> {
  const q = new URLSearchParams();
  if (conversationId) q.set("conversationId", conversationId);
  if (etag) q.set("etag", etag);
  const qs = q.toString();
  const res = await sidecarFetch(`/api/swarm${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Failed to load swarm (${res.status})`);
  return res.json();
}

export async function fetchWorktrees(roots: string[]): Promise<WorktreesPayload> {
  const q = new URLSearchParams();
  if (roots.length) q.set("roots", roots.join(","));
  const res = await sidecarFetch(`/api/worktrees?${q.toString()}`);
  if (!res.ok) throw new Error(`Failed to probe worktrees (${res.status})`);
  return res.json();
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
  window.sidecar.ui.toggleAuxPane({ openFile: uri });
  return true;
}

/** Detect theme luminance from CSS color string (`#rrggbb` or `rgb(r,g,b)`). */
export function inferThemeFromCssColor(color: string): ThemeMode | null {
  const s = String(color || "").trim();
  let r = 0;
  let g = 0;
  let b = 0;
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    r = parseInt(hex[1].slice(0, 2), 16);
    g = parseInt(hex[1].slice(2, 4), 16);
    b = parseInt(hex[1].slice(4, 6), 16);
  } else {
    const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
    if (!rgb) return null;
    r = Number(rgb[1]);
    g = Number(rgb[2]);
    b = Number(rgb[3]);
  }
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum < 0.45 ? "dark" : "light";
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
