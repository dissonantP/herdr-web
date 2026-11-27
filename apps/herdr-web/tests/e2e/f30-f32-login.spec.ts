import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import WebSocket from "ws";
import { authed, COOKIE, login, postLogin, QA_PASSWORD, QA_USER, tokenFrom, writeCredentials } from "../support/auth.ts";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F30-F32: the app login on top of Authelia. Login page and slowdown, sessions (cookie, file,
// sliding, logout closing streams, every route gated), and the service worker never serving a page
// or data without a session. Tests that log out use their own fresh session, never the global one.

const port = () => Number(process.env.HERDR_QA_PORT);
const base = () => `http://127.0.0.1:${String(port())}`;
const wsUrl = (pane: string, p = port()) => `ws://127.0.0.1:${String(p)}/api/terminal/${encodeURIComponent(pane)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pane = "";
test.beforeEach(async () => {
  pane = (await seed(qaCore())).terminals.betaA ?? "";
  // The backend's tree follows the core by events; the socket tests need it to know the new pane.
  await expect.poll(async () => (await (await fetch(`${base()}/api/tree`, { headers: authed() })).text()).includes(`"${pane}"`)).toBe(true);
});

/** Put the context on session `token` (a fresh one, so logging out leaves the global session alone). */
async function useSession(context: BrowserContext, token: string): Promise<void> {
  await context.clearCookies();
  await context.addCookies([{ name: COOKIE, value: token, domain: "127.0.0.1", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
}

function openSocket(token: string, p = port()): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(pane, p), { headers: authed({ origin: `http://127.0.0.1:${String(p)}` }, token) });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function upgradeStatus(headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl(pane), { headers });
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => resolve(String(res.statusCode)));
    ws.on("error", () => resolve("error"));
  });
}

/** Wait out the slowdown left by earlier failures (the limiter is global), by logging in once. */
async function settle(): Promise<void> {
  await expect.poll(async () => (await postLogin(base(), { username: QA_USER, password: QA_PASSWORD })).status, { timeout: 15_000, intervals: [500] }).toBe(303);
}

test.describe("@F30 login", () => {
  test("login page: generic error, slowdown before the check, then in to where it was going", async ({ page, context }) => {
    await context.clearCookies();
    await page.goto(`/s/${IDS.beta}`);
    await expect(page).toHaveURL(/\/login\?next=/u);
    const form = page.getByTestId("login-form");
    await expect(form).toBeVisible();

    const submit = async (user: string, password: string) => {
      await page.getByLabel("Username").fill(user);
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Log in" }).click();
      await page.waitForLoadState();
    };
    await submit(QA_USER, "wrong-password");
    await expect(page.getByTestId("login-error")).toHaveText("Wrong username or password.");
    await submit(QA_USER, QA_PASSWORD); // too soon: refused without checking
    await expect(page.getByTestId("login-error")).toContainText("Too many attempts");
    await sleep(1100);
    await submit("someone-else", QA_PASSWORD); // a wrong username gets the same generic error
    await expect(page.getByTestId("login-error")).toHaveText("Wrong username or password.");
    await sleep(2100);
    await submit(QA_USER, QA_PASSWORD);
    await expect(page).toHaveURL(new RegExp(`/s/${IDS.beta}$`, "u"));
    await expect(page.getByTestId("terminal-view")).toBeVisible();
  });

  test("the slowdown applies before any password check, and only one check runs at a time", async ({ isMobile }) => {
    test.skip(!isMobile, "no page involved");
    // Three at once with no slowdown pending: one is checked, the others refused at once.
    const first = await Promise.all([0, 1, 2].map(() => postLogin(base(), { username: QA_USER, password: "nope-nope" })));
    expect(first.map((r) => r.status).sort()).toEqual([401, 429, 429]);
    // Now slowed down: even the right password is refused, quickly, without a hash being run.
    const t = Date.now();
    const refused = await Promise.all([0, 1, 2, 3, 4].map(() => postLogin(base(), { username: QA_USER, password: QA_PASSWORD })));
    expect(refused.every((r) => r.status === 429 && tokenFrom(r) === null)).toBe(true);
    expect(Number(refused[0]?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Date.now() - t).toBeLessThan(500);
    await settle(); // never a hard lock
  });

  test("without a credentials file the backend refuses everything, then serves once it exists", async ({ isMobile }) => {
    test.skip(!isMobile, "no page involved");
    const own = port() + 1200;
    const dir = process.env.HERDR_QA_DIR ?? "";
    const credentials = join(dir, "missing-credentials.json");
    rmSync(credentials, { force: true });
    let log = "";
    const backend: ChildProcess = spawn(process.execPath, ["src/server/main.ts"], {
      env: { ...qaCore().childEnv(), HERDR_HOST: "127.0.0.1", HERDR_ALLOWED_SOURCE: "127.0.0.1", HERDR_PORT: String(own), HERDR_CREDENTIALS_FILE: credentials, HERDR_SESSIONS_FILE: join(dir, "own-sessions.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    backend.stderr?.on("data", (d: Buffer) => (log += d.toString()));
    try {
      const ownBase = `http://127.0.0.1:${String(own)}`;
      await expect.poll(() => fetch(`${ownBase}/login`).then((r) => r.status, () => 0), { timeout: 15_000 }).toBe(503);
      expect(log).toMatch(/refusing to serve: no credentials file at .*install\.sh apply login/u);
      for (const path of ["/", "/api/tree", "/api/events", "/manifest.webmanifest"]) expect((await fetch(`${ownBase}${path}`, { headers: authed() })).status).toBe(503);
      expect((await postLogin(ownBase, { username: QA_USER, password: QA_PASSWORD })).status).toBe(503);
      await writeCredentials(credentials);
      const token = await login(ownBase);
      expect((await fetch(`${ownBase}/api/tree`, { headers: authed({}, token) })).status).toBe(200);
    } finally {
      backend.kill("SIGTERM");
    }
  });
});

test.describe("@F31 sessions", () => {
  test.skip(({ isMobile }) => !isMobile, "no page involved");

  test("cookie: __Host-, HttpOnly, Secure, SameSite=Lax, 30 days; stored only hashed in a 0600 file", async () => {
    const res = await postLogin(base(), { username: QA_USER, password: QA_PASSWORD, next: "/s/x" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/s/x");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$`, "u"));
    const token = tokenFrom(res) ?? "";
    const file = qaCore().env.HERDR_SESSIONS_FILE;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain(token);
    // A login never redirects off the site.
    const away = await postLogin(base(), { username: QA_USER, password: QA_PASSWORD, next: "//evil.example/x" });
    expect(away.headers.get("location")).toBe("/");
  });

  test("every route, stream and upgrade needs a session, except the login page and its files", async () => {
    const asset = readdirSync("dist/web/assets")[0] ?? "";
    const variants: Record<string, string>[] = [{}, { cookie: `${COOKIE}=${"A".repeat(43)}` }];
    for (const headers of variants) {
      for (const path of ["/api/tree", "/api/events", "/api/session", "/api/nothing"]) expect((await fetch(`${base()}${path}`, { headers })).status, path).toBe(401);
      const post = await fetch(`${base()}/api/actions`, { method: "POST", headers: { ...headers, origin: base(), "content-type": "application/json" }, body: "{}" });
      expect(post.status).toBe(401);
      for (const path of ["/", `/s/${IDS.beta}`, `/assets/${asset}`, "/index.html"]) {
        const res = await fetch(`${base()}${path}`, { headers, redirect: "manual" });
        expect(res.status, path).toBe(302);
        expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent(path)}`);
      }
      expect(await upgradeStatus({ ...headers, origin: base() })).toBe("401");
    }
    for (const path of ["/login", "/manifest.webmanifest", "/icons/icon-192.png", "/sw.js"]) expect((await fetch(`${base()}${path}`)).status, path).toBe(200);
    // With the session, the same things work.
    expect((await fetch(`${base()}/api/session`, { headers: authed() })).status).toBe(204);
    const among = { cookie: `other=1; ${COOKIE}=${process.env.HERDR_QA_TOKEN ?? ""}; last=2` };
    expect((await fetch(`${base()}/api/session`, { headers: among })).status).toBe(204);
    // An oversized login form is refused without reading it all.
    expect((await postLogin(base(), { username: QA_USER, password: "x".repeat(8000) })).status).toBe(413);
    expect(await upgradeStatus(authed({ origin: base() }))).toBe("open");
  });

  test("logout ends the session and closes its open streams, not other sessions'", async () => {
    const token = await login(base());
    const other = await login(base());
    const sseEnded = fetch(`${base()}/api/events`, { headers: authed({}, token) }).then(async (r) => {
      const reader = r.body?.getReader();
      while (reader !== undefined && !(await reader.read()).done);
      return true;
    });
    const mine = await openSocket(token);
    const theirs = await openSocket(other);
    const mineClosed = new Promise<number>((resolve) => mine.on("close", (code: number) => resolve(code)));
    await sleep(200);
    const out = await fetch(`${base()}/api/logout`, { method: "POST", headers: authed({ origin: base() }, token) });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(new RegExp(`^${COOKIE}=; Path=/; Max-Age=0;`, "u"));
    expect(await mineClosed).toBe(4002);
    expect(await sseEnded).toBe(true);
    expect(theirs.readyState).toBe(WebSocket.OPEN);
    theirs.close();
    expect((await fetch(`${base()}/api/tree`, { headers: authed({}, token) })).status).toBe(401);
    expect((await fetch(`${base()}/api/tree`, { headers: authed({}, other) })).status).toBe(200);
  });

  test("sessions survive a backend restart", async () => {
    const own = port() + 1201;
    const start = () =>
      spawn(process.execPath, ["src/server/main.ts"], { env: { ...qaCore().childEnv(), HERDR_HOST: "127.0.0.1", HERDR_ALLOWED_SOURCE: "127.0.0.1", HERDR_PORT: String(own) }, stdio: ["ignore", "ignore", "inherit"] });
    const ownBase = `http://127.0.0.1:${String(own)}`;
    const up = () => expect.poll(() => fetch(`${ownBase}/login`).then((r) => r.status, () => 0), { timeout: 15_000 }).toBe(200);
    let backend = start();
    try {
      await up();
      const token = await login(ownBase);
      backend.kill("SIGTERM");
      await new Promise((r) => backend.once("exit", r));
      backend = start();
      await up();
      expect((await fetch(`${ownBase}/api/tree`, { headers: authed({}, token) })).status).toBe(200);
    } finally {
      backend.kill("SIGTERM");
    }
  });
});

test.describe("@F32 service worker", () => {
  test("network-only for pages and API: offline, no page is served from a cache", async ({ page, context }) => {
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.reload();
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    await expect(page.getByTestId("tree-space").first()).toBeVisible();
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) urls.push(new URL(req.url).pathname);
      return urls;
    });
    expect(cached.length).toBeGreaterThan(0);
    expect(cached.every((p) => p.startsWith("/assets/"))).toBe(true);
    await context.setOffline(true);
    await page.reload().catch(() => undefined);
    await expect(page.locator("#root")).toHaveCount(0);
    await context.setOffline(false);
  });

  test("a session ended elsewhere sends the open page to the login", async ({ page, context }) => {
    const token = await login(base());
    await useSession(context, token);
    await page.goto(`/s/${IDS.beta}`);
    await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live");
    expect((await fetch(`${base()}/api/logout`, { method: "POST", headers: authed({ origin: base() }, token) })).status).toBe(204);
    await expect(page).toHaveURL(/\/login\?next=/u, { timeout: 10_000 });
    await expect(page.getByTestId("login-form")).toBeVisible();
  });

  test("logging out in the app clears the caches and lands on the login", async ({ page, context }) => {
    await useSession(context, await login(base()));
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.reload();
    await expect(page.getByTestId("tree-space").first()).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).length)).toBeGreaterThan(0);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("logout").click();
    await expect(page).toHaveURL(/\/login$/u);
    expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(0);
    await page.goto("/");
    await expect(page).toHaveURL(/\/login\?next=/u);
  });
});
