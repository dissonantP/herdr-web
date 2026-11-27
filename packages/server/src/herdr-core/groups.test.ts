import { describe, expect, it } from "vitest";
import { groupForest, groupsFilePath, parseGroups } from "./groups.ts";

const file = (body: object) => JSON.stringify({ version: 2, ...body });

describe("groupsFilePath", () => {
  it("uses HERDR_GROUPS_FILE, else Desktop's default", () => {
    expect(groupsFilePath({ HERDR_GROUPS_FILE: "/tmp/g.json" }, "/home/x")).toBe("/tmp/g.json");
    expect(groupsFilePath({}, "/home/x")).toBe("/home/x/.local/state/herdr-groups/groups.json");
  });
});

describe("parseGroups", () => {
  it("reads each space's own colour, even outside a group", () => {
    const parsed = parseGroups(file({ groups: [], spaces: { a: { color: "inv:ansi4" }, b: { color: "dim" }, c: { color: null }, d: {} } }));
    expect([...parsed.spaceColor]).toEqual([["a", "inv:ansi4"], ["b", "dim"]]);
  });
  it("reads ids first and names as fallbacks", () => {
    const parsed = parseGroups(
      file({
        groups: [
          { id: "ga", name: "work", parent: null, parentId: null, color: "ansi2" },
          { id: "gb", name: "bugs", parent: "work", parentId: null, color: null },
          { id: "gc", name: "ops", parent: null, parentId: "ga", color: null },
        ],
        spaces: {
          sp1: { name: "one", group: "work", groupId: null, color: null },
          sp2: { name: "two", group: "bugs", groupId: "gc", color: null },
          sp3: { name: "three", group: null, groupId: "gone", color: null },
        },
      }),
    );
    expect(parsed.groups.map((g) => [g.id, g.parentId, g.color])).toEqual([
      ["ga", null, "ansi2"],
      ["gb", "ga", null],
      ["gc", "ga", null],
    ]);
    expect([...parsed.groupOf]).toEqual([
      ["sp1", "ga"],
      ["sp2", "gc"],
    ]);
  });

  it("treats a missing parent as top level and junk as no groups", () => {
    expect(parseGroups(file({ groups: [{ id: "g1", name: "x", parentId: "nope" }] })).groups[0]?.parentId).toBeNull();
    expect(parseGroups("not json").groups).toEqual([]);
    expect(parseGroups("[]").groups).toEqual([]);
  });
});

describe("groupForest", () => {
  it("nests groups in file order, children after their parent", () => {
    const g = (id: string, parentId: string | null) => ({ id, name: id, parentId, color: null });
    const forest = groupForest([g("a", null), g("b", "a"), g("c", null), g("d", "b"), g("e", "a")]);
    const show = (n: (typeof forest)[number]): unknown => [n.group.id, n.children.map(show)];
    expect(forest.map(show)).toEqual([["a", [["b", [["d", []]]], ["e", []]]], ["c", []]]);
  });

  it("puts a hand-written parent loop at top level, like Desktop", () => {
    const forest = groupForest([
      { id: "a", name: "a", parentId: "b", color: null },
      { id: "b", name: "b", parentId: "a", color: null },
    ]);
    expect(forest.map((n) => [n.group.id, n.children.map((c) => c.group.id)])).toEqual([["a", ["b"]]]);
  });
});
