import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaneStatus, Tree, TreeMessage } from "../../shared/model.ts";
import type { PushFacts } from "@herdr/server/adapters/backend.ts";
import { Presence } from "./presence.ts";
import { PushService, type PushPayload } from "./service.ts";
import { PushStore } from "./store.ts";
import { generateVapidKeys, type PushSubscription, type SendResult } from "./webpush.ts";
import { createPrivateKey } from "node:crypto";

interface P {
  id: string;
  agent?: boolean;
  status?: PaneStatus | null;
  asleep?: boolean;
}

const tree = (panes: P[], space = "sp1"): Tree => ({
  groups: [],
  spaces: [{ id: space, name: "alpha", quiet: false, color: null, children: [], tabs: [{ id: "tb1", name: "1", panes: panes.map((p) => ({ id: p.id, kind: "terminal" as const, name: `w-${p.id}`, agent: p.agent === false ? null : "claude", status: p.status ?? "idle", chat: true, asleep: p.asleep === true })) }] }],
});

const SUB: PushSubscription = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: "x".repeat(87), auth: "y".repeat(22) };

let dir = "";
let listeners: ((m: TreeMessage) => void)[] = [];
let current: TreeMessage = { ok: true, tree: tree([]) };
let facts: PushFacts = { notes: [], quietPanes: [], quietSpaces: new Set() };
let cleared: string[] = [];
let quietMarked: string[] = [];
let quietCleared: string[] = [];
let sent: PushPayload[] = [];
let sendResult: SendResult = "sent";
let store: PushStore;
let presence: Presence;
let svc: PushService;

const feed = (m: TreeMessage) => {
  current = m;
  for (const l of listeners) l(m);
};
const ok = (panes: P[], space?: string) => feed({ ok: true, tree: tree(panes, space) });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (test: () => boolean) => {
  for (let i = 0; i < 100 && !test(); i++) await wait(10);
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "herdr-push-"));
  listeners = [];
  facts = { notes: [], quietPanes: [], quietSpaces: new Set() };
  cleared = [];
  quietMarked = [];
  quietCleared = [];
  sent = [];
  sendResult = "sent";
  current = { ok: true, tree: tree([{ id: "t1", status: "working" }, { id: "t2", status: "idle" }]) };
  store = new PushStore(join(dir, "push.json"));
  store.addSubscription(SUB);
  presence = new Presence();
  const { publicKey, privatePem } = generateVapidKeys();
  svc = new PushService({
    tree: { subscribe: (l) => (listeners.push(l), () => (listeners = listeners.filter((x) => x !== l))), get: () => Promise.resolve(current) },
    backend: {
      watch: () => () => undefined,
      readPushFacts: () => Promise.resolve(facts),
      clearNote: (id) => (cleared.push(id), Promise.resolve()),
      markQuiet: (id) => (quietMarked.push(id), Promise.resolve()),
      clearQuietLabel: (id) => (quietCleared.push(id), Promise.resolve()),
    },
    store,
    vapid: { ok: true, keys: { publicKey, privateKey: createPrivateKey(privatePem) } },
    presence,
    subject: "mailto:x@x.invalid",
    send: (_sub, payload) => (sent.push(payload), Promise.resolve(sendResult)),
    finishSettleMs: 30,
  });
  svc.start();
  await wait(20); // the baseline read
});

afterEach(() => {
  svc.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("what pushes (F19)", () => {
  it("a pane that starts waiting pushes once, with its session as the tap target", async () => {
    ok([{ id: "t1", status: "waiting" }, { id: "t2" }]);
    await until(() => sent.length > 0);
    expect(sent).toEqual([{ kind: "needs-input", title: "alpha", body: "w-t1 needs your input", url: "/s/sp1/tb1/t1", tag: "needs-input:t1" }]);
    ok([{ id: "t1", status: "waiting" }, { id: "t2" }]);
    await wait(50);
    expect(sent).toHaveLength(1);
  });

  it("a turn that ends (working to idle, and staying idle) pushes 'finished'", async () => {
    ok([{ id: "t1", status: "idle" }, { id: "t2" }]);
    expect(sent).toHaveLength(0); // not yet: it must hold
    await until(() => sent.length > 0);
    expect(sent.map((p) => [p.kind, p.body])).toEqual([["finished", "w-t1 finished"]]);
  });

  it("idle that flickers back to working does not push", async () => {
    ok([{ id: "t1", status: "idle" }, { id: "t2" }]);
    ok([{ id: "t1", status: "working" }, { id: "t2" }]);
    await wait(80);
    expect(sent).toHaveLength(0);
  });

  it("an agent pane that disappears, or stops being an agent, pushes 'ended'", async () => {
    ok([{ id: "t2" }]);
    await until(() => sent.length > 0);
    expect(sent[0]?.kind).toBe("died");
    expect(sent[0]?.body).toBe("w-t1 ended");
    ok([{ id: "t2", agent: false, status: null }]);
    await until(() => sent.length > 1);
    expect(sent[1]?.body).toBe("w-t2 ended");
  });

  it("an agent put to sleep (the pane stays, asleep) is not reported as ended", async () => {
    ok([{ id: "t1", agent: false, status: null, asleep: true }, { id: "t2" }]);
    await wait(80);
    expect(sent).toHaveLength(0);
  });

  it("an ending caused by this app (a closed pane) is not reported", async () => {
    svc.expectEnding(["t1"]);
    ok([{ id: "t2" }]);
    await wait(60);
    expect(sent).toHaveLength(0);
  });

  it("an unrelated death during a change made here is still reported", async () => {
    svc.expectEnding(["t2"]);
    ok([{ id: "t2" }]); // t1 died on its own
    await until(() => sent.length > 0);
    expect(sent.map((p) => p.body)).toEqual(["w-t1 ended"]);
  });

  it("a shell that becomes an agent already waiting pushes needs-input", async () => {
    ok([{ id: "t1", status: "working" }, { id: "t2" }, { id: "t3", agent: false, status: null }]);
    ok([{ id: "t1", status: "working" }, { id: "t2" }, { id: "t3", status: "waiting" }]);
    await until(() => sent.length > 0);
    expect(sent.map((p) => p.body)).toEqual(["w-t3 needs your input"]);
  });

  it("shells push nothing, and neither does the first read or the first after the core was unreachable", async () => {
    ok([{ id: "t1", status: "working" }, { id: "t2" }, { id: "t3", agent: false, status: null }]);
    ok([{ id: "t1", status: "working" }, { id: "t2" }]); // the shell vanishing is not news
    feed({ ok: false, error: "core down" });
    feed({ ok: true, tree: tree([]) }); // everything "gone" while the core was away
    await wait(60);
    expect(sent).toHaveLength(0);
  });

  it("not for the pane a visible page has open; again once that report goes stale", async () => {
    presence.report("phone", ["t1"]);
    ok([{ id: "t1", status: "waiting" }, { id: "t2" }]);
    await wait(60);
    expect(sent).toHaveLength(0);
    presence.report("phone", []);
    ok([{ id: "t1", status: "working" }, { id: "t2" }]);
    ok([{ id: "t1", status: "waiting" }, { id: "t2" }]);
    await until(() => sent.length > 0);
    expect(sent).toHaveLength(1);
  });

  it("drops a subscription the push service says is gone", async () => {
    sendResult = "gone";
    ok([{ id: "t1", status: "waiting" }, { id: "t2" }]);
    await until(() => store.subscriptions().length === 0);
    expect(store.subscriptions()).toHaveLength(0);
  });
});

describe("mute, pause and quiet (F20)", () => {
  it("global pause stops every push; resuming brings them back", async () => {
    store.setPaused(true);
    ok([{ id: "t1", status: "waiting" }, { id: "t2" }]);
    await wait(60);
    expect(sent).toHaveLength(0);
    store.setPaused(false);
    ok([{ id: "t1", status: "working" }, { id: "t2" }]);
    ok([{ id: "t1", status: "waiting" }, { id: "t2" }]);
    await until(() => sent.length > 0);
    expect(sent).toHaveLength(1);
  });

  it("a muted space pushes nothing; other spaces still do", async () => {
    store.setMuted("sp1", true);
    ok([{ id: "t1", status: "waiting" }, { id: "t2" }]);
    await wait(60);
    expect(sent).toHaveLength(0);
    store.setMuted("sp1", false);
    ok([{ id: "t1", status: "working" }, { id: "t2" }]);
    ok([{ id: "t1", status: "waiting" }, { id: "t2" }]);
    await until(() => sent.length > 0);
    expect(sent).toHaveLength(1);
  });

  it("a space marked quiet in herdr-tree never pushes for itself", async () => {
    facts = { notes: [], quietPanes: [], quietSpaces: new Set(["sp1"]) };
    await svc.scan();
    ok([{ id: "t1", status: "waiting" }, { id: "t2" }]);
    ok([{ id: "t1", status: "working" }]);
    await wait(80);
    expect(sent).toHaveLength(0);
  });

  it("a terminal labelled herdr.quiet=1 gets its space recorded as quiet, and silenced", async () => {
    facts = { notes: [], quietPanes: ["t2"], quietSpaces: new Set() };
    await svc.scan();
    expect(quietMarked).toEqual(["sp1"]);
    // The label comes off once the doc has the flag, so turning it off in the app sticks.
    expect(quietCleared).toEqual(["t2"]);
    ok([{ id: "t1", status: "waiting" }, { id: "t2" }]);
    await wait(60);
    expect(sent).toHaveLength(0);
  });
});

describe("pushing on purpose (F21)", () => {
  it("sends a note's text, clears the label first, and taps open the agent's space", async () => {
    facts = { notes: [{ paneId: "t1", text: "  build\nis done  " }], quietPanes: [], quietSpaces: new Set() };
    await svc.scan();
    expect(cleared).toEqual(["t1"]);
    expect(sent).toEqual([{ kind: "note", title: "alpha", body: "build is done", url: "/s/sp1/tb1/t1", tag: "note:t1" }]);
  });

  it("a note from a pane the tree does not show yet is left for the next scan, not sent unchecked", async () => {
    facts = { notes: [{ paneId: "t99", text: "who am I" }], quietPanes: [], quietSpaces: new Set() };
    await svc.scan();
    expect(sent).toHaveLength(0);
    expect(cleared).toEqual([]);
  });

  it("is sent once even if the label could not be cleared", async () => {
    facts = { notes: [{ paneId: "t1", text: "hi" }], quietPanes: [], quietSpaces: new Set() };
    await svc.scan();
    await svc.scan();
    expect(sent).toHaveLength(1);
  });

  it("an empty note sends nothing but is cleared; a muted or paused space sends none", async () => {
    facts = { notes: [{ paneId: "t1", text: "   " }], quietPanes: [], quietSpaces: new Set() };
    await svc.scan();
    expect(cleared).toEqual(["t1"]);
    expect(sent).toHaveLength(0);
    store.setMuted("sp1", true);
    facts = { notes: [{ paneId: "t1", text: "muted one" }], quietPanes: [], quietSpaces: new Set() };
    await svc.scan();
    expect(sent).toHaveLength(0);
  });
});
