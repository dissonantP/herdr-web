import { describe, expect, it } from "vitest";
import type { Tree } from "../shared/model.ts";
import { shortcutTarget } from "./nav-shortcuts.ts";

const sp = (id: string, tabs: string[]) => ({ kind: "space", id, name: id, tabs: tabs.map((t) => ({ id: t, name: t, panes: [] })), children: [] });
const tree = { groups: [], spaces: [sp("a", ["a1", "a2", "a3"]), sp("b", []), sp("c", ["c1"])] } as unknown as Tree;
const at = (space: string | null, tab: string | null = null) => ({ space, tab, pane: null });

describe("shortcutTarget", () => {
  it("steps tabs and wraps at both ends; an unset tab counts as the first", () => {
    expect(shortcutTarget(tree, at("a", "a1"), [], { kind: "tab", dir: 1 })?.tab).toBe("a2");
    expect(shortcutTarget(tree, at("a", "a3"), [], { kind: "tab", dir: 1 })?.tab).toBe("a1");
    expect(shortcutTarget(tree, at("a", "a1"), [], { kind: "tab", dir: -1 })?.tab).toBe("a3");
    expect(shortcutTarget(tree, at("a"), [], { kind: "tab", dir: 1 })?.tab).toBe("a2");
  });
  it("has nowhere to go with no space, no tabs or an unknown space", () => {
    expect(shortcutTarget(tree, at(null), [], { kind: "tab", dir: 1 })).toBeNull();
    expect(shortcutTarget(tree, at("b"), [], { kind: "tab", dir: 1 })).toBeNull();
    expect(shortcutTarget(tree, at("zz"), [], { kind: "tab", dir: 1 })).toBeNull();
  });
  it("steps pins (skipping deleted spaces) and wraps; no open pin starts at either end", () => {
    const pins = ["a", "gone", "c"];
    expect(shortcutTarget(tree, at("a"), pins, { kind: "pin", dir: 1 })?.space).toBe("c");
    expect(shortcutTarget(tree, at("c"), pins, { kind: "pin", dir: 1 })?.space).toBe("a");
    expect(shortcutTarget(tree, at("a"), pins, { kind: "pin", dir: -1 })?.space).toBe("c");
    expect(shortcutTarget(tree, at(null), pins, { kind: "pin", dir: 1 })?.space).toBe("a");
    expect(shortcutTarget(tree, at(null), pins, { kind: "pin", dir: -1 })?.space).toBe("c");
    expect(shortcutTarget(tree, at("a"), [], { kind: "pin", dir: 1 })).toBeNull();
  });
  it("goes to the nth shown pin", () => {
    const pins = ["a", "gone", "c"];
    expect(shortcutTarget(tree, at("a"), pins, { kind: "pinAt", n: 2 })?.space).toBe("c");
    expect(shortcutTarget(tree, at("a"), pins, { kind: "pinAt", n: 3 })).toBeNull();
  });
});
