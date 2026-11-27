import { describe, expect, it } from "vitest";
import { parseRoute, routePath } from "./router.ts";

describe("routes", () => {
  it("round-trips", () => {
    for (const route of [
      { space: null, tab: null, pane: null },
      { space: "sp1", tab: null, pane: null },
      { space: "sp1", tab: "tb 2", pane: "t7" },
    ]) {
      expect(parseRoute(routePath(route))).toEqual(route);
    }
  });
  it("treats unknown paths as home", () => {
    expect(parseRoute("/nope")).toEqual({ space: null, tab: null, pane: null });
  });
});

describe("settings route", () => {
  it("is /settings and round-trips", () => {
    expect(parseRoute("/settings")).toEqual({ space: null, tab: null, pane: null, settings: true });
    expect(routePath({ space: null, tab: null, pane: null, settings: true })).toBe("/settings");
  });
});
