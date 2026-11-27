import { allSpaces } from "../shared/tree-walk.ts";
import type { AdminAction, GroupNode, PaneNode, SpaceNode, TabNode, Tree } from "../shared/model.ts";

// What the tree will look like once the server has made a change (task 142), so the screen shows it at
// once. It is only a guess: the server's next tree replaces it. `null`: no guess (a create needs the
// server's new ids), so that change waits for the server.

type Spaces = readonly SpaceNode[];

/** Every space list in the tree (top level, each group's, each space's children) passed through `f`. */
function mapSpaceLists(tree: Tree, f: (spaces: Spaces) => Spaces): Tree {
  const space = (s: SpaceNode): SpaceNode => ({ ...s, children: f(s.children).map(space) });
  const group = (g: GroupNode): GroupNode => ({ ...g, spaces: f(g.spaces).map(space), groups: g.groups.map(group) });
  return { spaces: f(tree.spaces).map(space), groups: tree.groups.map(group) };
}

function mapGroupLists(tree: Tree, f: (groups: readonly GroupNode[]) => readonly GroupNode[]): Tree {
  const group = (g: GroupNode): GroupNode => ({ ...g, groups: f(g.groups).map(group) });
  return { ...tree, groups: f(tree.groups).map(group) };
}

const mapSpace = (tree: Tree, id: string, f: (s: SpaceNode) => SpaceNode) => mapSpaceLists(tree, (list) => list.map((s) => (s.id === id ? f(s) : s)));
const mapGroup = (tree: Tree, id: string, f: (g: GroupNode) => GroupNode) => mapGroupLists(tree, (list) => list.map((g) => (g.id === id ? f(g) : g)));

const mapTabs = (tree: Tree, f: (tabs: readonly TabNode[]) => readonly TabNode[]) => mapSpaceLists(tree, (list) => list.map((s) => ({ ...s, tabs: f(s.tabs) })));
const mapTab = (tree: Tree, id: string, f: (t: TabNode) => TabNode) => mapTabs(tree, (tabs) => tabs.map((t) => (t.id === id ? f(t) : t)));
// A tab whose last pane closes goes with it, as in herdr-core.
const mapPanes = (tree: Tree, f: (panes: readonly PaneNode[]) => readonly PaneNode[]) => mapTabs(tree, (tabs) => tabs.map((t) => ({ ...t, panes: f(t.panes) })).filter((t, i) => t.panes.length > 0 || tabs[i]?.panes.length === 0));
const mapPane = (tree: Tree, id: string, f: (p: PaneNode) => PaneNode) => mapPanes(tree, (panes) => panes.map((p) => (p.id === id ? f(p) : p)));

const allPanes = (tree: Tree): PaneNode[] => allSpaces(tree).flatMap((s) => s.tabs.flatMap((t) => t.panes));

function findSpace(tree: Tree, id: string): SpaceNode | null {
  let found: SpaceNode | null = null;
  mapSpaceLists(tree, (list) => {
    found ??= list.find((s) => s.id === id) ?? null;
    return list;
  });
  return found;
}

/** The tree without space `id`; `lift`: its children take its place. */
function withoutSpace(tree: Tree, id: string, lift: boolean): Tree {
  return mapSpaceLists(tree, (list) => list.flatMap((s) => (s.id === id ? (lift ? s.children : []) : [s])));
}

function withoutGroup(tree: Tree, id: string, lift: boolean): Tree {
  let lifted: GroupNode | null = null;
  const pull = (list: readonly GroupNode[]) => list.flatMap((g) => {
    if (g.id !== id) return [g];
    lifted = g;
    return lift ? g.groups : [];
  });
  const groupsDone = mapGroupLists(tree, pull);
  const gone = lifted as GroupNode | null;
  if (!lift || gone === null) return groupsDone;
  // Its spaces go up a level too: into the group it was in, or to the top.
  const parent = (list: readonly GroupNode[]): GroupNode | null => list.find((g) => g.groups.some((c) => c.id === id)) ?? list.map((g) => parent(g.groups)).find((g) => g !== null) ?? null;
  const into = parent(tree.groups);
  if (into === null) return { ...groupsDone, spaces: [...groupsDone.spaces, ...gone.spaces] };
  return mapGroup(groupsDone, into.id, (g) => ({ ...g, spaces: [...g.spaces, ...gone.spaces] }));
}

export function predict(tree: Tree, action: AdminAction): Tree | null {
  switch (action.type) {
    case "group.rename":
      return mapGroup(tree, action.id, (g) => ({ ...g, name: action.name.trim() }));
    case "group.color":
      return mapGroup(tree, action.id, (g) => ({ ...g, color: action.color }));
    case "group.delete":
      return withoutGroup(tree, action.id, action.children === "lift");
    case "space.rename":
      // An empty name lets Herdr name it after its folder, which only the server knows.
      return action.name.trim() === "" ? null : mapSpace(tree, action.id, (s) => ({ ...s, name: action.name.trim() }));
    case "space.color":
      return mapSpace(tree, action.id, (s) => ({ ...s, color: action.color }));
    case "space.quiet":
      return mapSpace(tree, action.id, (s) => ({ ...s, quiet: action.quiet }));
    case "space.delete":
      return withoutSpace(tree, action.id, action.children === "lift");
    case "space.move": {
      const space = findSpace(tree, action.id);
      if (space === null) return null;
      const out = withoutSpace(tree, action.id, false);
      return action.groupId === null ? { ...out, spaces: [...out.spaces, space] } : mapGroup(out, action.groupId, (g) => ({ ...g, spaces: [...g.spaces, space] }));
    }
    case "space.reparent": {
      const space = findSpace(tree, action.id);
      // Back at the top it returns to the group the groups file still gives it, which only the server knows.
      if (space === null || action.parentId === null) return null;
      const parentId = action.parentId;
      return mapSpace(withoutSpace(tree, action.id, false), parentId, (p) => ({ ...p, children: [...p.children, space] }));
    }
    case "tab.rename":
      return action.name.trim() === "" ? null : mapTab(tree, action.id, (t) => ({ ...t, name: action.name.trim() }));
    case "tab.delete":
      return mapTabs(tree, (tabs) => tabs.filter((t) => t.id !== action.id));
    case "pane.close":
      return mapPanes(tree, (panes) => panes.filter((p) => p.id !== action.id));
    case "pane.sleep":
      return mapPane(tree, action.id, (p) => ({ ...p, agent: null, status: null, asleep: true, waking: undefined }));
    case "pane.wake":
      return mapPane(tree, action.id, (p) => ({ ...p, asleep: false, waking: true }));
    case "pane.seen":
      return mapPane(tree, action.id, (p) => ({ ...p, unseen: undefined }));
    case "pane.dismiss": {
      // The server keeps a pane waiting on an answer in the Inbox, so only it can say.
      const pane = allPanes(tree).find((p) => p.id === action.id);
      return pane === undefined || pane.status === "waiting" ? null : mapPane(tree, action.id, (p) => ({ ...p, unseen: undefined, dismissed: true }));
    }
    case "group.create":
    case "space.create":
    case "tab.create":
      return null;
  }
}
