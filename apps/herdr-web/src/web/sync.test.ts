import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult, AdminAction, Tree } from "../shared/model.ts";
import { change, dismissFailure, receive, resetSync, SLOW_MS, streamLive, syncView as view, track } from "./sync.ts";

const tree = (name: string): Tree => ({ spaces: [{ id: "s", name, quiet: false, color: null, children: [], tabs: [] }], groups: [] });
const rename = (name: string): AdminAction => ({ type: "space.rename", id: "s", name });
/** A send whose answer the test gives. */
function pendingSend() {
  let answer: (r: ActionResult) => void = () => undefined;
  const send = () => new Promise<ActionResult>((resolve) => (answer = resolve));
  return { send, answer: (r: ActionResult) => answer(r) };
}

beforeEach(() => {
  resetSync();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("sync store", () => {
  it("shows a predicted change at once and keeps it until the server's tree has it", async () => {
    receive({ ok: true, tree: tree("old") });
    const { send, answer } = pendingSend();
    const { done } = change(rename("new"), send, "Couldn't rename");
    expect(view().tree?.spaces[0]?.name).toBe("new");
    receive({ ok: true, tree: tree("old") }); // an unrelated tree before the answer: the change stays on top
    expect(view().tree?.spaces[0]?.name).toBe("new");
    answer({ ok: true, created: {} });
    await done;
    receive({ ok: true, tree: tree("new") });
    expect(view().tree?.spaces[0]?.name).toBe("new");
    receive({ ok: true, tree: tree("elsewhere") }); // a later rename from another device wins
    expect(view().tree?.spaces[0]?.name).toBe("elsewhere");
  });

  it("drops an answered change at once when a read of the tree already has it (the answer overtook the stream)", async () => {
    receive({ ok: true, tree: tree("old") });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, tree: tree("new") })))));
    const { send, answer } = pendingSend();
    const { done } = change(rename("new"), send, "Couldn't rename");
    answer({ ok: true, created: {} });
    await done;
    await vi.waitFor(() => expect(view().tree?.spaces[0]?.name).toBe("new"));
    receive({ ok: true, tree: tree("elsewhere") });
    expect(view().tree?.spaces[0]?.name).toBe("elsewhere");
    vi.unstubAllGlobals();
  });

  it("settles an answered change the server did differently on the server's tree", async () => {
    receive({ ok: true, tree: tree("old") });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, tree: tree("server-named") })))));
    const { send, answer } = pendingSend();
    const { done } = change(rename("new"), send, "Couldn't rename");
    answer({ ok: true, created: {} });
    await done;
    await vi.waitFor(() => expect(view().tree?.spaces[0]?.name).toBe("server-named"));
    vi.unstubAllGlobals();
  });

  it("takes a refused change back and says why", async () => {
    receive({ ok: true, tree: tree("old") });
    const { send, answer } = pendingSend();
    const { done } = change(rename("new"), send, "Couldn't rename");
    answer({ ok: false, error: "no such space" });
    await done;
    expect(view().tree?.spaces[0]?.name).toBe("old");
    expect(view().failure).toBe("Couldn't rename: no such space");
    dismissFailure();
    expect(view().failure).toBeNull();
  });

  it("shows syncing only for a write slower than SLOW_MS", async () => {
    let finish: () => void = () => undefined;
    const quick = track(new Promise<void>((r) => (finish = r)));
    vi.advanceTimersByTime(SLOW_MS - 1);
    expect(view().slow).toBe(false);
    vi.advanceTimersByTime(1);
    expect(view().slow).toBe(true);
    finish();
    await quick;
    expect(view().slow).toBe(false);
  });

  it("keeps the last tree when the core fails or the stream drops, marked out of date", () => {
    receive({ ok: true, tree: tree("kept") });
    receive({ ok: false, error: "timeout" });
    expect(view()).toMatchObject({ health: "stale", error: null });
    expect(view().tree?.spaces[0]?.name).toBe("kept");
    streamLive(false);
    vi.advanceTimersByTime(SLOW_MS - 1);
    expect(view().health).toBe("stale"); // a stream that comes straight back never shows as down
    vi.advanceTimersByTime(1);
    expect(view().health).toBe("offline");
    streamLive(true);
    receive({ ok: true, tree: tree("kept") });
    expect(view().health).toBe("live");
  });

  it("reports the error when there was never a tree", () => {
    receive({ ok: false, error: "no core" });
    expect(view()).toMatchObject({ tree: null, error: "no core" });
  });
});

describe("freshness", () => {
  it("lets an answer through only when no other change is on its way and none came after", async () => {
    const { freshness } = await import("./sync.ts");
    const f = freshness();
    const readBefore = f.read();
    const a = f.change();
    const readDuring = f.read();
    const b = f.change();
    expect(readBefore()).toBe(false); // started before a change
    expect(readDuring()).toBe(false); // answered while changes are on their way
    expect(a()).toBe(false); // b is still on its way
    expect(b()).toBe(true); // the last, nothing pending
    expect(f.read()()).toBe(true);
  });
});
