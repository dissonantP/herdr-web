import { describe, expect, it } from "vitest";
import { validColour } from "../shared/model.ts";
import { parseAction, runAction } from "./actions.ts";
import type { BackendAdapter, BackendAdmin, TabProgram } from "@herdr/server/adapters/backend.ts";

describe("parseAction", () => {
  it("accepts well-formed actions, trimming names", () => {
    expect(parseAction({ type: "space.rename", id: "spA", name: "  x  " })).toEqual({ type: "space.rename", id: "spA", name: "x" });
    expect(parseAction({ type: "group.delete", id: "g1", children: "lift" })).toEqual({ type: "group.delete", id: "g1", children: "lift" });
    expect(parseAction({ type: "space.move", id: "spA", groupId: null })).toEqual({ type: "space.move", id: "spA", groupId: null });
    expect(parseAction({ type: "group.color", id: "g1", color: "inv:ansi4" })).toEqual({ type: "group.color", id: "g1", color: "inv:ansi4" });
    expect(parseAction({ type: "space.color", id: "spA", color: "dim" })).toEqual({ type: "space.color", id: "spA", color: "dim" });
    expect(parseAction({ type: "space.color", id: "spA", color: null })).toEqual({ type: "space.color", id: "spA", color: null });
    expect(parseAction({ type: "group.color", id: "g1", color: "dim" })).toEqual({ invalid: "bad color" });
    expect(parseAction({ type: "space.color", id: "spA", color: "chartreuse" })).toEqual({ invalid: "bad color" });
    expect(parseAction({ type: "space.quiet", id: "spA", quiet: true })).toEqual({ type: "space.quiet", id: "spA", quiet: true });
    expect(parseAction({ type: "space.create", name: "", folder: "~", groupId: null })).toEqual({ type: "space.create", name: "", folder: "~", groupId: null, parentId: null });
    expect(parseAction({ type: "space.create", name: "", folder: "~", groupId: null, parentId: "spA" })).toEqual({ type: "space.create", name: "", folder: "~", groupId: null, parentId: "spA" });
    expect(parseAction({ type: "space.reparent", id: "spB", parentId: "spA" })).toEqual({ type: "space.reparent", id: "spB", parentId: "spA" });
    expect(parseAction({ type: "space.reparent", id: "spB", parentId: null })).toEqual({ type: "space.reparent", id: "spB", parentId: null });
    expect(parseAction({ type: "space.delete", id: "spA", children: "delete" })).toEqual({ type: "space.delete", id: "spA", children: "delete" });
    // An old client's delete names no children: they move up.
    expect(parseAction({ type: "space.delete", id: "spA" })).toEqual({ type: "space.delete", id: "spA", children: "lift" });
  });

  it("accepts a Claude tab with its form fields, and refuses bad ones", () => {
    const claude = { folder: " ~/x ", model: "opus", effort: "max", permission: "acceptEdits", resume: null };
    expect(parseAction({ type: "tab.create", spaceId: "spA", name: "", claude })).toEqual({ type: "tab.create", spaceId: "spA", name: "", claude: { ...claude, folder: "~/x" } });
    expect(parseAction({ type: "tab.create", spaceId: "spA", name: "" })).toEqual({ type: "tab.create", spaceId: "spA", name: "" });
    const id = "12345678-1234-4234-8234-123456789abc";
    expect(parseAction({ type: "tab.create", spaceId: "spA", name: "", claude: { ...claude, resume: id } })).toMatchObject({ claude: { resume: id } });
    for (const bad of [{ model: "gpt" }, { effort: "huge" }, { permission: "yolo" }, { folder: "" }, { folder: "a\u0000b" }, { resume: "../x" }]) {
      expect(parseAction({ type: "tab.create", spaceId: "spA", name: "", claude: { ...claude, ...bad } })).toHaveProperty("invalid");
    }
    expect(parseAction({ type: "tab.create", spaceId: "spA", name: "", claude: "x" })).toEqual({ invalid: "bad claude" });
  });

  it("accepts a new space that starts Claude", () => {
    const claude = { folder: "~", model: "default", effort: "default", permission: "default", resume: null };
    expect(parseAction({ type: "space.create", name: "x", folder: "~", groupId: null, claude })).toMatchObject({ type: "space.create", claude });
    expect(parseAction({ type: "space.create", name: "x", folder: "~", groupId: null, claude: { ...claude, model: "gpt" } })).toHaveProperty("invalid");
  });

  it("names a new Claude session after its space, but leaves a resume's own title", async () => {
    const programs: (TabProgram | undefined)[] = [];
    const backend = { createSpace: (_n: string, _f: string, _g: null, _p: null, program?: TabProgram) => (programs.push(program), Promise.resolve({})), createTab: (_s: string, _n: string, program?: TabProgram) => (programs.push(program), Promise.resolve({})) } as unknown as BackendAdmin & Pick<BackendAdapter, "sleepPane" | "wakePane" | "markSeen" | "dismissPane">;
    const agent = { startCommand: () => ["claude", "--model", "opus"] };
    const start = { folder: "~", model: "opus", effort: "default", permission: "default", resume: null } as const;
    await runAction(backend, agent, { type: "space.create", name: "My Space", folder: "~/x", groupId: null, parentId: null, claude: start });
    await runAction(backend, agent, { type: "space.create", name: "p", folder: "~", groupId: null, parentId: null });
    await runAction(backend, agent, { type: "tab.create", spaceId: "s", name: "", claude: { ...start, resume: "12345678-1234-4234-8234-123456789abc" } });
    expect(programs[0]?.folder).toBe("~/x");
    expect(programs[0]?.argv("My Space")).toEqual(["claude", "--model", "opus", "-n", "My Space"]);
    expect(programs[1]).toBeUndefined();
    expect(programs[2]?.argv("My Space")).toEqual(["claude", "--model", "opus"]);
  });

  it("accepts sleep and wake for a pane", () => {
    expect(parseAction({ type: "pane.sleep", id: "t7" })).toEqual({ type: "pane.sleep", id: "t7" });
    expect(parseAction({ type: "pane.wake", id: "t7" })).toEqual({ type: "pane.wake", id: "t7" });
    expect(parseAction({ type: "pane.wake" })).toEqual({ invalid: "bad id" });
  });

  it("accepts dismiss for a pane", () => {
    expect(parseAction({ type: "pane.dismiss", id: "t7" })).toEqual({ type: "pane.dismiss", id: "t7" });
  });

  it("accepts seen for a pane", () => {
    expect(parseAction({ type: "pane.seen", id: "t7" })).toEqual({ type: "pane.seen", id: "t7" });
    expect(parseAction({ type: "pane.seen" })).toEqual({ invalid: "bad id" });
  });

  it("refuses anything else", () => {
    expect(parseAction(null)).toEqual({ invalid: "not an action" });
    expect(parseAction({ type: "rm -rf" })).toEqual({ invalid: "unknown action" });
    expect(parseAction({ type: "group.create", name: " ", parentId: null })).toEqual({ invalid: "a name is needed" });
    expect(parseAction({ type: "space.rename", id: "sp A", name: "x" })).toEqual({ invalid: "bad id" });
    expect(parseAction({ type: "tab.rename", id: "tb", name: "a\u0007b" })).toEqual({ invalid: "bad name" });
    expect(parseAction({ type: "tab.rename", id: "tb", name: "x".repeat(200) })).toEqual({ invalid: "bad name" });
    expect(parseAction({ type: "group.delete", id: "g", children: "maybe" })).toEqual({ invalid: "bad children" });
    expect(parseAction({ type: "space.delete" })).toEqual({ invalid: "bad id" });
    expect(parseAction({ type: "space.quiet", id: "spA", quiet: "yes" })).toEqual({ invalid: "bad quiet" });
    expect(parseAction({ type: "space.reparent", id: "spA" })).toEqual({ invalid: "bad parentId" });
    expect(parseAction({ type: "space.delete", id: "spA", children: "all" })).toEqual({ invalid: "bad children" });
  });
});

describe("validColour", () => {
  it("accepts only Desktop's colour tokens", () => {
    for (const ok of ["ansi1", "ansi6", "#d9b54a", "inv:ansi4", "inv:#8a8f98", "dim"]) expect(validColour(ok)).toBe(true);
    for (const bad of ["ansi7", "red", "#fff", "inv:", "inv:dim", "", "ansi1 "]) expect(validColour(bad)).toBe(false);
  });
});
