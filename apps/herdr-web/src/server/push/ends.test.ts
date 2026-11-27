import { describe, expect, it } from "vitest";
import type { Tree } from "../../shared/model.ts";
import { endedBy } from "./ends.ts";

const pane = (id: string) => ({ id, kind: "terminal" as const, name: id, agent: "claude", status: "idle" as const, chat: true, asleep: false });
const tree: Tree = {
  spaces: [{ id: "s1", name: "one", quiet: false, color: null, children: [], tabs: [{ id: "tb1", name: "1", panes: [pane("a"), pane("b")] }, { id: "tb2", name: "2", panes: [pane("c")] }] }],
  groups: [{ id: "g1", name: "g", color: null, spaces: [{ id: "s2", name: "two", quiet: false, color: null, children: [], tabs: [{ id: "tb3", name: "3", panes: [pane("d")] }] }], groups: [{ id: "g2", name: "in", color: null, spaces: [{ id: "s3", name: "three", quiet: false, color: null, children: [], tabs: [{ id: "tb4", name: "4", panes: [pane("e")] }] }], groups: [] }] }],
};

describe("endedBy", () => {
  it("names only the panes a change ends", () => {
    expect(endedBy({ type: "pane.close", id: "a" }, tree)).toEqual(["a"]);
    expect(endedBy({ type: "tab.delete", id: "tb1" }, tree)).toEqual(["a", "b"]);
    expect(endedBy({ type: "space.delete", id: "s2", children: "lift" }, tree)).toEqual(["d"]);
    expect(endedBy({ type: "group.delete", id: "g1", children: "delete" }, tree).sort()).toEqual(["d", "e"]);
    expect(endedBy({ type: "group.delete", id: "g1", children: "lift" }, tree)).toEqual([]);
    expect(endedBy({ type: "space.rename", id: "s1", name: "x" }, tree)).toEqual([]);
  });
});
