import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Herdr Desktop's groups file (SPEC § Herdr Desktop groups data), READ ONLY here. Writing it comes
// with admin (M2), and must re-read right before writing, write tmp + mv, and keep this exact schema.
//
// Reading follows Desktop's spaces-grouped mod (github.com/dissonantP/herdr-mods,
// mods/spaces-grouped/sidebar.js `applyGroups` and
// `treeOrder`): canonical ids first, names as fallbacks.

export interface GroupEntry {
  readonly id: string;
  readonly name: string;
  /** The parent group's id, or `null` at top level (also for a parent that no longer exists). */
  readonly parentId: string | null;
  readonly color: string | null;
}

export interface GroupsFile {
  /** In the file's (sidebar) order. */
  readonly groups: readonly GroupEntry[];
  /** Space id to group id, for spaces the file puts in a group that exists. */
  readonly groupOf: ReadonlyMap<string, string>;
  /** Space id to its own colour token, for spaces that have one. */
  readonly spaceColor: ReadonlyMap<string, string>;
}

export const EMPTY_GROUPS: GroupsFile = { groups: [], groupOf: new Map(), spaceColor: new Map() };

/** The groups file path: `HERDR_GROUPS_FILE`, else Desktop's default on this machine. */
export function groupsFilePath(env: Readonly<Record<string, string | undefined>>, home: string = homedir()): string {
  const named = (env.HERDR_GROUPS_FILE ?? "").trim();
  return named !== "" ? named : join(home, ".local/state/herdr-groups/groups.json");
}

type Json = unknown;

function record(value: Json): Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>) : {};
}

function text(value: Json): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The file's text, parsed. Anything unreadable is "no groups", never an error. */
export function parseGroups(raw: string): GroupsFile {
  let data: Record<string, Json>;
  try {
    data = record(JSON.parse(raw));
  } catch {
    return EMPTY_GROUPS;
  }
  const list = Array.isArray(data.groups) ? data.groups.map(record) : [];
  const idOfName = (name: string | null) => (name === null ? null : (text(list.find((g) => g.name === name)?.id) ?? null));
  const draft = list
    .map((g) => ({
      id: text(g.id) ?? "",
      name: text(g.name) ?? "",
      parentId: text(g.parentId) ?? idOfName(text(g.parent)),
      color: text(g.color),
    }))
    .filter((g) => g.id !== "");
  const ids = new Set(draft.map((g) => g.id));
  const groups = draft.map((g) => ({ ...g, parentId: g.parentId !== null && ids.has(g.parentId) && g.parentId !== g.id ? g.parentId : null }));
  const groupOf = new Map<string, string>();
  const spaceColor = new Map<string, string>();
  for (const [space, value] of Object.entries(record(data.spaces))) {
    const entry = record(value);
    const group = text(entry.groupId) ?? idOfName(text(entry.group));
    if (group !== null && ids.has(group)) groupOf.set(space, group);
    const color = text(entry.color);
    if (color !== null) spaceColor.set(space, color);
  }
  return { groups, groupOf, spaceColor };
}

/** The file at `path`, parsed; a missing or unreadable file is "no groups". */
export async function readGroups(path: string): Promise<GroupsFile> {
  try {
    return parseGroups(await readFile(path, "utf8"));
  } catch {
    return EMPTY_GROUPS;
  }
}

export interface GroupTreeNode {
  readonly group: GroupEntry;
  readonly children: readonly GroupTreeNode[];
}

/**
 * The groups as Desktop nests them: top-level groups in file order, each with the groups inside it
 * in file order. A parent loop written by hand puts the loop's groups at top level, as Desktop does.
 */
export function groupForest(groups: readonly GroupEntry[]): GroupTreeNode[] {
  const seen = new Set<string>();
  const build = (g: GroupEntry): GroupTreeNode => {
    seen.add(g.id);
    const children = groups.filter((c) => c.parentId === g.id && !seen.has(c.id)).map(build);
    return { group: g, children };
  };
  const out: GroupTreeNode[] = [];
  for (const g of groups) if (g.parentId === null && !seen.has(g.id)) out.push(build(g));
  for (const g of groups) if (!seen.has(g.id)) out.push(build(g));
  return out;
}
