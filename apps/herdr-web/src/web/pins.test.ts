import { describe, expect, it } from "vitest";
import { insertIndex, movePin } from "./pins.ts";

describe("pin dragging", () => {
  it("counts the other pins whose centre is left of the pointer", () => {
    expect(insertIndex([50, 150, 250], 10)).toBe(0);
    expect(insertIndex([50, 150, 250], 160)).toBe(2);
    expect(insertIndex([50, 150, 250], 999)).toBe(3);
    expect(insertIndex([], 5)).toBe(0);
  });

  it("moves a pin so that the given number of others come before it", () => {
    expect(movePin(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(movePin(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(movePin(["a", "b", "c"], "b", 1)).toEqual(["a", "b", "c"]);
    expect(movePin(["a", "b", "c"], "b", 99)).toEqual(["a", "c", "b"]);
    expect(movePin(["a", "b"], "zzz", 0)).toEqual(["a", "b"]);
  });
});
