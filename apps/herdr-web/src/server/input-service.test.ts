import { describe, expect, it, vi } from "vitest";
import type { ChatMenu, MenuAnswer } from "../shared/chat.ts";
import type { AgentAdapter } from "@herdr/server/adapters/agent.ts";
import { AdminError } from "@herdr/server/adapters/backend.ts";
import type { InputStep } from "@herdr/server/adapters/chat.ts";
import { parseAnswer } from "./http.ts";
import type { BackendInput } from "@herdr/server/adapters/backend.ts";
import { answerMenu, safeName, sendMessage, upload, watchMenu } from "./input-service.ts";

// The input service is agent-neutral: a fake agent says which menu a screen shows and which steps
// answer it; these tests check the service does exactly those through the backend, and refuses when
// the screen no longer shows the menu the answer was for.

const menu = (id: string): ChatMenu => ({ id, kind: "question", multi: false, title: "Q?", detail: "", options: [], other: null, submit: null, steps: [] });

class FakeBackend implements BackendInput {
  screens: string[] = [];
  done: string[] = [];
  readScreen() {
    const s = this.screens.length > 1 ? this.screens.shift() : this.screens[0];
    return Promise.resolve(s ?? "");
  }
  pressKeys(_: string, keys: readonly string[]) {
    this.done.push(`keys ${keys.join(" ")}`);
    return Promise.resolve();
  }
  typeText(_: string, text: string) {
    this.done.push(`type ${text}`);
    return Promise.resolve();
  }
  sendText(_: string, text: string, force: boolean) {
    this.done.push(`${force ? "send!" : "send"} ${text}`);
    return Promise.resolve();
  }
  interrupt() {
    return Promise.resolve("stopped");
  }
  putFile(_: string, name: string, bytes: Uint8Array) {
    this.done.push(`put ${name} ${String(bytes.length)}`);
    return Promise.resolve(`/files/${name}`);
  }
}

function agentWith(steps: readonly InputStep[]): AgentAdapter {
  return {
    name: "fake",
    chat: true,
    recognise: () => null,
    needsInput: (s) => s.startsWith("MENU"),
    transcript: () => Promise.resolve(null),
    conversations: () => Promise.resolve([]),
    runningSession: () => Promise.resolve(null),
    startCommand: () => [],
    parser: () => ({ feed: () => [] }),
    readMenu: (s) => (s.startsWith("MENU") ? menu(s) : null),
    draft: (s) => (s.startsWith("❯") ? s.slice(1).trim() : null),
    answerSteps: (_s, a) => (a.action === "pick" && a.n === 9 ? { refused: "no such option" } : steps),
    commands: () => Promise.resolve([]),
  };
}

const pick = (id: string, n = 1): MenuAnswer => ({ id, action: "pick", n });

describe("answerMenu", () => {
  it("does the agent's steps in order, re-reading the screen for an until step, then returns the menu that follows", async () => {
    const backend = new FakeBackend();
    backend.screens = ["MENU a", "MENU a", "MENU a focused", "MENU a", "MENU b"];
    const agent = agentWith([{ kind: "keys", keys: ["3"] }, { kind: "until", test: (s) => s.endsWith("focused"), timeoutMs: 2000, error: "no focus" }, { kind: "send", text: "Teal" }]);
    expect((await answerMenu(backend, agent, "t1", pick("MENU a")))?.id).toBe("MENU b");
    expect(backend.done).toEqual(["keys 3", "send! Teal"]);
  });
  it("answers to one pane run one at a time: the second is checked against the screen the first left", async () => {
    const backend = new FakeBackend();
    backend.screens = ["MENU a", "MENU b"];
    const agent = agentWith([{ kind: "keys", keys: ["1"] }]);
    const first = answerMenu(backend, agent, "t1", pick("MENU a"));
    const second = answerMenu(backend, agent, "t1", pick("MENU a"));
    expect((await first)?.id).toBe("MENU b");
    await expect(second).rejects.toThrow(/changed/u);
    expect(backend.done).toEqual(["keys 1"]);
  });
  it("refuses when the screen shows another menu, or none, and presses nothing", async () => {
    const backend = new FakeBackend();
    const agent = agentWith([{ kind: "keys", keys: ["1"] }]);
    backend.screens = ["MENU b"];
    await expect(answerMenu(backend, agent, "t1", pick("MENU a"))).rejects.toThrow(/changed/u);
    backend.screens = ["idle"];
    await expect(answerMenu(backend, agent, "t1", pick("MENU a"))).rejects.toThrow(AdminError);
    backend.screens = ["MENU a"];
    await expect(answerMenu(backend, agent, "t1", pick("MENU a", 9))).rejects.toThrow("no such option");
    expect(backend.done).toEqual([]);
  });
  it("an until step that never holds fails with its reason, and stops there", async () => {
    const backend = new FakeBackend();
    backend.screens = ["MENU a"];
    const agent = agentWith([{ kind: "keys", keys: ["esc"] }, { kind: "until", test: () => false, timeoutMs: 200, error: "did not close" }, { kind: "send", text: "hi" }]);
    await expect(answerMenu(backend, agent, "t1", pick("MENU a"))).rejects.toThrow("did not close");
    expect(backend.done).toEqual(["keys esc"]);
  });
});

describe("sendMessage and upload", () => {
  it("sends a message, but not while a menu waits or when empty", async () => {
    const backend = new FakeBackend();
    const agent = agentWith([]);
    backend.screens = ["❯ "];
    await sendMessage(backend, agent, "t1", "hello");
    expect(backend.done).toEqual(["send hello"]); // not forced: a program blocked on a dialog refuses it
    backend.screens = ["MENU a"];
    await expect(sendMessage(backend, agent, "t1", "hello")).rejects.toThrow(/answer it first/u);
    await expect(sendMessage(backend, agent, "t1", "   ")).rejects.toThrow(AdminError);
    // Text already in the box (a desk draft, or a suggestion Claude shows) is cleared first.
    backend.done = [];
    backend.screens = ["❯ half a thought", "❯ half", "❯ ", "❯ "];
    await sendMessage(backend, agent, "t1", "hello");
    expect(backend.done).toEqual(["keys ctrl+e ctrl+u", "keys ctrl+e ctrl+u", "send hello"]);
    // A grey suggestion a plain read keeps showing: clearing changes nothing, the message goes anyway.
    backend.done = [];
    backend.screens = ["❯ run it"];
    await sendMessage(backend, agent, "t1", "hello");
    expect(backend.done).toEqual(["keys ctrl+e ctrl+u", "send hello"]);
  });
  it("wakes a sleeping session first and sends once Claude is up (task 137); an awake one is not woken", async () => {
    const backend = new FakeBackend();
    const agent = agentWith([]);
    backend.screens = ["❯ "];
    const events: string[] = [];
    let asleep = true;
    let ups = 0;
    const waker = {
      asleep: () => Promise.resolve(asleep),
      wake: () => {
        events.push("wake");
        asleep = false;
        return Promise.resolve();
      },
      up: () => Promise.resolve(++ups > 1),
    };
    vi.useFakeTimers();
    const sending = sendMessage(backend, agent, "t1", "hello", waker);
    await vi.advanceTimersByTimeAsync(0);
    // Up and prompt drawn, but a resumed Claude is still starting: nothing typed yet (task 139).
    expect(backend.done).toEqual([]);
    backend.screens = ["❯ "];
    await vi.advanceTimersByTimeAsync(6000);
    await sending;
    vi.useRealTimers();
    expect(events).toEqual(["wake"]);
    expect(ups).toBe(2);
    expect(backend.done).toEqual(["send hello"]);
    await sendMessage(backend, agent, "t1", "again", waker); // awake now: no second wake
    expect(events).toEqual(["wake"]);
  });
  it("presses Enter when a woken Claude kept the text in its box, and gives up the wake with failed() when it never comes up (task 139)", async () => {
    vi.useFakeTimers();
    const backend = new FakeBackend();
    backend.screens = ["❯ ", "❯ ", "❯ ", "❯ hello there"];
    const up = { asleep: () => Promise.resolve(true), wake: () => Promise.resolve(), up: () => Promise.resolve(true) };
    // Not waited (already up): no check, no extra Enter.
    const direct = sendMessage(backend, agentWith([]), "t1", "hello there", { ...up, asleep: () => Promise.resolve(false) });
    await vi.advanceTimersByTimeAsync(10_000);
    await direct;
    expect(backend.done).toEqual(["send hello there"]);
    // Woken, and the text stays in the box: Enter.
    backend.done = [];
    let ups = 0;
    backend.screens = ["❯ ", "❯ hello there"];
    const stuck = sendMessage(backend, agentWith([]), "t1", "hello there", { ...up, up: () => Promise.resolve(++ups > 1) });
    await vi.advanceTimersByTimeAsync(30_000);
    await stuck;
    expect(backend.done.at(-1)).toBe("keys enter");
    // Never comes up: the failure is reported and failed() undoes the wake.
    let undone = false;
    const never = sendMessage(backend, agentWith([]), "t1", "hi", { ...up, up: () => Promise.resolve(false), failed: () => ((undone = true), Promise.resolve()) });
    const caught = never.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(String(await caught)).toMatch(/didn't wake up in time/u);
    expect(undone).toBe(true);
    vi.useRealTimers();
  });
  it("refuses to send when it can't tell whether the session sleeps (the text would run in a shell)", async () => {
    const backend = new FakeBackend();
    backend.screens = ["❯ "];
    const waker = { asleep: () => Promise.reject(new AdminError("unknown")), wake: () => Promise.resolve(), up: () => Promise.resolve(true) };
    await expect(sendMessage(backend, agentWith([]), "t1", "rm -rf x", waker)).rejects.toThrow(/unknown/u);
    expect(backend.done).toEqual([]);
  });
  it("clears a multi-line draft row by row, and refuses when the box never empties", async () => {
    const backend = new FakeBackend();
    const agent = agentWith([]);
    backend.screens = ["❯ a", "❯ b", "❯ c", "❯ "];
    await sendMessage(backend, agent, "t1", "hi");
    expect(backend.done.filter((d) => d.startsWith("keys")).length).toBe(3);
    // Every press changes the screen but the box never empties.
    let n = 0;
    const busy = new FakeBackend();
    busy.readScreen = () => Promise.resolve(`❯ row ${String(n++)}`);
    await expect(sendMessage(busy, agent, "t1", "hi")).rejects.toThrow(/Couldn't clear/u);
    expect(busy.done.some((d) => d.startsWith("send"))).toBe(false);
  });
  it("puts a file under a safe name and gives back its path", async () => {
    const backend = new FakeBackend();
    expect(await upload(backend, "t1", "../../my photo (1).png", new Uint8Array(3))).toBe("/files/my_photo__1_.png");
    await expect(upload(backend, "t1", "a", new Uint8Array(0))).rejects.toThrow(AdminError);
    expect(safeName("...")).toBe("upload");
    expect(safeName("C:\\x\\.env")).toBe("env");
  });
});

describe("watchMenu", () => {
  it("reports the menu when it changes, not on every read", async () => {
    const backend = new FakeBackend();
    backend.screens = ["idle", "MENU a", "MENU a", "idle"];
    const seen: (string | null)[] = [];
    const watch = watchMenu(backend, agentWith([]), "t1", (m) => seen.push(m?.id ?? null), 5);
    await new Promise((r) => setTimeout(r, 80));
    watch.close();
    expect(seen).toEqual([null, "MENU a", null]);
  });
});

describe("parseAnswer", () => {
  it("takes the four answers and refuses anything else", () => {
    expect(parseAnswer({ id: "m", action: "pick", n: 2 })).toEqual({ id: "m", action: "pick", n: 2 });
    expect(parseAnswer({ id: "m", action: "toggle", n: 1 })).toEqual({ id: "m", action: "toggle", n: 1 });
    expect(parseAnswer({ id: "m", action: "submit" })).toEqual({ id: "m", action: "submit" });
    expect(parseAnswer({ id: "m", action: "other", text: "x" })).toEqual({ id: "m", action: "other", text: "x" });
    expect(parseAnswer({ id: "m", action: "pick", n: 0 })).toHaveProperty("invalid");
    expect(parseAnswer({ id: "m", action: "pick", n: "1" })).toHaveProperty("invalid");
    expect(parseAnswer({ action: "submit" })).toHaveProperty("invalid");
    expect(parseAnswer({ id: "m", action: "rm" })).toHaveProperty("invalid");
  });
});
