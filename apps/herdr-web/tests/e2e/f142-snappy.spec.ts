import { expect, test, type Page, type Route } from "@playwright/test";
import { dialog, home, row, rowAction } from "../support/admin-ui.ts";
import { addTab, claudeProgram, IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 142: the UI answers from client state and never waits on a round trip. With the server slowed (each API call
// held before it reaches the backend), every interaction shows within two frames, a syncing note shows while a change
// is on its way, a refused change is taken back with an error, and a dropped or failing stream shows as such.

const SLOW = "Syncing";

// Requests a service worker makes bypass page.route, so one that takes over mid-test would let them through unheld.
test.use({ serviceWorkers: "block" });

/** Hold every request to `pattern` until `release()`; then they go through. */
async function holdRequests(page: Page, pattern: string): Promise<{ release: () => void; held: () => number }> {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let count = 0;
  await page.route(pattern, async (route: Route) => {
    if (route.request().url().includes("/api/events")) return route.fallback();
    count++;
    await gate;
    await route.continue().catch(() => undefined);
  });
  return { release: () => open(), held: () => count };
}

/**
 * Click `click` in the page and check, two animation frames later and still in the page (no test-runner round trip),
 * that `selector` matches an element (with `text`, when given) or, with `absent`, none.
 */
async function withinTwoFrames(page: Page, click: string | { selector: string; text: string }, check: { selector: string; text?: string; absent?: boolean }): Promise<void> {
  const result = await page.evaluate(
    async ({ click, check }) => {
      const target = typeof click === "string" ? document.querySelector<HTMLElement>(click) : [...document.querySelectorAll<HTMLElement>(click.selector)].find((el) => el.textContent?.includes(click.text) === true) ?? null;
      if (target === null) return `nothing matches ${click}`;
      target.click();
      for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
      const found = [...document.querySelectorAll(check.selector)].filter((el) => check.text === undefined || el.textContent?.includes(check.text) === true);
      if (check.absent === true) return found.length === 0 ? "ok" : `${check.selector} is still there`;
      return found.length > 0 ? "ok" : `no ${check.selector}${check.text === undefined ? "" : ` with "${check.text}"`} after two frames`;
    },
    { click, check },
  );
  expect(result).toBe("ok");
}

const spaceName = (page: Page, id: string) => row(page, "space", id).locator(".row-name").first();

test.describe("@F142 snappy UI under a slow server", () => {
  test.beforeEach(async () => {
    await seed(qaCore());
  });

  test("a rename shows at once while the server is slow, the syncing note shows, and it lands", async ({ page }) => {
    await home(page);
    const slow = await holdRequests(page, "**/api/actions");
    await rowAction(row(page, "space", IDS.beta), "Rename");
    await dialog(page).getByLabel("Name", { exact: true }).fill("renamed-fast");
    await withinTwoFrames(page, '[data-testid="dialog"] button[type="submit"]', { selector: `[data-testid="tree-space"][data-id="${IDS.beta}"] .row-name`, text: "renamed-fast" });
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "syncing");
    await expect(page.getByTestId("sync-status")).toContainText(SLOW);
    expect(slow.held()).toBe(1);
    expect((await qaCore().layout()).spaces.find((s) => s.id === IDS.beta)?.name).toBe("beta"); // the server has not seen it yet
    slow.release();
    await expect(page.getByTestId("sync-status")).toHaveCount(0);
    await expect.poll(async () => (await qaCore().layout()).spaces.find((s) => s.id === IDS.beta)?.name).toBe("renamed-fast");
    await expect(spaceName(page, IDS.beta)).toHaveText("renamed-fast");
    await expect(page.getByTestId("sync-toast")).toHaveCount(0);
  });

  test("a refused change is taken back with an error", async ({ page }) => {
    await home(page);
    await page.route("**/api/actions", async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, error: "refused for the test" }) });
    });
    await rowAction(row(page, "space", IDS.beta), "Rename");
    await dialog(page).getByLabel("Name", { exact: true }).fill("never-lands");
    await withinTwoFrames(page, '[data-testid="dialog"] button[type="submit"]', { selector: `[data-testid="tree-space"][data-id="${IDS.beta}"] .row-name`, text: "never-lands" });
    await expect(page.getByTestId("sync-toast")).toHaveText(/Couldn't rename beta: refused for the test/u);
    await expect(spaceName(page, IDS.beta)).toHaveText("beta");
    await page.getByTestId("sync-toast-close").click();
    await expect(page.getByTestId("sync-toast")).toHaveCount(0);
  });

  test("tabs, Chat/Terminal, menus and toggles answer within two frames while every API call is slow", async ({ page }) => {
    const core = qaCore();
    const seeded = await seed(core);
    await addTab(core, seeded, "beta", "agent", claudeProgram("idle"));
    await page.goto(`/s/${IDS.beta}`);
    await expect(page.getByTestId("space-view")).toBeVisible();
    const slow = await holdRequests(page, "**/api/**");
    // Tabs.
    await withinTwoFrames(page, '.tabs [role="tab"]:nth-child(2)', { selector: '.tabs [role="tab"][aria-selected="true"]:nth-child(2)' });
    await withinTwoFrames(page, { selector: '.tabs [role="tab"]', text: "agent" }, { selector: '.tabs [role="tab"][aria-selected="true"]', text: "agent" });
    // Chat / Terminal.
    await expect(page.getByTestId("view-chat")).toBeVisible();
    await withinTwoFrames(page, '[data-testid="view-terminal"]', { selector: '[data-testid="pane-view"][data-view="terminal"]' });
    await withinTwoFrames(page, '[data-testid="view-chat"]', { selector: '[data-testid="pane-view"][data-view="chat"]' });
    // A menu opens, and a toggle in it shows its new state the next time it opens.
    await withinTwoFrames(page, '[data-testid="space-actions"]', { selector: '[data-testid="action-menu"]' });
    await page.keyboard.press("Escape");
    await page.getByTestId("space-actions").click();
    await page.getByRole("menuitem", { name: "Make quiet" }).click();
    await withinTwoFrames(page, '[data-testid="space-actions"]', { selector: '[data-testid="action-menu"] [role="menuitem"]', text: "Turn quiet off" });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("sync-status")).toBeVisible();
    slow.release();
    await expect(page.getByTestId("sync-status")).toHaveCount(0);
    await expect(page.getByTestId("sync-toast")).toHaveCount(0);
  });

  test("a sent message leaves the box at once and shows as on its way while the server is slow", async ({ page }) => {
    const core = qaCore();
    const seeded = await seed(core);
    await addTab(core, seeded, "beta", "agent", claudeProgram("idle"));
    await page.goto(`/s/${IDS.beta}`);
    await page.getByRole("tab", { name: "agent" }).click();
    await expect(page.getByTestId("composer-text")).toBeVisible();
    await page.getByTestId("composer-text").fill("hello slow");
    // The send is held, then answered as delivered (the fake Claude here never shows a prompt to type into).
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    await page.route(/\/api\/chat\/[^/]+\/send/u, async (route) => {
      await gate;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await withinTwoFrames(page, '[data-testid="send"]', { selector: '[data-testid="composer-text"]:placeholder-shown' });
    await expect(page.getByTestId("pending-message")).toContainText("hello slow");
    await expect(page.getByTestId("sync-status")).toBeVisible();
    open();
    await expect(page.getByTestId("pending-message")).toHaveCount(0);
    await expect(page.getByTestId("composer-error")).toHaveCount(0);
  });

  test("a settings read that a change overtook does not undo it", async ({ page }) => {
    await home(page);
    // The page's read on opening is answered by the server now but arrives late, after a change has saved.
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let delivered: () => void = () => undefined;
    const late = new Promise<void>((resolve) => (delivered = resolve));
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const answer = await route.fetch();
      await gate;
      await route.fulfill({ response: answer });
      delivered();
    });
    await page.getByTestId("open-settings").click();
    const inbox = page.getByTestId("inbox-enabled");
    await expect(inbox).not.toBeChecked();
    await withinTwoFrames(page, '[data-testid="inbox-enabled"]', { selector: '[data-testid="inbox-enabled"]:checked' });
    await expect(page.getByTestId("sync-status")).toHaveCount(0); // saved
    open();
    await late;
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(inbox).toBeChecked();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.evaluate(() => fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ inbox: false }) }));
  });

  test("mute and never sleep keep their new state while reads answer and the writes are still on their way", async ({ page }) => {
    await page.goto(`/s/${IDS.beta}`);
    await expect(page.getByTestId("space-view")).toBeVisible();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const writes = /\/api\/(push\/settings|settings)$/u;
    await page.route(writes, async (route) => {
      if (route.request().method() === "POST") await gate;
      await route.continue().catch(() => undefined);
    });
    const menu = async () => {
      // Opening the menu reads push and settings again; wait for both answers, which still carry the old values.
      const read = Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/push")), page.waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "GET")]);
      await page.getByTestId("space-actions").click();
      await read;
    };
    await menu();
    await page.getByRole("menuitem", { name: "Mute notifications" }).click();
    await menu();
    await page.getByRole("menuitem", { name: "Never sleep" }).click();
    await menu();
    await page.keyboard.press("Escape");
    await page.getByTestId("space-actions").click();
    await expect(page.getByRole("menuitem", { name: "Allow sleep" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Unmute notifications" })).toBeVisible();
    await page.keyboard.press("Escape");
    open();
    await expect(page.getByTestId("sync-status")).toHaveCount(0);
    await page.getByTestId("space-actions").click();
    await expect(page.getByRole("menuitem", { name: "Allow sleep" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Unmute notifications" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.evaluate(async (beta) => {
      const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await post("/api/settings", { neverSleep: { space: "beta", never: false } });
      await post("/api/push/settings", { mute: beta, muted: false });
    }, IDS.beta);
  });

  test("closing a tab takes it away at once; unpinning does too, and a refused unpin comes back with an error", async ({ page }) => {
    await page.goto(`/s/${IDS.beta}`);
    await expect(page.getByTestId("pin")).not.toHaveCount(0);
    const slow = await holdRequests(page, "**/api/actions");
    const tabs = page.locator(".tabs [role='tab']:not(.tab-add)");
    await expect(tabs).toHaveCount(2);
    await tabs.nth(1).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close tab…" }).click();
    await withinTwoFrames(page, '[data-testid="dialog"] .btn-danger', { selector: ".tabs [role='tab']:not(.tab-add):nth-child(2)", absent: true });
    slow.release();
    await page.unroute("**/api/actions");

    await page.route("**/api/pins", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await new Promise((r) => setTimeout(r, 800));
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "refused for the test" }) });
    });
    await withinTwoFrames(page, '[data-testid="pin-unpin"]', { selector: `[data-testid="pin"][data-pin="${IDS.beta}"]`, absent: true });
    await expect(page.getByTestId("sync-toast")).toHaveText(/Couldn't change the pins: refused for the test/u);
    await expect(page.locator(`[data-testid="pin"][data-pin="${IDS.beta}"]`)).toHaveCount(1);
  });

  test("a dropped stream shows Reconnecting, keeping the last tree on screen, until it is back", async ({ page }) => {
    await page.goto("/");
    const tree = await page.evaluate(async () => (await fetch("/api/tree")).text());
    // The stream gives one good tree then ends; every reconnect is refused, as a proxy does while the backend restarts.
    let first = true;
    await page.route("**/api/events", async (route) => {
      if (!first) return route.fulfill({ status: 503, body: "" });
      first = false;
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${tree}\n\n` });
    });
    await page.reload();
    await expect(page.getByTestId("tree-space").first()).toBeVisible();
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "offline");
    await expect(page.getByTestId("tree-space").first()).toBeVisible();
    await page.unroute("**/api/events");
    await expect(page.getByTestId("sync-status")).toHaveCount(0);
  });
});

test.describe("@F142 the Inbox under a slow server", () => {
  const setInboxAndPin = (page: Page, on: boolean) =>
    page.evaluate(
      async ([alpha, on]) => {
        const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        await post("/api/settings", { inbox: on });
        await post("/api/pins", on ? { pin: alpha } : { unpin: alpha });
      },
      [IDS.alpha, on] as const,
    );
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.goto("/");
    await setInboxAndPin(page, false);
    await page.evaluate(() => window.localStorage.removeItem("herdr.graph"));
  });

  test("a dismissed row goes at once", async ({ page }) => {
    const core = qaCore();
    const seeded = await seed(core);
    await addTab(core, seeded, "alpha", "calm", claudeProgram("working"));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await setInboxAndPin(page, true);
    await page.reload();
    await page.getByTestId("view-inbox").click();
    await expect(page.getByTestId("inbox-item").filter({ hasText: "calm" })).toBeVisible();
    const slow = await holdRequests(page, "**/api/actions");
    await withinTwoFrames(page, '[data-testid="inbox-dismiss"]', { selector: '[data-testid="inbox-item"]', absent: true });
    slow.release();
    await page.unroute("**/api/actions");
    await page.reload();
    await page.getByTestId("view-inbox").click();
    await expect(page.getByTestId("inbox-view")).toBeVisible();
    await expect(page.getByTestId("inbox-item").filter({ hasText: "calm" })).toHaveCount(0);
  });
});
