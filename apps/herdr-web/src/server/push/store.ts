import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PushSubscription } from "./webpush.ts";

// herdr's own push state, kept on the server (F20): the browsers' push subscriptions, the spaces
// muted, and the global pause. A 0600 JSON file next to the login sessions, written atomically.
// Quiet spaces are not here: they live in the herdr-core doc `herdr-tree` (SPEC).

export function pushStatePath(env: NodeJS.ProcessEnv, home = homedir()): string {
  return env.HERDR_PUSH_FILE ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "herdr", "push.json");
}

interface Saved {
  subscriptions: PushSubscription[];
  muted: string[];
  paused: boolean;
}

const MAX_SUBSCRIPTIONS = 20;

export class PushStore {
  private readonly path: string;
  private data: Saved = { subscriptions: [], muted: [], paused: false };

  constructor(path: string) {
    this.path = path;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Saved>;
      this.data = {
        subscriptions: (raw.subscriptions ?? []).filter((s) => typeof s.endpoint === "string" && typeof s.p256dh === "string" && typeof s.auth === "string"),
        muted: (raw.muted ?? []).filter((id) => typeof id === "string"),
        paused: raw.paused === true,
      };
    } catch {
      // first run, or unreadable: start empty
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  subscriptions(): readonly PushSubscription[] {
    return this.data.subscriptions;
  }

  /** Add or replace (by endpoint). `false` when the store is full. */
  addSubscription(sub: PushSubscription): boolean {
    const others = this.data.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
    if (others.length >= MAX_SUBSCRIPTIONS) return false;
    this.data.subscriptions = [...others, { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }];
    this.save();
    return true;
  }

  removeSubscription(endpoint: string): void {
    const next = this.data.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (next.length === this.data.subscriptions.length) return;
    this.data.subscriptions = next;
    this.save();
  }

  hasSubscription(endpoint: string): boolean {
    return this.data.subscriptions.some((s) => s.endpoint === endpoint);
  }

  paused(): boolean {
    return this.data.paused;
  }

  setPaused(paused: boolean): void {
    this.data.paused = paused;
    this.save();
  }

  muted(): ReadonlySet<string> {
    return new Set(this.data.muted);
  }

  setMuted(spaceId: string, muted: boolean): void {
    const set = new Set(this.data.muted);
    if (muted) set.add(spaceId);
    else set.delete(spaceId);
    this.data.muted = [...set];
    this.save();
  }
}
