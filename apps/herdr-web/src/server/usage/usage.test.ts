import { describe, expect, it } from "vitest";
import { parseUsage, UsageService } from "./usage.ts";

const OUT = `You are currently using your subscription to power your Claude Code usage

Current session: 10% used · resets Nov 17, 11am (America/Los_Angeles)
Current week (all models): 2% used · resets Nov 24, 1am (America/Los_Angeles)
Current week (Fable): 0% used · resets Nov 24, 1am (America/Los_Angeles)

What's contributing to your usage?`;

describe("parseUsage", () => {
  it("reads the limit lines", () => {
    expect(parseUsage(OUT)).toEqual([
      { label: "session", pct: 10, resets: "Nov 17, 11am (America/Los_Angeles)" },
      { label: "week (all models)", pct: 2, resets: "Nov 24, 1am (America/Los_Angeles)" },
      { label: "week (Fable)", pct: 0, resets: "Nov 24, 1am (America/Los_Angeles)" },
    ]);
  });
  it("gives nothing for other text", () => expect(parseUsage("Error: not logged in")).toEqual([]));
});

describe("UsageService", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  it("runs once per TTL, never twice at once, and retries a failure only after the TTL", async () => {
    let calls = 0;
    let now = 0;
    let fail = false;
    let release: (() => void) | null = null;
    const svc = new UsageService(
      () =>
        new Promise((resolve, reject) => {
          calls++;
          release = () => (fail ? reject(new Error("boom")) : resolve(OUT));
        }),
      1000,
      () => now,
    );
    expect(svc.get()).toMatchObject({ snapshot: null, loading: true });
    svc.get();
    expect(calls).toBe(1);
    release!();
    await settle();
    expect(svc.get().snapshot?.limits[0]?.pct).toBe(10);
    expect(calls).toBe(1);
    now = 1000;
    fail = true;
    expect(svc.get().loading).toBe(true);
    release!();
    await settle();
    const after = svc.get();
    expect(after).toMatchObject({ loading: false, error: "boom" });
    expect(after.snapshot?.limits).toHaveLength(3);
    expect(calls).toBe(2);
    now = 2000;
    svc.get();
    expect(calls).toBe(3);
  });
});
