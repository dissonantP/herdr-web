import { useSyncExternalStore } from "react";

// The Chat/Terminal choice for chat-capable panes, kept per browser so it carries over when switching spaces, tabs and panes.

export type PaneViewMode = "chat" | "terminal";

const KEY = "herdr.paneview";

function load(): PaneViewMode {
  try {
    return window.localStorage.getItem(KEY) === "terminal" ? "terminal" : "chat";
  } catch {
    return "chat";
  }
}

let current = load();
const listeners = new Set<() => void>();

export function setPaneView(view: PaneViewMode): void {
  current = view;
  try {
    window.localStorage.setItem(KEY, view);
  } catch {
    // Storage blocked: the choice still holds until reload.
  }
  for (const listener of listeners) listener();
}

export function usePaneView(): PaneViewMode {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => current,
  );
}
