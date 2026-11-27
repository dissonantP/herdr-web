import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The pin bar's list (F40): the space ids pinned, in order, kept on the server so every device shows the
// same bar. Which pin is active is just the open route, so it is per device and not stored here.
//
//   ~/.local/state/herdr/pins.json   (HERDR_PINS_FILE)
//   { "version": 1, "pins": ["<space id>", ...] }

export function pinsPath(env: NodeJS.ProcessEnv, home = homedir()): string {
  return env.HERDR_PINS_FILE ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "herdr", "pins.json");
}

export const MAX_PINS = 100;
const MAX_ID = 200;

export class PinsStore {
  private readonly path: string;
  private pins: string[] = [];

  constructor(path: string) {
    this.path = path;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { pins?: unknown };
      if (Array.isArray(raw.pins)) this.pins = dedupe(raw.pins.filter((p): p is string => typeof p === "string" && p !== "" && p.length <= MAX_ID)).slice(0, MAX_PINS);
    } catch {
      // first run, or unreadable: no pins
    }
  }

  get(): readonly string[] {
    return this.pins;
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, pins: this.pins }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  /** Append at the end (a no-op when already pinned). The oldest pin drops when the bar is full. */
  pin(id: string): boolean {
    if (id === "" || id.length > MAX_ID) return false;
    if (this.pins.includes(id)) return true;
    this.pins = [...this.pins, id].slice(-MAX_PINS);
    this.save();
    return true;
  }

  unpin(id: string): void {
    if (!this.pins.includes(id)) return;
    this.pins = this.pins.filter((p) => p !== id);
    this.save();
  }

  /**
   * A new order. It must hold the same ids as now, except that ids pinned by another device meanwhile
   * may be missing (they keep their place at the end) and ids unpinned meanwhile are ignored.
   */
  reorder(order: readonly string[]): boolean {
    if (order.length > MAX_PINS * 2 || order.some((p) => typeof p !== "string")) return false;
    const known = new Set(this.pins);
    const kept = dedupe(order.filter((p) => known.has(p)));
    const rest = this.pins.filter((p) => !kept.includes(p));
    this.pins = [...kept, ...rest];
    this.save();
    return true;
  }
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}
