import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { BackendAdapter } from "./adapters/backend.ts";
import { attachTerminalSockets, paneIdOf, parseResize, type TerminalSocketGate } from "./terminal-socket.ts";

describe("terminal socket", () => {
  it("accepts only well-formed resize messages", () => {
    expect(parseResize('{"type":"resize","cols":80,"rows":24}')).toEqual({ cols: 80, rows: 24 });
    expect(parseResize('{"type":"resize","cols":0,"rows":24}')).toBeNull();
    expect(parseResize('{"type":"resize","cols":80.5,"rows":24}')).toBeNull();
    expect(parseResize('{"type":"resize","cols":5000,"rows":24}')).toBeNull();
    expect(parseResize('{"type":"input","cols":80,"rows":24}')).toBeNull();
    expect(parseResize("not json")).toBeNull();
  });
  it("reads the pane id from the path, and refuses a malformed one", () => {
    expect(paneIdOf("/api/terminal/t7")).toBe("t7");
    expect(paneIdOf("/api/terminal/a%2Fb")).toBe("a/b");
    expect(paneIdOf("/api/terminal/%E0%A4%A")).toBeNull();
    expect(paneIdOf("/api/other/t7")).toBeNull();
  });
});

// The gate's refusals, on a real server with a stub backend that echoes input.
describe("terminal socket gate", () => {
  const backend = {
    attachTerminal: (_id: string, opts: { onData: (b: Buffer) => void }) => ({ write: (b: Buffer) => opts.onData(b), resize: () => undefined, close: () => undefined }),
  } as unknown as BackendAdapter;
  let server: Server;
  let port = 0;
  let gate: TerminalSocketGate;
  const sessions: (() => void)[] = [];

  beforeEach(async () => {
    sessions.length = 0;
    gate = { ready: () => true, session: () => ({ track: (close) => (sessions.push(close), () => undefined) }), canAttach: (id) => Promise.resolve(id === "t1") };
    server = createServer();
    attachTerminalSockets(server, backend, 60_000, gate);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(() => new Promise<void>((done) => server.close(() => done())));

  /** The upgrade's HTTP status, 101 when it opened. */
  const open = (pane: string, origin = `http://127.0.0.1:${String(port)}`) =>
    new Promise<number>((done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/terminal/${pane}`, { origin });
      ws.on("unexpected-response", (_req, res) => done(res.statusCode ?? 0));
      ws.on("open", () => {
        ws.close();
        done(101);
      });
    });

  it("opens a socket to an allowed pane, tied to the session", async () => {
    expect(await open("t1")).toBe(101);
    expect(sessions).toHaveLength(1);
  });
  it("refuses another origin, no login, an unknown pane, and a gate that is not ready", async () => {
    expect(await open("t1", "http://evil.example")).toBe(403);
    expect(await open("t9")).toBe(404);
    gate.session = () => null;
    expect(await open("t1")).toBe(401);
    gate.ready = () => false;
    expect(await open("t1")).toBe(503);
  });
  it("refuses when the login ends while the pane is looked up", async () => {
    let calls = 0;
    gate.session = () => (++calls === 1 ? { track: () => () => undefined } : null);
    expect(await open("t1")).toBe(401);
  });
});
