import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";
import { COOKIE } from "../support/auth.ts";
import { IDS } from "../support/fixture.ts";
import { startStack, stopStack, type Stack } from "../support/stack.ts";

// F69: an open page resyncs after the backend restarts (a deploy), without a manual reload, and
// reloads itself when the deployed UI build changed.

const names = (page: import("@playwright/test").Page) => page.locator('[data-testid="tree-space"] .row-name').allTextContents();

test.describe("@F69 resync after a backend restart", () => {
  let stack: Stack;
  let port: number;
  let session: string;

  test.beforeEach(async () => {
    port = 8000 + (process.pid % 500);
    session = `herdr-qa-f69-${String(process.pid)}`;
    stack = await startStack(port, session);
  });
  test.afterEach(async () => {
    await stopStack(stack.dir, session, stack.server.pid);
  });

  test("a restart plus tree changes made meanwhile show up in the open page", async ({ page, context }) => {
    await context.addCookies([{ name: COOKIE, value: stack.token, domain: "127.0.0.1", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
    await page.goto(`${stack.url}/`);
    await expect(page.locator('[data-testid="tree-space"]').first()).toBeVisible();
    expect(await names(page)).toContain("gamma");

    // Stop the backend, change the tree behind its back, bring it back up.
    stack.server.kill("SIGTERM");
    await new Promise((r) => stack.server.once("exit", r));
    const layout = await stack.core.layout();
    layout.spaces = layout.spaces.filter((s) => s.id !== IDS.gamma);
    await stack.core.setLayout(layout);
    const restarted: ChildProcess = spawn(process.execPath, ["src/server/main.ts"], {
      env: { ...stack.core.childEnv(), HERDR_HOST: "127.0.0.1", HERDR_ALLOWED_SOURCE: "127.0.0.1", HERDR_PUSH_ALLOW_INSECURE: "1", HERDR_PORT: String(port) },
      stdio: "inherit",
    });
    (stack as { server: ChildProcess }).server = restarted;
    await expect.poll(async () => names(page), { timeout: 15_000 }).not.toContain("gamma");
    expect(await names(page)).toContain("beta");
  });

  test("a stream the proxy refuses (502 during a deploy) is retried until it works", async ({ page, context }) => {
    await context.addCookies([{ name: COOKIE, value: stack.token, domain: "127.0.0.1", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
    let refuse = false;
    await page.route("**/api/events", (route) => (refuse ? route.fulfill({ status: 502, body: "bad gateway" }) : route.continue()));
    await page.goto(`${stack.url}/`);
    await expect(page.locator('[data-testid="tree-space"]').first()).toBeVisible();
    refuse = true;
    // Drop the live stream by restarting the server while refusing, then lift the refusal.
    stack.server.kill("SIGTERM");
    await new Promise((r) => stack.server.once("exit", r));
    const layout = await stack.core.layout();
    layout.spaces = layout.spaces.filter((s) => s.id !== IDS.gamma);
    await stack.core.setLayout(layout);
    const restarted = spawn(process.execPath, ["src/server/main.ts"], {
      env: { ...stack.core.childEnv(), HERDR_HOST: "127.0.0.1", HERDR_ALLOWED_SOURCE: "127.0.0.1", HERDR_PUSH_ALLOW_INSECURE: "1", HERDR_PORT: String(port) },
      stdio: "inherit",
    });
    (stack as { server: ChildProcess }).server = restarted;
    await page.waitForTimeout(2500); // the page keeps meeting 502s
    expect(await names(page)).toContain("gamma");
    refuse = false;
    await expect.poll(async () => names(page), { timeout: 10_000 }).not.toContain("gamma");
  });

  test("a changed UI build id reloads the page", async ({ page, context }) => {
    await context.addCookies([{ name: COOKIE, value: stack.token, domain: "127.0.0.1", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
    const loads: string[] = [];
    page.on("load", () => loads.push(page.url()));
    await page.route("**/api/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: "retry: 1000\n\nevent: build\ndata: /assets/index-other.js\n\n" }));
    await page.goto(`${stack.url}/`);
    await expect.poll(() => loads.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(3000);
    expect(loads.length, "reloads once, not in a loop").toBe(2);
  });
});

