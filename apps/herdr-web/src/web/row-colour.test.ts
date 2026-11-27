import { describe, expect, it } from "vitest";
import { ANSI, resolveColour, rowStyle } from "./row-colour.ts";

describe("resolveColour", () => {
  it("is none with no colour anywhere", () => expect(resolveColour(null, null)).toBeNull());
  it("maps ansi names to the Desktop palette", () => {
    expect(resolveColour("ansi4", null)).toEqual({ hue: ANSI.ansi4, inverted: false });
    for (const n of ["ansi1", "ansi2", "ansi3", "ansi4", "ansi5", "ansi6"]) expect(resolveColour(n, null)?.hue).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("accepts #rrggbb", () => expect(resolveColour("#d9b54a", null)).toEqual({ hue: "#d9b54a", inverted: false }));
  it("inherits the group's colour when the space has none", () => expect(resolveColour(null, "ansi2")).toEqual({ hue: ANSI.ansi2, inverted: false }));
  it("own colour beats the group's", () => expect(resolveColour("ansi1", "ansi2")?.hue).toBe(ANSI.ansi1));
  it("dim means no colour, even in a coloured group", () => {
    expect(resolveColour("dim", "ansi2")).toBeNull();
    expect(resolveColour(null, "dim")).toBeNull();
  });
  it("inv: fills the row", () => {
    expect(resolveColour("inv:ansi4", null)).toEqual({ hue: ANSI.ansi4, inverted: true });
    expect(resolveColour(null, "inv:#112233")).toEqual({ hue: "#112233", inverted: true });
    expect(resolveColour("inv:dim", "ansi1")).toBeNull();
  });
  it("ignores junk", () => expect(resolveColour("purple", "ansi1")).toBeNull());
  it("styles only coloured rows", () => {
    expect(rowStyle(null)).toEqual({});
    expect(rowStyle({ hue: "#112233", inverted: false })).toEqual({ "--row-hue": "#112233" });
  });
});
