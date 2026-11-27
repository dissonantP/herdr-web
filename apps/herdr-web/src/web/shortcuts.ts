import { useEffect, useState, useSyncExternalStore } from "react";

// Keyboard shortcuts (task 074): the app's rebindable shortcuts, kept per browser in localStorage
// (keys depend on the device's keyboard and OS, so they aren't shared like the server settings).
// A binding is a string like "Mod+K" or "Ctrl+Shift+J". "Mod" is the defaults' modifier: Ctrl or Cmd,
// whichever is pressed; a binding the user records names the exact modifiers they pressed.

export type Action = "launcher" | "sidebar" | "tabPrev" | "tabNext" | "pinPrev" | "pinNext" | "pinIndex";

export interface ActionInfo {
  readonly id: Action;
  readonly label: string;
  readonly defaults: readonly string[];
}

export const ACTIONS: readonly ActionInfo[] = [
  { id: "launcher", label: "Open the quick launcher", defaults: ["Mod+K", "Mod+P"] },
  { id: "sidebar", label: "Show or hide the sidebar", defaults: ["Mod+B"] },
  { id: "tabPrev", label: "Previous tab in this space", defaults: ["Ctrl+["] },
  { id: "tabNext", label: "Next tab in this space", defaults: ["Ctrl+]"] },
  { id: "pinPrev", label: "Previous pinned space", defaults: ["Ctrl+Shift+["] },
  { id: "pinNext", label: "Next pinned space", defaults: ["Ctrl+Shift+]"] },
  // One binding stands for the digits 1-9: its own digit is only an example (see pinNumber).
  { id: "pinIndex", label: "Go to pinned space 1-9 (the digit key)", defaults: ["Ctrl+Shift+1"] },
];

/** The fixed keys, listed in Settings for completeness. */
export const FIXED: readonly { readonly keys: string; readonly label: string }[] = [
  { keys: "Enter", label: "Send a chat message" },
  { keys: "Shift+Enter", label: "New line in a chat message" },
  { keys: "Escape", label: "Close the launcher, a dialog or a menu" },
  { keys: "Up, Down, Enter", label: "Pick a launcher result" },
];

const KEY = "herdr.shortcuts";
const MODS = ["Mod", "Ctrl", "Alt", "Shift", "Meta"] as const;
type Mod = (typeof MODS)[number];

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

interface Parsed {
  readonly mods: ReadonlySet<Mod>;
  readonly key: string;
}

function parse(binding: string): Parsed {
  const parts = binding.split("+");
  // A trailing empty part means the key itself is "+" (e.g. "Ctrl++").
  const key = parts.at(-1) === "" && parts.length > 1 ? "+" : (parts.at(-1) ?? "");
  const mods = new Set(parts.slice(0, parts.at(-1) === "" ? -2 : -1).filter((p): p is Mod => (MODS as readonly string[]).includes(p)));
  return { mods, key };
}

/** The key's name as stored: letters upper-case, space as "Space". */
function keyName(e: Pick<KeyboardEvent, "key" | "code">): string {
  // A letter is the one typed (so Dvorak's K is K). Only when the key gives no ASCII letter (Option on a
  // Mac, a Cyrillic layout) is it read from the physical key; digits always are (AZERTY needs Shift for them).
  if (/^[a-z]$/iu.test(e.key)) return e.key.toUpperCase();
  const m = /^(?:Key([A-Z])|Digit(\d))$/u.exec(e.code);
  if (m !== null) return m[1] ?? m[2] ?? "";
  if (e.key === " ") return "Space";
  // Shift turns [ and ] into { and } on most layouts; the binding is the bracket key itself.
  if (e.key === "{" && e.code === "BracketLeft") return "[";
  if (e.key === "}" && e.code === "BracketRight") return "]";
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

type KeyEv = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/** The binding a key press names, or null for a lone modifier. */
export function fromEvent(e: KeyEv): string | null {
  if (["Control", "Alt", "Shift", "Meta", "OS", "AltGraph", "CapsLock", "Dead", "Unidentified"].includes(e.key)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Meta");
  return [...mods, keyName(e)].join("+");
}

/** Whether a key press is this binding. */
export function matches(binding: string, e: KeyEv): boolean {
  const b = parse(binding);
  if (keyName(e) !== b.key) return false;
  if (b.mods.has("Mod")) {
    if (e.ctrlKey === e.metaKey) return false; // exactly one of Ctrl and Cmd
  } else if (e.ctrlKey !== b.mods.has("Ctrl") || e.metaKey !== b.mods.has("Meta")) return false;
  return e.altKey === b.mods.has("Alt") && e.shiftKey === b.mods.has("Shift");
}

/** How a binding reads in a label or tooltip, e.g. "Ctrl+K" ("Cmd+K" on a Mac). */
export function display(binding: string): string {
  const { mods, key } = parse(binding);
  const names: Record<Mod, string> = { Mod: IS_MAC ? "Cmd" : "Ctrl", Ctrl: "Ctrl", Alt: IS_MAC ? "Option" : "Alt", Shift: "Shift", Meta: IS_MAC ? "Cmd" : "Meta" };
  return [...MODS.filter((m) => mods.has(m)).map((m) => names[m]), key === " " ? "Space" : key].join("+");
}

// The concrete modifier sets a binding can mean ("Mod" means two), so overlaps can be found.
function variants(binding: string, anyDigit: boolean): string[] {
  const { mods, key } = parse(binding);
  const rest = MODS.filter((m) => m !== "Mod" && mods.has(m));
  const sets = mods.has("Mod") ? [[...rest, "Ctrl"], [...rest, "Meta"]] : [rest];
  // Any digit stands for the pinned-space digits 1-9, so one digit's binding overlaps all of them.
  const k = anyDigit && /^[1-9]$/u.test(key) ? "#" : key;
  return sets.map((s) => [...MODS.filter((m) => s.includes(m)), k].join("+"));
}
function overlaps(a: string, b: string, anyDigit = false): boolean {
  const vb = variants(b, anyDigit);
  return variants(a, anyDigit).some((v) => vb.includes(v));
}

// Keys the browser or OS keeps for itself (a page never sees them), or that the app needs as they are.
const RESERVED = ["Ctrl+W", "Ctrl+T", "Ctrl+N", "Ctrl+Q", "Ctrl+Tab", "Ctrl+Shift+Tab", "Ctrl+Shift+N", "Ctrl+Shift+T", "Ctrl+Shift+W", "Meta+W", "Meta+T", "Meta+N", "Meta+Q", "Meta+Tab", "Meta+H", "Meta+M", "Meta+Shift+N", "Meta+Shift+T", "Meta+Shift+W", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+A", "Ctrl+Z", "Meta+C", "Meta+V", "Meta+X", "Meta+A", "Meta+Z", "Ctrl+L", "Ctrl+F4", "Alt+F4", "Ctrl+Shift+Q", "Meta+L", "Meta+Shift+Q", "Alt+ArrowLeft", "Alt+ArrowRight", "F11",
  // Tab switching: Ctrl+PageUp/PageDown, Ctrl/Cmd+1-9, and the Mac's Cmd+Shift+[ ] and Cmd+Option+arrows.
  "Ctrl+PageUp", "Ctrl+PageDown", "Ctrl+Shift+PageUp", "Ctrl+Shift+PageDown", "Meta+Shift+[", "Meta+Shift+]", "Meta+Shift+{", "Meta+Shift+}", "Meta+[", "Meta+]", "Meta+Alt+ArrowLeft", "Meta+Alt+ArrowRight",
  ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].flatMap((d) => [`Ctrl+${d}`, `Meta+${d}`, `Alt+${d}`])];

/** Why a new binding for an action is refused, or null when it is fine. */
export function refusal(action: Action, binding: string, current: Readonly<Record<Action, readonly string[]>>, replacing?: string): string | null {
  const { mods, key } = parse(binding);
  const fn = /^F([1-9]|1[0-2])$/u.test(key);
  if (action === "pinIndex" && !/^[1-9]$/u.test(key)) return `${display(binding)} can't be used here: this shortcut needs a digit key 1-9 (the other digits follow).`;
  if (!fn && !mods.has("Ctrl") && !mods.has("Meta") && !mods.has("Alt") && !mods.has("Mod")) return `${display(binding)} needs a modifier so it doesn't interfere with typing. Add Ctrl, ${IS_MAC ? "Cmd or Option" : "Alt or Meta"}, or use F1-F12.`;
  if (["Escape", "Enter", "Backspace", "Delete"].includes(key)) return `${display(binding)} can't be used: ${key} is reserved by the app.`;
  const reserved = RESERVED.find((r) => overlaps(binding, r, action === "pinIndex"));
  if (reserved !== undefined) return display(reserved) === display(binding) ? `${display(binding)} can't be used: the browser or system reserves it.` : `${display(binding)} can't be used: the browser or system reserves ${display(reserved)}.`;
  for (const a of ACTIONS) {
    for (const other of current[a.id]) {
      if (a.id === action && other === replacing) continue;
      if (overlaps(binding, other, action === "pinIndex" || a.id === "pinIndex")) return a.id === action ? `${display(binding)} is already set for this action.` : `${display(binding)} is already used for “${a.label}”.`;
    }
  }
  return null;
}

function defaults(): Record<Action, readonly string[]> {
  return Object.fromEntries(ACTIONS.map((a) => [a.id, a.defaults])) as Record<Action, readonly string[]>;
}

function load(): Record<Action, readonly string[]> {
  const out = defaults();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return out;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    for (const a of ACTIONS) {
      const v = saved[a.id];
      if (Array.isArray(v) && v.every((b) => typeof b === "string")) out[a.id] = v as string[];
    }
  } catch {
    // unreadable or unavailable storage: the defaults
  }
  return out;
}

let bindings = load();
const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY && e.key !== null) return;
    bindings = load();
    emit();
  });

function save(next: Record<Action, readonly string[]>): void {
  bindings = next;
  try {
    const changed = ACTIONS.filter((a) => next[a.id].join("\n") !== a.defaults.join("\n"));
    if (changed.length === 0) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(changed.map((a) => [a.id, next[a.id]]))));
  } catch {
    // storage unavailable: the change lasts until reload
  }
  emit();
}

export function useBindings(): Readonly<Record<Action, readonly string[]>> {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => bindings,
  );
}

/** Adds a binding to an action (or replaces one of its bindings): the refusal, or null when saved. */
export function setBinding(action: Action, binding: string, replacing?: string): string | null {
  const why = refusal(action, binding, bindings, replacing);
  if (why !== null) return why;
  const list = bindings[action];
  const next = replacing === undefined || !list.includes(replacing) ? [...list, binding] : list.map((b) => (b === replacing ? binding : b));
  save({ ...bindings, [action]: next });
  return null;
}

export function removeBinding(action: Action, binding: string): void {
  save({ ...bindings, [action]: bindings[action].filter((b) => b !== binding) });
}

export function resetBindings(): void {
  save(defaults());
}

export function isDefault(b: Readonly<Record<Action, readonly string[]>>): boolean {
  return ACTIONS.every((a) => b[a.id].join("\n") === a.defaults.join("\n"));
}

// While Settings is recording a new binding, the shortcuts don't fire, so the press is only recorded. The
// recorder's own stopPropagation isn't enough: the launcher's window capture listener is added first, so runs first.
let recording = false;
export function setRecording(on: boolean): void {
  recording = on;
}

/** Whether a key press is one of the action's shortcuts (never while recording). */
export function pressed(action: Action, e: KeyEv): boolean {
  return !recording && bindings[action].some((b) => matches(b, e));
}

/** The pinned space number (1-9) a key press asks for, from the pinIndex binding's modifiers and the digit key's code; else null. */
export function pinNumber(e: KeyEv): number | null {
  if (recording) return null;
  const m = /^Digit([1-9])$/u.exec(e.code);
  if (m === null) return null;
  const n = Number(m[1]);
  return pinIndexMatches(e, n) ? n : null;
}

/** Whether the event's modifiers (and, for a key, the digit n) are one of the pinIndex bindings, with the digit swapped for n. */
function pinIndexMatches(e: KeyEv, n: number): boolean {
  const ev = { key: String(n), code: `Digit${String(n)}`, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey };
  return bindings.pinIndex.some((b) => matches(b.slice(0, b.lastIndexOf("+") + 1) + String(n), ev));
}

/** True while the pinIndex binding's modifiers are all held (the dock then shows each pin's number). */
export function useIndexBadges(): boolean {
  const [held, setHeld] = useState(false);
  const list = useBindings().pinIndex; // re-subscribes when the binding changes
  useEffect(() => {
    const update = (e: KeyboardEvent) => {
      // A lone modifier press has no digit; matches() is checked against the same modifiers with a digit.
      setHeld(pinIndexMatches(e, 1) && !recording);
    };
    const off = () => setHeld(false);
    window.addEventListener("keydown", update, true);
    window.addEventListener("keyup", update, true);
    window.addEventListener("blur", off);
    document.addEventListener("visibilitychange", off);
    return () => {
      window.removeEventListener("keydown", update, true);
      window.removeEventListener("keyup", update, true);
      window.removeEventListener("blur", off);
      document.removeEventListener("visibilitychange", off);
    };
  }, [list]);
  return held;
}

/** The action's shortcuts as a tooltip reads them, e.g. "Ctrl+K or Ctrl+P"; "" with none. */
export function hint(list: readonly string[]): string {
  return list.map(display).join(" or ");
}
