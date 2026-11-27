import { useSyncExternalStore } from "react";
import type { GroupNode, SpaceNode, Tree } from "../shared/model.ts";
import type { Route } from "./router.ts";
import { dotState, findSpace, type DotState } from "./tree-utils.ts";

// The quick launcher (task 059): a command-palette overlay that fuzzy-finds groups, spaces, tabs and
// panes by name. This file is the pure part (entries, fuzzy match, recents) and the open/closed state.

export interface Entry {
  readonly key: string;
  readonly kind: "space";
  readonly name: string;
  /** Where it sits, e.g. `Work › alpha › tab`. Empty at the top level. */
  readonly path: string;
  readonly status: DotState | null;
  readonly asleep: boolean;
  /** Where Enter goes. */
  readonly route: Route;
  readonly spaceId: string;
}

const SEP = " › ";
const ORDER: readonly DotState[] = ["waiting", "working", "finished", "idle"];

function worst(statuses: readonly DotState[]): DotState | null {
  return ORDER.find((s) => statuses.includes(s)) ?? null;
}

function spaceStatuses(space: SpaceNode): DotState[] {
  return [...space.tabs.flatMap((t) => t.panes.map(dotState)), ...space.children.flatMap(spaceStatuses)];
}

/** Every space in the tree (not groups, tabs or panes) as a launcher entry, in display order. */
export function entries(tree: Tree): Entry[] {
  const out: Entry[] = [];
  const space = (s: SpaceNode, trail: readonly string[]) => {
    out.push({ key: `s:${s.id}`, kind: "space", name: s.name, path: trail.join(SEP), status: worst(spaceStatuses(s)), asleep: false, route: { space: s.id, tab: null, pane: null }, spaceId: s.id });
    for (const c of s.children) space(c, [...trail, s.name]);
  };
  const group = (g: GroupNode, trail: readonly string[]) => {
    const here = [...trail, g.name];
    for (const s of g.spaces) space(s, here);
    for (const c of g.groups) group(c, here);
  };
  for (const s of tree.spaces) space(s, []);
  for (const g of tree.groups) group(g, []);
  return out;
}

/** A subsequence match score (higher is better), or `null` when the query's letters aren't all in the text in order. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q === "") return 0;
  const whole = t.indexOf(q);
  if (whole >= 0) return 1000 - whole * 4 - (t.length - q.length) + (whole === 0 ? 200 : 0) + (whole > 0 && /[\s\-_/.›]/.test(t[whole - 1] ?? "") ? 100 : 0);
  let score = 0;
  let at = -1;
  let run = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, at + 1);
    if (i < 0) return null;
    run = i === at + 1 ? run + 1 : 0;
    score += 10 + run * 5 - Math.min(i - at - 1, 10);
    at = i;
  }
  return score;
}

/** Entries matching the query, best first; with an empty query, recently opened spaces first, then the rest in display order. */
export function search(all: readonly Entry[], query: string, recents: readonly string[]): Entry[] {
  const q = query.trim();
  if (q === "") {
    const rank = (e: Entry) => {
      const i = recents.indexOf(e.spaceId);
      return i < 0 ? Infinity : i;
    };
    const recent = all.filter((e) => rank(e) !== Infinity).sort((a, b) => rank(a) - rank(b));
    return [...recent, ...all.filter((e) => rank(e) === Infinity)];
  }
  const scored: { e: Entry; s: number }[] = [];
  for (const e of all) {
    const own = fuzzyScore(q, e.name);
    const viaPath = own === null ? fuzzyScore(q, e.path) : null;
    const s = own ?? (viaPath === null ? null : viaPath - 500);
    if (s !== null) scored.push({ e, s });
  }
  return scored.sort((a, b) => b.s - a.s).map((x) => x.e);
}

// Recently opened spaces, newest first, kept per browser.
const KEY = "herdr.recents";
const MAX_RECENTS = 12;

function loadRecents(): string[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function recordRecent(id: string): void {
  const next = [id, ...loadRecents().filter((x) => x !== id)].slice(0, MAX_RECENTS);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: recents just don't persist.
  }
}

/** Recents that still exist. */
export function liveRecents(tree: Tree): string[] {
  return loadRecents().filter((id) => findSpace(tree, id) !== null);
}

// Open state.
let open = false;
const listeners = new Set<() => void>();
export function setLauncherOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const l of listeners) l();
}
export const toggleLauncher = (): void => setLauncherOpen(!open);
export function useLauncherOpen(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => open,
  );
}
