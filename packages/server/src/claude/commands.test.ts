import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCommands, frontMatterDescription } from "./commands.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-cmds-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("claudeCommands", () => {
  it("lists the built-in commands, then the project's and the user's own commands and skills", async () => {
    const config = join(dir, "config");
    const project = join(dir, "proj");
    mkdirSync(join(config, "commands", "git"), { recursive: true });
    writeFileSync(join(config, "commands", "git", "sync.md"), "---\ndescription: Sync the branch\n---\nbody");
    mkdirSync(join(config, "skills", "deploy"), { recursive: true });
    writeFileSync(join(config, "skills", "deploy", "SKILL.md"), '---\nname: deploy\ndescription: "Ship it"\n---\n');
    mkdirSync(join(project, ".claude", "commands"), { recursive: true });
    writeFileSync(join(project, ".claude", "commands", "check.md"), "no front matter");
    const list = await claudeCommands(config, { labels: { "claude.cwd": project }, cwd: "/elsewhere" });
    const names = list.map((c) => c.name);
    expect(names.slice(0, 2)).toEqual(["/compact", "/clear"]);
    expect(list.find((c) => c.name === "/compact")?.arg).toBe("[instructions]");
    expect(list.find((c) => c.name === "/git:sync")?.description).toBe("Sync the branch");
    expect(list.find((c) => c.name === "/deploy")?.description).toBe("Ship it");
    expect(names).toContain("/check");
    expect(new Set(names).size).toBe(names.length);
  });
  it("copes with missing folders", async () => {
    expect((await claudeCommands(join(dir, "nope"), { labels: {}, cwd: "" })).length).toBeGreaterThan(20);
  });
  it("reads a description only from front matter", () => {
    expect(frontMatterDescription("description: not front matter")).toBe("");
    expect(frontMatterDescription("---\r\ndescription: 'x'\r\n---\r\n")).toBe("x");
  });
});
