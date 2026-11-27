import { describe, expect, it } from "vitest";
import type { PaneNode, PaneStatus, Tree } from "../shared/model.ts";
import type { ChatMessage } from "../shared/chat.ts";
import { newNotices, pendingFor, withPending, statusMap, viewedPane } from "./reply-notify.ts";

const pane = (id: string, status: PaneStatus | null, extra: Partial<PaneNode> = {}): PaneNode => ({ id, kind: "terminal", name: id, agent: "claude", status, chat: true, asleep: false, ...extra });
const tree = (...panes: PaneNode[]): Tree => ({ groups: [], spaces: [{ id: "s1", name: "Space", quiet: false, color: null, children: [], tabs: [{ id: "t1", name: "T", panes }] }] });

describe("newNotices", () => {
  it("notices working -> idle and ->waiting", () => {
    const before = statusMap(tree(pane("a", "working"), pane("b", "idle")));
    const got = newNotices(before, tree(pane("a", "idle"), pane("b", "waiting")), null);
    expect(got.map((n) => [n.paneId, n.kind])).toEqual([["a", "done"], ["b", "waiting"]]);
  });
  it("skips the viewed pane, hidden, asleep, new panes and unchanged ones", () => {
    const before = statusMap(tree(pane("a", "working"), pane("h", "working"), pane("z", "working"), pane("i", "idle")));
    const now = tree(pane("a", "idle"), pane("h", "idle", { inboxHidden: true }), pane("z", "idle", { asleep: true }), pane("i", "idle"), pane("new", "idle"));
    expect(newNotices(before, now, "a")).toEqual([]);
  });
  it("skips both the routed pane and the pane in an open modal, but not another pane", () => {
    const before = statusMap(tree(pane("a", "working"), pane("m", "working"), pane("o", "working")));
    const now = tree(pane("a", "idle"), pane("m", "idle"), pane("o", "idle"));
    expect(newNotices(before, now, "a", "m").map((n) => n.paneId)).toEqual(["o"]);
  });
  it("does not notice idle -> working or a pane that stays waiting", () => {
    const before = statusMap(tree(pane("a", "idle"), pane("b", "waiting")));
    expect(newNotices(before, tree(pane("a", "working"), pane("b", "waiting")), null)).toEqual([]);
  });
});

describe("viewedPane", () => {
  it("is the route's pane, else the first of the tab, else null", () => {
    const t = tree(pane("a", "idle"), pane("b", "idle"));
    expect(viewedPane(t, { space: "s1", tab: "t1", pane: "b" })).toBe("b");
    expect(viewedPane(t, { space: "s1", tab: null, pane: null })).toBe("a");
    expect(viewedPane(t, { space: null, tab: null, pane: null })).toBeNull();
    expect(viewedPane(t, { space: "s1", tab: null, pane: null, settings: true })).toBeNull();
  });
});

describe("withPending", () => {
  const msg = (id: string, role: "user" | "assistant", text: string): ChatMessage => ({ id, role, at: "", parts: [{ kind: "text", text }] });
  const texts = (ms: ChatMessage[]) => ms.map((m) => (m.parts[0]?.kind === "text" ? m.parts[0].text : ""));
  const before = [msg("1", "user", "hi"), msg("2", "assistant", "yo")];
  it("shows a sent message until the transcript has a new user message, whatever its text", () => {
    const p = [pendingFor(before, "/compact", "0")];
    expect(texts(withPending(before, before, p))).toEqual(["hi", "yo", "/compact"]);
    const after = [...before, msg("3", "user", "Run compact")];
    expect(texts(withPending(after, after, p))).toEqual(["hi", "yo", "Run compact"]);
  });
  it("settles several pending messages one by one", () => {
    const p = [pendingFor(before, "a", "0"), pendingFor(before, "b", "1")];
    const one = [...before, msg("3", "user", "a")];
    expect(texts(withPending(one, one, p))).toEqual(["hi", "yo", "a", "b"]); // "a" is the transcript's; the echo of "a" is gone, only "b" remains
    expect(withPending(one, one, p).filter((m) => m.id.startsWith("pending-")).map((m) => m.id)).toEqual(["pending-1"]);
  });
});
