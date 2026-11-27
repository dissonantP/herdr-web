import { useSyncExternalStore } from "react";
import type { ActionResult, AdminAction, Tree, TreeMessage } from "../shared/model.ts";
import { predict } from "./predict.ts";

// Client state apart from server state (task 142). The screen draws the server's last tree with the
// user's own changes laid over it, so a change shows at once and never waits on a round trip. A change
// stays laid over until the server's tree has it (or the server answers and a newer tree arrives); a
// refused change is taken back and says why. Every write in flight is counted, so a slow server shows
// as "Syncing" instead of a frozen screen, and a dropped stream or failing core as out of date.

/** A write that takes longer than this shows the syncing indicator; quicker ones never flicker it. */
export const SLOW_MS = 400;

interface Overlay {
  readonly apply: (tree: Tree) => Tree;
  /** The server has answered yes; the overlay goes with the next tree. */
  answered: boolean;
}

export type Health = "live" | "stale" | "offline";

export interface SyncView {
  /** The tree as the screen shows it: the server's, plus changes still on their way. `null` until the first tree. */
  readonly tree: Tree | null;
  /** Why there is no tree yet, when the first message was an error. */
  readonly error: string | null;
  /** live: the stream is up and the last tree read fine; stale: the core failed its last read; offline: the stream is down. */
  readonly health: Health;
  /** A write has been waiting longer than SLOW_MS. */
  readonly slow: boolean;
  /** The last refused change, for the error toast; cleared when dismissed. */
  readonly failure: string | null;
}

let server: Tree | null = null;
let firstError: string | null = null;
let health: Health = "live";
let overlays: Overlay[] = [];
let inFlight = new Map<number, number>(); // write id -> when it started
let nextId = 0;
let slow = false;
let slowTimer: ReturnType<typeof setTimeout> | undefined;
let failure: string | null = null;
let view: SyncView = { tree: null, error: null, health, slow, failure };
const listeners = new Set<() => void>();

function publish(): void {
  const tree = server === null ? null : overlays.reduce((t, o) => o.apply(t), server);
  view = { tree, error: server === null ? firstError : null, health, slow, failure };
  for (const listener of listeners) listener();
}

function checkSlow(): void {
  clearTimeout(slowTimer);
  const oldest = Math.min(...inFlight.values());
  const wait = oldest + SLOW_MS - Date.now();
  const now = inFlight.size > 0 && wait <= 0;
  if (inFlight.size > 0 && wait > 0) slowTimer = setTimeout(checkSlow, wait);
  if (now !== slow) {
    slow = now;
    publish();
  }
}

/** Count `work` as a write in flight while it runs, for the syncing indicator. */
export function track<T>(work: Promise<T>): Promise<T> {
  const id = nextId++;
  inFlight.set(id, Date.now());
  checkSlow();
  return work.finally(() => {
    inFlight.delete(id);
    checkSlow();
  });
}

/** Show why a change was refused (it has already been taken back). */
export function fail(message: string): void {
  failure = message;
  publish();
}

export function dismissFailure(): void {
  failure = null;
  publish();
}

/** A message from the tree stream. An error after a good tree keeps that tree on screen, marked out of date. */
export function receive(message: TreeMessage): void {
  if (message.ok) {
    server = message.tree;
    health = "live";
    // Overlays the server has answered are in this tree now.
    overlays = overlays.filter((o) => !o.answered);
  } else {
    if (server === null) firstError = message.error;
    health = "stale";
  }
  publish();
}

let dropTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * The stream dropped (`false`) or reconnected (`true`; its first message says whether the core is fine). A drop
 * shows only if the stream is still down after SLOW_MS, so the server's routine stream rotation never flickers it.
 */
export function streamLive(live: boolean): void {
  clearTimeout(dropTimer);
  if (!live) {
    dropTimer = setTimeout(() => {
      health = "offline";
      publish();
    }, SLOW_MS);
    return;
  }
  if (health !== "offline") return;
  health = "live";
  publish();
}

/**
 * Make a change: shown at once where it can be predicted (`predicted`), then sent. `done` is the server's answer;
 * a refused prediction is taken back and reported (`what`: e.g. "Couldn't rename"). A `quiet` change (a background
 * mark the user didn't make) neither shows as syncing nor reports a refusal.
 */
export function change(action: AdminAction, send: (action: AdminAction) => Promise<ActionResult>, what: string, opts: { quiet?: boolean } = {}): { predicted: boolean; done: Promise<ActionResult> } {
  const overlay: Overlay | null = server !== null && predict(server, action) !== null ? { apply: (t) => predict(t, action) ?? t, answered: false } : null;
  if (overlay !== null) {
    overlays = [...overlays, overlay];
    publish();
  }
  const sent = opts.quiet === true ? send(action) : track(send(action));
  const done = sent.then((result) => {
    if (overlay === null) return result;
    if (result.ok) {
      overlay.answered = true;
      // The server reads its tree before answering, so the stream has normally brought the change already.
      if (server !== null && JSON.stringify(overlay.apply(server)) === JSON.stringify(server)) overlays = overlays.filter((o) => o !== overlay);
      else void settle(overlay);
    } else {
      overlays = overlays.filter((o) => o !== overlay);
      if (opts.quiet === true) console.error(`${action.type}: ${result.error}`);
      else failure = `${what}: ${result.error}`;
    }
    publish();
    return result;
  });
  return { predicted: overlay !== null, done };
}

/**
 * An answered overlay whose change the shown tree does not have: the answer overtook the stream, or the server did
 * something other than predicted. Either way the server's tree now has the outcome, so read it once and drop the overlay.
 */
async function settle(overlay: Overlay): Promise<void> {
  const message = await fetch("/api/tree", { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<TreeMessage>) : null))
    .catch(() => null);
  if (!overlays.includes(overlay)) return; // a stream message has settled it
  if (message?.ok === true) server = message.tree;
  overlays = overlays.filter((o) => o !== overlay);
  publish();
}

/**
 * For a store of server state that also takes local changes (pins, settings, mute): whether an answer from the server
 * may replace what is shown. Not while any local change is in flight, nor if one was made since a read started, since
 * the answer may predate it (task 142).
 */
export function freshness(): { change: () => () => boolean; read: () => () => boolean } {
  let made = 0;
  let pending = 0;
  return {
    change: () => {
      const mine = ++made;
      pending++;
      return () => --pending === 0 && mine === made;
    },
    read: () => {
      const seen = made;
      return () => pending === 0 && seen === made;
    },
  };
}

export const syncView = (): SyncView => view;

export function useSync(): SyncView {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    syncView,
  );
}

/** For tests: back to the state before the first tree. */
export function resetSync(): void {
  server = null;
  firstError = null;
  health = "live";
  overlays = [];
  inFlight = new Map();
  slow = false;
  failure = null;
  clearTimeout(slowTimer);
  clearTimeout(dropTimer);
  publish();
}
