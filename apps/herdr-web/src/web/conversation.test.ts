import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../shared/chat.ts";
import { recognitionErrorText, replyAfter, speakable } from "./conversation.ts";

const msg = (role: ChatMessage["role"], ...parts: ChatMessage["parts"]): ChatMessage => ({ id: "x", role, at: "", parts });

describe("speakable", () => {
  it("drops markdown symbols and code, keeps link text", () => {
    expect(speakable("# Title\n\nSee [the docs](https://x.y) and `foo`.\n\n```js\nlet a = 1\n```\n- **bold** item")).toBe("Title See the docs and foo. (code omitted) bold item");
  });
});

describe("speakable identifiers", () => {
  it("keeps underscores inside words", () => {
    expect(speakable("run my_var and _emphasis_ now")).toBe("run my_var and emphasis now");
  });
});

describe("replyAfter", () => {
  it("reads only assistant text after the given point, not tools or thinking", () => {
    const list = [
      msg("assistant", { kind: "text", text: "old" }),
      msg("user", { kind: "text", text: "q" }),
      msg("assistant", { kind: "thinking", text: "hm" }, { kind: "text", text: "First." }),
      msg("note", { kind: "text", text: "note" }),
      msg("assistant", { kind: "text", text: "Second." }),
    ];
    expect(replyAfter(list, 1)).toBe("First. Second.");
    expect(replyAfter(list, 5)).toBe("");
  });
});

describe("recognitionErrorText", () => {
  it("explains errors and ignores our own abort", () => {
    expect(recognitionErrorText("aborted")).toBe("");
    expect(recognitionErrorText("not-allowed")).toMatch(/blocked/);
    expect(recognitionErrorText("NotAllowedError")).toMatch(/blocked/);
    expect(recognitionErrorText("no-speech")).toMatch(/Didn't hear/);
    expect(recognitionErrorText("weird")).toBe("Speech recognition: weird");
  });
});
