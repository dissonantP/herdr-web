import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTerminal } from "./terminalConnection.ts";

// F26: when the server closes a terminal socket because its capped lifetime ran out (code 4001),
// the client reconnects at once without showing "reconnecting"; other drops use the backoff.

class FakeSocket {
  static all: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 1;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: unknown = null;
  onclose: ((e: { code: number }) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(): void {}
  close(): void {}
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("window", { location: { protocol: "https:", host: "herdr.test" } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function handlers() {
  const states: string[] = [];
  return { states, h: { onOutput: () => undefined, onFreshStart: () => undefined, onState: (s: string) => states.push(s), onOpen: () => undefined } };
}

describe("terminal connection lifetime", () => {
  it("reconnects immediately and silently after the lifetime close", () => {
    const { states, h } = handlers();
    connectTerminal("p1", h);
    FakeSocket.all[0]?.onopen?.();
    expect(states).toEqual(["connecting", "live"]);
    FakeSocket.all[0]?.onclose?.({ code: 4001 });
    vi.advanceTimersByTime(0);
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1]?.url).toBe("wss://herdr.test/api/terminal/p1");
    expect(states).toEqual(["connecting", "live"]); // no "reconnecting" flash
  });

  it("other drops back off and say reconnecting", () => {
    const { states, h } = handlers();
    connectTerminal("p1", h);
    FakeSocket.all[0]?.onopen?.();
    FakeSocket.all[0]?.onclose?.({ code: 1006 });
    expect(states.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(0);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(600);
    expect(FakeSocket.all).toHaveLength(2);
  });
});
