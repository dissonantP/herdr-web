import { describe, expect, it } from "vitest";
import { ClaudeCodeAgent } from "./agent.ts";

const facts = (app: string, state: string, foreground = "") => ({ app, state, blockedOn: "", foreground });

describe("ClaudeCodeAgent", () => {
  const agent = new ClaudeCodeAgent();
  it("recognises Claude Code by its own report and maps its state", () => {
    expect(agent.recognise(facts("claude-code", "working"))).toEqual({ agent: "claude", status: "working" });
    expect(agent.recognise(facts("claude-code", "blocked"))).toEqual({ agent: "claude", status: "waiting" });
    expect(agent.recognise(facts("claude-code", "done"))).toEqual({ agent: "claude", status: "idle" });
  });
  it("falls back to the process name before the first report", () => {
    expect(agent.recognise(facts("", "", "claude"))).toEqual({ agent: "claude", status: null });
  });
  it("leaves other programs alone", () => {
    expect(agent.recognise(facts("", "", "bash"))).toBeNull();
    expect(agent.recognise(facts("omp", "working", "claude"))).toBeNull();
  });
  it("says a screen needs input when a menu is waiting on it", () => {
    expect(agent.needsInput("❯ hello\n")).toBe(false);
    expect(agent.needsInput(" Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n")).toBe(true);
  });
});

describe("startCommand", () => {
  it("adds the form's flags, leaving defaults out", () => {
    const agent = new ClaudeCodeAgent("", ["/bin/claude"]);
    expect(agent.startCommand({ folder: "~", model: "sonnet", effort: "high", permission: "plan", resume: null })).toEqual(["/bin/claude", "--model", "sonnet", "--effort", "high", "--permission-mode", "plan"]);
    expect(agent.startCommand({ folder: "~", model: "default", effort: "default", permission: "default", resume: "12345678-1234-4234-8234-123456789abc" })).toEqual(["/bin/claude", "--resume", "12345678-1234-4234-8234-123456789abc"]);
  });
});
