import { useEffect } from "react";
import { toLogin } from "@herdr/web/session.ts";
import { fail, freshness, track } from "./sync.ts";

// Web push from the page's side (F19-F21): subscribing this browser, the pause and per-space mute
// the menus show, and telling the server which pane is open so it never pushes for it. Everything
// goes over the same logged-in API as the rest; the service worker (public/sw.js) shows the
// notifications and needs no session to do it.

export interface PushInfo {
  readonly enabled: boolean;
  readonly publicKey: string | null;
  readonly paused: boolean;
  readonly muted: readonly string[];
  readonly subscriptions: number;
}

let info: PushInfo | null = null;
const fresh = freshness();
const listeners = new Set<() => void>();

export const pushInfo = (): PushInfo | null => info;
export function onPushInfo(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Read the server's push state (and keep it for the menus). `null` when the server can't be reached. */
export async function refreshPushInfo(): Promise<PushInfo | null> {
  const still = fresh.read();
  try {
    const res = await fetch("/api/push", { cache: "no-store" });
    if (res.status === 401) {
      toLogin();
      return null;
    }
    if (!res.ok) return info;
    const read = (await res.json()) as PushInfo;
    if (!still()) return info;
    info = read;
    for (const l of listeners) l();
    return info;
  } catch {
    return info;
  }
}

export const pushSupported = (): boolean => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** Whether this browser holds a push subscription the server knows of. */
export async function thisDeviceSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) != null;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Ask for permission, subscribe this browser and register it with the server. Returns why not, or `null` on success. */
export async function enablePush(): Promise<string | null> {
  if (!pushSupported()) return "This browser can't receive push notifications (on iPhone, install the app to the home screen first).";
  const current = (await refreshPushInfo()) ?? info;
  if (current === null || !current.enabled || current.publicKey === null) return "Push isn't set up on the server yet.";
  if ((await Notification.requestPermission()) !== "granted") return "Notifications are blocked for this site; allow them in the browser's site settings.";
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(current.publicKey) }));
  const res = await post("/api/push/subscribe", sub.toJSON());
  if (res.status === 401) {
    toLogin();
    return "Logged out.";
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return body?.error ?? `The server answered ${String(res.status)}.`;
  }
  await refreshPushInfo();
  return null;
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub != null) {
    await post("/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  await refreshPushInfo();
}

export async function setPaused(paused: boolean): Promise<void> {
  await post("/api/push/settings", { paused }).catch(() => undefined);
  await refreshPushInfo();
}

/** Shown in the space menu at once (task 142); the server's state replaces it after. */
export async function setMuted(spaceId: string, muted: boolean): Promise<void> {
  const answered = fresh.change();
  if (info !== null) {
    info = { ...info, muted: muted ? [...info.muted.filter((id) => id !== spaceId), spaceId] : info.muted.filter((id) => id !== spaceId) };
    for (const l of listeners) l();
  }
  const ok = await track(post("/api/push/settings", { mute: spaceId, muted }).then((r) => r.ok, () => false));
  answered();
  await refreshPushInfo(); // the server's state, a refusal's undo included (unless another change is still on its way)
  if (!ok) fail(`Couldn't ${muted ? "mute" : "unmute"} notifications`);
}

/** A test push to every subscribed browser; how many it reached. */
export async function sendTestPush(): Promise<number | string> {
  const res = await post("/api/push/test", {}).catch(() => null);
  const body = (await res?.json().catch(() => null)) as { sent?: number; error?: string } | null;
  return body?.sent ?? body?.error ?? "Can't reach herdr.";
}

const REPORT_MS = 10_000;
const clientId = ((): string => {
  try {
    const kept = window.sessionStorage.getItem("herdr.client");
    if (kept !== null) return kept;
    const fresh = crypto.randomUUID();
    window.sessionStorage.setItem("herdr.client", fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
})();

function report(panes: readonly string[]): void {
  void fetch("/api/presence", { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ id: clientId, panes }) }).catch(() => undefined);
}

/**
 * Tell the server which pane this page shows, while the page is visible, so that session does not
 * push (F19). Nothing is reported for a hidden page, and the server forgets a silent one after 25 s.
 */
export function usePresence(paneId: string | null): void {
  useEffect(() => {
    if (paneId === null) return;
    const now = () => report(document.visibilityState === "visible" ? [paneId] : []);
    now();
    const timer = window.setInterval(now, REPORT_MS);
    const leave = () => report([]);
    document.addEventListener("visibilitychange", now);
    window.addEventListener("pagehide", leave);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", now);
      window.removeEventListener("pagehide", leave);
      report([]);
    };
  }, [paneId]);
}
