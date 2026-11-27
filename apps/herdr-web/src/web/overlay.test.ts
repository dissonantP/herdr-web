import { describe, expect, it } from "vitest";
import { placeBox } from "./overlay.tsx";

const view = { w: 400, h: 800 };
const size = { w: 200, h: 300 };

describe("placeBox", () => {
  it("starts at the anchor when it fits", () => {
    expect(placeBox({ x: 50, y: 60 }, size, view)).toEqual({ x: 50, y: 60 });
  });
  it("flips left and up near the right and bottom edges", () => {
    expect(placeBox({ x: 380, y: 780 }, size, view)).toEqual({ x: 180, y: 480 });
  });
  it("clamps when it fits on neither side", () => {
    expect(placeBox({ x: 100, y: 100 }, { w: 200, h: 780 }, view)).toEqual({ x: 100, y: 8 });
    expect(placeBox({ x: 5, y: 5 }, { w: 390, h: 300 }, view)).toEqual({ x: 8, y: 8 });
  });
});
