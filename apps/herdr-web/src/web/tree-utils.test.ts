import { describe, expect, it } from "vitest";
import type { PaneNode, PaneStatus, SpaceNode, Tree } from "../shared/model.ts";
import { allSpaces, dotState, isSleeping, filterTree, inboxItems, parentOfSpace, runningIn, spacesWithDepth, waitingIn, workingIn } from "./tree-utils.ts";

const pane = (id: string, name: string, status: PaneStatus | null = null) => ({ id, kind: "terminal" as const, name, agent: status === null ? null : "claude", status, chat: status !== null, asleep: false });
const tree: Tree = {
  spaces: [{ id: "s0", name: "loose", quiet: false, color: null, children: [], tabs: [{ id: "t0", name: "1", panes: [pane("p0", "shell")] }] }],
  groups: [
    {
      id: "g1",
      name: "work",
      color: null,
      spaces: [
        { id: "s1", name: "api", quiet: false, color: null, children: [], tabs: [{ id: "t1", name: "main", panes: [pane("p1", "server", "working"), pane("p2", "tests", "waiting")] }] },
        { id: "s2", name: "docs", quiet: false, color: null, children: [], tabs: [{ id: "t2", name: "1", panes: [pane("p3", "writer", "idle")] }] },
      ],
      groups: [],
    },
  ],
};

describe("waitingIn", () => {
  it("counts the panes waiting for input beneath a node", () => {
    expect(waitingIn(tree.groups[0]!)).toBe(1);
    expect(waitingIn(tree.groups[0]!.spaces[1]!)).toBe(0);
    expect(waitingIn(tree.spaces[0]!)).toBe(0);
  });
});

describe("filterTree", () => {
  it("keeps everything for an empty query", () => {
    expect(filterTree(tree, "  ").tree).toBe(tree);
  });
  it("keeps a space that matches by name with all its tabs, closed unless something beneath matches", () => {
    const result = filterTree(tree, "API");
    expect(result.tree.spaces).toEqual([]);
    expect(result.tree.groups[0]?.spaces.map((s) => s.id)).toEqual(["s1"]);
    expect(result.tree.groups[0]?.spaces[0]?.tabs[0]?.panes).toHaveLength(2);
    expect(result.open.has("g1")).toBe(true);
    expect(result.open.has("s1")).toBe(false);
  });
  it("keeps only the matching sessions of a space that does not match, and opens it", () => {
    const result = filterTree(tree, "tests");
    const space = result.tree.groups[0]?.spaces[0];
    expect(space?.tabs[0]?.panes.map((p) => p.id)).toEqual(["p2"]);
    expect(result.open).toEqual(new Set(["g1", "s1"]));
    expect(result.matches).toBe(1);
  });
  it("keeps a whole group that matches by name", () => {
    const result = filterTree(tree, "work");
    expect(result.tree.groups[0]?.spaces).toHaveLength(2);
  });
  it("is empty when nothing matches", () => {
    const result = filterTree(tree, "zzz");
    expect(result.tree).toEqual({ spaces: [], groups: [] });
    expect(result.matches).toBe(0);
  });
});

describe("nested spaces (F23)", () => {
  const kid = { id: "k1", name: "kid", quiet: false, color: null, children: [], tabs: [{ id: "tk", name: "1", panes: [pane("pk", "helper", "waiting")] }] };
  const nested: Tree = { spaces: [{ id: "r", name: "root", quiet: false, color: null, tabs: [], children: [{ id: "m", name: "mid", quiet: false, color: null, tabs: [], children: [kid] }] }], groups: [] };

  it("finds, counts and filters through nested spaces", () => {
    expect(allSpaces(nested).map((s) => s.id)).toEqual(["r", "m", "k1"]);
    expect(spacesWithDepth(nested).map(({ space, depth }) => [space.id, depth])).toEqual([["r", 0], ["m", 1], ["k1", 2]]);
    expect(parentOfSpace(nested, "k1")?.id).toBe("m");
    expect(parentOfSpace(nested, "r")).toBeNull();
    expect(waitingIn(nested.spaces[0]!)).toBe(1);
    expect(runningIn(nested.spaces[0]!).map((p) => p.id)).toEqual(["pk"]);
    const found = filterTree(nested, "helper");
    expect(found.tree.spaces[0]?.children[0]?.children[0]?.id).toBe("k1");
    expect([...found.open].sort()).toEqual(["k1", "m", "r"]);
  });
});

describe("inboxItems", () => {
  it("skips panes labelled herdr.inbox=hide", () => {
    const pane = (id: string, hidden: boolean) => ({ id, kind: "terminal" as const, name: id, agent: "claude", status: "idle" as const, chat: true, asleep: false, ...(hidden ? { inboxHidden: true } : {}) });
    const tree = { groups: [], spaces: [{ id: "s", name: "s", quiet: false, color: null, children: [], tabs: [{ id: "t", name: "t", panes: [pane("shown", false), pane("hidden", true)] }] }] };
    expect(inboxItems(tree).map((i) => i.pane.id)).toEqual(["shown"]);
  });

  const apane = (id: string, status: PaneNode["status"]): PaneNode => ({ id, kind: "terminal", name: id, agent: status === null ? null : "claude", status, chat: false, asleep: false });
  const space = (id: string, panes: PaneNode[], children: SpaceNode[] = []): SpaceNode => ({ id, name: id, quiet: false, color: null, tabs: [{ id: `${id}-t`, name: "t", panes }], children });

  it("lists agent panes waiting first, then working, then idle, keeping tree order inside each; shells are left out", () => {
    const tree: Tree = {
      spaces: [space("a", [apane("a1", "idle"), apane("a2", "working"), apane("shell", null)], [space("a-kid", [apane("k1", "waiting")])])],
      groups: [{ id: "g", name: "g", color: null, spaces: [space("b", [apane("b1", "waiting"), apane("b2", "idle")])], groups: [] }],
    };
    expect(inboxItems(tree).map((i) => i.pane.id)).toEqual(["k1", "b1", "a2", "a1", "b2"]);
    expect(inboxItems(tree)[0]).toMatchObject({ spaceId: "a-kid", tabId: "a-kid-t" });
  });
});

describe("inboxItems with pins", () => {
  const ap = (id: string, status: PaneNode["status"], unseen = false): PaneNode => ({ id, kind: "terminal", name: id, agent: "claude", status, chat: false, asleep: false, ...(unseen ? { unseen: true } : {}) });
  const sp = (id: string, panes: PaneNode[]): SpaceNode => ({ id, name: id, quiet: false, color: null, children: [], tabs: [{ id: `${id}-t`, name: "t", panes }] });
  const tree: Tree = { groups: [], spaces: [sp("pinned", [ap("pi", "idle")]), sp("loose", [ap("li", "idle"), ap("lw", "waiting"), ap("lk", "working"), ap("lf", "idle", true)])] };
  it("leaves idle sessions of unpinned spaces out, keeps the rest, and brings them back when pinned", () => {
    expect(inboxItems(tree, ["pinned"]).map((i) => i.pane.id)).toEqual(["lw", "lk", "pi", "lf"]);
    expect(inboxItems(tree, ["pinned", "loose"]).map((i) => i.pane.id)).toContain("li");
    expect(inboxItems(tree).map((i) => i.pane.id)).toContain("li");
  });
});

describe("space roll-up", () => {
  it("counts a working pane in tab 2, inbox-hidden or not, while the Inbox still hides it", () => {
    const hidden = { ...pane("w", "w", "working"), inboxHidden: true };
    const sp: SpaceNode = { id: "s", name: "s", quiet: false, color: null, children: [], tabs: [{ id: "t1", name: "1", panes: [pane("i", "i", "idle")] }, { id: "t2", name: "2", panes: [hidden] }] };
    expect(workingIn(sp)).toBe(1);
    expect(inboxItems({ spaces: [sp], groups: [] }).map((i) => i.pane.id)).toEqual(["i"]);
  });
});

describe("dotState", () => {
  it("gives one dot state per pane, the same for every view", () => {
    const p = (over: Partial<PaneNode>): PaneNode => ({ ...pane("p", "x", "idle"), ...over });
    expect(dotState(p({ status: "working" }))).toBe("working");
    expect(dotState(p({ status: "waiting" }))).toBe("waiting");
    expect(dotState(p({ status: "idle" }))).toBe("idle");
    expect(dotState(p({ status: "idle", unseen: true }))).toBe("finished");
    expect(dotState(p({ status: "working", unseen: true }))).toBe("working");
    expect(dotState(p({ status: null, agent: null }))).toBe("none");
    expect(dotState(p({ asleep: true, status: "idle", unseen: true }))).toBe("asleep");
  });
});

describe("isSleeping", () => {
  const space = (panes: PaneNode[]): SpaceNode => ({ id: "s", name: "s", color: null, tabs: [{ id: "t", name: "t", panes }], children: [] }) as unknown as SpaceNode;
  const asleep = { ...pane("a", "a"), asleep: true };
  it("is true with a sleeping session and no awake agent", () => {
    expect(isSleeping(space([asleep, pane("sh", "sh")]))).toBe(true);
  });
  it("counts nested child spaces", () => {
    const child = space([asleep]);
    const parent = { ...space([pane("sh", "sh")]), children: [child] } as SpaceNode;
    expect(isSleeping(parent)).toBe(true);
    expect(isSleeping({ ...parent, children: [child, space([pane("b", "b", "working")])] } as SpaceNode)).toBe(false);
  });
  it("is false when an agent is awake or nothing sleeps", () => {
    expect(isSleeping(space([asleep, pane("b", "b", "idle")]))).toBe(false);
    expect(isSleeping(space([pane("sh", "sh")]))).toBe(false);
  });
});
