import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdminError } from "../adapters/backend.ts";
import { HerdrCoreAdmin, slug } from "./admin.ts";
import { HcError, type WireTerminal } from "./client.ts";
import type { JsonValue } from "./json.ts";

// The admin side against a fake core: a versioned herdr-app doc (doc.set lands only on the version
// read, as the real core) and a set of live terminals.

const block = (terminal: string) => ({ type: "block", id: `p${terminal}`, content: { terminal } });
const tab = (id: string, ...terminals: string[]) => ({ id, name: "", root: { type: "row", id, children: terminals.map(block) } });

function world(opts: { race?: () => void; recheckMs?: readonly number[] } = {}) {
  let doc = {
    version: 4,
    value: {
      spaces: [
        { id: "spA", name: "a", folder: "/a", tabs: [tab("tbA1", "t1", "t2"), tab("tbA2", "t3")] },
        { id: "spB", name: "b", folder: "/b", tabs: [tab("tbB1", "t4")] },
      ],
    } as JsonValue,
  };
  const terminals = new Map<string, WireTerminal>();
  const add = (address: string, labels: Record<string, string> = {}, name = "") =>
    terminals.set(address, { address, name, labels, state: "live", cwd: "", cols: 80, rows: 24, title: "", status: null, statusMs: null, pid: null, foreground: null, parent: "" });
  for (const t of ["t1", "t2", "t3", "t4"]) add(t);
  let race = opts.race;
  let next = 10;
  const killed: string[] = [];
  const started: { cwd?: string | undefined; argv?: readonly string[] | undefined; name?: string | undefined }[] = [];
  const failKill = new Set<string>();
  const flags = { finishOnFail: false };
  // herdr's own doc, `herdr-tree`, beside herdr-app's.
  let tree = { version: 0, value: null as JsonValue };
  const rpc = {
    getDoc: (name: string) => Promise.resolve(structuredClone(name === "herdr-tree" ? tree : doc)),
    setDoc: (name: string, value: JsonValue, version: number) => {
      if (name === "herdr-tree") {
        if (version !== tree.version) return Promise.reject(new HcError("conflict", "conflict"));
        tree = { value: structuredClone(value), version: version + 1 };
        return Promise.resolve();
      }
      if (race) {
        race();
        race = undefined;
      }
      if (version !== doc.version) return Promise.reject(new HcError("conflict", "conflict"));
      doc = { value, version: version + 1 };
      return Promise.resolve();
    },
    runShell: (req: { cwd?: string; labels: Readonly<Record<string, string>>; argv?: readonly string[]; name?: string }) => {
      started.push({ cwd: req.cwd, argv: req.argv, name: req.name });
      const address = `t${String(next++)}`;
      add(address, { ...req.labels }, req.name ?? "");
      return Promise.resolve(terminals.get(address) as WireTerminal);
    },
    killTerminal: (address: string) => {
      if (failKill.has(address)) {
        if (flags.finishOnFail) {
          const t = terminals.get(address);
          if (t) terminals.set(address, { ...t, state: "finished" });
        }
        return Promise.reject(new HcError("internal", "kill failed"));
      }
      killed.push(address);
      const t = terminals.get(address);
      if (t) terminals.set(address, { ...t, state: "finished" });
      return Promise.resolve();
    },
    listTerminals: () => Promise.resolve([...terminals.values()].filter((t) => t.state === "live")),
  };
  const dir = mkdtempSync(join(tmpdir(), "herdr-admin-test-"));
  const groupsFile = join(dir, "groups.json");
  writeFileSync(groupsFile, JSON.stringify({ version: 2, groups: [{ id: "gw", name: "work", parent: null, parentId: null, color: null }], spaces: { spB: { name: "b", group: "work", groupId: "gw", color: null } } }));
  const admin = new HerdrCoreAdmin({ rpc, groupsFile, home: "/home/me", recheckMs: opts.recheckMs ?? [] });
  const spaces = () => (doc.value as { spaces: { id: string; name: string; folder: string; tabs: { id: string; name: string }[] }[] }).spaces;
  const groups = () => JSON.parse(readFileSync(groupsFile, "utf8")) as { groups: { id: string; name: string }[]; spaces: Record<string, { groupId: string | null }> };
  return {
    admin,
    rpc,
    groupsFile,
    failKill,
    started,
    set finishOnFail(v: boolean) {
      flags.finishOnFail = v;
    },
    spaces,
    groups,
    killed, terminals, add, docVersion: () => doc.version, setDoc: (v: JsonValue) => (doc = { value: v, version: doc.version + 1 }),
    tree: () => tree.value as { spaces: Record<string, { parent: string | null; quiet: boolean }> } | null,
    setTree: (v: JsonValue) => (tree = { value: v, version: tree.version + 1 }),
  };
}

describe("HerdrCoreAdmin", () => {
  it("creates a space: a labelled shell placed under the same ids, in a group", async () => {
    const w = world();
    const made = await w.admin.createSpace("new", "~/code", "gw");
    const space = w.spaces().at(-1);
    expect(space?.id).toBe(made.spaceId);
    expect(space?.name).toBe("new");
    expect(space?.folder).toBe("/home/me/code");
    expect(space?.tabs[0]?.id).toBe(made.tabId);
    expect(w.terminals.get(made.paneId ?? "")?.labels).toEqual({ "herdr.space": made.spaceId, "herdr.tab": made.tabId });
    expect(w.groups().spaces[made.spaceId ?? ""]).toEqual({ name: "new", group: "work", groupId: "gw", color: null });
  });

  it("puts a new space back in its group when Desktop's own write wiped the entry", async () => {
    const w = world({ recheckMs: [20, 60] });
    const made = await w.admin.createSpace("new", "/tmp", "gw");
    const id = made.spaceId ?? "";
    // Desktop sees the space and writes its stale text: the space, with no group.
    writeFileSync(w.groupsFile, JSON.stringify({ version: 2, groups: [{ id: "gw", name: "work", parent: null, parentId: null, color: null }], spaces: { [id]: { name: "new", group: null, groupId: null, color: null } } }));
    await new Promise((r) => setTimeout(r, 150));
    expect(w.groups().spaces[id]?.groupId).toBe("gw");
  });

  it("does not undo a move made after the space was created", async () => {
    const w = world({ recheckMs: [20] });
    const made = await w.admin.createSpace("new", "/tmp", "gw");
    await w.admin.moveSpace(made.spaceId ?? "", null);
    await new Promise((r) => setTimeout(r, 100));
    // A move cancels the pending rechecks, which couldn't tell it from a wipe.
    expect(w.groups().spaces[made.spaceId ?? ""]?.groupId).toBe(null);
  });

  it("keeps a Desktop write that lands between its read and its write (version conflict, then retry)", async () => {
    const w: ReturnType<typeof world> = world({
      race: () => {
        // Desktop renames space b meanwhile.
        const v = { spaces: w.spaces().map((s) => (s.id === "spB" ? { ...s, name: "desk" } : s)) } as unknown as JsonValue;
        w.setDoc(v);
      },
    });
    await w.admin.renameSpace("spA", "ay");
    expect(w.spaces().map((s) => s.name)).toEqual(["ay", "desk"]);
  });

  it("deletes a space: gone from the doc and the groups file, its programs ended, also labelled strays", async () => {
    const w = world();
    w.add("t20", { "herdr.space": "spB" });
    w.add("t21", { "herdr.space": "spA" });
    await w.admin.deleteSpace("spB", "lift");
    expect(w.spaces().map((s) => s.id)).toEqual(["spA"]);
    expect(w.killed.sort()).toEqual(["t20", "t4"]);
    expect(w.groups().spaces.spB).toBeUndefined();
  });

  it("never ends a terminal another space still shows", async () => {
    const w = world();
    w.add("t30", { "herdr.space": "spB" });
    const v = { spaces: w.spaces().map((s) => (s.id === "spA" ? { ...s, tabs: [...s.tabs, tab("tbA3", "t30")] } : s)) } as unknown as JsonValue;
    w.setDoc(v);
    await w.admin.deleteSpace("spB", "lift");
    expect(w.killed).toEqual(["t4"]);
  });

  it("deletes a tab and ends its programs; refuses the only tab", async () => {
    const w = world();
    await w.admin.deleteTab("tbA1");
    expect(w.killed.sort()).toEqual(["t1", "t2"]);
    await expect(w.admin.deleteTab("tbB1")).rejects.toBeInstanceOf(AdminError);
  });

  it("closes a pane: ends it and takes it out of its tab", async () => {
    const w = world();
    await w.admin.closePane("t2");
    expect(w.killed).toEqual(["t2"]);
    expect(JSON.stringify(w.spaces())).not.toContain('"t2"');
    await expect(w.admin.closePane("t99")).rejects.toBeInstanceOf(AdminError);
    // spB's only pane: refused, nothing ends.
    await expect(w.admin.closePane("t4")).rejects.toThrow(/delete the space/u);
    expect(w.killed).toEqual(["t2"]);
  });

  it("reports a program it could not end, but not one that finished meanwhile", async () => {
    const w = world();
    w.failKill.add("t4");
    await expect(w.admin.deleteSpace("spB", "lift")).rejects.toThrow(/couldn't end t4/u);
    // The groups file was still brought in step before the failed kill.
    expect(w.groups().spaces.spB).toBeUndefined();
    const v = world();
    v.failKill.add("t4");
    v.finishOnFail = true;
    await v.admin.deleteSpace("spB", "lift");
  });

  it("deletes a group lifting its spaces, or with everything in it", async () => {
    const lift = world();
    await lift.admin.deleteGroup("gw", "lift");
    expect(lift.groups().groups).toEqual([]);
    expect(lift.groups().spaces.spB?.groupId).toBeNull();
    expect(lift.killed).toEqual([]);
    const all = world();
    await all.admin.deleteGroup("gw", "delete");
    expect(all.spaces().map((s) => s.id)).toEqual(["spA"]);
    expect(all.killed).toEqual(["t4"]);
    expect(all.groups()).toEqual({ version: 2, groups: [], spaces: {} });
  });

  it("starts a tab's program in the given folder", async () => {
    const w = world();
    await w.admin.createTab("spB", "", { folder: "~/code", argv: () => ["prog", "--x"] });
    await w.admin.createTab("spB", "");
    expect(w.started.map((s) => ({ cwd: s.cwd, argv: s.argv }))).toEqual([{ cwd: "/home/me/code", argv: ["prog", "--x"] }, { cwd: "/b", argv: undefined }]);
    await expect(w.admin.createTab("spB", "", { folder: "rel", argv: () => ["p"] })).rejects.toBeInstanceOf(AdminError);
  });

  it("names a session after its space: the title to the program, its slug as the hc name, a number when taken", async () => {
    const w = world();
    const program = { folder: "/tmp", argv: (title: string) => ["claude", "-n", title] };
    await w.admin.createSpace("My Space!", "/tmp", null, null, program);
    await w.admin.createSpace("My Space!", "/tmp", null, null, program);
    await w.admin.createTab("spB", "", program);
    await w.admin.createSpace("", "/tmp/code/", null, null, program);
    expect(w.started.map((s) => [s.argv, s.name])).toEqual([
      [["claude", "-n", "My Space!"], "my-space"],
      [["claude", "-n", "My Space!"], "my-space-2"],
      [["claude", "-n", "b"], "b"],
      [["claude", "-n", "code"], "code"],
    ]);
  });

  it("slugs a name into hc's form", () => {
    expect(slug("Hello  World_1")).toBe("hello-world-1");
    expect(slug("***")).toBe("claude");
    expect(slug("x".repeat(40)).length).toBe(32);
  });

  it("creates and renames tabs and groups, and moves spaces", async () => {
    const w = world();
    const t = await w.admin.createTab("spB", "logs");
    expect(w.spaces()[1]?.tabs.map((x) => x.name)).toEqual(["", "logs"]);
    expect(w.terminals.get(t.paneId ?? "")?.labels["herdr.tab"]).toBe(t.tabId);
    await w.admin.renameTab(t.tabId ?? "", "log");
    expect(w.spaces()[1]?.tabs[1]?.name).toBe("log");
    const g = await w.admin.createGroup("new", null);
    await w.admin.renameGroup(g.groupId ?? "", "newer");
    await w.admin.moveSpace("spA", g.groupId ?? null);
    expect(w.groups().spaces.spA?.groupId).toBe(g.groupId);
    await w.admin.moveSpace("spB", null);
    expect(w.groups().spaces.spB?.groupId).toBeNull();
    await expect(w.admin.moveSpace("spA", "gnope")).rejects.toBeInstanceOf(AdminError);
    await expect(w.admin.createSpace("", "relative", null)).rejects.toBeInstanceOf(AdminError);
  });

  describe("nesting (F23)", () => {
    // spA holds spB; spC is a new top-level space added to herdr-app here.
    function nested() {
      const w = world();
      w.add("t5");
      w.setDoc({ spaces: [...w.spaces(), { id: "spC", name: "c", folder: "/c", tabs: [tab("tbC1", "t5")] }] } as unknown as JsonValue);
      w.setTree({ spaces: { spA: { parent: null, quiet: false }, spB: { parent: "spA", quiet: true }, spC: { parent: null, quiet: false } } });
      return w;
    }

    it("moves a space to another parent and to the top, keeping its other fields", async () => {
      const w = nested();
      await w.admin.reparentSpace("spA", "spC");
      expect(w.tree()?.spaces.spA).toEqual({ parent: "spC", quiet: false });
      await w.admin.reparentSpace("spB", null);
      expect(w.tree()?.spaces.spB).toEqual({ parent: null, quiet: true });
    });

    it("refuses a move that would make a cycle, changing nothing", async () => {
      const w = nested();
      await expect(w.admin.reparentSpace("spA", "spB")).rejects.toThrow(/inside its own/u);
      await expect(w.admin.reparentSpace("spA", "spA")).rejects.toThrow(/inside itself/u);
      expect(w.tree()?.spaces.spA).toEqual({ parent: null, quiet: false });
      await expect(w.admin.reparentSpace("spA", "spGone")).rejects.toBeInstanceOf(AdminError);
    });

    it("refuses to delete or move when herdr-tree can't be read, instead of guessing", async () => {
      const w = nested();
      const getDoc = w.rpc.getDoc;
      w.rpc.getDoc = (name: string) => (name === "herdr-tree" ? Promise.reject(new HcError("timeout", "timeout")) : getDoc(name));
      await expect(w.admin.deleteSpace("spA", "delete")).rejects.toThrow();
      await expect(w.admin.moveSpace("spA", "gw")).rejects.toThrow();
      expect(w.spaces().map((s) => s.id)).toEqual(["spA", "spB", "spC"]);
      expect(w.killed).toEqual([]);
    });

    it("puts only top-level spaces in groups", async () => {
      const w = nested();
      await expect(w.admin.moveSpace("spB", "gw")).rejects.toThrow(/top-level/u);
    });

    it("deletes a parent and moves its children up a level, into its group at the top", async () => {
      const w = nested();
      w.setTree({ spaces: { spA: { parent: null, quiet: false }, spB: { parent: "spA", quiet: true }, spC: { parent: "spB", quiet: false } } });
      await w.admin.deleteSpace("spB", "lift");
      expect(w.spaces().map((s) => s.id)).toEqual(["spA", "spC"]);
      expect(w.tree()?.spaces).toEqual({ spA: { parent: null, quiet: false }, spC: { parent: "spA", quiet: false } });
      expect(w.killed).toEqual(["t4"]);
      // spB was in group gw; a child lifted to the top joins it.
      const v = nested();
      await v.admin.reparentSpace("spB", null);
      await v.admin.reparentSpace("spC", "spB");
      await v.admin.deleteSpace("spB", "lift");
      expect(v.tree()?.spaces.spC).toEqual({ parent: null, quiet: false });
      expect(v.groups().spaces.spC?.groupId).toBe("gw");
    });

    it("deletes a whole subtree, ending every program in it", async () => {
      const w = nested();
      await w.admin.reparentSpace("spC", "spB");
      await w.admin.deleteSpace("spA", "delete");
      expect(w.spaces()).toEqual([]);
      expect(w.killed.sort()).toEqual(["t1", "t2", "t3", "t4", "t5"]);
      expect(w.tree()?.spaces).toEqual({});
    });

    it("creates a space inside another: its place is written first, and it gets no group", async () => {
      const w = nested();
      const made = await w.admin.createSpace("kid", "/tmp", "gw", "spB");
      expect(w.tree()?.spaces[made.spaceId ?? ""]).toEqual({ parent: "spB", quiet: false });
      expect(w.groups().spaces[made.spaceId ?? ""]).toBeUndefined();
      await expect(w.admin.createSpace("kid", "/tmp", null, "spGone")).rejects.toBeInstanceOf(AdminError);
    });

    it("deletes a group's spaces with everything nested in them", async () => {
      const w = nested();
      // spB, top level in gw, holds spC; spA is in no group and stays.
      await w.admin.reparentSpace("spB", null);
      await w.admin.reparentSpace("spC", "spB");
      await w.admin.deleteGroup("gw", "delete");
      expect(w.spaces().map((s) => s.id)).toEqual(["spA"]);
      expect(w.killed.sort()).toEqual(["t4", "t5"]);
    });
  });
});
