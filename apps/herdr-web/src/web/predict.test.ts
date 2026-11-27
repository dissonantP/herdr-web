import { describe, expect, it } from "vitest";
import type { PaneNode, SpaceNode, Tree } from "../shared/model.ts";
import { allSpaces } from "../shared/tree-walk.ts";
import { predict } from "./predict.ts";

const pane = (id: string, extra: Partial<PaneNode> = {}): PaneNode => ({ id, kind: "terminal", name: id, agent: "claude", status: "idle", chat: true, asleep: false, ...extra });
const space = (id: string, extra: Partial<SpaceNode> = {}): SpaceNode => ({ id, name: id, quiet: false, color: null, children: [], tabs: [{ id: `${id}-t`, name: "1", panes: [pane(`${id}-p`)] }], ...extra });
const tree: Tree = {
  spaces: [space("loose", { children: [space("kid")] })],
  groups: [{ id: "g", name: "work", color: null, spaces: [space("api")], groups: [{ id: "g2", name: "inner", color: null, spaces: [space("deep")], groups: [] }] }],
};
const ids = (t: Tree) => allSpaces(t).map((s) => s.id);
const find = (t: Tree, id: string) => allSpaces(t).find((s) => s.id === id);

describe("predict", () => {
  it("renames and recolours spaces, groups and tabs where they are", () => {
    expect(find(predict(tree, { type: "space.rename", id: "kid", name: " child " })!, "kid")?.name).toBe("child");
    expect(predict(tree, { type: "group.rename", id: "g2", name: "core" })!.groups[0]?.groups[0]?.name).toBe("core");
    expect(find(predict(tree, { type: "tab.rename", id: "api-t", name: "main" })!, "api")?.tabs[0]?.name).toBe("main");
    expect(find(predict(tree, { type: "space.color", id: "deep", color: "ansi3" })!, "deep")?.color).toBe("ansi3");
    expect(find(predict(tree, { type: "space.quiet", id: "api", quiet: true })!, "api")?.quiet).toBe(true);
  });

  it("does not guess what only the server knows", () => {
    expect(predict(tree, { type: "space.rename", id: "api", name: "" })).toBeNull();
    expect(predict(tree, { type: "tab.create", spaceId: "api", name: "" })).toBeNull();
    expect(predict(tree, { type: "space.move", id: "nope", groupId: null })).toBeNull();
  });

  it("deletes a space with or without its children", () => {
    expect(ids(predict(tree, { type: "space.delete", id: "loose", children: "lift" })!)).toEqual(["kid", "api", "deep"]);
    expect(ids(predict(tree, { type: "space.delete", id: "loose", children: "delete" })!)).toEqual(["api", "deep"]);
  });

  it("deletes a group, lifting what it holds a level up", () => {
    const lifted = predict(tree, { type: "group.delete", id: "g2", children: "lift" })!;
    expect(lifted.groups[0]?.groups).toEqual([]);
    expect(lifted.groups[0]?.spaces.map((s) => s.id)).toEqual(["api", "deep"]);
    expect(ids(predict(tree, { type: "group.delete", id: "g", children: "lift" })!)).toEqual(["loose", "kid", "api", "deep"]);
    expect(ids(predict(tree, { type: "group.delete", id: "g", children: "delete" })!)).toEqual(["loose", "kid"]);
  });

  it("moves a space to a group or under another space", () => {
    expect(predict(tree, { type: "space.move", id: "api", groupId: "g2" })!.groups[0]?.groups[0]?.spaces.map((s) => s.id)).toEqual(["deep", "api"]);
    expect(predict(tree, { type: "space.reparent", id: "kid", parentId: null })).toBeNull(); // its group is the server's to say
    expect(find(predict(tree, { type: "space.reparent", id: "deep", parentId: "api" })!, "api")?.children.map((s) => s.id)).toEqual(["deep"]);
  });

  it("closes tabs and panes; a tab whose last pane closes goes too", () => {
    expect(find(predict(tree, { type: "tab.delete", id: "api-t" })!, "api")?.tabs).toEqual([]);
    expect(find(predict(tree, { type: "pane.close", id: "api-p" })!, "api")?.tabs).toEqual([]);
  });

  it("marks panes seen, dismissed, asleep and waking", () => {
    const unseen: Tree = { spaces: [space("s", { tabs: [{ id: "t", name: "1", panes: [pane("p", { unseen: true })] }] })], groups: [] };
    const p = (t: Tree | null) => t?.spaces[0]?.tabs[0]?.panes[0];
    expect(p(predict(unseen, { type: "pane.seen", id: "p" }))?.unseen).toBeUndefined();
    expect(p(predict(unseen, { type: "pane.dismiss", id: "p" }))).toMatchObject({ dismissed: true, unseen: undefined });
    const waiting: Tree = { spaces: [space("s", { tabs: [{ id: "t", name: "1", panes: [pane("p", { status: "waiting" })] }] })], groups: [] };
    expect(predict(waiting, { type: "pane.dismiss", id: "p" })).toBeNull(); // the server keeps those in the Inbox
    expect(p(predict(unseen, { type: "pane.sleep", id: "p" }))).toMatchObject({ asleep: true, agent: null, status: null });
    expect(p(predict(unseen, { type: "pane.wake", id: "p" }))).toMatchObject({ asleep: false, waking: true });
  });
});
