import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseIdle, SettingsStore } from "./store.ts";

let dir = "";
let file = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-settings-"));
  file = join(dir, "sub", "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const onDisk = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

describe("SettingsStore (F51)", () => {
  it("starts with auto-sleep on, 3h, nothing exempt, no inbox", () => {
    expect(new SettingsStore(file).get()).toEqual({ autosleep: { enabled: true, idle: "3h", every: "30m", neverSleep: [] }, inbox: false });
  });

  it("takes the check interval, refusing invalid ones", () => {
    const s = new SettingsStore(file);
    expect(s.setEvery("2h")).toBe(true);
    expect(s.get().autosleep.every).toBe("2h");
    expect(s.setEvery("soon")).toBe(false);
    expect(s.setEvery("0m")).toBe(false);
    expect(s.get().autosleep.every).toBe("2h");
    expect(new SettingsStore(file).get().autosleep.every).toBe("2h");
  });

  it("writes the file the auto-sleep job reads, 0600, and reloads it", () => {
    const s = new SettingsStore(file);
    s.setAutosleepEnabled(false);
    expect(s.setIdle(" 90m ")).toBe(true);
    s.setInbox(true);
    expect(s.setNeverSleep("My Space", true)).toBe(true);
    expect(onDisk()).toEqual({ version: 1, autosleep: { enabled: false, idle: "90m", every: "30m", neverSleep: ["My Space"] }, inbox: true });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new SettingsStore(file).get()).toEqual(s.get());
  });

  it("ensureFile writes the defaults once and never overwrites", () => {
    const s = new SettingsStore(file);
    s.ensureFile();
    expect(onDisk()).toMatchObject({ autosleep: { enabled: true, idle: "3h" } });
    s.setIdle("1d");
    s.ensureFile();
    expect(onDisk()).toMatchObject({ autosleep: { idle: "1d" } });
  });

  it("refuses bad thresholds and keeps the old one", () => {
    const s = new SettingsStore(file);
    for (const bad of ["", "soon", "0h", "3", "-1h", "3 h", 3, null]) expect(s.setIdle(bad)).toBe(false);
    expect(s.get().autosleep.idle).toBe("3h");
    expect(parseIdle("07h")).toBe("7h");
  });

  it("never-sleep matches names the way the job does, and follows a rename", () => {
    const s = new SettingsStore(file);
    s.setNeverSleep("My Space", true);
    s.setNeverSleep("my-space", true); // the same space: no duplicate
    expect(s.get().autosleep.neverSleep).toEqual(["my-space"]);
    s.spaceRenamed("my space", "Other");
    expect(s.get().autosleep.neverSleep).toEqual(["Other"]);
    s.setNeverSleep("OTHER", false);
    expect(s.get().autosleep.neverSleep).toEqual([]);
    expect(s.setNeverSleep("  ", true)).toBe(false);
  });

  it("falls back to defaults for a bad file, field by field", () => {
    writeFileSync(join(dir, "bad.json"), "nope");
    expect(new SettingsStore(join(dir, "bad.json")).get().autosleep.idle).toBe("3h");
    writeFileSync(join(dir, "odd.json"), JSON.stringify({ autosleep: { enabled: false, idle: "x", neverSleep: ["a", 5, ""] }, inbox: "yes" }));
    expect(new SettingsStore(join(dir, "odd.json")).get()).toEqual({ autosleep: { enabled: false, idle: "3h", every: "30m", neverSleep: ["a"] }, inbox: false });
  });
});
