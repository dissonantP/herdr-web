import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../chat.ts";
import type { PaneFacts } from "../adapters/chat.ts";
import { openChat } from "../chat-service.ts";
import { ClaudeCodeAgent, projectDirName } from "./agent.ts";
import { INITIAL_BYTES, MAX_LINE_BYTES, TranscriptTail } from "../transcript-tail.ts";

const SESSION = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";
const user = (id: string, text: string) => `${JSON.stringify({ type: "user", uuid: id, message: { role: "user", content: text } })}\n`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(10);
  }
}

let config: string;
let root: string;
beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), "herdr-chat-"));
  root = join(config, "projects");
  mkdirSync(root);
});
afterEach(() => rmSync(config, { recursive: true, force: true }));

function transcript(cwd: string, session: string, body: string): string {
  const dir = join(root, projectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${session}.jsonl`);
  writeFileSync(path, body);
  return path;
}

describe("ClaudeCodeAgent.transcript", () => {
  const agent = () => new ClaudeCodeAgent(config);
  it("finds the file from the claude.session and claude.cwd labels", async () => {
    const path = transcript("/home/x/proj.one", SESSION, "");
    expect(await agent().transcript({ labels: { "claude.session": SESSION, "claude.cwd": "/home/x/proj.one" }, cwd: "/elsewhere" })).toEqual({ key: SESSION, path });
  });
  it("falls back to the terminal's cwd, then to searching every project folder", async () => {
    const path = transcript("/a/b", SESSION, "");
    expect(await agent().transcript({ labels: { "claude.session": SESSION }, cwd: "/a/b" })).toEqual({ key: SESSION, path });
    expect(await agent().transcript({ labels: { "claude.session": SESSION, "claude.cwd": "/nope" }, cwd: "/nope2" })).toEqual({ key: SESSION, path });
  });
  it("has no transcript without a valid session, or when the file is missing", async () => {
    const pane = (labels: Record<string, string>): PaneFacts => ({ labels, cwd: "/a/b" });
    expect(await agent().transcript(pane({}))).toBeNull();
    expect(await agent().transcript(pane({ "claude.session": "../../etc/passwd" }))).toBeNull();
    expect(await agent().transcript(pane({ "claude.session": SESSION }))).toBeNull();
  });
});

describe("TranscriptTail", () => {
  it("reads what is there, then only whole lines as they are appended", async () => {
    const path = transcript("/a", SESSION, user("u1", "one"));
    const seen: string[] = [];
    const tail = new TranscriptTail({ path, parser: () => new ClaudeCodeAgent(config).parser(), pollMs: 10, onMessages: (m) => seen.push(...m.map((x) => x.id)) });
    const first = await tail.start();
    expect(first.messages.map((m) => m.id)).toEqual(["u:u1"]);
    appendFileSync(path, user("u2", "two").slice(0, 30)); // half a line
    await wait(60);
    expect(seen).toEqual([]);
    appendFileSync(path, user("u2", "two").slice(30));
    await until(() => seen.length > 0);
    expect(seen).toEqual(["u:u2"]);
    tail.close();
  });
  it("shows only the end of a huge transcript and says so", async () => {
    const filler = user("f", "x".repeat(1000)).repeat(Math.ceil(INITIAL_BYTES / 1000) + 50);
    const path = transcript("/a", SESSION, filler + user("last", "the end"));
    const tail = new TranscriptTail({ path, parser: () => new ClaudeCodeAgent(config).parser(), onMessages: () => undefined });
    const first = await tail.start();
    tail.close();
    expect(first.truncated).toBe(true);
    expect(first.messages.at(-1)?.id).toBe("u:last");
  });
});

describe("TranscriptTail limits", () => {
  it("skips a line longer than the cap instead of buffering it, and carries on after it", async () => {
    const path = transcript("/a", SESSION, user("u1", "one"));
    const seen: string[] = [];
    const tail = new TranscriptTail({ path, parser: () => new ClaudeCodeAgent(config).parser(), pollMs: 10, onMessages: (m) => seen.push(...m.map((x) => x.id)) });
    await tail.start();
    appendFileSync(path, "x".repeat(MAX_LINE_BYTES + 10)); // an unfinished, enormous line
    await wait(100);
    appendFileSync(path, `${"y".repeat(100)}\n${user("u2", "after")}`);
    await until(() => seen.includes("u:u2"));
    tail.close();
    expect(seen).toEqual(["u:u2"]);
  });
  it("starts a fresh parse when the file is replaced by a shorter one", async () => {
    const path = transcript("/a", SESSION, user("u1", "one") + user("u2", "two"));
    const seen: string[] = [];
    const tail = new TranscriptTail({ path, parser: () => new ClaudeCodeAgent(config).parser(), pollMs: 10, onMessages: (m) => seen.push(...m.map((x) => x.id)) });
    await tail.start();
    writeFileSync(path, user("u3", "three"));
    await until(() => seen.includes("u:u3"));
    tail.close();
  });
});

describe("openChat", () => {
  it("waits for a session, streams its conversation live and switches when the session changes", async () => {
    const labels: Record<string, string> = {};
    const backend = { paneFacts: () => Promise.resolve<PaneFacts | null>({ labels, cwd: "/a" }) };
    const events: ChatEvent[] = [];
    const sub = openChat(backend, new ClaudeCodeAgent(config), "t1", (e) => events.push(e), 20);
    await until(() => events.length > 0);
    expect(events[0]).toMatchObject({ type: "none" });

    const path = transcript("/a", SESSION, user("u1", "hello"));
    labels["claude.session"] = SESSION;
    await until(() => events.some((e) => e.type === "reset"));
    expect(events.at(-1)).toMatchObject({ type: "reset", session: SESSION, messages: [{ id: "u:u1" }] });

    appendFileSync(path, user("u2", "more"));
    await until(() => events.some((e) => e.type === "upsert"));
    expect(events.at(-1)).toMatchObject({ type: "upsert", messages: [{ id: "u:u2" }] });

    transcript("/a", OTHER, user("o1", "fresh"));
    labels["claude.session"] = OTHER;
    await until(() => events.at(-1)?.type === "reset" && (events.at(-1) as { session: string }).session === OTHER);
    sub.close();
    const count = events.length;
    appendFileSync(path, user("u3", "ignored"));
    await wait(80);
    expect(events).toHaveLength(count);
  });
});
