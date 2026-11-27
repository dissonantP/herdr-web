import { randomBytes } from "node:crypto";
import type { JsonObject, JsonValue } from "./json.ts";

// Edits to herdr-app's layout document (`herdr-app`), pure: a copy of the doc's value in, the
// changed value out (or `null`: nothing to change). Only the space, tab or pane asked for changes;
// every other part stays exactly as herdr-app wrote it, unknown fields included.
//
// Shape (HC_API.md § Documents, and a live doc on 2026-11-13): `{spaces: [{id, name, folder,
// tabs: [{id, name, root}]}]}`; `root` is a split tree of `{type: "row"|"column", id, children}`
// containers whose leaves are `{type: "block", id, content: {terminal} | {mod}}`. A tab's root row
// has the tab's id. Ids: `sp`, `tb` or `p` and 32 hex digits.
//
// Herdr Desktop changes structure through its own commands; with no Desktop window open,
// herdr writes the doc itself the way Shepherdr's service does with no window (eliasstravik/
// shepherdr service/saved-spaces.ts): doc.set with the version it read, retried on a conflict
// (admin.ts), so a concurrent Desktop write is never overwritten.

export const newId = (prefix: "sp" | "tb" | "p"): string => `${prefix}${randomBytes(16).toString("hex")}`;

type Obj = JsonObject;

function obj(value: JsonValue | undefined): Obj | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function list(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

/** The doc's spaces array, or `null` when the doc is not herdr-app's shape (never write those). */
function spacesOf(doc: JsonValue): JsonValue[] | null {
  const spaces = obj(doc)?.spaces;
  return Array.isArray(spaces) ? spaces : null;
}

function findSpace(doc: JsonValue, id: string): Obj | null {
  return (spacesOf(doc) ?? []).map(obj).find((s) => s?.id === id) ?? null;
}

function findTab(doc: JsonValue, id: string): { space: Obj; tab: Obj } | null {
  for (const space of (spacesOf(doc) ?? []).map(obj)) {
    const tab = list(space?.tabs).map(obj).find((t) => t?.id === id);
    if (space && tab) return { space, tab };
  }
  return null;
}

/** Every space id, in the doc's order. */
export function spaceIds(doc: JsonValue): string[] {
  return (spacesOf(doc) ?? []).map((s) => obj(s)?.id).filter((id): id is string => typeof id === "string");
}

/** The tab whose split tree shows this terminal, or `null`. */
export function tabOfTerminal(doc: JsonValue, terminal: string): string | null {
  for (const space of (spacesOf(doc) ?? []).map(obj)) {
    for (const tab of list(space?.tabs).map(obj)) if (tab !== null && typeof tab.id === "string" && terminalsIn(tab.root).includes(terminal)) return tab.id;
  }
  return null;
}

/** Show `next` where a block of this space shows `old`; `null` when no block shows `old`. */
export function replaceTerminal(doc: JsonValue, spaceId: string, old: string, next: string): JsonValue | null {
  let changed = false;
  const visit = (node: JsonValue | undefined) => {
    const n = obj(node);
    if (n === null) return;
    const content = obj(n.content);
    if (n.type === "block" && content?.terminal === old) {
      content.terminal = next;
      changed = true;
    }
    list(n.children).forEach(visit);
  };
  for (const tab of list(findSpace(doc, spaceId)?.tabs)) visit(obj(tab)?.root);
  return changed ? doc : null;
}

/** Every terminal a split tree shows, and its block ids. */
export function terminalsIn(node: JsonValue | undefined): string[] {
  const n = obj(node);
  if (n === null) return [];
  const terminal = obj(n.content)?.terminal;
  const own = n.type === "block" && typeof terminal === "string" && terminal !== "" ? [terminal] : [];
  return [...own, ...list(n.children).flatMap(terminalsIn)];
}

/** Every terminal the space's tabs show. */
export function spaceTerminals(doc: JsonValue, spaceId: string): string[] {
  return list(findSpace(doc, spaceId)?.tabs).flatMap((t) => terminalsIn(obj(t)?.root));
}

/** Every terminal the tab shows. */
export function tabTerminals(doc: JsonValue, tabId: string): string[] {
  return terminalsIn(findTab(doc, tabId)?.tab.root);
}

/** Every terminal any space shows. */
export function allTerminals(doc: JsonValue): string[] {
  return (spacesOf(doc) ?? []).flatMap((s) => list(obj(s)?.tabs).flatMap((t) => terminalsIn(obj(t)?.root)));
}

/** The space a tab is in, or `null`. */
export function spaceOfTab(doc: JsonValue, tabId: string): string | null {
  const id = findTab(doc, tabId)?.space.id;
  return typeof id === "string" ? id : null;
}

/** The space's folder (where it was made), or `null` when there is no such space. */
export function spaceFolder(doc: JsonValue, spaceId: string): string | null {
  const space = findSpace(doc, spaceId);
  if (space === null) return null;
  return typeof space.folder === "string" ? space.folder : "";
}

/** The space's own name (`""` when herdr-app derives it, or when there is no such space). */
export function spaceName(doc: JsonValue, spaceId: string): string {
  const name = findSpace(doc, spaceId)?.name;
  return typeof name === "string" ? name : "";
}

export function tabCount(doc: JsonValue, spaceId: string): number {
  return list(findSpace(doc, spaceId)?.tabs).length;
}

function tabOf(tabId: string, name: string, paneId: string, terminal: string): Obj {
  return { id: tabId, name, root: { type: "row", id: tabId, children: [{ type: "block", id: paneId, content: { terminal } }] } };
}

export interface NewTab {
  readonly tabId: string;
  readonly paneId: string;
  readonly terminal: string;
  readonly name: string;
}

/**
 * A new space at the end holding one tab with one terminal. When Desktop adopted the terminal first
 * (it already shows a space with this id), only the name is set.
 */
export function addSpace(doc: JsonValue, space: { id: string; name: string; folder: string }, tab: NewTab): JsonValue | null {
  const spaces = spacesOf(doc);
  if (spaces === null) return null;
  const known = findSpace(doc, space.id);
  if (known !== null) {
    if (known.name === space.name) return null;
    known.name = space.name;
    return doc;
  }
  spaces.push({ id: space.id, name: space.name, folder: space.folder, tabs: [tabOf(tab.tabId, tab.name, tab.paneId, tab.terminal)] });
  return doc;
}

/** A new tab at the end of a space. When Desktop adopted the terminal first, only the name is set. */
export function addTab(doc: JsonValue, spaceId: string, tab: NewTab): JsonValue | null {
  const known = findTab(doc, tab.tabId);
  if (known !== null) {
    if (known.tab.name === tab.name) return null;
    known.tab.name = tab.name;
    return doc;
  }
  const space = findSpace(doc, spaceId);
  if (space === null) return null;
  space.tabs = [...list(space.tabs), tabOf(tab.tabId, tab.name, tab.paneId, tab.terminal)];
  return doc;
}

/** Rename a space or a tab (`""`: herdr-app derives the name again). */
export function rename(doc: JsonValue, id: string, name: string): JsonValue | null {
  const target = findSpace(doc, id) ?? findTab(doc, id)?.tab ?? null;
  if (target === null || target.name === name) return null;
  target.name = name;
  return doc;
}

export function removeSpace(doc: JsonValue, id: string): JsonValue | null {
  const d = obj(doc);
  const spaces = spacesOf(doc);
  if (d === null || spaces === null || findSpace(doc, id) === null) return null;
  d.spaces = spaces.filter((s) => obj(s)?.id !== id);
  return doc;
}

export function removeTab(doc: JsonValue, id: string): JsonValue | null {
  const found = findTab(doc, id);
  if (found === null) return null;
  found.space.tabs = list(found.space.tabs).filter((t) => obj(t)?.id !== id);
  return doc;
}

/** The split tree without the leaves `drop` picks; containers left empty go too (`null`: all gone). */
function prune(node: JsonValue | undefined, drop: (block: Obj) => boolean): JsonValue | null {
  const n = obj(node);
  if (n === null) return node ?? null;
  if (n.type === "block") return drop(n) ? null : n;
  if (!Array.isArray(n.children)) return n;
  const children = n.children.map((c) => prune(c, drop)).filter((c): c is JsonValue => c !== null);
  if (children.length === 0) return null;
  return { ...n, children };
}

/**
 * Whether the pane is all that is left in its space (the only pane of its only tab). Closing it
 * would leave an empty split tree, which Desktop never writes; delete the space instead.
 */
export function isLastPaneOfSpace(doc: JsonValue, paneId: string): boolean {
  const drop = (b: Obj) => b.id === paneId || obj(b.content)?.terminal === paneId;
  return (spacesOf(doc) ?? []).some((raw) => {
    const tabs = list(obj(raw)?.tabs).map(obj);
    const root = tabs.length === 1 ? tabs[0]?.root : undefined;
    // The pane is in that tab, and nothing else is.
    return root !== undefined && prune(root, () => false) !== null && prune(root, drop) === null;
  });
}

/**
 * Close a pane: drop the block showing this terminal (or the mod block with this id). A tab left
 * with nothing goes too. A space's last pane is never removed (see {@link isLastPaneOfSpace}, which
 * closePane checks first): that tab stays as it was, so this stays safe on its own.
 */
export function removePane(doc: JsonValue, paneId: string): JsonValue | null {
  const drop = (b: Obj) => b.id === paneId || obj(b.content)?.terminal === paneId;
  let changed = false;
  for (const space of (spacesOf(doc) ?? []).map(obj)) {
    if (space === null) continue;
    const tabs = list(space.tabs);
    const next: JsonValue[] = [];
    for (const raw of tabs) {
      const tab = obj(raw);
      if (tab === null) {
        next.push(raw);
        continue;
      }
      const before = JSON.stringify(tab.root);
      const root = prune(tab.root, drop);
      if (JSON.stringify(root) === before) {
        next.push(tab);
        continue;
      }
      if (root === null && tabs.length <= 1) {
        next.push(tab);
        continue;
      }
      changed = true;
      if (root === null) continue;
      tab.root = root;
      next.push(tab);
    }
    space.tabs = next;
  }
  return changed ? doc : null;
}

/**
 * Drop every block showing one of these (removed) terminals; a tab left with no blocks goes, and a
 * space left with no tabs goes (as space.js's detach does). Mod blocks stay. `null`: nothing shown.
 */
export function dropTerminals(doc: JsonValue, gone: ReadonlySet<string>): JsonValue | null {
  const d = obj(doc);
  const spaces = spacesOf(doc);
  if (d === null || spaces === null || gone.size === 0) return null;
  const drop = (b: Obj) => {
    const terminal = obj(b.content)?.terminal;
    return typeof terminal === "string" && gone.has(terminal);
  };
  let changed = false;
  const keptSpaces: JsonValue[] = [];
  for (const raw of spaces) {
    const space = obj(raw);
    if (space === null) {
      keptSpaces.push(raw);
      continue;
    }
    const tabs = list(space.tabs);
    const keptTabs: JsonValue[] = [];
    for (const rawTab of tabs) {
      const tab = obj(rawTab);
      if (tab === null) {
        keptTabs.push(rawTab);
        continue;
      }
      const before = JSON.stringify(tab.root);
      const root = prune(tab.root, drop);
      if (JSON.stringify(root) === before) {
        keptTabs.push(tab);
        continue;
      }
      changed = true;
      if (root === null) continue;
      tab.root = root;
      keptTabs.push(tab);
    }
    if (keptTabs.length === 0 && tabs.length > 0) {
      changed = true;
      continue;
    }
    space.tabs = keptTabs;
    keptSpaces.push(space);
  }
  if (!changed) return null;
  d.spaces = keptSpaces;
  return doc;
}
