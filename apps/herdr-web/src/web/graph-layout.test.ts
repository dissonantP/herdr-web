import { describe, expect, it } from "vitest";
import type { GroupNode, PaneNode, SpaceNode, Tree } from "../shared/model.ts";
import { buildGraph, spaceStatus, titleLines } from "./graph-layout.ts";

const pane = (id: string, over: Partial<PaneNode> = {}): PaneNode => ({ id, kind: "terminal", name: id, agent: "claude", status: "idle", chat: true, asleep: false, ...over });
const space = (id: string, panes: PaneNode[], children: SpaceNode[] = []): SpaceNode => ({ id, name: id, quiet: false, color: null, tabs: [{ id: `t${id}`, name: "1", panes }], children });
const tree = (...spaces: SpaceNode[]): Tree => ({ spaces, groups: [] });

describe("spaceStatus", () => {
  it("takes the most urgent live session", () => {
    expect(spaceStatus(space("a", [pane("1"), pane("2", { status: "waiting" }), pane("3", { status: "working" })]))).toBe("waiting");
    expect(spaceStatus(space("a", [pane("1"), pane("2", { status: "working" })]))).toBe("working");
    expect(spaceStatus(space("a", [pane("1")]))).toBe("idle");
    expect(spaceStatus(space("a", [pane("1"), pane("2", { unseen: true })]))).toBe("finished");
    expect(spaceStatus(space("a", [pane("1", { unseen: true }), pane("2", { status: "working" })]))).toBe("working");
  });
  it("is asleep when only sleeping sessions remain", () => {
    expect(spaceStatus(space("a", [pane("1", { asleep: true, agent: null, status: "idle" })]))).toBe("asleep");
    expect(spaceStatus(space("a", [pane("1", { asleep: true }), pane("2", { status: "working" })]))).toBe("working");
  });
  it("is none for no sessions or shells", () => {
    expect(spaceStatus(space("a", []))).toBe("none");
    expect(spaceStatus(space("a", [pane("1", { agent: null, status: null })]))).toBe("none");
  });
});

const inside = (inner: { x: number; y: number; w: number; h: number } | undefined, outer: { x: number; y: number; w: number; h: number } | undefined) =>
  inner !== undefined && outer !== undefined && inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

describe("buildGraph", () => {
  const t = tree(space("top", [], [space("kid", [pane("p1")], [space("grand", [])]), space("kid2", [])]));
  const at = (nodes: readonly { id: string }[], id: string) => nodes.find((n) => n.id === id) as ReturnType<typeof buildGraph>["nodes"][number];

  it("draws a space with child spaces as a box around its subtree, its own node at the top", () => {
    const { nodes } = buildGraph(t, false);
    expect(nodes.filter((n) => n.kind === "box").map((n) => n.spaceId).sort()).toEqual(["kid", "top"]);
    expect(inside(at(nodes, "kid"), at(nodes, "box:top"))).toBe(true);
    expect(inside(at(nodes, "grand"), at(nodes, "box:kid"))).toBe(true);
    expect(inside(at(nodes, "box:kid"), at(nodes, "box:top"))).toBe(true);
    expect(at(nodes, "grand").parent).toBe("box:kid");
    expect(at(nodes, "top").y).toBeLessThan(at(nodes, "kid").y);
    expect(at(nodes, "kid").y).toBeLessThan(at(nodes, "grand").y);
    // A space with no children has no box.
    expect(nodes.some((n) => n.id === "box:kid2" || n.id === "box:grand")).toBe(false);
  });

  it("adds a small node per session only when asked, inside its space's box", () => {
    expect(buildGraph(t, false).nodes.some((n) => n.kind === "session")).toBe(false);
    const withSessions = buildGraph(t, true).nodes;
    expect(at(withSessions, "pane:p1")).toMatchObject({ kind: "session", spaceId: "kid", paneId: "p1", parent: "box:kid" });
    expect(inside(at(withSessions, "pane:p1"), at(withSessions, "box:kid"))).toBe(true);
  });

  it("wraps a wide fan-out into a grid instead of one long row", () => {
    const wide = tree(space("top", [], Array.from({ length: 12 }, (_, i) => space(`c${String(i)}`, []))));
    const tall = buildGraph(wide, false, 0.55).nodes.find((n) => n.id === "box:top");
    const flat = buildGraph(wide, false, 1.8).nodes.find((n) => n.id === "box:top");
    expect(flat?.w).toBeLessThan(12 * 140);
    expect(tall?.w).toBeLessThan(flat?.w ?? 0);
    expect(tall?.h).toBeGreaterThan(flat?.h ?? Infinity);
  });

  it("never overlaps two nodes", () => {
    const kids = Array.from({ length: 9 }, (_, i) => space(`c${String(i)}`, [], i % 3 === 0 ? [space(`g${String(i)}`, [])] : []));
    const wide = tree(space("top", [], kids));
    for (const aspect of [0.55, 1.8]) {
      const nodes = buildGraph(wide, true, aspect).nodes.filter((n) => n.kind === "space");
      for (const a of nodes) {
        for (const b of nodes) {
          if (a.id < b.id) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
        }
      }
    }
  });
});

describe("groups as boxes", () => {
  const group = (id: string, spaces: SpaceNode[], groups: GroupNode[] = []): GroupNode => ({ id, name: id, color: null, spaces, groups });
  const t: Tree = { spaces: [space("top", [])], groups: [group("work", [space("a", [])], [group("inner", [space("b", [], [space("kid", [])])])])] };
  const at = (nodes: readonly { id: string }[], id: string) => nodes.find((n) => n.id === id) as ReturnType<typeof buildGraph>["nodes"][number];

  it("draws each group and nested group as a box around its spaces, to any depth", () => {
    const { nodes } = buildGraph(t, false);
    expect(nodes.filter((n) => n.kind === "group").map((n) => n.groupId).sort()).toEqual(["inner", "work"]);
    expect(inside(at(nodes, "a"), at(nodes, "group:work"))).toBe(true);
    expect(inside(at(nodes, "group:inner"), at(nodes, "group:work"))).toBe(true);
    expect(inside(at(nodes, "box:b"), at(nodes, "group:inner"))).toBe(true);
    expect(inside(at(nodes, "kid"), at(nodes, "box:b"))).toBe(true);
    expect(at(nodes, "group:inner").parent).toBe("group:work");
    expect(at(nodes, "group:work").parent).toBeNull();
    // Containers draw above the ones around them; a group's label strip sits above what it holds.
    expect(at(nodes, "box:b").depth).toBeGreaterThan(at(nodes, "group:inner").depth);
    expect(at(nodes, "a").y).toBeGreaterThanOrEqual(at(nodes, "group:work").y + at(nodes, "group:work").labelH);
    // The ungrouped space is outside every box.
    expect(at(nodes, "top").parent).toBeNull();
  });

  it("gives every node a second line and grows a node to fit a long title", () => {
    const long = { ...space("s", []), name: "a very long space name that must wrap onto several lines without being cut off" };
    const { nodes } = buildGraph({ spaces: [space("short", []), long], groups: [] }, false);
    const h = (id: string) => nodes.find((n) => n.id === id)?.h ?? NaN;
    expect(h("s")).toBeGreaterThan(h("short"));
    expect(nodes.find((n) => n.id === "short")?.detail).toBe("no sessions");
  });
});

describe("titleLines", () => {
  it("wraps words and breaks a word that is wider than a line", () => {
    expect(titleLines("short", 14, 130)).toBe(1);
    expect(titleLines("one two three four five six seven eight", 14, 130)).toBeGreaterThan(2);
    expect(titleLines("x".repeat(120), 14, 130)).toBeGreaterThan(4);
  });
});
