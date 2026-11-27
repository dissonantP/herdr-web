import { describe, expect, it, vi } from "vitest";
import type { RawTree } from "@herdr/server/adapters/backend.ts";
import type { AgentAdapter } from "@herdr/server/adapters/agent.ts";
import { decorate, TreeService, type TreeSource } from "./tree-service.ts";

const raw = (name: string): RawTree => ({
  spaces: [{ id: "sp1", name, quiet: false, color: null, children: [], tabs: [{ id: "tb1", name: "1", panes: [{ id: "t1", kind: "terminal", name: "c", program: { app: "claude-code", state: "working", blockedOn: "", foreground: "claude" }, asleep: false }] }] }],
  groups: [],
});

const fakeAgent: AgentAdapter = {
  name: "claude",
  chat: true,
  transcript: () => Promise.resolve(null),
  conversations: () => Promise.resolve([]),
  runningSession: () => Promise.resolve(null),
  startCommand: () => [],
  parser: () => ({ feed: () => [] }),
  recognise: (p) => (p.app === "claude-code" ? { agent: "claude", status: "working" } : null),
  needsInput: (screen) => screen.includes("MENU"),
  readMenu: () => null,
  draft: () => null,
  answerSteps: () => ({ refused: "no" }),
  commands: () => Promise.resolve([]),
};

describe("decorate unseen", () => {
  const withState = (state: string, unseen: boolean): RawTree => ({ ...raw("a"), spaces: [{ ...raw("a").spaces[0]!, tabs: [{ id: "tb1", name: "1", panes: [{ id: "t1", kind: "terminal", name: "c", program: { app: "claude-code", state, blockedOn: "", foreground: "claude", unseen }, asleep: false }] }] }] });
  const idleAgent: AgentAdapter = { ...fakeAgent, recognise: (p) => ({ agent: "claude", status: p.state === "working" ? "working" : "idle" }) };
  it("flags an idle pane whose finished turn is unseen, and nothing else", () => {
    expect(decorate(withState("done", true), [idleAgent]).spaces[0]?.tabs[0]?.panes[0]?.unseen).toBe(true);
    expect(decorate(withState("done", false), [idleAgent]).spaces[0]?.tabs[0]?.panes[0]?.unseen).toBeUndefined();
    expect(decorate(withState("working", true), [idleAgent]).spaces[0]?.tabs[0]?.panes[0]?.unseen).toBeUndefined();
  });
});

describe("decorate dismissed", () => {
  const tree: RawTree = { ...raw("a"), spaces: [{ ...raw("a").spaces[0]!, tabs: [{ id: "tb1", name: "1", panes: [{ id: "t1", kind: "terminal", name: "c", program: { app: "claude-code", state: "done", blockedOn: "", foreground: "claude", dismissed: true }, asleep: false }] }] }] };
  const dismissed = (waiting: ReadonlySet<string>) => decorate(tree, [fakeAgent], waiting).spaces[0]?.tabs[0]?.panes[0]?.dismissed;
  it("carries the dismissal, but not for a pane whose screen shows a menu", () => {
    expect(dismissed(new Set())).toBe(true);
    expect(dismissed(new Set(["t1"]))).toBeUndefined();
  });
});

class FakeBackend implements TreeSource {
  tree = raw("a");
  fail = false;
  onChange: () => void = () => {};
  readTree() {
    return this.fail ? Promise.reject(new Error("core down")) : Promise.resolve(this.tree);
  }
  watch(onChange: () => void) {
    this.onChange = onChange;
    return () => {};
  }
  screen = "";
  readScreen() {
    return Promise.resolve(this.screen);
  }
}

describe("TreeService", () => {
  it("decorates panes with the agent reading and whether they can chat", async () => {
    const service = new TreeService(new FakeBackend(), [fakeAgent]);
    const message = await service.get();
    expect(message.ok && message.tree.spaces[0]?.tabs[0]?.panes[0]).toMatchObject({ agent: "claude", status: "working", chat: true });
  });

  it("an asleep pane is no agent, whatever status the killed Claude last reported", async () => {
    const asleepRaw = (asleep: boolean, app: string): RawTree => ({
      groups: [],
      spaces: [{ id: "sp1", name: "a", quiet: false, color: null, children: [], tabs: [{ id: "tb1", name: "1", panes: [{ id: "t1", kind: "terminal", name: "c", asleep, program: { app, state: "", blockedOn: "", foreground: app === "" ? "bash" : "claude" } }] }] }],
    });
    const backend = new FakeBackend();
    backend.tree = asleepRaw(true, "claude-code");
    const service = new TreeService(backend, [fakeAgent]);
    const pane = async () => {
      const m = await service.get();
      return m.ok ? m.tree.spaces[0]?.tabs[0]?.panes[0] : undefined;
    };
    expect(await pane()).toMatchObject({ asleep: true, agent: null, chat: true });
    backend.tree = asleepRaw(false, "claude-code"); // woken: Claude is the foreground again
    await service.refresh();
    expect(await pane()).toMatchObject({ asleep: false, agent: "claude" });
  });

  it("marks a pane waiting while its screen shows a menu its program did not report (F4)", async () => {
    const backend = new FakeBackend();
    backend.screen = "working...";
    const service = new TreeService(backend, [fakeAgent]);
    const status = async () => {
      const m = await service.get();
      return m.ok ? m.tree.spaces[0]?.tabs[0]?.panes[0]?.status : null;
    };
    await service.scan();
    expect(await status()).toBe("working");
    backend.screen = "a MENU is up";
    await service.scan();
    expect(await status()).toBe("waiting");
    backend.screen = "answered";
    await service.scan();
    expect(await status()).toBe("working");
  });

  it("tells listeners only about real changes, and about the core going down", async () => {
    vi.useFakeTimers();
    const backend = new FakeBackend();
    const service = new TreeService(backend, []);
    const seen: string[] = [];
    service.subscribe((m) => seen.push(m.ok ? (m.tree.spaces[0]?.name ?? "") : `error: ${m.error}`));
    service.start();
    await vi.advanceTimersByTimeAsync(500); // the read settles (the screen scan runs on its own timer)
    backend.onChange();
    await vi.advanceTimersByTimeAsync(500); // the read settles (the screen scan runs on its own timer)
    backend.tree = raw("b");
    backend.onChange();
    backend.onChange();
    await vi.advanceTimersByTimeAsync(500); // the read settles (the screen scan runs on its own timer)
    backend.fail = true;
    backend.onChange();
    await vi.advanceTimersByTimeAsync(500); // the read settles (the screen scan runs on its own timer)
    expect(seen).toEqual(["a", "b", "error: core down"]);
    service.stop();
    vi.useRealTimers();
  });
});
