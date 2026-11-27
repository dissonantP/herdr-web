import type { GroupNode, SpaceNode, Tree } from "./model.ts";

// Walking the tree's spaces, nested ones included (a nested space is only in its parent's `children`).

/** A space and every space nested beneath it, depth first, parent before children. */
export function spaceAndBelow(space: SpaceNode): SpaceNode[] {
  return [space, ...space.children.flatMap(spaceAndBelow)];
}

/** Every space in the tree, nested ones included, in display order. */
export function allSpaces(tree: Tree): SpaceNode[] {
  const fromGroup = (g: GroupNode): SpaceNode[] => [...g.spaces.flatMap(spaceAndBelow), ...g.groups.flatMap(fromGroup)];
  return [...tree.spaces.flatMap(spaceAndBelow), ...tree.groups.flatMap(fromGroup)];
}
