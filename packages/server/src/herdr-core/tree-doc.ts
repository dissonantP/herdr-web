import { HcError, type HcRpc } from "./client.ts";
import type { JsonObject, JsonValue } from "./json.ts";

// The nesting of spaces (SPEC, "Hierarchy of spaces"): the herdr-core doc `herdr-tree`,
// `{spaces: {"<space id>": {parent: "<space id>" | null, quiet: bool}}}`. (Older docs also had a `root`
// space id; {@link migrateTreeDoc} drops it and makes the root's children top level.)
// It is herdr's own doc (not herdr-app's, which Desktop owns, nor the groups file, which drops
// unknown fields). Every write is a doc.set on the version read, started again from a concurrent
// writer's version, and carries over any field it does not own.
//
// Integrity, kept by {@link reconcile} on every tree read:
// - an entry for a space that is no longer in herdr-app is dropped, and the spaces nested in it move
//   up to its own parent;
// - a space herdr-app shows but the doc does not place yet (no entry, or one without `parent`) is new: it is nested in the space its first
//   terminal's parent terminal belongs to (that terminal's `herdr.space` label), else at the top;
// - a parent that is missing or would close a cycle is read as "top level" ({@link effectiveParents}),
//   so a hand-edited doc can never hang or hide the tree. Moves made here refuse cycles outright.

export const TREE_DOC = "herdr-tree";
const ATTEMPTS = 5;

type Rpc = Pick<HcRpc, "getDoc" | "setDoc">;

const isObject = (v: JsonValue | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** The doc as read: each space's parent and quiet flag, by id. */
export interface TreeDoc {
  readonly parents: ReadonlyMap<string, string | null>;
  readonly quiet: ReadonlySet<string>;
}

export const EMPTY_TREE_DOC: TreeDoc = { parents: new Map(), quiet: new Set() };

/**
 * A doc of the older shape, `{root, spaces}`, as the current shape: the `root` field dropped and the
 * spaces that were nested directly in that root space made top level. Any other doc is returned as is.
 */
function withoutRoot(value: JsonObject): JsonObject {
  if (!("root" in value)) return value;
  const { root, ...rest } = value;
  if (typeof root !== "string" || root === "" || !isObject(rest.spaces)) return rest;
  const spaces: JsonObject = {};
  for (const [id, entry] of Object.entries(rest.spaces)) spaces[id] = isObject(entry) && entry.parent === root ? { ...entry, parent: null } : entry;
  return { ...rest, spaces };
}

export function parseTreeDoc(raw: JsonValue | undefined): TreeDoc {
  if (!isObject(raw)) return EMPTY_TREE_DOC;
  const value = withoutRoot(raw);
  const parents = new Map<string, string | null>();
  const quiet = new Set<string>();
  if (isObject(value.spaces)) {
    for (const [id, entry] of Object.entries(value.spaces)) {
      if (!isObject(entry)) continue;
      parents.set(id, typeof entry.parent === "string" && entry.parent !== "" ? entry.parent : null);
      if (entry.quiet === true) quiet.add(id);
    }
  }
  return { parents, quiet };
}

/** The doc, read for its meaning (empty when never written). Rejects when the core can't be read: never act on a guess. */
export async function readTreeDoc(rpc: Pick<Rpc, "getDoc">): Promise<TreeDoc> {
  return parseTreeDoc((await rpc.getDoc(TREE_DOC)).value);
}

/** The doc as a mutable object: `spaces` an object of entry objects. */
export interface EditableTreeDoc extends JsonObject {
  spaces: { [id: string]: JsonObject };
}

function editable(value: JsonValue): EditableTreeDoc {
  const next: JsonObject = isObject(value) ? withoutRoot(structuredClone(value)) : {};
  const spaces: { [id: string]: JsonObject } = {};
  if (isObject(next.spaces)) for (const [id, entry] of Object.entries(next.spaces)) if (isObject(entry)) spaces[id] = entry;
  return { ...next, spaces };
}

/** A new entry with the doc's fields. */
export const newEntry = (parent: string | null): JsonObject => ({ parent, quiet: false });

/**
 * Change the doc: `edit` gets an editable copy as it is now and returns whether it changed it.
 * Lands only on the version read; a conflict starts again from the other writer's version.
 * Returns the doc as written (or as it was, when nothing changed). `edit` may throw to refuse.
 */
export async function changeTreeDoc(rpc: Rpc, edit: (doc: EditableTreeDoc) => boolean | Promise<boolean>): Promise<TreeDoc> {
  for (let i = 0; i < ATTEMPTS; i++) {
    const raw = await rpc.getDoc(TREE_DOC);
    const doc = editable(raw.value);
    if (!(await edit(doc))) return parseTreeDoc(raw.value);
    try {
      await rpc.setDoc(TREE_DOC, doc, raw.version);
      return parseTreeDoc(doc);
    } catch (err) {
      if (!(err instanceof HcError && err.kind === "conflict")) throw err;
    }
  }
  throw new Error("herdr-tree kept changing meanwhile; try again.");
}

/**
 * Rewrite a doc of the older shape (with a `root`) as the current one, once, on start. Lands only on
 * the version read; a conflict starts again. Returns whether it wrote.
 */
export async function migrateTreeDoc(rpc: Rpc): Promise<boolean> {
  for (let i = 0; i < ATTEMPTS; i++) {
    const raw = await rpc.getDoc(TREE_DOC);
    if (!isObject(raw.value) || !("root" in raw.value)) return false;
    try {
      await rpc.setDoc(TREE_DOC, withoutRoot(raw.value), raw.version);
      return true;
    } catch (err) {
      if (!(err instanceof HcError && err.kind === "conflict")) throw err;
    }
  }
  throw new Error("herdr-tree kept changing meanwhile; try again.");
}

/**
 * Each space's parent as the tree draws it: the doc's parent when that space exists and following
 * parents up never comes back round; otherwise `null` (top level).
 */
export function effectiveParents(doc: TreeDoc, spaces: ReadonlySet<string>): Map<string, string | null> {
  const declared = (id: string): string | null => {
    const p = doc.parents.get(id) ?? null;
    return p !== null && p !== id && spaces.has(p) ? p : null;
  };
  const out = new Map<string, string | null>();
  for (const id of spaces) {
    const seen = new Set([id]);
    let at = declared(id);
    let cycle = false;
    while (at !== null) {
      if (seen.has(at)) {
        cycle = true;
        break;
      }
      seen.add(at);
      at = declared(at);
    }
    out.set(id, cycle ? null : declared(id));
  }
  return out;
}

/** A space and every space nested beneath it (by these parents), the space first. */
export function subtree(parents: ReadonlyMap<string, string | null>, id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const [child, parent] of parents) if (parent === out[i]) out.push(child);
  return out;
}

/** What {@link reconcile} needs to know about herdr-app's spaces right now. */
export interface ReconcileFacts {
  /** The spaces herdr-app shows. */
  readonly spaces: ReadonlySet<string>;
  /**
   * A new space's parent from its first terminal: the space id, `null` for no known parent, or
   * `undefined` when it cannot tell yet (no live terminal): then it is left for a later read.
   */
  parentOfNew(spaceId: string): string | null | undefined;
  /** Spaces being made right now (their entry may be written before herdr-app shows them). */
  readonly pending: ReadonlySet<string>;
}

/** The entries {@link reconcile} would drop as gone. */
export function goneIn(doc: EditableTreeDoc, facts: ReconcileFacts): string[] {
  return Object.keys(doc.spaces).filter((id) => !facts.spaces.has(id) && !facts.pending.has(id));
}

/** Apply the integrity rules to an editable doc; whether anything changed. */
export function reconcile(doc: EditableTreeDoc, facts: ReconcileFacts): boolean {
  let changed = false;
  const parentOf = (id: string): string | null => {
    const p = doc.spaces[id]?.parent;
    return typeof p === "string" && p !== "" ? p : null;
  };
  // Entries of spaces that are gone: their children move up past every gone ancestor.
  const gone = new Set(goneIn(doc, facts));
  if (gone.size > 0) {
    const liftTo = (id: string | null): string | null => {
      const seen = new Set<string>();
      let at = id;
      while (at !== null && gone.has(at) && !seen.has(at)) {
        seen.add(at);
        at = parentOf(at);
      }
      return at !== null && gone.has(at) ? null : at;
    };
    for (const [id, entry] of Object.entries(doc.spaces)) {
      if (gone.has(id)) continue;
      const p = parentOf(id);
      if (p !== null && gone.has(p)) entry.parent = liftTo(p);
    }
    for (const id of gone) delete doc.spaces[id];
    changed = true;
  }
  for (const id of facts.spaces) {
    // New: no entry, or one with no `parent` yet (its quiet flag was recorded before it was placed).
    const entry = doc.spaces[id];
    if ((entry !== undefined && "parent" in entry) || facts.pending.has(id)) continue;
    const found = facts.parentOfNew(id);
    if (found === undefined) continue;
    const parent = found !== null && found !== id && facts.spaces.has(found) ? found : null;
    doc.spaces[id] = { ...newEntry(parent), ...entry, parent };
    changed = true;
  }
  return changed;
}
