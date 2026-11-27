import { describe, expect, it, vi } from "vitest";
import { idleMs, type Settings } from "../settings/store.ts";
import { AutoSleep } from "./auto-sleep.ts";

const HOUR = 3_600_000;
const settings = (every: string): Settings => ({ autosleep: { enabled: true, idle: "3h", every, neverSleep: [] }, inbox: false });

describe("AutoSleep interval (task 075)", () => {
  it("reads the interval from the settings each round", async () => {
    vi.useFakeTimers();
    let cur = settings("30m");
    const sleepIdle = vi.fn(async () => [] as string[]);
    const a = new AutoSleep({ backend: { sleepIdle }, settings: { get: () => cur } });
    a.start();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(sleepIdle).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sleepIdle).toHaveBeenCalledTimes(1);
    cur = settings("1h");
    await vi.advanceTimersByTimeAsync(30 * 60_000); // the round already scheduled still uses 30m
    expect(sleepIdle).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(sleepIdle).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sleepIdle).toHaveBeenCalledTimes(3);
    a.stop();
    vi.useRealTimers();
  });

  it("caps a huge interval instead of firing at once", async () => {
    vi.useFakeTimers();
    const sleepIdle = vi.fn(async () => [] as string[]);
    const a = new AutoSleep({ backend: { sleepIdle }, settings: { get: () => settings("9999d") } });
    a.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sleepIdle).toHaveBeenCalledTimes(0);
    a.stop();
    vi.useRealTimers();
  });

  it("everyMs overrides the setting", async () => {
    vi.useFakeTimers();
    const sleepIdle = vi.fn(async () => [] as string[]);
    const a = new AutoSleep({ backend: { sleepIdle }, settings: { get: () => settings("30m") }, everyMs: 1000 });
    a.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sleepIdle).toHaveBeenCalledTimes(1);
    a.stop();
    vi.useRealTimers();
  });
});

describe("AutoSleep", () => {
  it("reads the settings' idle time", () => {
    expect(idleMs("90m")).toBe(90 * 60_000);
    expect(idleMs("3h")).toBe(3 * HOUR);
    expect(idleMs("1d")).toBe(24 * HOUR);
    expect(idleMs("soon")).toBeNull();
  });

  const store = (autosleep: Settings["autosleep"]) => ({ get: (): Settings => ({ autosleep, inbox: false }) });

  it("sleeps with the settings' idle time and never-sleep list while it is on", async () => {
    const calls: unknown[] = [];
    const backend = { sleepIdle: (idle: number, never: readonly string[], skip?: readonly string[]) => (calls.push([idle, never, skip]), Promise.resolve(["t1"])) };
    const auto = new AutoSleep({ backend, settings: store({ enabled: true, idle: "90m", every: "30m", neverSleep: ["a"] }), self: "t0", waiting: () => new Set(["t9"]) });
    expect(await auto.round()).toEqual(["t1"]);
    expect(calls).toEqual([[90 * 60_000, ["a"], ["t9", "t0"]]]);
  });

  it("does nothing while it is off", async () => {
    let called = false;
    const backend = { sleepIdle: () => ((called = true), Promise.resolve([])) };
    expect(await new AutoSleep({ backend, settings: store({ enabled: false, idle: "1m", every: "30m", neverSleep: [] }) }).round()).toEqual([]);
    expect(called).toBe(false);
  });
});
