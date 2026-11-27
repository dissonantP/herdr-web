import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HerdrCoreBackend } from "./adapter.ts";
import { HcError, parseLayout, type WireTerminal } from "./client.ts";
import type { JsonValue } from "./json.ts";

// A tree read racing a create (F23): the read sees herdr-app from before the new space, and its
// reconcile runs after the create is done. The new space's entry must survive.

describe("HerdrCoreBackend nesting", () => {
  it("keeps a space created while a tree read was holding an older herdr-app", async () => {
    const docs = new Map<string, { value: JsonValue; version: number }>([
      ["herdr-app", { value: { spaces: [{ id: "spA", name: "a", folder: "/", tabs: [{ id: "tbA", name: "", root: { type: "block", id: "pA", content: { terminal: "t1" } } }] }] }, version: 1 }],
      ["herdr-tree", { value: { spaces: { spA: { parent: null, quiet: false } } }, version: 1 }],
    ]);
    const terminals: WireTerminal[] = [{ address: "t1", name: "", labels: {}, state: "live", cwd: "/", cols: 80, rows: 24, title: "", status: null, statusMs: null, pid: null, foreground: null, parent: "" }];
    let hold: ((v: unknown) => void) | null = null;
    let stale: JsonValue = null;
    const rpc = {
      getDoc: (name: string) => Promise.resolve(structuredClone(docs.get(name) ?? { value: null, version: 0 })),
      setDoc: (name: string, value: JsonValue, version: number) => {
        if ((docs.get(name)?.version ?? 0) !== version) return Promise.reject(new HcError("conflict", "conflict"));
        docs.set(name, { value: structuredClone(value), version: version + 1 });
        return Promise.resolve();
      },
      readLayout: async () => {
        if (hold === null && stale === null) {
          // The first read answers with herdr-app as it is now, then waits.
          stale = structuredClone(docs.get("herdr-app")?.value ?? null);
          await new Promise((r) => (hold = r));
          return parseLayout(stale);
        }
        return parseLayout(docs.get("herdr-app")?.value);
      },
      listTerminals: () => Promise.resolve(terminals),
      runShell: (req: { labels: Readonly<Record<string, string>> }) => {
        const t: WireTerminal = { ...terminals[0]!, address: "t2", labels: { ...req.labels } };
        terminals.push(t);
        return Promise.resolve(t);
      },
      killTerminal: () => Promise.resolve(),
    };
    const dir = mkdtempSync(join(tmpdir(), "herdr-adapter-test-"));
    const groupsFile = join(dir, "groups.json");
    writeFileSync(groupsFile, JSON.stringify({ version: 2, groups: [], spaces: {} }));
    const backend = new HerdrCoreBackend({ rpc: rpc as never, groupsFile, home: "/home/me" });

    const reading = backend.readTree();
    await new Promise((r) => setTimeout(r, 10));
    const made = await backend.createSpace("kid", "/tmp", null, "spA");
    (hold as unknown as (v: unknown) => void)(undefined);
    const tree = await reading;
    const spaces = (docs.get("herdr-tree")?.value as { spaces: Record<string, { parent: string | null }> }).spaces;
    expect(spaces[made.spaceId ?? ""]?.parent).toBe("spA");
    expect(tree.spaces.map((s) => s.id)).toEqual(["spA"]);
    expect((await backend.readTree()).spaces[0]?.children.map((s) => s.id)).toEqual([made.spaceId]);
  });
});

// F49: an agent moves its own space with the herdr.parent label.
describe("HerdrCoreBackend applyParentLabels", () => {
  function setup(labels: Record<string, string>) {
    const mk = (id: string, name: string, term: string) => ({ id, name, folder: "/", tabs: [{ id: `tb${id}`, name: "", root: { type: "block", id: `p${id}`, content: { terminal: term } } }] });
    const docs = new Map<string, { value: JsonValue; version: number }>([
      ["herdr-app", { value: { spaces: [mk("spA", "alpha", "t1"), mk("spB", "beta", "t2"), mk("spC", "gamma", "t3")] } as JsonValue, version: 1 }],
      ["herdr-tree", { value: { spaces: { spA: { parent: null, quiet: false }, spB: { parent: "spA", quiet: false }, spC: { parent: null, quiet: false } } }, version: 1 }],
    ]);
    const base = { name: "", state: "live", cwd: "/", cols: 80, rows: 24, title: "", status: null, statusMs: null, pid: null, foreground: null, parent: "" } as const;
    const terminals: WireTerminal[] = [
      { ...base, address: "t1", labels: {} },
      { ...base, address: "t2", labels },
      { ...base, address: "t3", labels: {} },
    ];
    const rpc = {
      getDoc: (name: string) => Promise.resolve(structuredClone(docs.get(name) ?? { value: null, version: 0 })),
      setDoc: (name: string, value: JsonValue, version: number) => {
        if ((docs.get(name)?.version ?? 0) !== version) return Promise.reject(new HcError("conflict", "conflict"));
        docs.set(name, { value: structuredClone(value), version: version + 1 });
        return Promise.resolve();
      },
      readLayout: () => Promise.resolve(parseLayout(docs.get("herdr-app")?.value)),
      listTerminals: () => Promise.resolve(terminals),
      labelTerminal: (address: string, set: Record<string, string>) => {
        const i = terminals.findIndex((t) => t.address === address);
        terminals[i] = { ...terminals[i]!, labels: { ...terminals[i]!.labels, ...set } };
        return Promise.resolve();
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "herdr-adapter-test-"));
    const groupsFile = join(dir, "groups.json");
    writeFileSync(groupsFile, JSON.stringify({ version: 2, groups: [], spaces: {} }));
    const backend = new HerdrCoreBackend({ rpc: rpc as never, groupsFile, home: "/home/me" });
    const parents = () => Object.fromEntries(Object.entries((docs.get("herdr-tree")?.value as { spaces: Record<string, { parent: string | null }> }).spaces).map(([k, v]) => [k, v.parent]));
    return { backend, terminals, parents };
  }

  it("moves the labelled terminal's space under a space named by name, and clears the label", async () => {
    const s = setup({ "herdr.parent": "Gamma" });
    await s.backend.applyParentLabels();
    expect(s.parents().spB).toBe("spC");
    expect(s.terminals[1]?.labels["herdr.parent"]).toBe("");
  });

  it("accepts a space id, and - for the top level", async () => {
    const s = setup({ "herdr.parent": "-" });
    await s.backend.applyParentLabels();
    expect(s.parents().spB).toBeNull();
    const t = setup({ "herdr.parent": "spC" });
    await t.backend.applyParentLabels();
    expect(t.parents().spB).toBe("spC");
  });

  it("refuses a cycle but still clears the label", async () => {
    const s = setup({ "herdr.parent": "beta" }); // spB under spB
    await s.backend.applyParentLabels();
    expect(s.parents().spB).toBe("spA");
    expect(s.terminals[1]?.labels["herdr.parent"]).toBe("");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const u = setup({ "herdr.parent": "nowhere" });
    await u.backend.applyParentLabels();
    expect(u.parents().spB).toBe("spA");
    expect(u.terminals[1]?.labels["herdr.parent"]).toBe("");
    err.mockRestore();
  });
});

describe("HerdrCoreBackend markSeen", () => {
  const base = { name: "", state: "live", cwd: "/", cols: 80, rows: 24, title: "", statusMs: null, pid: null, foreground: null, parent: "", address: "t1" } as const;
  function run(over: Partial<WireTerminal>, id = "t1") {
    const labelTerminal = vi.fn(() => Promise.resolve());
    const term: WireTerminal = { ...base, labels: {}, status: { app: "claude-code", state: "done", kind: "" }, turn: 5, ...over };
    const rpc = { getTerminal: () => Promise.resolve(term), labelTerminal };
    const backend = new HerdrCoreBackend({ rpc: rpc as never, groupsFile: "/nonexistent", home: "/home/me" });
    return { labelTerminal, done: backend.markSeen(id) };
  }

  it("records the finished turn as seen", async () => {
    const r = run({ labels: { "herdr.seen": "3" } });
    await r.done;
    expect(r.labelTerminal).toHaveBeenCalledWith("t1", { "herdr.seen": "5" });
    const none = run({});
    await none.done;
    expect(none.labelTerminal).toHaveBeenCalledWith("t1", { "herdr.seen": "5" });
  });

  it("leaves a seen turn, a running turn and a gone pane alone", async () => {
    for (const over of [{ labels: { "herdr.seen": "5" } }, { status: { app: "claude-code", state: "working", kind: "" } }, { state: "finished" }]) {
      const r = run(over);
      await r.done;
      expect(r.labelTerminal).not.toHaveBeenCalled();
    }
  });

  it("refuses an id that is not a local terminal", async () => {
    await expect(run({}, "m/t1").done).rejects.toThrow();
  });
});

describe("HerdrCoreBackend dismissPane", () => {
  const base = { name: "", state: "live", cwd: "/", cols: 80, rows: 24, title: "", statusMs: null, pid: null, foreground: null, parent: "", address: "t1" } as const;
  function run(over: Partial<WireTerminal>) {
    const labelTerminal = vi.fn(() => Promise.resolve());
    const term: WireTerminal = { ...base, labels: {}, status: { app: "claude-code", state: "done", kind: "" }, turn: 5, ...over };
    const backend = new HerdrCoreBackend({ rpc: { getTerminal: () => Promise.resolve(term), labelTerminal } as never, groupsFile: "/nonexistent", home: "/home/me" });
    return { labelTerminal, done: backend.dismissPane("t1") };
  }

  it("records the turn and state, and marks a finished turn seen", async () => {
    const r = run({});
    await r.done;
    expect(r.labelTerminal).toHaveBeenCalledWith("t1", { "herdr.seen": "5", "herdr.dismissed": "5:done" });
  });

  it("only records the dismissal while working or waiting", async () => {
    const r = run({ status: { app: "claude-code", state: "blocked", kind: "permission" } });
    await r.done;
    expect(r.labelTerminal).toHaveBeenCalledWith("t1", { "herdr.dismissed": "5:blocked" });
  });

  it("refuses an id that is not a local terminal", async () => {
    await expect(new HerdrCoreBackend({ rpc: {} as never, groupsFile: "/nonexistent", home: "/home/me" }).dismissPane("m/t1")).rejects.toThrow();
  });
});

// Task 083: a terminal's group= label files its space in a group, with Desktop closed.
describe("HerdrCoreBackend applyGroupLabels", () => {
  function setup(labels: Record<string, string>, groups: unknown[] = []) {
    const mk = (id: string, name: string, term: string) => ({ id, name, folder: "/", tabs: [{ id: `tb${id}`, name: "", root: { type: "block", id: `p${id}`, content: { terminal: term } } }] });
    const layout = parseLayout({ spaces: [mk("spA", "alpha", "t1"), mk("spB", "beta", "t2")] } as JsonValue);
    const base = { name: "", state: "live", cwd: "/", cols: 80, rows: 24, title: "", status: null, statusMs: null, pid: null, foreground: null, parent: "" } as const;
    const terminals: WireTerminal[] = [
      { ...base, address: "t1", labels: {} },
      { ...base, address: "t2", labels },
    ];
    const rpc = {
      readLayout: () => Promise.resolve(layout),
      listTerminals: () => Promise.resolve(terminals),
      labelTerminal: (address: string, set: Record<string, string>) => {
        const i = terminals.findIndex((t) => t.address === address);
        terminals[i] = { ...terminals[i]!, labels: { ...terminals[i]!.labels, ...set } };
        return Promise.resolve();
      },
    };
    const groupsFile = join(mkdtempSync(join(tmpdir(), "herdr-adapter-test-")), "groups.json");
    writeFileSync(groupsFile, JSON.stringify({ version: 2, groups, spaces: {} }));
    const backend = new HerdrCoreBackend({ rpc: rpc as never, groupsFile, home: "/home/me" });
    const file = () => JSON.parse(readFileSync(groupsFile, "utf8")) as { groups: { id: string; name: string; parentId: string | null }[]; spaces: Record<string, { groupId: string | null; group: string | null }> };
    return { backend, terminals, file, path: groupsFile };
  }

  it("files the space in an existing group by name, clears the label, and a second pass changes nothing", async () => {
    const s = setup({ group: "bugs" }, [{ id: "g1", name: "bugs", parent: null, parentId: null, color: null }]);
    await s.backend.applyGroupLabels();
    expect(s.file().spaces.spB).toMatchObject({ groupId: "g1", group: "bugs" });
    expect(s.terminals[1]?.labels.group).toBe("");
    const before = JSON.stringify(s.file());
    s.terminals[1] = { ...s.terminals[1]!, labels: { group: "bugs" } };
    await s.backend.applyGroupLabels();
    expect(JSON.stringify(s.file())).toBe(before);
  });

  it("makes a missing group at top level", async () => {
    const s = setup({ group: "meta tasks" });
    await s.backend.applyGroupLabels();
    const f = s.file();
    expect(f.groups).toHaveLength(1);
    expect(f.groups[0]).toMatchObject({ name: "meta tasks", parentId: null });
    expect(f.spaces.spB?.groupId).toBe(f.groups[0]?.id);
  });

  it("takes the space out of its group with -", async () => {
    const s = setup({ group: "-" }, [{ id: "g1", name: "bugs", parent: null, parentId: null, color: null }]);
    writeFileSync(s.path, JSON.stringify({ version: 2, groups: [{ id: "g1", name: "bugs", parent: null, parentId: null, color: null }], spaces: { spB: { name: "beta", group: "bugs", groupId: "g1", color: null } } }));
    await s.backend.applyGroupLabels();
    expect(s.file().spaces.spB).toMatchObject({ groupId: null, group: null });
    expect(s.terminals[1]?.labels.group).toBe("");
  });

  it("accepts a group id", async () => {
    const s = setup({ group: "g1" }, [{ id: "g1", name: "bugs", parent: null, parentId: null, color: null }]);
    await s.backend.applyGroupLabels();
    expect(s.file().spaces.spB?.groupId).toBe("g1");
  });

  it("leaves the label on a space not in the layout yet", async () => {
    const t = setup({ group: "x" });
    t.terminals.push({ ...t.terminals[0]!, address: "t9", labels: { group: "x" } });
    await t.backend.applyGroupLabels();
    expect(t.terminals[2]?.labels.group).toBe("x");
  });

  it("keeps the label when the groups file isn't JSON", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = setup({ group: "bugs" });
    writeFileSync(s.path, "not json");
    await s.backend.applyGroupLabels();
    expect(s.terminals[1]?.labels.group).toBe("bugs");
    err.mockRestore();
  });
});

// Task 087: tabs of removed terminals leave herdr-app's layout; live, finished and sleeping ones stay.
describe("HerdrCoreBackend dropRemovedTerminals", () => {
  const tab = (id: string, term: string) => ({ id: `tb${id}`, name: id, root: { type: "row", id: `tb${id}`, children: [{ type: "block", id: `p${id}`, content: { terminal: term } }] } });
  function setup(known: Record<string, "live" | "finished">, lookupFails = false) {
    let value: unknown = { spaces: [{ id: "spA", name: "a", folder: "/", tabs: [tab("1", "t1"), tab("2", "t2"), tab("3", "t3")] }, { id: "spB", name: "b", folder: "/", tabs: [tab("4", "t4")] }] };
    let version = 1;
    const rpc = {
      getDoc: () => Promise.resolve({ value: structuredClone(value), version }),
      setDoc: (_n: string, v: unknown) => {
        value = v;
        version += 1;
        return Promise.resolve(version);
      },
      listTerminals: () => Promise.resolve(Object.entries(known).filter(([, s]) => s === "live").map(([address]) => ({ address }))),
      getTerminal: (address: string) => (lookupFails ? Promise.reject(new Error("socket closed")) : address in known ? Promise.resolve({ address }) : Promise.reject(new HcError("not_found", "gone"))),
    };
    const backend = new HerdrCoreBackend({ rpc: rpc as never, groupsFile: "/nonexistent", home: "/home/me" });
    return { backend, value: () => value as { spaces: { id: string; tabs: { id: string }[] }[] } };
  }

  it("drops the tab of a removed terminal and a space left empty, keeps live and finished ones", async () => {
    const s = setup({ t1: "live", t3: "finished" });
    await s.backend.dropRemovedTerminals();
    expect(s.value().spaces.map((x) => [x.id, x.tabs.map((t) => t.id)])).toEqual([["spA", ["tb1", "tb3"]]]);
  });

  it("leaves the layout alone when a lookup fails for another reason", async () => {
    const s = setup({ t1: "live" }, true);
    const before = JSON.stringify(s.value());
    await s.backend.dropRemovedTerminals();
    expect(JSON.stringify(s.value())).toBe(before);
  });
});

// Task 103: waking clears leftover prompt text (Ctrl+C) before the resume line is typed.
describe("HerdrCoreBackend wakePane", () => {
  it("presses Ctrl+C before typing the resume line", async () => {
    const calls: string[] = [];
    const term: WireTerminal = { address: "t1", name: "", labels: { "sleep.session": "22222222-2222-4222-8222-222222222222", "sleep.cwd": "/tmp" }, state: "live", cwd: "/tmp", cols: 80, rows: 24, title: "", status: null, statusMs: null, pid: null, foreground: { name: "fish" }, parent: "" } as unknown as WireTerminal;
    const rpc = {
      getTerminal: () => Promise.resolve(term),
      labelTerminal: () => Promise.resolve(),
      pressKeys: (_id: string, keys: string[]) => (calls.push(`keys:${keys.join("+")}`), Promise.resolve()),
      sendText: (_id: string, text: string) => (calls.push(`text:${text}`), Promise.resolve()),
    };
    const sessions = { resumeCommand: (s: string) => ["claude", "--resume", s] };
    const dir = mkdtempSync(join(tmpdir(), "herdr-adapter-test-"));
    const backend = new HerdrCoreBackend({ rpc: rpc as never, groupsFile: join(dir, "g.json"), home: "/home/me", sessions } as never);
    await backend.wakePane("t1");
    expect(calls).toEqual(["keys:ctrl+c", "text:cd /tmp && claude --resume 22222222-2222-4222-8222-222222222222"]);
  });

  // Task 139: a wake whose Claude never came up gives the sleep labels back, so the pane shows asleep again.
  it("restoreSleep gives the labels back while only a shell runs, and not once Claude runs", async () => {
    const labelled: Record<string, string>[] = [];
    let term = { address: "t1", name: "", labels: { "sleep.session": "22222222-2222-4222-8222-222222222222", "sleep.cwd": "/tmp" }, state: "live", cwd: "/tmp", cols: 80, rows: 24, title: "", status: null, statusMs: null, pid: null, foreground: { name: "fish" }, parent: "" } as unknown as WireTerminal;
    const rpc = {
      getTerminal: () => Promise.resolve(term),
      labelTerminal: (_id: string, l: Record<string, string>) => (labelled.push(l), Promise.resolve()),
      pressKeys: () => Promise.resolve(),
      sendText: () => Promise.resolve(),
    };
    const sessions = { resumeCommand: (s: string) => ["claude", "--resume", s] };
    const dir = mkdtempSync(join(tmpdir(), "herdr-adapter-test-"));
    const backend = new HerdrCoreBackend({ rpc: rpc as never, groupsFile: join(dir, "g.json"), home: "/home/me", sessions } as never);
    await backend.wakePane("t1");
    labelled.length = 0;
    term = { ...term, labels: {} } as unknown as WireTerminal; // labels cleared by the wake; the shell is still there
    await backend.restoreSleep("t1");
    expect(labelled).toEqual([{ "sleep.session": "22222222-2222-4222-8222-222222222222", "sleep.cwd": "/tmp", "claude.session": "", "claude.cwd": "" }]);
    labelled.length = 0;
    await backend.restoreSleep("t1"); // already given back
    expect(labelled).toEqual([]);
  });
});
