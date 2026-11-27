import type { HcRpc } from "./client.ts";
import { changeTreeDoc, EMPTY_TREE_DOC, readTreeDoc } from "./tree-doc.ts";

// The quiet flag of a space (SPEC, "Hierarchy of spaces"): `spaces.<id>.quiet` in `herdr-tree`
// (tree-doc.ts). Quiet means "don't alert; my parent orchestrator reports": the space never pushes
// for itself.

type Rpc = Pick<HcRpc, "getDoc" | "setDoc">;

/** The spaces `herdr-tree` marks quiet (none when the doc does not exist yet). */
export async function readQuietSpaces(rpc: Pick<Rpc, "getDoc">): Promise<Set<string>> {
  // Push only reads it: an unreadable doc means nothing is known to be quiet.
  return new Set((await readTreeDoc(rpc).catch(() => EMPTY_TREE_DOC)).quiet);
}

/**
 * Mark a space quiet (or not). A space the doc does not know yet gets an entry with no `parent`
 * yet, so the next tree read still nests it as a new space (tree-doc.ts `reconcile`).
 */
export async function recordQuiet(rpc: Rpc, spaceId: string, quiet = true): Promise<void> {
  await changeTreeDoc(rpc, (doc) => {
    const entry = doc.spaces[spaceId];
    if ((entry?.quiet === true) === quiet) return false;
    doc.spaces[spaceId] = entry === undefined ? { quiet } : { ...entry, quiet };
    return true;
  });
}
