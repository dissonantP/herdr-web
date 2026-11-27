import { describe, expect, it } from "vitest";
import { clampZoom, wheelZoom, ZOOM_MAX, ZOOM_MIN } from "./chat-zoom.ts";

describe("chat zoom", () => {
  it("clamps to the limits", () => {
    expect(clampZoom(1.2)).toBe(1.2);
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
  });
  it("wheel up (negative delta) zooms in, down zooms out", () => {
    expect(wheelZoom(1, -50)).toBeGreaterThan(1);
    expect(wheelZoom(1, 50)).toBeLessThan(1);
    expect(wheelZoom(ZOOM_MAX, -500)).toBe(ZOOM_MAX);
  });
});
