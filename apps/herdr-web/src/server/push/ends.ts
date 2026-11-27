import type { AdminAction, GroupNode, SpaceNode, Tree } from "../../shared/model.ts";
import { allSpaces, spaceAndBelow } from "../../shared/tree-walk.ts";

// Which panes an admin change ends, from the tree as it is before the change, so their ending is
// not reported as a session dying (push/service.ts `expectEnding`).

const spacePanes = (s: SpaceNode): string[] => s.tabs.flatMap((t) => t.panes.map((p) => p.id));
const groupPanes = (g: GroupNode): string[] => [...g.spaces.flatMap(spaceAndBelow).flatMap(spacePanes), ...g.groups.flatMap(groupPanes)];

export function endedBy(action: AdminAction, tree: Tree): string[] {
  const spaces = allSpaces(tree);
  switch (action.type) {
    case "pane.close":
      return [action.id];
    case "tab.delete":
      return spaces.flatMap((s) => s.tabs.filter((t) => t.id === action.id).flatMap((t) => t.panes.map((p) => p.id)));
    case "space.delete":
      // `delete` takes its nested spaces too; `lift` keeps them.
      return spaces.filter((s) => s.id === action.id).flatMap((s) => (action.children === "delete" ? spaceAndBelow(s) : [s])).flatMap(spacePanes);
    case "group.delete": {
      if (action.children !== "delete") return []; // `lift` ends nothing
      const find = (groups: readonly GroupNode[]): GroupNode | undefined => {
        for (const g of groups) {
          if (g.id === action.id) return g;
          const inner = find(g.groups);
          if (inner !== undefined) return inner;
        }
        return undefined;
      };
      const g = find(tree.groups);
      return g === undefined ? [] : groupPanes(g);
    }
    default:
      return [];
  }
}
