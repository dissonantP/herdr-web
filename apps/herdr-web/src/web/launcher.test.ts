import { describe, expect, it } from "vitest";
import type { Tree } from "../shared/model.ts";
import { entries, fuzzyScore, search } from "./launcher.ts";

const pane = (id: string, name: string, status: "working" | "waiting" | "idle" | null = null) => ({ id, kind: "terminal" as const, name, agent: status === null ? null : "claude", status, chat: status !== null, asleep: false });
const space = (id: string, name: string, panes = [pane(`p-${id}`, "shell")], children: Tree["spaces"][number][] = []) => ({ id, name, quiet: false, color: null, children, tabs: [{ id: `t-${id}`, name: "main", panes }] });
const tree: Tree = {
  spaces: [space("s0", "loose")],
  groups: [{ id: "g1", name: "Work", color: null, spaces: [space("s1", "api server", [pane("p1", "builder", "waiting")], [space("s2", "docs")])], groups: [] }],
};

describe("fuzzyScore", () => {
  it("matches subsequences, not other letters", () => {
    expect(fuzzyScore("aps", "api server")).not.toBeNull();
    expect(fuzzyScore("xyz", "api server")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });
  it("prefers a prefix over a middle match over a scattered one", () => {
    const prefix = fuzzyScore("api", "api server") ?? 0;
    const middle = fuzzyScore("api", "my api") ?? 0;
    const scattered = fuzzyScore("api", "a p i") ?? 0;
    expect(prefix).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(scattered);
  });
});

describe("entries", () => {
  const all = entries(tree);
  it("lists only spaces, with their path", () => {
    expect(all.map((e) => e.key)).toEqual(["s:s0", "s:s1", "s:s2"]);
    expect(all.find((e) => e.key === "s:s2")).toMatchObject({ kind: "space", path: "Work › api server", route: { space: "s2", tab: null, pane: null } });
  });
  it("gives a space the most urgent status beneath it", () => {
    expect(all.find((e) => e.key === "s:s1")?.status).toBe("waiting");
    expect(all.find((e) => e.key === "s:s0")?.status).toBeNull();
  });
});

describe("search", () => {
  const all = entries(tree);
  it("finds by name or by path, best match first", () => {
    expect(search(all, "build", [])).toEqual([]);
    expect(search(all, "work", [])[0]?.key).toBe("s:s1");
    expect(search(all, "docs", [])[0]?.key).toBe("s:s2");
    expect(search(all, "zzz", [])).toEqual([]);
  });
  it("with an empty query lists recent spaces first, then the rest", () => {
    const keys = search(all, "", ["s2", "s0"]).map((e) => e.key);
    expect(keys.slice(0, 2)).toEqual(["s:s2", "s:s0"]);
    expect(keys).toEqual(["s:s2", "s:s0", "s:s1"]);
  });
});
