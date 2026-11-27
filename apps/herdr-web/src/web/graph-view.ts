import { useSyncExternalStore } from "react";

// Which view the app shows (the list, the node graph or the "needs you" inbox) and whether the graph
// draws each space's sessions as child nodes. Kept per browser.

export type ViewMode = "list" | "graph" | "inbox" | "pinned";
export interface GraphPrefs {
  readonly mode: ViewMode;
  readonly sessions: boolean;
}

/** Graph and Inbox views are parked (task 057): while false the switch is hidden and the app always shows the List. The code stays for later. */
export const VIEWS_ENABLED = false;

const KEY = "herdr.graph";
const DEFAULT: GraphPrefs = { mode: "list", sessions: false };

function load(): GraphPrefs {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Partial<GraphPrefs> | null;
    return { mode: raw?.mode === "graph" || raw?.mode === "inbox" || raw?.mode === "pinned" ? raw.mode : "list", sessions: raw?.sessions === true };
  } catch {
    return DEFAULT;
  }
}

let current = load();
const listeners = new Set<() => void>();

export function setGraphPrefs(change: Partial<GraphPrefs>): void {
  current = { ...current, ...change };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Storage blocked: the choice just doesn't persist.
  }
  for (const listener of listeners) listener();
}

export function useGraphPrefs(): GraphPrefs {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => current,
  );
}
