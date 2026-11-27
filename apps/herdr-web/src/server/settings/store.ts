import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// herdr's settings page (F51), stored on the server in one small JSON file. herdr's own auto-sleep
// (sleep/auto-sleep.ts) reads it each round; an external `sessions.py sleep --idle` (beside hc-sleep) may read
// the same shape, so the file stays a contract with it:
//
//   ~/.local/state/herdr/settings.json   (HERDR_SETTINGS_FILE)
//   {
//     "version": 1,
//     "autosleep": {
//       "enabled": true,           // false: auto-sleep puts nothing to sleep
//       "idle": "3h",              // a number and m, h or d: sleep sessions idle longer than this
//       "every": "30m",            // same format: how often herdr's auto-sleep checks (default 30m)
//       "neverSleep": ["my space"] // space names whose sessions never auto-sleep
//     },
//     "inbox": false               // the "needs you" inbox view (F41)
//   }
//
// The global push pause is not here: it stays in push.json (push/store.ts) and the page shows it.

export function settingsPath(env: NodeJS.ProcessEnv, home = homedir()): string {
  return env.HERDR_SETTINGS_FILE ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "herdr", "settings.json");
}

export interface Settings {
  readonly autosleep: { readonly enabled: boolean; readonly idle: string; readonly every: string; readonly neverSleep: readonly string[] };
  readonly inbox: boolean;
}

export const DEFAULT_IDLE = "3h";
export const DEFAULT_EVERY = "30m";
const IDLE = /^(\d{1,4})([mhd])$/u;
const MAX_NEVER = 200;
const MAX_NAME = 120;

/** A valid idle threshold (`90m`, `3h`, `1d`; at least a minute), or `null`. */
export function parseIdle(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const m = IDLE.exec(text.trim());
  if (m === null || Number(m[1]) < 1) return null;
  return `${String(Number(m[1]))}${m[2] ?? ""}`;
}

/** An idle threshold in milliseconds, or `null` when it isn't one. */
export function idleMs(text: string): number | null {
  const valid = parseIdle(text);
  if (valid === null) return null;
  const n = Number(valid.slice(0, -1));
  return n * { m: 60_000, h: 3_600_000, d: 86_400_000 }[valid.slice(-1) as "m" | "h" | "d"];
}

/** Spaces are matched the way sessions.py does: ignoring case, spaces, dashes and underscores. */
const norm = (name: string): string => name.toLowerCase().replace(/[\s_-]+/gu, "");

export class SettingsStore {
  private readonly path: string;
  private data: Settings = { autosleep: { enabled: true, idle: DEFAULT_IDLE, every: DEFAULT_EVERY, neverSleep: [] }, inbox: false };

  constructor(path: string) {
    this.path = path;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { autosleep?: Record<string, unknown>; inbox?: unknown };
      const a = raw.autosleep ?? {};
      this.data = {
        autosleep: {
          enabled: a.enabled !== false,
          idle: parseIdle(a.idle) ?? DEFAULT_IDLE,
          every: parseIdle(a.every) ?? DEFAULT_EVERY,
          neverSleep: Array.isArray(a.neverSleep) ? a.neverSleep.filter((n): n is string => typeof n === "string" && n !== "").slice(0, MAX_NEVER) : [],
        },
        inbox: raw.inbox === true,
      };
    } catch {
      // first run, or unreadable: defaults (and the file is written on the first change)
    }
  }

  get(): Settings {
    return this.data;
  }

  /** Make the file exist with what is in force, so the job reads the same defaults the page shows. */
  ensureFile(): void {
    try {
      readFileSync(this.path);
    } catch {
      try {
        this.save();
      } catch (err) {
        console.error("settings: can't write", this.path, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, ...this.data }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  private set(next: Settings): void {
    this.data = next;
    this.save();
  }

  setAutosleepEnabled(enabled: boolean): void {
    this.set({ ...this.data, autosleep: { ...this.data.autosleep, enabled } });
  }

  /** `false` for an invalid threshold. */
  setIdle(text: unknown): boolean {
    const idle = parseIdle(text);
    if (idle === null) return false;
    this.set({ ...this.data, autosleep: { ...this.data.autosleep, idle } });
    return true;
  }

  /** `false` for an invalid interval. */
  setEvery(text: unknown): boolean {
    const every = parseIdle(text);
    if (every === null) return false;
    this.set({ ...this.data, autosleep: { ...this.data.autosleep, every } });
    return true;
  }

  setInbox(inbox: boolean): void {
    this.set({ ...this.data, inbox });
  }

  /** `false` when the name is not usable or the list is full. */
  setNeverSleep(space: string, never: boolean): boolean {
    const name = space.trim();
    if (name === "" || name.length > MAX_NAME) return false;
    const others = this.data.autosleep.neverSleep.filter((n) => norm(n) !== norm(name));
    if (never && others.length >= MAX_NEVER) return false;
    this.set({ ...this.data, autosleep: { ...this.data.autosleep, neverSleep: never ? [...others, name] : others } });
    return true;
  }

  /** A space was renamed here: its exemption follows it. */
  spaceRenamed(from: string, to: string): void {
    if (!this.data.autosleep.neverSleep.some((n) => norm(n) === norm(from))) return;
    const rest = this.data.autosleep.neverSleep.filter((n) => norm(n) !== norm(from));
    this.set({ ...this.data, autosleep: { ...this.data.autosleep, neverSleep: to.trim() === "" ? rest : [...rest, to.trim()] } });
  }
}
