import { describe, expect, it } from "vitest";
import { display, fromEvent, matches, pinNumber, refusal, type Action } from "./shortcuts.ts";

const ev = (key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}, code?: string) => ({
  key,
  code: code ?? (/^[a-z]$/iu.test(key) ? `Key${key.toUpperCase()}` : ""),
  ctrlKey: mods.ctrl === true,
  altKey: mods.alt === true,
  shiftKey: mods.shift === true,
  metaKey: mods.meta === true,
});
const defaults: Record<Action, readonly string[]> = {
  launcher: ["Mod+K", "Mod+P"],
  sidebar: ["Mod+B"],
  tabPrev: ["Ctrl+["],
  tabNext: ["Ctrl+]"],
  pinPrev: ["Ctrl+Shift+["],
  pinNext: ["Ctrl+Shift+]"],
  pinIndex: ["Ctrl+Shift+1"],
};

describe("matches", () => {
  it("Mod is Ctrl or Cmd, but not both", () => {
    expect(matches("Mod+K", ev("k", { ctrl: true }))).toBe(true);
    expect(matches("Mod+K", ev("k", { meta: true }))).toBe(true);
    expect(matches("Mod+K", ev("k", { ctrl: true, meta: true }))).toBe(false);
    expect(matches("Mod+K", ev("k"))).toBe(false);
    expect(matches("Mod+K", ev("K", { ctrl: true, shift: true }))).toBe(false);
  });
  it("exact modifiers, letters from the physical key", () => {
    expect(matches("Ctrl+Alt+J", ev("∆", { ctrl: true, alt: true }, "KeyJ"))).toBe(true);
    expect(matches("Ctrl+Alt+J", ev("j", { meta: true, alt: true }))).toBe(false);
    expect(matches("F2", ev("F2"))).toBe(true);
  });
  it("follows the typed letter on other layouts (Dvorak's K sits on QWERTY's V)", () => {
    expect(matches("Mod+K", ev("k", { ctrl: true }, "KeyV"))).toBe(true);
    expect(matches("Mod+K", ev("v", { ctrl: true }, "KeyK"))).toBe(false);
  });
});

describe("fromEvent and display", () => {
  it("records the pressed modifiers and key", () => {
    expect(fromEvent(ev("J", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+J");
    expect(fromEvent(ev("Control", { ctrl: true }))).toBeNull();
    expect(fromEvent(ev("!", { ctrl: true, shift: true }, "Digit1"))).toBe("Ctrl+Shift+1");
  });
  it("reads Mod as Ctrl off a Mac", () => {
    expect(display("Mod+K")).toBe("Ctrl+K");
    expect(display("Ctrl+Shift+J")).toBe("Ctrl+Shift+J");
  });
});

describe("refusal", () => {
  it("accepts a free binding", () => {
    expect(refusal("sidebar", "Ctrl+Shift+J", defaults)).toBeNull();
    expect(refusal("sidebar", "F2", defaults)).toBeNull();
  });
  it("refuses a binding another action has, including through Mod", () => {
    expect(refusal("sidebar", "Ctrl+K", defaults)).toMatch(/already used for “Open the quick launcher”/u);
    expect(refusal("sidebar", "Meta+P", defaults)).toMatch(/already used/u);
    expect(refusal("launcher", "Mod+P", defaults)).toMatch(/already set for this action/u);
  });
  it("lets a binding be replaced by itself", () => {
    expect(refusal("launcher", "Mod+P", defaults, "Mod+P")).toBeNull();
  });
  it("refuses keys that get in the way of typing or that the browser keeps", () => {
    expect(refusal("sidebar", "J", defaults)).toMatch(/typing/u);
    expect(refusal("sidebar", "Shift+J", defaults)).toMatch(/typing/u);
    expect(refusal("sidebar", "Ctrl+W", defaults)).toMatch(/browser or system/u);
    expect(refusal("sidebar", "Mod+C", defaults)).toMatch(/browser or system/u);
    for (const b of ["Ctrl+PageDown", "Ctrl+PageUp", "Shift+Meta+}", "Alt+Meta+ArrowRight", "Ctrl+3", "Meta+9"]) expect(refusal("sidebar", b, defaults)).toMatch(/browser or system/u);
    expect(refusal("sidebar", "Ctrl+Escape", defaults)).toMatch(/Escape is reserved by the app/u);
  });
});

describe("tab and pin shortcuts (task 97)", () => {
  it("Shift turns [ into { but the binding stays the bracket key", () => {
    expect(fromEvent(ev("{", { ctrl: true, shift: true }, "BracketLeft"))).toBe("Ctrl+Shift+[");
    expect(matches("Ctrl+Shift+]", ev("}", { ctrl: true, shift: true }, "BracketRight"))).toBe(true);
    expect(matches("Ctrl+]", ev("]", { ctrl: true }, "BracketRight"))).toBe(true);
    expect(matches("Ctrl+]", ev("}", { ctrl: true, shift: true }, "BracketRight"))).toBe(false);
  });
  it("the pin digit comes from the key code, whatever Shift types", () => {
    expect(pinNumber(ev("!", { ctrl: true, shift: true }, "Digit1"))).toBe(1);
    expect(pinNumber(ev("(", { ctrl: true, shift: true }, "Digit9"))).toBe(9);
    expect(pinNumber(ev("0", { ctrl: true, shift: true }, "Digit0"))).toBeNull();
    expect(pinNumber(ev("1", { ctrl: true }, "Digit1"))).toBeNull();
    expect(pinNumber(ev("K", { ctrl: true, shift: true }, "KeyK"))).toBeNull();
  });
  it("the pin number binding needs a digit and overlaps every digit", () => {
    expect(refusal("pinIndex", "Ctrl+Shift+K", defaults)).toMatch(/digit/u);
    expect(refusal("sidebar", "Ctrl+Shift+5", defaults)).toMatch(/already used/u);
    // Other actions' digits stay independent.
    expect(refusal("sidebar", "Ctrl+Alt+2", { ...defaults, launcher: ["Ctrl+Alt+1"] })).toBeNull();
    expect(refusal("pinIndex", "Alt+Shift+1", defaults, "Ctrl+Shift+1")).toBeNull();
  });
});
