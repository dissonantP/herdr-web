import { useEffect, useSyncExternalStore } from "react";
import { toLogin } from "@herdr/web/session.ts";
import { freshness, track } from "./sync.ts";

// The settings (F51): what GET /api/settings returns, and the changes POSTed back. One store for the settings page,
// the space menu (never sleep) and the view switch (inbox): a change shows everywhere at once and is taken back alone
// if refused (task 142). The push pause lives with the push state (push.ts).

export interface SettingsView {
  readonly autosleep: { readonly enabled: boolean; readonly idle: string; readonly every: string; readonly neverSleep: readonly string[] };
  readonly inbox: boolean;
  readonly pushPaused: boolean;
}

export type SettingsChange =
  | { readonly autosleep: { readonly enabled?: boolean; readonly idle?: string; readonly every?: string } }
  | { readonly inbox: boolean }
  | { readonly neverSleep: { readonly space: string; readonly never: boolean } };

// `null` until the first answer from the server; the app loads it at start (App.tsx), before any menu opens.
let current: SettingsView | null = null;
const fresh = freshness();
const listeners = new Set<() => void>();
function set(s: SettingsView): void {
  current = s;
  for (const listener of listeners) listener();
}
const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

const normName = (n: string) => n.toLowerCase().replace(/[\s_-]+/gu, "");
/** Whether a space is on the never-sleep list, as last loaded. */
export function neverSleeps(name: string): boolean {
  return current?.autosleep.neverSleep.some((n) => normName(n) === normName(name)) === true;
}

/** Whether the inbox view is on: `null` while not yet known. */
export function useInboxEnabled(): boolean | null {
  return useSyncExternalStore(subscribe, () => current?.inbox ?? null);
}

/** The settings with `change` made. */
export function applyChange(s: SettingsView, change: SettingsChange): SettingsView {
  if ("inbox" in change) return { ...s, inbox: change.inbox };
  if ("neverSleep" in change) {
    const { space, never } = change.neverSleep;
    const others = s.autosleep.neverSleep.filter((n) => normName(n) !== normName(space));
    return { ...s, autosleep: { ...s.autosleep, neverSleep: never ? [...others, space] : others } };
  }
  return { ...s, autosleep: { ...s.autosleep, ...change.autosleep } };
}

/** The change that takes `change` back, as `s` was before it. */
function undoOf(s: SettingsView, change: SettingsChange): SettingsChange {
  if ("inbox" in change) return { inbox: s.inbox };
  if ("neverSleep" in change) return { neverSleep: { space: change.neverSleep.space, never: neverSleeps(change.neverSleep.space) } };
  const before = s.autosleep;
  return { autosleep: Object.fromEntries(Object.keys(change.autosleep).map((k) => [k, before[k as keyof typeof change.autosleep]])) };
}

/** Make a change: shown at once, then saved; the answer is the new settings, or why not (the change is then taken back alone). */
export function changeSettings(change: SettingsChange): Promise<SettingsView | string> {
  const answered = fresh.change();
  const undo = current === null ? null : undoOf(current, change);
  if (current !== null) set(applyChange(current, change));
  return track(send(change)).then((result) => {
    // The answer is the server's whole settings; while another change is on its way it may lack that one.
    const latest = answered();
    if (typeof result !== "string") {
      if (latest) set(result);
    } else if (undo !== null && current !== null) set(applyChange(current, undo));
    return result;
  });
}

async function send(change: SettingsChange): Promise<SettingsView | string> {
  try {
    const res = await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
    if (res.status === 401) {
      toLogin();
      return "Logged out.";
    }
    const body = (await res.json().catch(() => null)) as (SettingsView & { ok: true }) | { ok: false; error: string } | null;
    if (body === null) return `The server answered ${String(res.status)}.`;
    return body.ok ? body : body.error;
  } catch {
    return "Can't reach herdr.";
  }
}

/** Read the server's settings into the store; a read a change overtook is dropped. */
export async function loadSettings(): Promise<void> {
  const still = fresh.read();
  try {
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (res.status === 401) return toLogin();
    if (!res.ok) return;
    const s = (await res.json()) as SettingsView;
    if (still()) set(s);
  } catch {
    // Offline or restarting: keep what is shown.
  }
}

/** The settings as the store has them (refreshed when the page opens); `null` until first loaded. */
export function useSettings(): SettingsView | null {
  useEffect(() => void loadSettings(), []);
  return useSyncExternalStore(subscribe, () => current);
}
