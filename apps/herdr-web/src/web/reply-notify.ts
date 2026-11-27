import type { ChatMessage } from "../shared/chat.ts";
import { useSyncExternalStore } from "react";
import type { PaneStatus, Tree } from "../shared/model.ts";
import { allSpaces } from "../shared/tree-walk.ts";
import type { Route } from "./router.ts";

// In-app reply notifications (task 101): when an agent answers (working -> idle) or starts waiting for input,
// a banner shows at the top; tapping it opens a quick-reply modal. A per-device setting (localStorage), off by default.
// This file is the logic (what counts as a reply, which pane you are looking at, the setting); the UI is ReplyNotify.tsx.

export interface Notice {
  readonly paneId: string;
  readonly paneName: string;
  readonly spaceId: string;
  readonly spaceName: string;
  readonly tabId: string;
  /** `done`: the agent answered; `waiting`: it needs input (a permission or question). */
  readonly kind: "done" | "waiting";
}

/** Every agent pane's status, by pane id. */
export function statusMap(tree: Tree): Map<string, PaneStatus> {
  const out = new Map<string, PaneStatus>();
  for (const space of allSpaces(tree)) for (const tab of space.tabs) for (const pane of tab.panes) if (pane.status !== null) out.set(pane.id, pane.status);
  return out;
}

/** The pane the open space shows (as SpaceView picks it), or `null` when none is on screen. */
export function viewedPane(tree: Tree, route: Route): string | null {
  if (route.settings === true || route.space === null) return null;
  const space = allSpaces(tree).find((s) => s.id === route.space);
  const tab = space?.tabs.find((t) => t.id === route.tab) ?? space?.tabs[0];
  return (tab?.panes.find((p) => p.id === route.pane) ?? tab?.panes[0])?.id ?? null;
}

/**
 * The notices a tree update brings: panes that went from working to idle, or into waiting. Not for the pane in
 * `viewed` or `alsoViewed` (the pane in an open quick-reply modal), panes hidden from the Inbox (`herdr.inbox=hide`), sleeping ones, or panes that were not in `before`
 * (the first tree, a new pane).
 */
export function newNotices(before: ReadonlyMap<string, PaneStatus>, tree: Tree, viewed: string | null, alsoViewed: string | null = null): Notice[] {
  const out: Notice[] = [];
  for (const space of allSpaces(tree)) {
    for (const tab of space.tabs) {
      for (const pane of tab.panes) {
        const was = before.get(pane.id);
        if (was === undefined || pane.status === null || pane.id === viewed || pane.id === alsoViewed || pane.inboxHidden === true || pane.asleep) continue;
        const kind = pane.status === "idle" && was === "working" ? "done" : pane.status === "waiting" && was !== "waiting" ? "waiting" : null;
        if (kind !== null) out.push({ paneId: pane.id, paneName: pane.name, spaceId: space.id, spaceName: space.name, tabId: tab.id, kind });
      }
    }
  }
  return out;
}

// The setting.
const KEY = "herdr.replyNotify";
const listeners = new Set<() => void>();
function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
let on = read();

export function setReplyNotify(next: boolean): void {
  on = next;
  try {
    window.localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    // storage blocked: it holds for this page only
  }
  for (const listener of listeners) listener();
}

export function useReplyNotify(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => on,
  );
}

/** A message sent from the quick-reply modal, shown until the transcript gets a user message after it. `base`: the transcript's user messages at send time. */
export interface PendingSend {
  readonly id: string;
  readonly text: string;
  readonly base: number;
}

const userCount = (messages: readonly ChatMessage[]) => messages.filter((m) => m.role === "user").length;

export const pendingFor = (messages: readonly ChatMessage[], text: string, id: string): PendingSend => ({ id, text, base: userCount(messages) });

/** The shown messages plus the sent ones the transcript has not caught up with: any new user message in the transcript settles the oldest pending one (so a slash command or image path logged differently still clears it). */
export function withPending(shown: readonly ChatMessage[], all: readonly ChatMessage[], pending: readonly PendingSend[]): ChatMessage[] {
  const n = userCount(all);
  const echoes = pending
    .filter((p, i) => n < p.base + 1 + pending.slice(0, i).filter((q) => q.base === p.base).length)
    .map((p): ChatMessage => ({ id: `pending-${p.id}`, role: "user", at: "", parts: [{ kind: "text", text: p.text }] }));
  return [...shown, ...echoes];
}
