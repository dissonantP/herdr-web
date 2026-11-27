import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login, writeCredentials } from "./auth.ts";
import { seed } from "./fixture.ts";
import { ensureVapid } from "../../src/server/push/vapid.ts";
import { QaCore, qaEnv } from "./qa-core.ts";

// The whole isolated stack: a temp folder, a QA herdr-core seeded with the standard world, and the
// herdr backend pointed at it (serving the built UI from dist/web), with the QA login set and one
// session logged in (`token`).

export interface Stack {
  readonly dir: string;
  readonly core: QaCore;
  readonly server: ChildProcess;
  readonly url: string;
  readonly token: string;
}

async function waitForTree(url: string, server: ChildProcess, token: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`herdr backend exited with ${String(server.exitCode)}`);
    const ok = await fetch(`${url}/api/tree`, { headers: { cookie: `__Host-herdr_session=${token}` } }).then((r) => r.ok, () => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("herdr backend did not come up");
}

async function waitForLogin(url: string, server: ChildProcess): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`herdr backend exited with ${String(server.exitCode)}`);
    const up = await fetch(`${url}/login`).then(() => true, () => false);
    if (up) return login(url);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("herdr backend did not come up");
}

/**
 * `detached`: the backend outlives this process and logs to `<dir>/server.log` (for `qa-core up`).
 * `env`: more settings for the backend.
 */
export async function startStack(port: number, session = `herdr-qa-${String(process.pid)}`, detached = false, env: Record<string, string> = {}): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), "herdr-qa-"));
  const core = new QaCore(qaEnv(dir, session));
  let server: ChildProcess | undefined;
  try {
    core.start();
    await seed(core);
    await writeCredentials(core.env.HERDR_CREDENTIALS_FILE);
    ensureVapid(core.env.HERDR_VAPID_FILE);
    server = spawn(process.execPath, ["src/server/main.ts"], {
    env: { ...core.childEnv(), HERDR_HOST: "127.0.0.1", HERDR_ALLOWED_SOURCE: "127.0.0.1", HERDR_PUSH_ALLOW_INSECURE: "1", HERDR_PORT: String(port), ...env },
    stdio: detached ? ["ignore", openSync(join(dir, "server.log"), "a"), openSync(join(dir, "server.log"), "a")] : ["ignore", "inherit", "inherit"],
    detached,
  });
    if (detached) server.unref();
    const url = `http://127.0.0.1:${String(port)}`;
    const token = await waitForLogin(url, server);
    await waitForTree(url, server, token);
    return { dir, core, server, url, token };
  } catch (err) {
    await stopStack(dir, session, server?.pid).catch(() => undefined);
    throw err;
  }
}

export async function stopStack(dir: string, session: string, serverPid: number | undefined): Promise<void> {
  if (serverPid !== undefined) {
    try {
      process.kill(serverPid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  try {
    await new QaCore(qaEnv(dir, session)).stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
