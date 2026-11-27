import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// Writing Herdr Desktop's groups file (SPEC § Herdr Desktop groups data). Desktop rewrites the
// whole file (tmp + mv, last write wins, no lock) and drops unknown fields, so herdr:
// - re-reads the file right before every write and edits what it read, never a cached copy;
// - checks the file did not change while it worked (else starts again from the new text);
// - writes atomically the same way, to its own tmp name (Desktop's is `groups.json.tmp`);
// - keeps the exact schema: `{version: 2, groups: [{id, name, parent, parentId, color}], spaces:
//   {"<space id>": {name, group, groupId, color}}}`; `parent` and `group` are names (for agents
//   reading the file), the ids are canonical. New entries carry only these fields.
// The text is formatted as Desktop's mod writes it (`JSON.stringify(body, null, 1)` and a newline,
// dissonantP/herdr-mods mods/spaces-grouped/sidebar.js `groupsBody`).

export interface RawGroup {
  id: string;
  name: string;
  parent: string | null;
  parentId: string | null;
  color: string | null;
}

export interface RawSpaceEntry {
  name: string;
  group: string | null;
  groupId: string | null;
  color: string | null;
}

export interface RawGroupsFile {
  version: number;
  groups: RawGroup[];
  spaces: Record<string, RawSpaceEntry>;
}

/** A group id as Desktop makes them: `g` and base-36 time (plus two random digits, so two made in one ms differ). */
export function newGroupId(now = Date.now()): string {
  return `g${now.toString(36)}${(randomBytes(2).readUInt16BE(0) % 1296).toString(36).padStart(2, "0")}`;
}

/** The file's text as an editable body; `null` when it exists but is not a groups file (never overwrite it). */
export function parseForEdit(text: string | null): RawGroupsFile | null {
  if (text === null || text.trim() === "") return { version: 2, groups: [], spaces: {} };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const body = data as Partial<RawGroupsFile>;
  return {
    ...body,
    version: typeof body.version === "number" ? body.version : 2,
    groups: Array.isArray(body.groups) ? body.groups : [],
    spaces: body.spaces !== null && typeof body.spaces === "object" && !Array.isArray(body.spaces) ? body.spaces : {},
  };
}

export const formatGroups = (body: RawGroupsFile): string => `${JSON.stringify(body, null, 1)}\n`;

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** A hook for tests: runs after the edit, before the file is checked and replaced. */
export interface UpdateHooks {
  beforeReplace?(): Promise<void> | void;
}

const ATTEMPTS = 5;

/**
 * Edit the groups file: `edit` gets the body as it is on disk now and changes it in place, or
 * returns `false` for nothing to do. Throws when the file is not a groups file or kept changing.
 */
export async function updateGroups(path: string, edit: (body: RawGroupsFile) => boolean, hooks: UpdateHooks = {}): Promise<void> {
  for (let i = 0; i < ATTEMPTS; i++) {
    const before = await readText(path);
    const body = parseForEdit(before);
    if (body === null) throw new Error("The groups file is not readable JSON; not touching it.");
    if (!edit(body)) return;
    const tmp = join(dirname(path), `.${basename(path)}.herdr-${randomBytes(4).toString("hex")}.tmp`);
    await writeFile(tmp, formatGroups(body));
    await hooks.beforeReplace?.();
    // Desktop wrote meanwhile: start again from its text, so its edit is kept. (A Desktop write
    // landing between this check and the rename is still lost: without a lock, that tiny window
    // is unavoidable, and Desktop's own writes are last-write-wins the same way.)
    if ((await readText(path)) !== before) {
      await rm(tmp, { force: true });
      continue;
    }
    await rename(tmp, path);
    return;
  }
  throw new Error("The groups file kept changing meanwhile; try again.");
}

// The edits, on a body read from disk.

const nameOf = (body: RawGroupsFile, id: string | null): string | null => (id === null ? null : (body.groups.find((g) => g.id === id)?.name ?? null));

/** The group and every group nested in it, by id. */
export function subtreeIds(groups: readonly { readonly id: string; readonly parentId: string | null }[], id: string): Set<string> {
  const out = new Set<string>([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const g of groups) {
      if (g.parentId !== null && out.has(g.parentId) && !out.has(g.id)) {
        out.add(g.id);
        grew = true;
      }
    }
  }
  return out;
}

export function addGroup(body: RawGroupsFile, group: { id: string; name: string; parentId: string | null }): boolean {
  const parentId = group.parentId !== null && body.groups.some((g) => g.id === group.parentId) ? group.parentId : null;
  body.groups.push({ id: group.id, name: group.name, parent: nameOf(body, parentId), parentId, color: null });
  return true;
}

/** Rename a group, and the name copies other entries keep of it. `false`: no such group. */
export function renameGroup(body: RawGroupsFile, id: string, name: string): boolean {
  const group = body.groups.find((g) => g.id === id);
  if (group === undefined) return false;
  group.name = name;
  for (const g of body.groups) if (g.parentId === id) g.parent = name;
  for (const s of Object.values(body.spaces)) if (s.groupId === id) s.group = name;
  return true;
}

/** Set a group's colour (`null`: none). `false`: no such group, or nothing changes. */
export function setGroupColor(body: RawGroupsFile, id: string, color: string | null): boolean {
  const group = body.groups.find((g) => g.id === id);
  if (group === undefined || group.color === color) return false;
  group.color = color;
  return true;
}

/** Set a space's own colour (`null`: same as its group, `"dim"`: none even in a coloured group), adding its entry when the file has none. */
export function setSpaceColor(body: RawGroupsFile, spaceId: string, spaceName: string, color: string | null): boolean {
  const entry = body.spaces[spaceId];
  if (entry === undefined) {
    if (color === null) return false;
    body.spaces[spaceId] = { name: spaceName, group: null, groupId: null, color };
    return true;
  }
  if (entry.color === color) return false;
  entry.color = color;
  return true;
}

/** Put a space in a group (`null`: in no group). */
export function setSpaceGroup(body: RawGroupsFile, spaceId: string, spaceName: string, groupId: string | null): boolean {
  const known = groupId !== null && body.groups.some((g) => g.id === groupId) ? groupId : null;
  const entry = body.spaces[spaceId];
  if (entry === undefined) {
    body.spaces[spaceId] = { name: spaceName, group: nameOf(body, known), groupId: known, color: null };
    return true;
  }
  entry.groupId = known;
  entry.group = nameOf(body, known);
  return true;
}

/**
 * Apply a terminal's `group=` label as Desktop's spaces-grouped mod does (mods/spaces-grouped
 * commands.js `space-group`): a group id or the first group with that name, made (top level) when
 * none has it; `-` takes the space out of its group. `false`: the space is already there.
 */
export function applyGroupLabel(body: RawGroupsFile, spaceId: string, spaceName: string, want: string, makeId: () => string = newGroupId): boolean {
  if (want === "-") return (body.spaces[spaceId]?.groupId ?? null) !== null && setSpaceGroup(body, spaceId, spaceName, null);
  let group = body.groups.find((g) => g.id === want) ?? body.groups.find((g) => g.name === want);
  if (group === undefined) {
    const id = makeId();
    addGroup(body, { id, name: want, parentId: null });
    group = { id, name: want, parent: null, parentId: null, color: null };
  } else if (body.spaces[spaceId]?.groupId === group.id) return false;
  return setSpaceGroup(body, spaceId, spaceName, group.id);
}

/** Keep the file's copy of a space's name in step; `false` when the file has no entry for it. */
export function renameSpaceEntry(body: RawGroupsFile, spaceId: string, name: string): boolean {
  const entry = body.spaces[spaceId];
  if (entry === undefined || entry.name === name) return false;
  entry.name = name;
  return true;
}

export function removeSpaceEntries(body: RawGroupsFile, spaceIds: readonly string[]): boolean {
  const known = spaceIds.filter((id) => id in body.spaces);
  for (const id of known) delete body.spaces[id];
  return known.length > 0;
}

/**
 * Delete a group. `lift`: what was inside it (spaces and groups) moves up to its parent (or to top
 * level). Otherwise the whole subtree of groups goes; its spaces' entries are the caller's to drop.
 */
export function removeGroup(body: RawGroupsFile, id: string, lift: boolean): boolean {
  const group = body.groups.find((g) => g.id === id);
  if (group === undefined) return false;
  if (lift) {
    const up = group.parentId !== null && body.groups.some((g) => g.id === group.parentId) ? group.parentId : null;
    for (const g of body.groups) {
      if (g.parentId === id) {
        g.parentId = up;
        g.parent = nameOf(body, up);
      }
    }
    for (const s of Object.values(body.spaces)) {
      if (s.groupId === id) {
        s.groupId = up;
        s.group = nameOf(body, up);
      }
    }
    body.groups = body.groups.filter((g) => g.id !== id);
    return true;
  }
  const gone = subtreeIds(body.groups, id);
  body.groups = body.groups.filter((g) => !gone.has(g.id));
  return true;
}
