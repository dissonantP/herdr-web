import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";
import WebSocket from "ws";
import { authed } from "../support/auth.ts";
import { seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F25: the backend serves only the allowed source address; any other is refused. F26: SSE and terminal streams end after the capped lifetime. Own backends against the
// isolated QA core. No page involved, so they run once (the phone project).

test.skip(({ isMobile }) => !isMobile, "no page involved");

let pane = "";
test.beforeEach(async () => {
  pane = (await seed(qaCore())).terminals.betaA ?? "";
});

const portFor = (offset: number) => Number(process.env.HERDR_QA_PORT) + 1100 + offset;

function startBackend(port: number, extra: Record<string, string | undefined>): ChildProcess {
  const env: Record<string, string | undefined> = { ...qaCore().childEnv(), HERDR_HOST: "127.0.0.1", HERDR_PORT: String(port), ...extra };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return spawn(process.execPath, ["src/server/main.ts"], { env, stdio: ["ignore", "ignore", "inherit"] });
}

async function waitListening(backend: ChildProcess, port: number): Promise<void> {
  await expect
    .poll(
      async () => {
        if (backend.exitCode !== null) throw new Error("backend exited");
        return fetch(`http://127.0.0.1:${String(port)}/api/tree`, { headers: authed() }).then((r) => r.status, () => 0);
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
}

const wsUrl = (port: number) => `ws://127.0.0.1:${String(port)}/api/terminal/${encodeURIComponent(pane)}`;
/** A same-origin page's upgrade carries Origin == Host (F27 refuses one without). */
const sameOrigin = (port: number) => ({ headers: authed({ origin: `http://127.0.0.1:${String(port)}` }) });

test("@F25 a source other than the allowed one gets nothing: no HTTP, no WebSocket", async () => {
  const port = portFor(0);
  // Another allowed source (a documentation address): this test connects from loopback.
  const backend = startBackend(port, { HERDR_ALLOWED_SOURCE: "192.0.2.1" });
  try {
    // Not waitListening: that would treat every refusal as "not up yet". Give it time to start.
    await new Promise((r) => setTimeout(r, 2500));
    expect(backend.exitCode).toBeNull();
    for (const path of ["/api/tree", "/", "/manifest.webmanifest"]) {
      await expect(fetch(`http://127.0.0.1:${String(port)}${path}`)).rejects.toThrow();
    }
    const result = await new Promise<string>((resolve) => {
      const ws = new WebSocket(wsUrl(port), sameOrigin(port));
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("error"));
      ws.on("unexpected-response", () => resolve("response"));
    });
    expect(result).toBe("error");
  } finally {
    backend.kill("SIGTERM");
  }
});

test("@F25 the allowed source is configurable and then served", async () => {
  const port = portFor(1);
  const backend = startBackend(port, { HERDR_ALLOWED_SOURCE: "127.0.0.1" });
  try {
    await waitListening(backend, port);
    const ws = new WebSocket(wsUrl(port), sameOrigin(port));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.close();
  } finally {
    backend.kill("SIGTERM");
  }
});

test("@F26 SSE and terminal streams are closed after the capped lifetime", async () => {
  const port = portFor(2);
  const backend = startBackend(port, { HERDR_ALLOWED_SOURCE: "127.0.0.1", HERDR_STREAM_MAX_MS: "1500" });
  try {
    await waitListening(backend, port);
    const started = Date.now();
    const sse = fetch(`http://127.0.0.1:${String(port)}/api/events`, { headers: authed() }).then(async (r) => {
      const reader = r.body?.getReader();
      while (reader !== undefined && !(await reader.read()).done);
      return Date.now() - started;
    });
    const wsClosed = new Promise<{ code: number; ms: number }>((resolve, reject) => {
      const ws = new WebSocket(wsUrl(port), sameOrigin(port));
      ws.on("close", (code: number) => resolve({ code, ms: Date.now() - started }));
      ws.on("error", reject);
    });
    const sseMs = await sse;
    expect(sseMs).toBeGreaterThanOrEqual(1400);
    expect(sseMs).toBeLessThan(6000);
    const ws = await wsClosed;
    expect(ws.code).toBe(4001);
    expect(ws.ms).toBeGreaterThanOrEqual(1400);
    expect(ws.ms).toBeLessThan(6000);
    // A fresh connection works again (what the browser's reconnect does).
    const again = await fetch(`http://127.0.0.1:${String(port)}/api/tree`, { headers: authed() });
    expect(again.ok).toBe(true);
  } finally {
    backend.kill("SIGTERM");
  }
});
