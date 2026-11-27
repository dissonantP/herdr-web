import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listConversations, readHead } from "./conversations.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const line = (o: object) => JSON.stringify(o);

describe("readHead", () => {
  it("takes the folder and the first real user message, skipping commands and meta lines", () => {
    const text = [
      line({ type: "mode" }),
      line({ type: "user", cwd: "/p", isMeta: true, message: { content: "meta" } }),
      line({ type: "user", cwd: "/p", message: { content: "<command-name>/clear</command-name>" } }),
      line({ type: "user", cwd: "/p", message: { content: [{ type: "text", text: "Fix   the\nbug" }] } }),
    ].join("\n");
    expect(readHead(text)).toEqual({ cwd: "/p", title: "Fix the bug" });
  });
  it("prefers the session's name, and survives a cut-off last line", () => {
    const text = [line({ type: "user", cwd: "/p", message: { content: "hello" } }), line({ type: "custom-title", customTitle: "my work" }), '{"type":"user","mess'].join("\n");
    expect(readHead(text)).toEqual({ cwd: "/p", title: "my work" });
  });
});

describe("listConversations", () => {
  it("lists newest first, leaving out empty and non-session files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-conv-"));
    const proj = join(dir, "projects", "-p");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, `${A}.jsonl`), line({ type: "user", cwd: "/p", message: { content: "old one" } }));
    writeFileSync(join(proj, `${B}.jsonl`), line({ type: "user", cwd: "/p", message: { content: "new one" } }));
    writeFileSync(join(proj, "agent-x.jsonl"), line({ type: "user", cwd: "/p", message: { content: "agent" } }));
    writeFileSync(join(proj, "cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl"), line({ type: "mode" }));
    utimesSync(join(proj, `${A}.jsonl`), 1000, 1000);
    utimesSync(join(proj, `${B}.jsonl`), 2000, 2000);
    expect((await listConversations(dir)).map((c) => [c.session, c.title, c.cwd])).toEqual([
      [B, "new one", "/p"],
      [A, "old one", "/p"],
    ]);
    expect(await listConversations(dir, 1)).toHaveLength(1);
    expect(await listConversations(join(dir, "nope"))).toEqual([]);
    expect(await listConversations("")).toEqual([]);
  });
});
