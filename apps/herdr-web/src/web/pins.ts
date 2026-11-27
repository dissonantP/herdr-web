import { useSyncExternalStore } from "react";
import { toLogin } from "@herdr/web/session.ts";
import { fail, freshness, track } from "./sync.ts";

// The pin bar's list (F40): space ids in order, kept on the server (`/api/pins`) so every device shows the
// same bar. Changes show at once and are then replaced by the server's answer (a refusal reloads the server's
// list and says so in the sync toast, sync.ts); other devices' changes
// arrive when the window is focused again or on the next poll. Which pin is active is the route.

export interface PinsState {
  readonly loaded: boolean;
  readonly pins: readonly string[];
}

let current: PinsState = { loaded: false, pins: [] };
const listeners = new Set<() => void>();
const fresh = freshness();
const set = (next: PinsState) => {
  current = next;
  for (const listener of listeners) listener();
};

/** The server's answer to a change, or why it failed (`null`: logged out). */
async function post(body: unknown): Promise<string[] | string | null> {
  try {
    const res = await fetch("/api/pins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.status === 401) return null;
    const answer = (await res.json().catch(() => null)) as { ok?: boolean; pins?: string[]; error?: string } | null;
    return answer?.ok === true && Array.isArray(answer.pins) ? answer.pins : (answer?.error ?? `the server answered ${String(res.status)}`);
  } catch {
    return "can't reach herdr";
  }
}

async function send(body: unknown): Promise<void> {
  const answered = fresh.change();
  const result = await post(body);
  const latest = answered(); // while another change is on its way, this answer may lack it
  if (result === null) return toLogin();
  if (typeof result !== "string") {
    if (latest) set({ loaded: true, pins: result });
    return;
  }
  fail(`Couldn't change the pins: ${result}`);
  await loadPins();
}

const call = (body: unknown): Promise<void> => track(send(body));

export async function loadPins(): Promise<void> {
  const still = fresh.read();
  try {
    const res = await fetch("/api/pins", { cache: "no-store" });
    if (res.status === 401) return toLogin();
    if (!res.ok) return;
    const body = (await res.json()) as { pins?: string[] };
    if (Array.isArray(body.pins) && still()) set({ loaded: true, pins: body.pins });
  } catch {
    // Offline or restarting: keep what is shown.
  }
}

export function pinSpace(id: string): void {
  // Always sent (the server ignores a repeat), since the local list may be a poll behind.
  if (!current.pins.includes(id)) set({ ...current, pins: [...current.pins, id] });
  void call({ pin: id });
}

export function unpinSpace(id: string): void {
  set({ ...current, pins: current.pins.filter((p) => p !== id) });
  void call({ unpin: id });
}

export function reorderPins(order: readonly string[]): void {
  set({ ...current, pins: order });
  void call({ order });
}

/** Where a dragged pin would land among the others: how many of them have their centre left of `x`. */
export function insertIndex(otherCentres: readonly number[], x: number): number {
  return otherCentres.filter((c) => c < x).length;
}

/** `order` with `id` taken out and put back so that `index` others come before it. */
export function movePin(order: readonly string[], id: string, index: number): string[] {
  const others = order.filter((p) => p !== id);
  if (!order.includes(id)) return [...order];
  others.splice(Math.max(0, Math.min(index, others.length)), 0, id);
  return others;
}

export function usePins(): PinsState {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => current,
  );
}
