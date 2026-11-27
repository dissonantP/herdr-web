import { AdminError, type BackendAdmin, type Created, type TabProgram } from "../adapters/backend.ts";
import { HcError, type HcRpc } from "./client.ts";
import { readGroups } from "./groups.ts";
import { addGroup, newGroupId, removeGroup, removeSpaceEntries, renameGroup, renameSpaceEntry, setGroupColor, setSpaceColor, setSpaceGroup, subtreeIds, updateGroups } from "./groups-write.ts";
import type { JsonValue } from "./json.ts";
import * as L from "./layout-edit.ts";
import { recordQuiet } from "./quiet.ts";
import { changeTreeDoc, effectiveParents, newEntry, parseTreeDoc, readTreeDoc, subtree, type TreeDoc } from "./tree-doc.ts";

// Changing the hierarchy on herdr-core (BackendAdmin): spaces and tabs in herdr-app's layout doc
// (layout-edit.ts), groups in Desktop's groups file (groups-write.ts), programs in the core.
//
// A new space or tab is a shell carrying herdr-app's `herdr.space` and `herdr.tab` labels (as
// AltanS/collie's herdr-core adapter createSpace/createTab start one, commit 62e638c), placed in the
// layout doc under the same ids. Desktop, if it sees the terminal first, adopts it under those ids
// ("an id Herdr doesn't know becomes a new space or tab"), so either order ends with one space.
//
// Deleting ends what ran there: the terminals its tabs showed, and live terminals still labelled
// with its id (Desktop would otherwise adopt them back into a new space), but never a terminal
// another space still shows.
//
// Nesting (`herdr-tree`, tree-doc.ts): a space is nested in another or top level; only top-level
// spaces go in groups. A move that would put a space inside itself is refused.

const DOC = "herdr-app";
const SPACE_LABEL = "herdr.space";
const TAB_LABEL = "herdr.tab";
const ATTEMPTS = 5;

type Rpc = Pick<HcRpc, "getDoc" | "setDoc" | "runShell" | "killTerminal" | "listTerminals">;

export interface AdminDeps {
  readonly rpc: Rpc;
  readonly groupsFile: string;
  readonly home: string;
  /** When (ms after a new space is made) to check Desktop didn't undo its group; default 1.5 s, 4.5 s, 9 s. */
  readonly recheckMs?: readonly number[];
}

/**
 * Change the layout doc: `edit` gets a copy of the value as it is now and returns the new value,
 * or `null` for nothing to do. The write lands only on the version read; a conflict (Desktop
 * wrote meanwhile) starts again from Desktop's version. Returns the value written, or `null`.
 */
export async function changeLayout(rpc: Pick<Rpc, "getDoc" | "setDoc">, edit: (value: JsonValue) => JsonValue | null): Promise<JsonValue | null> {
  for (let i = 0; i < ATTEMPTS; i++) {
    const doc = await rpc.getDoc(DOC);
    const start: JsonValue = doc.value === null && doc.version === 0 ? { spaces: [] } : structuredClone(doc.value);
    const next = edit(start);
    if (next === null) return null;
    try {
      await rpc.setDoc(DOC, next, doc.version);
      return next;
    } catch (err) {
      if (!(err instanceof HcError && err.kind === "conflict")) throw err;
    }
  }
  throw new AdminError("The spaces kept changing meanwhile; try again.");
}

/** hc names are 1-32 of a-z 0-9 - _: the space name in the hc-sessions skill's slug form. */
export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 32).replace(/-+$/u, "") || "claude";
}

/** What herdr-app calls a space with no name: its folder's last part. */
const folderName = (folder: string): string => {
  const trimmed = folder.replace(/\/+$/u, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "home";
};

const isLocal = (address: string) => address !== "" && !address.includes("/");

export class HerdrCoreAdmin implements BackendAdmin {
  private readonly deps: AdminDeps;
  /** Pending group rechecks per new space; a move or delete of it cancels them. */
  private readonly rechecks = new Map<string, ReturnType<typeof setTimeout>[]>();
  /** Recheck sets cancelled by a move or delete, so one already awaiting a read still stands down. */
  private readonly cancelled = new WeakSet<object>();
  /** Spaces being made here: their `herdr-tree` entry is written before herdr-app shows them. */
  protected readonly pendingSpaces = new Set<string>();

  constructor(deps: AdminDeps) {
    this.deps = deps;
  }

  private async doc(): Promise<JsonValue> {
    return (await this.deps.rpc.getDoc(DOC)).value;
  }

  /** `~` and `~/x` at home; anything else must be absolute. */
  private folder(folder: string): string {
    const f = folder.trim() === "" ? "~" : folder.trim();
    if (f === "~") return this.deps.home;
    if (f.startsWith("~/")) return `${this.deps.home}/${f.slice(2)}`;
    if (!f.startsWith("/")) throw new AdminError("The folder must start with / or ~.");
    return f;
  }

  /**
   * What to end: the terminals in `shown` that no space shows any more, and live ones labelled
   * `label=id` that no space shows. Callers finish their writes first, then {@link kill} these, so a
   * failed kill never leaves the groups file half done.
   */
  private async toEnd(shown: readonly string[], label: string | null, ids: ReadonlySet<string>, docAfter: JsonValue | null): Promise<string[]> {
    const kept = new Set(docAfter === null ? [] : L.allTerminals(docAfter));
    const live = await this.deps.rpc.listTerminals();
    const end = new Set(shown.filter((t) => !kept.has(t)));
    if (label !== null) {
      for (const t of live) {
        const value = t.labels[label];
        if (isLocal(t.address) && t.state === "live" && value !== undefined && ids.has(value) && !kept.has(t.address)) end.add(t.address);
      }
    }
    const liveSet = new Set(live.filter((t) => t.state === "live").map((t) => t.address));
    return [...end].filter((t) => isLocal(t) && liveSet.has(t));
  }

  /** End these terminals. One that is gone or finished meanwhile is fine; any other failure is reported. */
  private async kill(addresses: readonly string[]): Promise<void> {
    const failed = (await Promise.allSettled(addresses.map((t) => this.deps.rpc.killTerminal(t)))).some((r) => r.status === "rejected");
    if (!failed) return;
    const still = new Set((await this.deps.rpc.listTerminals()).filter((t) => t.state === "live").map((t) => t.address));
    const left = addresses.filter((t) => still.has(t));
    if (left.length > 0) throw new AdminError(`Removed, but couldn't end ${left.join(", ")}: ${left.length === 1 ? "it is" : "they are"} still running in herdr-core.`);
  }

  private async groupExists(id: string): Promise<boolean> {
    return (await readGroups(this.deps.groupsFile)).groups.some((g) => g.id === id);
  }

  /** herdr-app's spaces, `herdr-tree`, and each space's parent as the tree draws it. */
  protected async nest(): Promise<{ layout: JsonValue; doc: TreeDoc; parents: Map<string, string | null> }> {
    const [layout, doc] = await Promise.all([this.doc(), readTreeDoc(this.deps.rpc)]);
    return { layout, doc, parents: effectiveParents(doc, new Set(L.spaceIds(layout))) };
  }

  async createGroup(name: string, parentId: string | null): Promise<Created> {
    if (parentId !== null && !(await this.groupExists(parentId))) throw new AdminError("That group is gone.");
    const id = newGroupId();
    await updateGroups(this.deps.groupsFile, (body) => addGroup(body, { id, name, parentId }));
    return { groupId: id };
  }

  async renameGroup(id: string, name: string): Promise<void> {
    let found = false;
    await updateGroups(this.deps.groupsFile, (body) => (found = renameGroup(body, id, name)));
    if (!found) throw new AdminError("That group is gone.");
  }

  async setGroupColor(id: string, color: string | null): Promise<void> {
    if (!(await this.groupExists(id))) throw new AdminError("That group is gone.");
    await updateGroups(this.deps.groupsFile, (body) => setGroupColor(body, id, color));
  }

  async setSpaceColor(id: string, color: string | null): Promise<void> {
    const doc = await this.doc();
    if (L.spaceFolder(doc, id) === null) throw new AdminError("That space is gone.");
    const name = L.spaceName(doc, id);
    await updateGroups(this.deps.groupsFile, (body) => setSpaceColor(body, id, name, color));
  }

  async deleteGroup(id: string, children: "lift" | "delete"): Promise<void> {
    const groups = await readGroups(this.deps.groupsFile);
    if (!groups.groups.some((g) => g.id === id)) throw new AdminError("That group is gone.");
    if (children === "lift") {
      await updateGroups(this.deps.groupsFile, (body) => removeGroup(body, id, true));
      return;
    }
    // The groups beneath it as herdr reads them (name fallbacks resolved), and their spaces.
    const inside = subtreeIds(groups.groups, id);
    // Its top-level spaces and every space nested in them.
    const { parents } = await this.nest();
    const spaces = [...groups.groupOf].filter(([space, group]) => inside.has(group) && parents.get(space) === null).flatMap(([space]) => subtree(parents, space));
    const end = await this.deleteSpaces(spaces);
    await updateGroups(this.deps.groupsFile, (body) => {
      // From the file as it is now: a space Desktop put in the subtree meanwhile loses its entry too.
      const gone = new Set([...inside, ...subtreeIds(body.groups, id)]);
      const now = Object.entries(body.spaces).filter(([, s]) => s.groupId !== null && gone.has(s.groupId)).map(([space]) => space);
      const before = body.groups.length;
      body.groups = body.groups.filter((g) => !gone.has(g.id));
      return removeSpaceEntries(body, [...spaces, ...now]) || body.groups.length !== before;
    });
    await this.kill(end);
  }

  async createSpace(name: string, folder: string, groupId: string | null, parentId: string | null = null, program?: TabProgram): Promise<Created> {
    const cwd = this.folder(folder);
    if (parentId !== null && L.spaceFolder(await this.doc(), parentId) === null) throw new AdminError("That parent space is gone.");
    const group = parentId === null ? groupId : null; // a nested space follows its parent
    if (group !== null && !(await this.groupExists(group))) throw new AdminError("That group is gone.");
    const spaceId = L.newId("sp");
    const tabId = L.newId("tb");
    const paneId = L.newId("p");
    // Its place first, so the tree never sees it unplaced (and nests it by its terminal).
    this.pendingSpaces.add(spaceId);
    try {
      await changeTreeDoc(this.deps.rpc, (doc) => {
        doc.spaces[spaceId] = { ...newEntry(parentId), ...doc.spaces[spaceId], parent: parentId };
        return true;
      });
      const terminal = await this.start(cwd, spaceId, tabId, program, name === "" ? folderName(cwd) : name);
      try {
        await changeLayout(this.deps.rpc, (doc) => L.addSpace(doc, { id: spaceId, name, folder: cwd }, { tabId, paneId, terminal, name: "" }));
      } catch (err) {
        await this.deps.rpc.killTerminal(terminal).catch(() => undefined);
        throw err;
      }
      if (group !== null) {
        try {
          await updateGroups(this.deps.groupsFile, (body) => setSpaceGroup(body, spaceId, name, group));
        } catch (err) {
          throw new AdminError(`The space was made, but not put in the group (${err instanceof Error ? err.message : String(err)}); move it from its menu.`);
        }
        this.keepInGroup(spaceId, name, group);
      }
      return { spaceId, tabId, paneId: terminal };
    } finally {
      this.pendingSpaces.delete(spaceId);
    }
  }

  /**
   * Desktop writes its whole in-memory groups text as soon as it sees a new space (before its next
   * 3 s read of the file), which can wipe the group just written for it. So look again a few times
   * over Desktop's read period, and put the space back only if its entry shows no group (the wipe's
   * signature, so a move made here meanwhile is never undone; a deliberate ungroup made in Desktop
   * inside this ~9 s window would be, an accepted trade).
   */
  private keepInGroup(spaceId: string, name: string, groupId: string): void {
    const timers: ReturnType<typeof setTimeout>[] = [];
    this.rechecks.set(spaceId, timers);
    const times = this.deps.recheckMs ?? [1500, 4500, 9000];
    times.forEach((ms, i) => {
      const timer = setTimeout(() => {
        if (i === times.length - 1 && this.rechecks.get(spaceId) === timers) this.rechecks.delete(spaceId);
        void (async () => {
          if (!(await this.groupExists(groupId)) || L.spaceFolder(await this.doc(), spaceId) === null) return;
          // A move or delete meanwhile, even while this was awaiting a read: stand down.
          if (this.cancelled.has(timers)) return;
          await updateGroups(this.deps.groupsFile, (body) => (body.spaces[spaceId]?.groupId ?? null) === null && setSpaceGroup(body, spaceId, body.spaces[spaceId]?.name ?? name, groupId));
        })().catch(() => undefined);
      }, ms);
      timer.unref();
      timers.push(timer);
    });
  }

  private stopRechecks(spaceId: string): void {
    const timers = this.rechecks.get(spaceId);
    if (timers === undefined) return;
    this.cancelled.add(timers);
    for (const t of timers) clearTimeout(t);
    this.rechecks.delete(spaceId);
  }

  /** Start the tab's terminal: the shell, or `program` named after the space (`title`) as the hc session convention has it. */
  private async start(cwd: string, spaceId: string, tabId: string, program: TabProgram | undefined, title: string): Promise<string> {
    try {
      const extra = program === undefined ? {} : { argv: program.argv(title), name: await this.freeName(title) };
      const created = await this.deps.rpc.runShell({ cwd, labels: { [SPACE_LABEL]: spaceId, [TAB_LABEL]: tabId }, ...extra });
      return created.address;
    } catch (err) {
      if (err instanceof HcError) throw new AdminError(`Couldn't start a shell in ${cwd}: ${err.message}`);
      throw err;
    }
  }

  /** The hc name for a session in a space called `title`: its slug, or slug-2, slug-3 ... when a live terminal has it. */
  private async freeName(title: string): Promise<string> {
    const taken = new Set((await this.deps.rpc.listTerminals()).filter((t) => t.state === "live").map((t) => t.name));
    const base = slug(title);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 32 - String(n).length - 1)}-${String(n)}`;
    return name;
  }

  async renameSpace(id: string, name: string): Promise<void> {
    await changeLayout(this.deps.rpc, (doc) => {
      if (L.spaceFolder(doc, id) === null) throw new AdminError("That space is gone.");
      return L.rename(doc, id, name);
    });
    await updateGroups(this.deps.groupsFile, (body) => renameSpaceEntry(body, id, name));
  }

  /**
   * Delete a space and end its programs. Its nested spaces move up to its own parent (`lift`; at the
   * top they join its group) or are deleted with it (`delete`).
   */
  async deleteSpace(id: string, children: "lift" | "delete"): Promise<void> {
    this.stopRechecks(id);
    const { layout, parents } = await this.nest();
    if (L.spaceFolder(layout, id) === null) throw new AdminError("That space is gone.");
    const gone = children === "delete" ? subtree(parents, id) : [id];
    if (children === "lift") {
      const up = parents.get(id) ?? null;
      const kids = [...parents].filter(([, p]) => p === id).map(([kid]) => kid);
      if (kids.length > 0) {
        await changeTreeDoc(this.deps.rpc, (d) => {
          // From the doc as it is now too, so a child moved here meanwhile is lifted as well.
          for (const e of Object.values(d.spaces)) if (e.parent === id) e.parent = up;
          for (const kid of kids) if (d.spaces[kid]?.parent !== up) d.spaces[kid] = { ...newEntry(up), ...d.spaces[kid], parent: up };
          return true;
        });
        const group = up === null ? ((await readGroups(this.deps.groupsFile)).groupOf.get(id) ?? null) : null;
        if (group !== null) await updateGroups(this.deps.groupsFile, (body) => kids.map((kid) => setSpaceGroup(body, kid, L.spaceName(layout, kid), group)).some(Boolean));
      }
    }
    for (const g of gone) this.stopRechecks(g);
    const end = await this.deleteSpaces(gone);
    await updateGroups(this.deps.groupsFile, (body) => removeSpaceEntries(body, gone));
    await changeTreeDoc(this.deps.rpc, (d) => {
      const had = gone.filter((g) => d.spaces[g] !== undefined);
      for (const g of had) delete d.spaces[g];
      return had.length > 0;
    });
    await this.kill(end);
  }

  /** Nest a space in another (`null`: top level). Refuses a move into itself or its own subtree. */
  async reparentSpace(id: string, parentId: string | null): Promise<void> {
    const { layout } = await this.nest();
    if (L.spaceFolder(layout, id) === null) throw new AdminError("That space is gone.");
    if (parentId !== null && L.spaceFolder(layout, parentId) === null) throw new AdminError("That parent space is gone.");
    this.stopRechecks(id);
    const ids = new Set(L.spaceIds(layout));
    await changeTreeDoc(this.deps.rpc, (d) => {
      // Checked on the doc as it is now, so a concurrent move can't sneak a cycle in.
      const now = effectiveParents(parseTreeDoc(d), ids);
      if (parentId !== null && subtree(now, id).includes(parentId)) throw new AdminError(parentId === id ? "A space can't go inside itself." : "That would put the space inside its own subspace.");
      if (now.get(id) === parentId && d.spaces[id] !== undefined && "parent" in d.spaces[id]) return false;
      d.spaces[id] = { ...newEntry(parentId), ...d.spaces[id], parent: parentId };
      return true;
    });
  }

  /** Take the spaces out of the layout; returns what ran in them, for the caller to end last. */
  private async deleteSpaces(ids: readonly string[]): Promise<string[]> {
    let shown: string[] = [];
    const after = await changeLayout(this.deps.rpc, (doc) => {
      shown = ids.flatMap((id) => L.spaceTerminals(doc, id));
      let changed = false;
      for (const id of ids) changed = L.removeSpace(doc, id) !== null || changed;
      return changed ? doc : null;
    });
    return this.toEnd(shown, SPACE_LABEL, new Set(ids), after ?? (await this.doc()));
  }

  async setQuiet(id: string, quiet: boolean): Promise<void> {
    if (L.spaceFolder(await this.doc(), id) === null) throw new AdminError("That space is gone.");
    await recordQuiet(this.deps.rpc, id, quiet);
  }

  async moveSpace(id: string, groupId: string | null): Promise<void> {
    this.stopRechecks(id);
    const { layout: doc, parents } = await this.nest();
    if (L.spaceFolder(doc, id) === null) throw new AdminError("That space is gone.");
    if (parents.get(id) !== null) throw new AdminError("Only a top-level space goes in a group; a nested space follows its parent.");
    if (groupId !== null && !(await this.groupExists(groupId))) throw new AdminError("That group is gone.");
    const name = L.spaceName(doc, id);
    await updateGroups(this.deps.groupsFile, (body) => setSpaceGroup(body, id, name, groupId));
  }

  async createTab(spaceId: string, name: string, program?: TabProgram): Promise<Created> {
    const layout = await this.doc();
    const folder = L.spaceFolder(layout, spaceId);
    if (folder === null) throw new AdminError("That space is gone.");
    const tabId = L.newId("tb");
    const paneId = L.newId("p");
    const cwd = program === undefined ? (folder === "" ? this.deps.home : folder) : this.folder(program.folder);
    const spaceName = L.spaceName(layout, spaceId);
    const terminal = await this.start(cwd, spaceId, tabId, program, spaceName === "" ? folderName(folder === "" ? cwd : folder) : spaceName);
    try {
      await changeLayout(this.deps.rpc, (doc) => {
        if (L.spaceFolder(doc, spaceId) === null) throw new AdminError("That space is gone.");
        return L.addTab(doc, spaceId, { tabId, paneId, terminal, name });
      });
    } catch (err) {
      await this.deps.rpc.killTerminal(terminal).catch(() => undefined);
      throw err;
    }
    return { spaceId, tabId, paneId: terminal };
  }

  async renameTab(id: string, name: string): Promise<void> {
    await changeLayout(this.deps.rpc, (doc) => {
      if (L.spaceOfTab(doc, id) === null) throw new AdminError("That tab is gone.");
      return L.rename(doc, id, name);
    });
  }

  async deleteTab(id: string): Promise<void> {
    let shown: string[] = [];
    const after = await changeLayout(this.deps.rpc, (doc) => {
      const space = L.spaceOfTab(doc, id);
      if (space === null) throw new AdminError("That tab is gone.");
      if (L.tabCount(doc, space) <= 1) throw new AdminError("That's the space's only tab: delete the space instead.");
      shown = L.tabTerminals(doc, id);
      return L.removeTab(doc, id);
    });
    await this.kill(await this.toEnd(shown, TAB_LABEL, new Set([id]), after ?? (await this.doc())));
  }

  async closePane(id: string): Promise<void> {
    const live = (await this.deps.rpc.listTerminals()).some((t) => t.address === id && t.state === "live");
    const after = await changeLayout(this.deps.rpc, (doc) => {
      if (L.isLastPaneOfSpace(doc, id)) throw new AdminError("That's the space's last pane: delete the space instead.");
      return L.removePane(doc, id);
    });
    if (!live && after === null) throw new AdminError("That pane is gone.");
    if (live && isLocal(id)) await this.kill([id]);
  }
}
