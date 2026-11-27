import type { Tree } from "../shared/model.ts";
import type { Route } from "./router.ts";
import { findSpace } from "./tree-utils.ts";

// Where a tab or pin shortcut (task 097) goes. Pure, so the stepping and wrapping can be unit tested.

/** The pinned spaces that still exist, in dock order: the dock's pins and the shortcut numbers both index this. */
export function shownPins(tree: Tree, pins: readonly string[]): string[] {
  return pins.filter((id) => findSpace(tree, id) !== null);
}

const step = (len: number, at: number, d: 1 | -1) => (at < 0 ? (d === 1 ? 0 : len - 1) : (at + d + len) % len);

export type NavKey = { readonly kind: "tab" | "pin"; readonly dir: 1 | -1 } | { readonly kind: "pinAt"; readonly n: number };

/** The route a shortcut goes to, or null when there is nowhere to go (it still counts as handled). Both step kinds wrap. */
export function shortcutTarget(tree: Tree, route: Route, pins: readonly string[], key: NavKey): Route | null {
  if (key.kind === "tab") {
    const space = route.space === null ? null : findSpace(tree, route.space);
    if (space === null || space.tabs.length === 0) return null;
    const at = Math.max(0, space.tabs.findIndex((t) => t.id === route.tab));
    const tab = space.tabs[step(space.tabs.length, at, key.dir)];
    return tab === undefined ? null : { space: space.id, tab: tab.id, pane: null };
  }
  const shown = shownPins(tree, pins);
  const id = key.kind === "pinAt" ? shown[key.n - 1] : shown[step(shown.length, route.space === null ? -1 : shown.indexOf(route.space), key.dir)];
  return id === undefined ? null : { space: id, tab: null, pane: null };
}
