import { describe, expect, it } from "vitest";
import type { WireLayout, WireTerminal } from "./client.ts";
import { processStartMs } from "./adapter.ts";
import { autoSleepCandidates, sleepSignal, wakeLine } from "./sleep.ts";

// Task 067: which sessions auto-sleep picks, how a session is ended and resumed.

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function term(address: string, over: Partial<WireTerminal> = {}): WireTerminal {
  return {
    address,
    name: "",
    labels: {},
    state: "live",
    cwd: "/",
    cols: 80,
    rows: 24,
    title: "",
    status: { state: "idle", app: "claude-code", kind: "" },
    statusMs: NOW - 4 * HOUR,
    pid: 7,
    foreground: { name: "claude", cwd: "/", pid: 42 },
    parent: "",
    ...over,
  };
}

const layout: WireLayout = {
  spaces: [
    { id: "s1", name: "Work Space", folder: "/", tabs: [{ id: "tb1", name: "", blocks: [{ id: "b1", terminal: "t1", mod: "" }, { id: "b2", terminal: "t2", mod: "" }] }] },
    { id: "s2", name: "keep-me", folder: "/", tabs: [{ id: "tb2", name: "", blocks: [{ id: "b3", terminal: "t3", mod: "" }] }] },
  ],
} as unknown as WireLayout;

const rules = { idleMs: 3 * HOUR, neverSleep: [] as string[], now: NOW };

describe("autoSleepCandidates", () => {
  it("picks a Claude idle or done for longer than the idle time", () => {
    const ts = [term("t1"), term("t2", { status: { state: "done", app: "claude-code", kind: "" } })];
    expect(autoSleepCandidates(ts, layout, rules)).toEqual(["t1", "t2"]);
  });

  it("never picks a working or waiting (blocked) session, however long ago it changed", () => {
    const ts = [term("t1", { status: { state: "working", app: "claude-code", kind: "" } }), term("t2", { status: { state: "blocked", app: "claude-code", kind: "permission" } })];
    expect(autoSleepCandidates(ts, layout, rules)).toEqual([]);
  });

  it("leaves a session idle for less than the idle time, or with no status time", () => {
    expect(autoSleepCandidates([term("t1", { statusMs: NOW - HOUR }), term("t2", { statusMs: null })], layout, rules)).toEqual([]);
  });

  it("counts idle time from when this Claude started, so a woken session is not slept again at once", () => {
    // Idle reported 4 h ago (before it slept), but this process was first seen a minute ago.
    expect(autoSleepCandidates([term("t1")], layout, { ...rules, awakeSince: () => NOW - 60_000 })).toEqual([]);
    expect(autoSleepCandidates([term("t1")], layout, { ...rules, awakeSince: () => NOW - 3.5 * HOUR })).toEqual(["t1"]);
  });

  it("skips panes the app sees waiting on a menu", () => {
    expect(autoSleepCandidates([term("t1"), term("t2")], layout, { ...rules, skip: new Set(["t1"]) })).toEqual(["t2"]);
  });

  it("skips panes labelled herdr.nosleep", () => {
    expect(autoSleepCandidates([term("t1", { labels: { "herdr.nosleep": "autopilot" } }), term("t2")], layout, rules)).toEqual(["t2"]);
  });

  it("skips never-sleep spaces by name, ignoring case, spaces, dashes and underscores", () => {
    const ts = [term("t1"), term("t3")];
    expect(autoSleepCandidates(ts, layout, { ...rules, neverSleep: ["work_space", "KEEP ME"] })).toEqual([]);
    // A terminal not in the layout is matched by its `where` label's space part.
    expect(autoSleepCandidates([term("t9", { labels: { where: "keep me / 1" } })], layout, { ...rules, neverSleep: ["keep-me"] })).toEqual([]);
  });

  it("skips what isn't a running Claude: a shell, an asleep pane, a finished or remote terminal, herdr's own", () => {
    const ts = [
      term("t1", { foreground: { name: "bash", cwd: "/" } }),
      term("t2", { foreground: { name: "bash", cwd: "/" }, labels: { "sleep.session": "x" } }),
      term("t3", { state: "finished" }),
      term("box/t4"),
      term("t5"),
    ];
    expect(autoSleepCandidates(ts, layout, { ...rules, skip: new Set(["t5"]) })).toEqual([]);
  });
});

describe("sleep and wake details", () => {
  it("kills a terminal whose own program is Claude (so keep gives it a shell), and terminates one under a shell", () => {
    expect(sleepSignal(term("t1", { pid: 42 }))).toBe("SIGKILL");
    expect(sleepSignal(term("t1", { pid: 7 }))).toBe("SIGTERM");
  });

  it("types a cd and the resume command, quoting what needs it", () => {
    expect(wakeLine("/home/u/my app", ["/home/u/.local/bin/claude", "--resume", "22222222-2222-4222-8222-222222222222"])).toBe(
      "cd '/home/u/my app' && /home/u/.local/bin/claude --resume 22222222-2222-4222-8222-222222222222",
    );
    expect(wakeLine("/tmp/it's", ["claude"])).toBe("cd '/tmp/it'\\''s' && claude");
  });
});

describe("processStartMs", () => {
  it("reads when a process started, so a restarted backend or a late switch-on still counts its whole idle time", () => {
    const started = processStartMs(process.pid);
    expect(Date.now() - started).toBeGreaterThanOrEqual(0);
    expect(Date.now() - started).toBeLessThan(10 * 60_000);
    expect(processStartMs(undefined)).toBe(0);
    expect(processStartMs(2 ** 30)).toBe(0);
  });
});
