import type { PaneNode, Tree } from "../shared/model.ts";
import { allSpaces } from "../shared/tree-walk.ts";

/** The pane with this id anywhere in the tree, or `null`. */
export function findPane(tree: Tree, id: string): PaneNode | null {
  for (const space of allSpaces(tree)) {
    for (const tab of space.tabs) {
      const pane = tab.panes.find((p) => p.id === id);
      if (pane !== undefined) return pane;
    }
  }
  return null;
}
