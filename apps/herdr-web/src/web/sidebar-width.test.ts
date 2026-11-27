import { describe, expect, it } from "vitest";
import { clampWidth, SIDEBAR_MAX, SIDEBAR_MIN } from "./sidebar-width.ts";

describe("clampWidth", () => {
  it("keeps values inside the limits", () => {
    expect(clampWidth(350)).toBe(350);
    expect(clampWidth(10)).toBe(SIDEBAR_MIN);
    expect(clampWidth(5000)).toBe(SIDEBAR_MAX);
  });
  it("leaves room for the main area on narrow viewports", () => {
    expect(clampWidth(600, 900)).toBe(580);
    expect(clampWidth(600, 400)).toBe(SIDEBAR_MIN);
  });
});
