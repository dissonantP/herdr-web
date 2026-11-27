import { describe, expect, it } from "vitest";
import { level, resetTime, summary } from "./UsageBar.tsx";

describe("usage bar helpers", () => {
  it("summarises the 5-hour and weekly limits", () => {
    expect(summary([{ label: "session", pct: 10, resets: null }, { label: "week (Fable)", pct: 1, resets: null }, { label: "week (all models)", pct: 2, resets: null }])).toBe("5h 10% · wk 2%");
  });
  it("warns from 80% and goes red from 95%", () => {
    expect([79, 80, 94, 95].map(level)).toEqual(["", " usage-warn", " usage-warn", " usage-crit"]);
  });
  it("splits the zone off a reset time", () => {
    expect(resetTime("Nov 24, 1am (America/Los_Angeles)")).toEqual({ time: "Nov 24, 1am", zone: "America/Los_Angeles" });
    expect(resetTime("soon")).toEqual({ time: "soon", zone: null });
  });
});
