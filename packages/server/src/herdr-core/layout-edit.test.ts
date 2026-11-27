import { describe, expect, it } from "vitest";
import type { JsonValue } from "./json.ts";
import * as L from "./layout-edit.ts";

const block = (id: string, terminal: string) => ({ type: "block", id, content: { terminal } });
const doc = (): JsonValue => ({
  spaces: [
    { id: "spA", name: "a", folder: "/a", extra: 1, tabs: [{ id: "tbA1", name: "", root: { type: "row", id: "tbA1", children: [block("p1", "t1"), { type: "column", id: "c", children: [block("p2", "t2")] }] } }, { id: "tbA2", name: "two", root: { type: "row", id: "tbA2", children: [block("p3", "t3")] } }] },
    { id: "spB", name: "", folder: "/b", tabs: [{ id: "tbB1", name: "", root: { type: "row", id: "tbB1", children: [block("p4", "t4"), { type: "block", id: "m1", content: { mod: "md-review" } }] } }] },
  ],
});

describe("layout edits", () => {
  it("adds a space with one tab and one terminal at the end, keeping the rest", () => {
    const next = L.addSpace(doc(), { id: "spN", name: "new", folder: "/n" }, { tabId: "tbN", paneId: "pN", terminal: "t9", name: "" }) as { spaces: { id: string; extra?: number }[] };
    expect(next.spaces.map((s) => s.id)).toEqual(["spA", "spB", "spN"]);
    expect(next.spaces[0]?.extra).toBe(1);
    expect(next.spaces[2]).toEqual({ id: "spN", name: "new", folder: "/n", tabs: [{ id: "tbN", name: "", root: { type: "row", id: "tbN", children: [block("pN", "t9")] } }] });
  });

  it("only names a space Desktop adopted first", () => {
    const d = L.addSpace(doc(), { id: "spB", name: "named", folder: "/x" }, { tabId: "tbX", paneId: "pX", terminal: "t9", name: "" }) as { spaces: { id: string; name: string; tabs: unknown[] }[] };
    expect(d.spaces).toHaveLength(2);
    expect(d.spaces[1]?.name).toBe("named");
    expect(d.spaces[1]?.tabs).toHaveLength(1);
  });

  it("adds a tab, or only names one already there", () => {
    const d = L.addTab(doc(), "spB", { tabId: "tbN", paneId: "pN", terminal: "t9", name: "x" });
    expect(L.tabTerminals(d as JsonValue, "tbN")).toEqual(["t9"]);
    expect(L.addTab(doc(), "spB", { tabId: "tbB1", paneId: "pN", terminal: "t9", name: "" })).toBeNull();
    expect(L.addTab(doc(), "spZ", { tabId: "tbN", paneId: "pN", terminal: "t9", name: "" })).toBeNull();
  });

  it("renames spaces and tabs; nothing to do is null", () => {
    expect(L.spaceName(L.rename(doc(), "spB", "bee") as JsonValue, "spB")).toBe("bee");
    const d = L.rename(doc(), "tbA2", "") as { spaces: { tabs: { name: string }[] }[] };
    expect(d.spaces[0]?.tabs[1]?.name).toBe("");
    expect(L.rename(doc(), "spA", "a")).toBeNull();
    expect(L.rename(doc(), "nope", "a")).toBeNull();
  });

  it("removes a space or a tab, and lists their terminals", () => {
    expect(L.spaceTerminals(doc(), "spA")).toEqual(["t1", "t2", "t3"]);
    expect(L.allTerminals(L.removeSpace(doc(), "spA") as JsonValue)).toEqual(["t4"]);
    expect(L.allTerminals(L.removeTab(doc(), "tbA1") as JsonValue)).toEqual(["t3", "t4"]);
    expect(L.removeSpace(doc(), "nope")).toBeNull();
    expect(L.spaceOfTab(doc(), "tbB1")).toBe("spB");
    expect(L.tabCount(doc(), "spA")).toBe(2);
  });

  it("closes a pane: its block goes, empty containers and an emptied tab go, a last tab stays", () => {
    const d1 = L.removePane(doc(), "t2") as JsonValue;
    expect(JSON.stringify(d1)).not.toContain('"c"');
    expect(L.allTerminals(d1)).toEqual(["t1", "t3", "t4"]);
    const d2 = L.removePane(doc(), "t3") as JsonValue;
    expect(L.tabCount(d2, "spA")).toBe(1);
    // The last pane of a space's only tab is never removed (no empty split tree in Desktop's doc).
    const d3 = L.removePane(doc(), "t4") as JsonValue;
    expect(L.isLastPaneOfSpace(d3, "m1")).toBe(true);
    expect(L.isLastPaneOfSpace(doc(), "m1")).toBe(false);
    expect(L.isLastPaneOfSpace(doc(), "t3")).toBe(false);
    expect(L.removePane(d3, "m1")).toBeNull();
    expect(L.removePane(doc(), "t99")).toBeNull();
  });

  it("never writes a doc that is not herdr-app's shape", () => {
    expect(L.addSpace({ other: true }, { id: "s", name: "", folder: "/" }, { tabId: "t", paneId: "p", terminal: "t1", name: "" })).toBeNull();
  });

  it("makes ids shaped like herdr-app's", () => {
    expect(L.newId("sp")).toMatch(/^sp[0-9a-f]{32}$/u);
    expect(L.newId("p")).toMatch(/^p[0-9a-f]{32}$/u);
  });

  it("drops tabs and spaces left with only removed terminals, keeps the rest and mod blocks", () => {
    const d = L.dropTerminals(doc(), new Set(["t1", "t2", "t4"])) as { spaces: { id: string; tabs: { id: string }[] }[] };
    expect(d.spaces.map((s) => [s.id, s.tabs.map((t) => t.id)])).toEqual([["spA", ["tbA2"]], ["spB", ["tbB1"]]]);
    expect(L.allTerminals(d as JsonValue)).toEqual(["t3"]);
    const e = L.dropTerminals(doc(), new Set(["t1", "t2", "t3"])) as { spaces: { id: string }[] };
    expect(e.spaces.map((s) => s.id)).toEqual(["spB"]);
    // a tab still showing a live pane only loses the removed one
    const m = L.dropTerminals(doc(), new Set(["t1"])) as JsonValue;
    expect(L.tabTerminals(m, "tbA1")).toEqual(["t2"]);
    expect(L.dropTerminals(doc(), new Set(["t9"]))).toBeNull();
    expect(L.dropTerminals(doc(), new Set())).toBeNull();
  });
});
