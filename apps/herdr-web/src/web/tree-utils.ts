import type { GroupNode, PaneNode, SpaceNode, TabNode, Tree } from "../shared/model.ts";
import { allSpaces } from "../shared/tree-walk.ts";

export { allSpaces };

export function findSpace(tree: Tree, id: string): SpaceNode | null {
  return allSpaces(tree).find((s) => s.id === id) ?? null;
}

type Counted = PaneNode | TabNode | SpaceNode | GroupNode;

function count(node: Counted, is: (pane: PaneNode) => boolean): number {
  if ("status" in node) return is(node) ? 1 : 0;
  if ("panes" in node) return node.panes.reduce((n, p) => n + count(p, is), 0);
  if ("tabs" in node) return node.tabs.reduce((n, t) => n + count(t, is), 0) + node.children.reduce((n, c) => n + count(c, is), 0);
  return node.spaces.reduce((n, s) => n + count(s, is), 0) + node.groups.reduce((n, g) => n + count(g, is), 0);
}

/** How many panes at or under a node (nested spaces included) are waiting for input. */
export const waitingIn = (node: Counted): number => count(node, (p) => p.status === "waiting");

/** How many panes at or under a node (nested spaces included) finished a turn nobody has viewed yet. */
export const unseenIn = (node: Counted): number => count(node, (p) => p.unseen === true);

/** How many panes at or under a node (nested spaces included) have an agent working. */
export const workingIn = (node: Counted): number => count(node, (p) => p.status === "working");

/** How many panes at or under a node (nested spaces included) are asleep. */
const asleepIn = (node: Counted): number => count(node, (p) => p.asleep);

/** A space is sleeping when it has a sleeping session and no agent awake in it (nested spaces count as part of it). */
export const isSleeping = (node: Counted): boolean => asleepIn(node) > 0 && count(node, (p) => p.status !== null) === 0;

export interface Filtered {
  /** The tree cut down to what matches the query, in the same order. */
  readonly tree: Tree;
  /** Groups and spaces with a match somewhere beneath them: shown open so the match is visible. */
  readonly open: ReadonlySet<string>;
  readonly matches: number;
}

const has = (name: string, needle: string) => name.toLowerCase().includes(needle);

/**
 * The tree filtered by name (case-insensitive substring). A group, space or tab that matches keeps
 * everything beneath it; otherwise it stays only for the matching things beneath it. An empty
 * query keeps the whole tree.
 */
export function filterTree(tree: Tree, query: string): Filtered {
  const needle = query.trim().toLowerCase();
  if (needle === "") return { tree, open: new Set(), matches: 0 };
  const open = new Set<string>();
  let matches = 0;

  const tab = (t: TabNode): TabNode | null => {
    if (has(t.name, needle)) {
      matches += 1;
      return t;
    }
    const panes = t.panes.filter((p) => has(p.name, needle));
    matches += panes.length;
    return panes.length > 0 ? { ...t, panes } : null;
  };
  const space = (s: SpaceNode): SpaceNode | null => {
    if (has(s.name, needle)) {
      matches += 1;
      return s;
    }
    const tabs = s.tabs.map(tab).filter((t): t is TabNode => t !== null);
    const children = s.children.map(space).filter((c): c is SpaceNode => c !== null);
    if (tabs.length === 0 && children.length === 0) return null;
    open.add(s.id);
    return { ...s, tabs, children };
  };
  const group = (g: GroupNode): GroupNode | null => {
    if (has(g.name, needle)) {
      matches += 1;
      return g;
    }
    const spaces = g.spaces.map(space).filter((s): s is SpaceNode => s !== null);
    const groups = g.groups.map(group).filter((c): c is GroupNode => c !== null);
    if (spaces.length === 0 && groups.length === 0) return null;
    open.add(g.id);
    return { ...g, spaces, groups };
  };
  return {
    tree: {
      spaces: tree.spaces.map(space).filter((s): s is SpaceNode => s !== null),
      groups: tree.groups.map(group).filter((g): g is GroupNode => g !== null),
    },
    open,
    matches,
  };
}

/** The programs running at or under a node (its terminal panes, nested spaces included), as deleting it all would end them. */
export function runningIn(node: PaneNode | TabNode | SpaceNode | GroupNode): PaneNode[] {
  if ("status" in node) return node.kind === "terminal" ? [node] : [];
  if ("panes" in node) return node.panes.flatMap(runningIn);
  if ("tabs" in node) return [...node.tabs.flatMap(runningIn), ...node.children.flatMap(runningIn)];
  return [...node.spaces.flatMap(runningIn), ...node.groups.flatMap(runningIn)];
}

/** Every group, depth first in display order, with how deep it sits (0: top level). */
export function allGroups(tree: Tree): { readonly group: GroupNode; readonly depth: number }[] {
  const walk = (g: GroupNode, depth: number): { group: GroupNode; depth: number }[] => [{ group: g, depth }, ...g.groups.flatMap((c) => walk(c, depth + 1))];
  return tree.groups.flatMap((g) => walk(g, 0));
}

/** Every space, depth first in display order, with how deeply it is nested (0: top level). */
export function spacesWithDepth(tree: Tree): { readonly space: SpaceNode; readonly depth: number }[] {
  const walk = (s: SpaceNode, depth: number): { space: SpaceNode; depth: number }[] => [{ space: s, depth }, ...s.children.flatMap((c) => walk(c, depth + 1))];
  const fromGroup = (g: GroupNode): SpaceNode[] => [...g.spaces, ...g.groups.flatMap(fromGroup)];
  return [...tree.spaces, ...tree.groups.flatMap(fromGroup)].flatMap((s) => walk(s, 0));
}

/** The space a space is nested in, or `null` at the top level. */
export function parentOfSpace(tree: Tree, spaceId: string): SpaceNode | null {
  return allSpaces(tree).find((s) => s.children.some((c) => c.id === spaceId)) ?? null;
}

/** The group a space sits in directly, or `null` for none. */
export function groupOfSpace(tree: Tree, spaceId: string): GroupNode | null {
  return allGroups(tree).find(({ group }) => group.spaces.some((s) => s.id === spaceId))?.group ?? null;
}

export interface InboxItem {
  readonly spaceId: string;
  readonly spaceName: string;
  readonly tabId: string;
  readonly pane: PaneNode;
}

/** The order the inbox shows: waiting on you first, then working, then idle. */
export const INBOX_ORDER = ["waiting", "working", "idle"] as const;

/**
 * Every agent pane in the tree (shells have no status; panes labelled `herdr.inbox=hide` and dismissed ones are skipped), waiting first, then working, then idle;
 * inside each, in the tree's order. With `pins` given, an idle pane (no unseen reply) in an unpinned space is left out.
 */
export function inboxItems(tree: Tree, pins?: readonly string[]): InboxItem[] {
  const items: InboxItem[] = [];
  for (const space of allSpaces(tree)) {
    for (const tab of space.tabs) for (const pane of tab.panes) if (pane.status !== null && !pane.inboxHidden && pane.dismissed !== true && (pins === undefined || pins.includes(space.id) || dotState(pane) !== "idle")) items.push({ spaceId: space.id, spaceName: space.name, tabId: tab.id, pane });
  }
  const rank = (i: InboxItem) => INBOX_ORDER.indexOf(i.pane.status ?? "idle");
  return items.map((item, n) => ({ item, n })).sort((a, b) => rank(a.item) - rank(b.item) || a.n - b.n).map((x) => x.item);
}

export type DotState = "working" | "waiting" | "finished" | "idle" | "asleep" | "none";

/** The one mapping from a pane to its status dot, used by every view: asleep, finished (idle with an unseen turn), or its status. */
export function dotState(pane: PaneNode): DotState {
  if (pane.asleep) return "asleep";
  if (pane.status === "idle" && pane.unseen === true) return "finished";
  return pane.status ?? "none";
}
