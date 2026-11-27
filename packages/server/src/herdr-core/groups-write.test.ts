import { mkdtempSync, readFileSync, renameSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addGroup, formatGroups, newGroupId, parseForEdit, removeGroup, renameGroup, setGroupColor, setSpaceColor, setSpaceGroup, updateGroups, type RawGroupsFile } from "./groups-write.ts";
import { parseGroups } from "./groups.ts";

const fixture = (): RawGroupsFile => ({
  version: 2,
  groups: [
    { id: "gw", name: "work", parent: null, parentId: null, color: "ansi2" },
    { id: "gi", name: "inner", parent: "work", parentId: "gw", color: null },
  ],
  spaces: { spA: { name: "a", group: "inner", groupId: "gi", color: null }, spB: { name: "b", group: "work", groupId: "gw", color: "dim" } },
});

const file = (body: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-groups-test-"));
  const path = join(dir, "groups.json");
  writeFileSync(path, JSON.stringify(body, null, 2));
  return { dir, path, read: () => JSON.parse(readFileSync(path, "utf8")) as RawGroupsFile };
};

describe("groups file edits", () => {
  it("adds a group with exactly Desktop's fields", () => {
    const b = fixture();
    addGroup(b, { id: "gn", name: "new", parentId: "gw" });
    expect(b.groups[2]).toEqual({ id: "gn", name: "new", parent: "work", parentId: "gw", color: null });
  });

  it("renames a group and the name copies of it", () => {
    const b = fixture();
    expect(renameGroup(b, "gw", "job")).toBe(true);
    expect(b.groups[1]?.parent).toBe("job");
    expect(b.spaces.spB?.group).toBe("job");
    expect(renameGroup(b, "nope", "x")).toBe(false);
  });

  it("sets and clears a group's colour, inv: included", () => {
    const b = fixture();
    expect(setGroupColor(b, "gi", "ansi4")).toBe(true);
    expect(setGroupColor(b, "gi", "inv:#d9b54a")).toBe(true);
    expect(b.groups[1]?.color).toBe("inv:#d9b54a");
    expect(setGroupColor(b, "gw", null)).toBe(true);
    expect(b.groups[0]?.color).toBeNull();
    expect(setGroupColor(b, "gw", null)).toBe(false);
    expect(setGroupColor(b, "nope", "ansi1")).toBe(false);
    expect(parseGroups(formatGroups(b)).groups[1]?.color).toBe("inv:#d9b54a");
  });

  it("sets a space's colour, none (follow group) and dim, adding its entry when missing", () => {
    const b = fixture();
    expect(setSpaceColor(b, "spA", "a", "inv:ansi2")).toBe(true);
    expect(b.spaces.spA?.color).toBe("inv:ansi2");
    expect(setSpaceColor(b, "spB", "b", null)).toBe(true);
    expect(b.spaces.spB?.color).toBeNull();
    expect(setSpaceColor(b, "spA", "a", "dim")).toBe(true);
    expect(b.spaces.spA?.color).toBe("dim");
    expect(setSpaceColor(b, "spN", "n", "ansi3")).toBe(true);
    expect(b.spaces.spN).toEqual({ name: "n", group: null, groupId: null, color: "ansi3" });
    expect(setSpaceColor(b, "spZ", "z", null)).toBe(false);
    expect(parseGroups(formatGroups(b)).spaceColor.get("spA")).toBe("dim");
  });

  it("moves a space into a group, out of groups, or adds its entry", () => {
    const b = fixture();
    setSpaceGroup(b, "spA", "a", null);
    expect(b.spaces.spA).toEqual({ name: "a", group: null, groupId: null, color: null });
    setSpaceGroup(b, "spN", "n", "gi");
    expect(b.spaces.spN).toEqual({ name: "n", group: "inner", groupId: "gi", color: null });
    expect(parseGroups(formatGroups(b)).groupOf.get("spN")).toBe("gi");
  });

  it("deletes a group lifting what is inside, or with its subtree", () => {
    const lifted = fixture();
    removeGroup(lifted, "gw", true);
    expect(lifted.groups).toEqual([{ id: "gi", name: "inner", parent: null, parentId: null, color: null }]);
    expect(lifted.spaces.spB?.groupId).toBeNull();
    const gone = fixture();
    removeGroup(gone, "gw", false);
    expect(gone.groups).toEqual([]);
  });

  it("refuses to edit a file that is not JSON; a missing one starts empty", () => {
    expect(parseForEdit("{nope")).toBeNull();
    expect(parseForEdit(null)).toEqual({ version: 2, groups: [], spaces: {} });
  });

  it("makes ids like Desktop's", () => {
    expect(newGroupId(1_700_000_000_000)).toMatch(/^g[0-9a-z]+$/u);
  });
});

describe("updateGroups", () => {
  it("writes atomically, formatted as Desktop's mod does, leaving no tmp file", async () => {
    const f = file(fixture());
    await updateGroups(f.path, (b) => renameGroup(b, "gi", "in"));
    expect(readFileSync(f.path, "utf8")).toBe(`${JSON.stringify({ ...fixture(), groups: [fixture().groups[0], { ...fixture().groups[1], name: "in" }], spaces: { ...fixture().spaces, spA: { ...fixture().spaces.spA, group: "in" } } }, null, 1)}\n`);
    expect(readdirSync(f.dir)).toEqual(["groups.json"]);
  });

  it("keeps a Desktop write that lands while it works, and applies its own edit on top", async () => {
    const f = file(fixture());
    let raced = false;
    await updateGroups(f.path, (b) => renameGroup(b, "gi", "in"), {
      beforeReplace: () => {
        if (raced) return;
        raced = true;
        // Desktop adds a group, whole file, tmp + mv.
        const desktop = fixture();
        desktop.groups.push({ id: "gd", name: "desk", parent: null, parentId: null, color: null });
        writeFileSync(`${f.path}.tmp`, JSON.stringify(desktop, null, 1));
        renameSync(`${f.path}.tmp`, f.path);
      },
    });
    const after = f.read();
    expect(after.groups.map((g) => `${g.id}:${g.name}`)).toEqual(["gw:work", "gi:in", "gd:desk"]);
    expect(readdirSync(f.dir)).toEqual(["groups.json"]);
  });

  it("does not write when there is nothing to change", async () => {
    const f = file(fixture());
    const before = readFileSync(f.path, "utf8");
    await updateGroups(f.path, () => false);
    expect(readFileSync(f.path, "utf8")).toBe(before);
  });
});
