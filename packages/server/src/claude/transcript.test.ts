import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chat.ts";
import { mergeById } from "../transcript-tail.ts";
import { classifyUserText, ClaudeTranscriptParser, summarizeTool } from "./transcript.ts";

// Canned transcript: the shapes Claude Code 2.1.x writes. If Claude Code changes its format these are
// what should fail.
const fixture = readFileSync(new URL("../../tests/fixtures/claude/session.jsonl", import.meta.url), "utf8").split("\n");

function parse(lines: readonly string[]): ChatMessage[] {
  const parser = new ClaudeTranscriptParser();
  return mergeById(lines.flatMap((l) => parser.feed(l)));
}

describe("reply text stored as a thinking block (thinkingDisplay: updates)", () => {
  it("shows the text before an AskUserQuestion in the same turn", () => {
    const lines = readFileSync(new URL("../../tests/fixtures/claude/update-before-question.jsonl", import.meta.url), "utf8").split("\n");
    const a = parse(lines).find((m) => m.id === "a:msg_b2");
    expect(a?.parts.map((p) => p.kind)).toEqual(["text", "tool"]);
    expect(a?.parts[0]).toMatchObject({ text: "Two alerts, two different causes." });
  });
});

describe("ClaudeTranscriptParser", () => {
  const messages = parse(fixture);
  const find = (id: string) => messages.find((m) => m.id === id);

  it("shows the user's speech and joins one API message's rows into one assistant message", () => {
    expect(messages[0]).toMatchObject({ id: "u:u1", role: "user", parts: [{ kind: "text", text: "Fix the **greeting** in hello.txt" }] });
    const a = find("a:msg_1");
    expect(a?.parts.map((p) => p.kind)).toEqual(["thinking", "text", "tool"]);
  });

  it("folds a tool result into its call and drops the result row", () => {
    const read = find("a:msg_1")?.parts[2];
    expect(read).toMatchObject({ kind: "tool", name: "Read", summary: "/work/hello.txt", subagent: false, result: { text: "hello wrold\n", isError: false } });
    expect(messages.some((m) => m.id === "u:u2")).toBe(false);
  });

  it("carries a file edit's diff from the result's structuredPatch", () => {
    const edit = find("a:msg_2")?.parts[0];
    expect(edit).toMatchObject({ kind: "tool", name: "Edit", file: "/work/hello.txt", diff: [{ header: "@@ -1,1 +1,1 @@", lines: ["-hello wrold", "+hello world"] }] });
  });

  it("builds a diff from the Edit input when the call is still waiting", () => {
    const [m] = parse([fixture[6] ?? ""]);
    expect(m?.parts[0]).toMatchObject({ kind: "tool", diff: [{ lines: ["-wrold", "+world"] }] });
    expect(m?.parts[0]).not.toHaveProperty("result");
  });

  it("marks a subagent run, shows its result and drops its sidechain traffic", () => {
    expect(find("a:msg_3")?.parts[0]).toMatchObject({ subagent: true, summary: "Check spelling elsewhere", result: { text: "No other typos." } });
    expect(JSON.stringify(messages)).not.toContain("subagent internal chatter");
  });

  it("flags a failed tool call", () => {
    expect(find("a:msg_4")?.parts[0]).toMatchObject({ result: { isError: true, text: "Exit code 1" } });
  });

  it("hides plumbing addressed to the model, and shows slash commands and their output", () => {
    expect(JSON.stringify(messages)).not.toContain("hidden");
    expect(find("u:u6")).toMatchObject({ role: "user", parts: [{ text: "/compact" }] });
    expect(find("u:u7")).toMatchObject({ role: "note", parts: [{ text: "Compacted" }] });
  });

  it("sends an assistant message again, same id, when it grows", () => {
    const parser = new ClaudeTranscriptParser();
    const first = parser.feed(fixture[3] ?? "");
    const second = parser.feed(fixture[4] ?? "");
    expect(first[0]?.id).toBe("a:msg_1");
    expect(second[0]?.id).toBe("a:msg_1");
    expect(second[0]?.parts).toHaveLength(2);
  });

  it("ignores bookkeeping rows, blank lines, garbage and thinking with no text", () => {
    const parser = new ClaudeTranscriptParser();
    expect(parser.feed('{"type":"mode"}')).toEqual([]);
    expect(parser.feed("")).toEqual([]);
    expect(parser.feed("{not json")).toEqual([]);
    expect(parser.feed(JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "thinking", thinking: "", signature: "s" }] } }))).toEqual([]);
  });

  it("keeps a typed message with an attached image", () => {
    const row = { type: "user", uuid: "x", message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } }] } };
    expect(new ClaudeTranscriptParser().feed(JSON.stringify(row))[0]?.parts).toEqual([{ kind: "text", text: "look" }, { kind: "image", note: "image attached" }]);
  });
});

describe("classifyUserText", () => {
  it("unwraps a bracketed paste", () => {
    expect(classifyUserText('\n\n<pasted_content id="6100">\nline one\nline two\n</pasted_content id="6100">\n')).toEqual({ role: "user", text: "line one\nline two" });
  });
  it("reduces a task notification to its summary", () => {
    expect(classifyUserText("<task-notification><summary>Agent finished</summary></task-notification>")).toEqual({ role: "note", text: "Agent finished" });
  });
  it("drops the command caveat", () => {
    expect(classifyUserText("<local-command-caveat>DO NOT respond</local-command-caveat>")).toBeNull();
  });
});

describe("summarizeTool", () => {
  it("picks the command, path or pattern and shortens long lines", () => {
    expect(summarizeTool("Bash", { command: "ls   -la" })).toBe("ls -la");
    expect(summarizeTool("Grep", { pattern: "foo" })).toBe("foo");
    expect(summarizeTool("Bash", { command: "x".repeat(500) })).toHaveLength(140);
    expect(summarizeTool("Odd", {})).toBe("");
  });
});
