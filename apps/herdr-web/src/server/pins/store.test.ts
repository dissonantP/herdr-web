import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PINS, PinsStore, pinsPath } from "./store.ts";

let dir = "";
let file = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-pins-"));
  file = join(dir, "pins.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("PinsStore", () => {
  it("starts empty and appends pins at the end, once each", () => {
    const s = new PinsStore(file);
    expect(s.get()).toEqual([]);
    s.pin("a");
    s.pin("b");
    s.pin("a");
    expect(s.get()).toEqual(["a", "b"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, pins: ["a", "b"] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new PinsStore(file).get()).toEqual(["a", "b"]);
  });

  it("unpins and ignores unknown ids", () => {
    const s = new PinsStore(file);
    s.pin("a");
    s.pin("b");
    s.unpin("a");
    s.unpin("zzz");
    expect(s.get()).toEqual(["b"]);
  });

  it("reorders; ids another device pinned meanwhile keep their place at the end, unknown ids are dropped", () => {
    const s = new PinsStore(file);
    for (const id of ["a", "b", "c"]) s.pin(id);
    expect(s.reorder(["c", "a", "b"])).toBe(true);
    expect(s.get()).toEqual(["c", "a", "b"]);
    s.reorder(["b", "ghost", "b"]);
    expect(s.get()).toEqual(["b", "c", "a"]);
  });

  it("refuses unusable ids and caps the list", () => {
    const s = new PinsStore(file);
    expect(s.pin("")).toBe(false);
    expect(s.pin("x".repeat(500))).toBe(false);
    for (let i = 0; i < MAX_PINS + 5; i++) s.pin(`s${String(i)}`);
    expect(s.get()).toHaveLength(MAX_PINS);
    expect(s.get()[MAX_PINS - 1]).toBe(`s${String(MAX_PINS + 4)}`);
  });

  it("survives a bad file", () => {
    writeFileSync(file, "not json");
    expect(new PinsStore(file).get()).toEqual([]);
    writeFileSync(file, JSON.stringify({ pins: ["a", 3, "a", ""] }));
    expect(new PinsStore(file).get()).toEqual(["a"]);
  });

  it("finds its file from the env", () => {
    expect(pinsPath({ HERDR_PINS_FILE: "/x/pins.json" }, "/home/u")).toBe("/x/pins.json");
    expect(pinsPath({ XDG_STATE_HOME: "/state" }, "/home/u")).toBe("/state/herdr/pins.json");
    expect(pinsPath({}, "/home/u")).toBe("/home/u/.local/state/herdr/pins.json");
  });
});
