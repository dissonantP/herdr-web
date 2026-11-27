import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import WebSocket from "ws";
import type { PaneNode, TreeMessage } from "../../src/shared/model.ts";
import { authed } from "../support/auth.ts";
import { addTab, seed, type Seeded } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F8: the production backend (deploy/herdr.service) stays under its 300 MB budget with 30 live
// terminals, restarts after a crash, and herdr-core sessions don't care when it stops. These run
// their own backends against the isolated QA core, never the live one. They don't use the page,
// so they run once (the phone project).

test.skip(({ isMobile }) => !isMobile, "no page involved");

const unit = readFileSync(new URL("../../deploy/herdr.service", import.meta.url), "utf8");
const setting = (key: string) => new RegExp(`^${key}=(.*)$`, "mu").exec(unit)?.[1] ?? "";
const LIMIT_BYTES = 300 * 1024 * 1024;

function backendPort(offset: number): number {
  return Number(process.env.HERDR_QA_PORT) + 1000 + offset;
}

function startBackend(port: number): ChildProcess {
  return spawn(process.execPath, ["src/server/main.ts"], {
    env: { ...qaCore().childEnv(), HERDR_HOST: "127.0.0.1", HERDR_ALLOWED_SOURCE: "127.0.0.1", HERDR_PORT: String(port), NODE_OPTIONS: /^Environment=NODE_OPTIONS=(.*)$/mu.exec(unit)?.[1] ?? "" },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

async function treeOf(port: number): Promise<TreeMessage | null> {
  return fetch(`http://127.0.0.1:${String(port)}/api/tree`, { headers: authed() }).then(
    (r) => r.json() as Promise<TreeMessage>,
    () => null,
  );
}

async function waitUp(port: number): Promise<void> {
  await expect.poll(async () => (await treeOf(port))?.ok === true, { timeout: 15_000 }).toBe(true);
}

function rssBytes(pid: number): number {
  const kb = /VmRSS:\s+(\d+) kB/u.exec(readFileSync(`/proc/${String(pid)}/status`, "utf8"))?.[1];
  return Number(kb) * 1024;
}

interface Walkable {
  readonly spaces: readonly { readonly tabs: readonly { readonly panes: readonly PaneNode[] }[] }[];
  readonly groups?: readonly Walkable[];
}

function terminalPanes(message: TreeMessage | null): PaneNode[] {
  if (message === null || !message.ok) return [];
  const walk = (node: Walkable): PaneNode[] => [
    ...node.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes.filter((p) => p.kind === "terminal"))),
    ...(node.groups ?? []).flatMap(walk),
  ];
  return walk(message.tree);
}

const CHATTY = ["sh", "-c", 'i=0; while :; do echo "line $i the quick brown fox jumps over the lazy dog"; i=$((i+1)); sleep 0.02; done'];

let seeded: Seeded;
test.beforeEach(async () => {
  seeded = await seed(qaCore());
});

test("@F8 unit file sets the budget and restart policy", () => {
  expect(setting("MemoryMax")).toBe("300M");
  expect(setting("Restart")).toBe("on-failure");
  expect(setting("WantedBy")).toBe("default.target");
});

test("@F8 backend RSS stays under 300 MB with 30 live terminals", async () => {
  test.setTimeout(90_000);
  const core = qaCore();
  for (let i = 0; i < 30; i++) await addTab(core, seeded, "gamma", `load-${String(i)}`, CHATTY);
  const port = backendPort(0);
  const backend = startBackend(port);
  const sockets: WebSocket[] = [];
  try {
    await waitUp(port);
    // 30 chatty terminals, all live, all in the tree.
    await expect.poll(async () => terminalPanes(await treeOf(port)).filter((p) => p.name.startsWith("load-")).length).toBeGreaterThanOrEqual(30);

    // The backend's cap of open terminal sockets, all streaming; plus the tree event stream.
    const panes = terminalPanes(await treeOf(port)).filter((p) => p.name.startsWith("load-")).slice(0, 16);
    let received = 0;
    for (const pane of panes) {
      // Same-origin, as the app's page connects (F27 refuses an upgrade without Origin).
      const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/terminal/${encodeURIComponent(pane.id)}`, { headers: authed({ origin: `http://127.0.0.1:${String(port)}` }) });
      ws.on("message", (data: Buffer) => (received += data.length));
      ws.on("error", () => undefined);
      sockets.push(ws);
    }
    const events = new AbortController();
    void fetch(`http://127.0.0.1:${String(port)}/api/events`, { signal: events.signal, headers: authed() }).then(async (r) => {
      const reader = r.body?.getReader();
      while (reader !== undefined && !(await reader.read()).done);
    }).catch(() => undefined); // the abort below ends the stream

    const pid = backend.pid ?? 0;
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      peak = Math.max(peak, rssBytes(pid));
      await new Promise((r) => setTimeout(r, 250));
    }
    events.abort();
    expect(received).toBeGreaterThan(10_000); // the sockets really streamed
    console.log(`peak backend RSS ${(peak / 1024 / 1024).toFixed(1)} MB with 30 terminals, ${String(panes.length)} streaming`);
    expect(peak).toBeLessThan(LIMIT_BYTES);
  } finally {
    sockets.forEach((s) => s.terminate());
    backend.kill("SIGKILL");
  }
});

test("@F8 herdr-core sessions are unaffected when the backend stops or dies", async () => {
  const core = qaCore();
  const live = async () => {
    const list = (await core.call("terminal.list", {})).terminals as { address: string; state: string }[];
    return list.filter((t) => t.state === "live").map((t) => t.address).sort();
  };
  const before = await live();
  expect(before.length).toBeGreaterThanOrEqual(6);

  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const port = backendPort(1);
    const backend = startBackend(port);
    await waitUp(port);
    const exited = new Promise((r) => backend.once("exit", r));
    backend.kill(signal);
    await exited;
    expect(await live(), signal).toEqual(before);
    // The terminals still work: type into one through the core.
    const betaA = seeded.terminals.betaA ?? "";
    await core.call("terminal.send", { terminal: betaA, text: `echo after-${signal}` });
    await expect.poll(() => core.screen(betaA)).toContain(`after-${signal}`);
  }
  // A fresh backend picks them all up again.
  const port = backendPort(1);
  const backend = startBackend(port);
  try {
    await waitUp(port);
    expect(terminalPanes(await treeOf(port)).length).toBeGreaterThanOrEqual(6);
  } finally {
    backend.kill("SIGKILL");
  }
});

test("@F8 systemd restarts the backend after a crash, with the unit's limits", async () => {
  test.setTimeout(60_000);
  const hasUser = execFileSyncOk("systemctl", ["--user", "show", "-p", "Version", "--value"]);
  test.skip(!hasUser, "no systemd user manager here");

  // A transient unit (named herdr-qa-restart-*, not herdr.service) with the real unit's restart policy and memory limit,
  // running the backend against the isolated core.
  const name = `herdr-qa-restart-${String(process.pid)}`;
  const port = backendPort(2);
  const env = qaCore().childEnv();
  const setenv = ["HC_SOCKET", "HC_SESSION", "XDG_STATE_HOME", "HERDR_GROUPS_FILE", "HERDR_CREDENTIALS_FILE", "HERDR_SESSIONS_FILE", "XDG_RUNTIME_DIR"].filter((k) => env[k] !== undefined).flatMap((k) => ["--setenv", `${k}=${env[k] ?? ""}`]);
  const show = (prop: string) => execFileSync("systemctl", ["--user", "show", name, "-p", prop, "--value"], { encoding: "utf8" }).trim();
  execFileSync("systemd-run", [
    "--user", `--unit=${name}`, "--collect", `--working-directory=${process.cwd()}`,
    "-p", `Restart=${setting("Restart")}`, "-p", `RestartSec=${setting("RestartSec")}`, "-p", `MemoryMax=${setting("MemoryMax")}`,
    ...setenv, "--setenv", `HERDR_HOST=127.0.0.1`, "--setenv", "HERDR_ALLOWED_SOURCE=127.0.0.1", "--setenv", `HERDR_PORT=${String(port)}`,
    process.execPath, "src/server/main.ts",
  ], { stdio: "ignore" });
  try {
    await waitUp(port);
    expect(show("MemoryMax")).toBe(String(LIMIT_BYTES));
    const first = Number(show("MainPID"));
    expect(first).toBeGreaterThan(0);
    process.kill(first, "SIGKILL");
    await expect.poll(() => Number(show("MainPID")), { timeout: 15_000 }).not.toBe(first);
    await waitUp(port);
    expect(Number(show("NRestarts"))).toBeGreaterThanOrEqual(1);
  } finally {
    execFileSync("systemctl", ["--user", "stop", name], { stdio: "ignore" });
  }
});

function execFileSyncOk(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
