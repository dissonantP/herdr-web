import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@herdr/server/chat.ts";
import { applyChatEvent, type ChatState } from "./useChat.ts";

const msg = (id: string, text: string): ChatMessage => ({ id, role: "assistant", at: "", parts: [{ kind: "text", text }] });
const connecting: ChatState = { status: "connecting", messages: [], truncated: false };

describe("applyChatEvent", () => {
  it("a reset replaces everything, which is how a reconnect or a new session starts clean", () => {
    const live = applyChatEvent(connecting, { type: "reset", session: "s", messages: [msg("a", "1")], truncated: false });
    const again = applyChatEvent(live, { type: "reset", session: "s", messages: [msg("a", "1"), msg("b", "2")], truncated: true });
    expect(again).toMatchObject({ status: "live", truncated: true });
    expect(again.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });
  it("an upsert replaces a message by id and appends a new one", () => {
    const live = applyChatEvent(connecting, { type: "reset", session: "s", messages: [msg("a", "1")], truncated: false });
    const next = applyChatEvent(live, { type: "upsert", messages: [msg("a", "grown"), msg("b", "2")] });
    expect(next.messages).toEqual([msg("a", "grown"), msg("b", "2")]);
  });
  it("ignores an upsert before any conversation, and a 'none' once one is showing", () => {
    expect(applyChatEvent(connecting, { type: "upsert", messages: [msg("a", "1")] })).toBe(connecting);
    const live = applyChatEvent(connecting, { type: "reset", session: "s", messages: [msg("a", "1")], truncated: false });
    expect(applyChatEvent(live, { type: "none", reason: "gone" })).toBe(live);
    expect(applyChatEvent(connecting, { type: "none", reason: "wait" })).toMatchObject({ status: "none", reason: "wait" });
  });
});
