import type { PaneStatus, Tree, TreeMessage } from "../../shared/model.ts";
import { allSpaces } from "../../shared/tree-walk.ts";
import type { BackendNotes } from "@herdr/server/adapters/backend.ts";
import { Presence } from "./presence.ts";
import { PushStore } from "./store.ts";
import type { VapidResult } from "./vapid.ts";
import { endpointAllowed, sendPush, type PushSubscription, type SendResult } from "./webpush.ts";

// Web push (F19-F21): watches the tree for the moments worth a buzz and sends them to every
// subscribed browser.
//
//   needs-input  an agent pane goes to `waiting`
//   finished     an agent pane goes from `working` to `idle` and stays there a moment (a turn ended)
//   died         an agent pane ends or its agent is gone (not when this app closed it)
//   note         an agent set `herdr.notify=<text>` on its own terminal: sent on purpose, label cleared
//
// Nothing is sent while paused, for a muted space, for a quiet space (marked in `herdr-tree`, or
// by a terminal in it carrying `herdr.quiet=1`, which is recorded there), or for a pane a visible
// page has open. Statuses come from herdr-core through the tree service (its events, plus the
// screen scan for menus), so no Claude hook is involved.

/** An idle that follows `working` must hold this long before it counts as a finished turn (flicker between steps does not). */
const FINISH_SETTLE_MS = 1500;
/** How often agent labels are re-read besides on every core event. */
const FACTS_POLL_MS = 5000;
const FACTS_FRESH_MS = 1000;
/** A note sent but whose label could not be cleared is not sent again for this long. */
const NOTE_QUIET_MS = 60_000;
const NOTE_MAX_CHARS = 300;
/** How long after a change made here its sessions' ending still counts as that change. */
const ACTION_GRACE_MS = 3000;

export type PushKind = "needs-input" | "finished" | "died" | "note";

export interface PushPayload {
  readonly kind: PushKind;
  readonly title: string;
  readonly body: string;
  /** Where tapping it goes: the session (`/s/<space>/<tab>/<pane>`) or, for a note, its space. */
  readonly url: string;
  /** Same tag replaces the earlier notification on the device. */
  readonly tag: string;
}

interface PaneInfo {
  readonly id: string;
  readonly name: string;
  readonly agent: string | null;
  readonly status: PaneStatus | null;
  readonly asleep: boolean;
  readonly spaceId: string;
  readonly spaceName: string;
  readonly tabId: string;
}

function indexTree(tree: Tree): Map<string, PaneInfo> {
  const panes = new Map<string, PaneInfo>();
  for (const s of allSpaces(tree)) {
    for (const t of s.tabs) for (const p of t.panes) panes.set(p.id, { id: p.id, name: p.name, agent: p.agent, status: p.status, asleep: p.asleep, spaceId: s.id, spaceName: s.name, tabId: t.id });
  }
  return panes;
}

const clean = (text: string, max: number): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, max);

export interface TreeFeed {
  subscribe(listener: (message: TreeMessage) => void): () => void;
  get(): Promise<TreeMessage>;
}

export interface PushOptions {
  readonly tree: TreeFeed;
  readonly backend: BackendNotes & { watch(onChange: () => void): () => void };
  readonly store: PushStore;
  readonly vapid: VapidResult;
  readonly presence: Presence;
  /** The VAPID `sub` claim: a contact URL for the push services. */
  readonly subject: string;
  /** Tests only: allow http endpoints on loopback. */
  readonly allowInsecure?: boolean;
  /** Replaces the real sender (unit tests). */
  readonly send?: (sub: PushSubscription, payload: PushPayload) => Promise<SendResult>;
  readonly finishSettleMs?: number;
}

export class PushService {
  private readonly o: PushOptions;
  private panes: Map<string, PaneInfo> | null = null;
  private lastOk = false;
  private quiet = new Set<string>();
  private factsAt = 0;
  private factsRead: Promise<void> | null = null;
  private finishing = new Map<string, ReturnType<typeof setTimeout>>();
  private recentNotes = new Map<string, number>();
  /** Panes a change made here is ending, until when (ms): their ending is not a death to report. */
  private ending = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;
  private stopWatch: (() => void) | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private scanning = false;
  private rescan = false;
  private stopped = false;

  constructor(options: PushOptions) {
    this.o = options;
  }

  start(): void {
    this.unsubscribe = this.o.tree.subscribe((m) => this.onTree(m));
    void this.o.tree.get().then((m) => this.onTree(m));
    this.stopWatch = this.o.backend.watch(() => this.scheduleScan());
    this.poll = setInterval(() => this.scheduleScan(), FACTS_POLL_MS);
    this.scheduleScan();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.stopWatch?.();
    if (this.poll !== null) clearInterval(this.poll);
    if (this.scanTimer !== null) clearTimeout(this.scanTimer);
    for (const t of this.finishing.values()) clearTimeout(t);
    this.finishing.clear();
  }

  /** Whether the server can send at all (a valid VAPID key file). */
  get enabled(): boolean {
    return this.o.vapid.ok;
  }

  get presence(): Presence {
    return this.o.presence;
  }

  get paused(): boolean {
    return this.o.store.paused();
  }

  get publicKey(): string | null {
    return this.o.vapid.ok ? this.o.vapid.keys.publicKey : null;
  }

  /**
   * Call before a change made from this app that ends these panes: their ending is not a death to
   * report (others still are). Covers the moment the tree takes to drop them.
   */
  expectEnding(paneIds: readonly string[]): void {
    const until = Date.now() + ACTION_GRACE_MS * 3;
    for (const id of paneIds) this.ending.set(id, until);
  }

  private onTree(message: TreeMessage): void {
    if (this.stopped) return;
    if (!message.ok) {
      this.lastOk = false;
      return;
    }
    const cur = indexTree(message.tree);
    const prev = this.panes;
    const trusted = this.lastOk && prev !== null;
    this.panes = cur;
    this.lastOk = true;
    if (!trusted) return; // the first read, or the first after the core was unreachable: a baseline, not news
    for (const [id, was] of prev) {
      const now = cur.get(id);
      // A shell that became an agent already asking something (Claude started in an existing terminal).
      if (was.agent === null) {
        if (now !== undefined && now.agent !== null && now.status === "waiting") this.emit("needs-input", now, null);
        continue;
      }
      if (now === undefined || now.agent === null) {
        this.cancelFinish(id);
        // Put to sleep (here or by the auto-sleep job): the session is kept, nothing died.
        if (now !== undefined && now.asleep) continue;
        // Also when the program is still there but no longer an agent (Claude quit to its shell).
        if ((this.ending.get(id) ?? 0) < Date.now()) this.emit("died", was, null);
        continue;
      }
      if (now.status === "waiting" && was.status !== "waiting") {
        this.cancelFinish(id);
        this.emit("needs-input", now, null);
      } else if (was.status === "working" && now.status === "idle") this.settleFinish(id);
      else if (now.status !== "idle") this.cancelFinish(id);
    }
    for (const [id, now] of cur) if (now.agent !== null && !prev.has(id) && now.status === "waiting") this.emit("needs-input", now, null);
  }

  private cancelFinish(id: string): void {
    const timer = this.finishing.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.finishing.delete(id);
  }

  private settleFinish(id: string): void {
    if (this.finishing.has(id)) return;
    this.finishing.set(
      id,
      setTimeout(() => {
        this.finishing.delete(id);
        const now = this.panes?.get(id);
        if (now !== undefined && now.agent !== null && now.status === "idle") this.emit("finished", now, null);
      }, this.o.finishSettleMs ?? FINISH_SETTLE_MS),
    );
  }

  private emit(kind: PushKind, pane: PaneInfo, text: string | null): void {
    void this.deliver(kind, pane, text).catch((err: unknown) => console.error("push:", err instanceof Error ? err.message : String(err)));
  }

  // ---- what agents asked for through labels ----

  private scheduleScan(): void {
    if (this.stopped || this.scanTimer !== null) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.scan();
    }, 200);
  }

  /** Read the agents' labels: send pending notes, record quiet marks. One scan at a time. */
  async scan(): Promise<void> {
    if (this.scanning) {
      this.rescan = true;
      return;
    }
    this.scanning = true;
    try {
      do {
        this.rescan = false;
        await this.readFacts(true);
      } while (this.rescan && !this.stopped);
    } finally {
      this.scanning = false;
    }
  }

  private async readFacts(handleNotes: boolean): Promise<void> {
    let facts;
    try {
      facts = await this.o.backend.readPushFacts();
    } catch {
      return; // the core is unreachable: keep what is known
    }
    this.factsAt = Date.now();
    const quiet = new Set(facts.quietSpaces);
    for (const paneId of facts.quietPanes) {
      const space = this.panes?.get(paneId)?.spaceId;
      if (space === undefined) continue;
      quiet.add(space);
      // The doc is the one home of the flag (the app's toggle writes it too): record the label,
      // then take it off so turning the flag off in the app sticks.
      try {
        if (!facts.quietSpaces.has(space)) await this.o.backend.markQuiet(space);
        await this.o.backend.clearQuietLabel(paneId);
      } catch (err) {
        console.error("push: quiet not recorded:", err instanceof Error ? err.message : String(err));
      }
    }
    this.quiet = quiet;
    if (!handleNotes) return;
    const now = Date.now();
    for (const [key, at] of this.recentNotes) if (now - at > NOTE_QUIET_MS) this.recentNotes.delete(key);
    for (const note of facts.notes) {
      // A pane the tree doesn't show yet has no space to check mute and quiet against: leave its
      // label and look again next scan.
      const pane = this.panes?.get(note.paneId);
      if (pane === undefined) continue;
      const text = clean(note.text, NOTE_MAX_CHARS);
      const key = `${note.paneId}\n${text}`;
      if (this.recentNotes.has(key)) {
        await this.o.backend.clearNote(note.paneId).catch(() => undefined);
        continue;
      }
      this.recentNotes.set(key, now);
      // Cleared first: a note is sent once, and a failed send is not retried into a storm.
      await this.o.backend.clearNote(note.paneId).catch(() => undefined);
      if (text === "") continue;
      await this.deliver("note", pane, text).catch(() => undefined);
    }
  }

  // ---- delivery ----

  private async deliver(kind: PushKind, pane: PaneInfo, text: string | null): Promise<void> {
    if (!this.o.vapid.ok || this.o.store.paused()) return;
    if (Date.now() - this.factsAt > FACTS_FRESH_MS) await (this.factsRead ??= this.readFacts(false).finally(() => (this.factsRead = null)));
    if (this.o.store.muted().has(pane.spaceId) || this.quiet.has(pane.spaceId)) return;
    if (this.o.presence.isOpen(pane.id)) return;
    await this.sendAll(payloadFor(kind, pane, text));
  }

  /** The same payload to every subscription, dropping those the push service says are gone. */
  async sendAll(payload: PushPayload): Promise<number> {
    if (!this.o.vapid.ok) return 0;
    const keys = this.o.vapid.keys;
    const allowInsecure = this.o.allowInsecure === true;
    const send = this.o.send ?? ((sub, p) => sendPush(sub, p, { keys, subject: this.o.subject }));
    let sent = 0;
    await Promise.all(
      this.o.store.subscriptions().map(async (sub) => {
        if (!endpointAllowed(sub.endpoint, allowInsecure)) return;
        const result = await send(sub, payload);
        if (result === "sent") sent++;
        else if (result === "gone") this.o.store.removeSubscription(sub.endpoint);
      }),
    );
    return sent;
  }

  /** A test notification, to every subscription. */
  sendTest(): Promise<number> {
    return this.sendAll({ kind: "note", title: "herdr", body: "Push works.", url: "/", tag: "test" });
  }
}

export function payloadFor(kind: PushKind, pane: PaneInfo, text: string | null): PushPayload {
  const what = kind === "needs-input" ? "needs your input" : kind === "finished" ? "finished" : "ended";
  const space = `/s/${encodeURIComponent(pane.spaceId)}`;
  const session = `${space}/${encodeURIComponent(pane.tabId)}/${encodeURIComponent(pane.id)}`;
  if (kind === "note") return { kind, title: pane.spaceName, body: text ?? "", url: session, tag: `note:${pane.id}` };
  return { kind, title: pane.spaceName, body: `${clean(pane.name, 60)} ${what}`, url: session, tag: `${kind}:${pane.id}` };
}
