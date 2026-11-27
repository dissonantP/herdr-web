import { useEffect, useState } from "react";

// A tiny path router on the History API, so the phone's back button walks back through screens.
//   /                          the tree
//   /s/<space>[/<tab>[/<pane>]] a space, optionally at one tab and pane

export interface Route {
  readonly space: string | null;
  readonly tab: string | null;
  readonly pane: string | null;
  /** The settings page (`/settings`); the other fields are then `null`. */
  readonly settings?: boolean;
}

export function parseRoute(path: string): Route {
  const parts = path.split("/").filter((p) => p !== "").map(decodeURIComponent);
  if (parts.length === 1 && parts[0] === "settings") return { space: null, tab: null, pane: null, settings: true };
  if (parts[0] !== "s" || parts[1] === undefined) return { space: null, tab: null, pane: null };
  return { space: parts[1], tab: parts[2] ?? null, pane: parts[3] ?? null };
}

export function routePath(route: Route): string {
  if (route.settings === true) return "/settings";
  if (route.space === null) return "/";
  return "/" + ["s", route.space, route.tab, route.pane].filter((p): p is string => p !== null).map(encodeURIComponent).join("/");
}

const listeners = new Set<() => void>();
let depth = 0; // how many in-app screens are on the history stack above where the app opened

export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const path = routePath(route);
  if (path === window.location.pathname) return;
  if (opts.replace === true) window.history.replaceState({ depth }, "", path);
  else window.history.pushState({ depth: ++depth }, "", path);
  for (const listener of listeners) listener();
}

/** Back to the tree: the browser's back when the app put a screen on the stack, else a replace. */
export function goHome(): void {
  if (depth > 0) window.history.back();
  else navigate({ space: null, tab: null, pane: null }, { replace: true });
}

export function useRoute(): Route {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    const onPop = (event: PopStateEvent) => {
      const state: unknown = event.state;
      depth = typeof state === "object" && state !== null && "depth" in state && typeof state.depth === "number" ? state.depth : 0;
      update();
    };
    listeners.add(update);
    window.addEventListener("popstate", onPop);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", onPop);
    };
  }, []);
  return parseRoute(path);
}
