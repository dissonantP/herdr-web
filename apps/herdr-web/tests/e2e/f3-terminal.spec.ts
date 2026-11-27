import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F3: a terminal pane opens a live terminal (ghostty-web) that accepts typing, with a keys bar
// (Esc, Tab, Ctrl, arrows). Typing goes through the browser, the backend and herdr-core; the
// assertions read what the terminal really shows (from the core) and what the page shows.

let beta: string;
test.beforeEach(async () => {
  const seeded = await seed(qaCore());
  beta = seeded.terminals.betaA ?? "";
});

async function openLive(page: Page) {
  await page.goto(`/s/${IDS.beta}`);
  const view = page.getByTestId("terminal-view");
  await expect(view).toHaveAttribute("data-state", "live");
  // Tap/click focuses the terminal on both phone and desktop.
  await page.getByTestId("terminal").click();
}

async function screen(): Promise<string> {
  return qaCore().screen(beta);
}

test.describe("@F3 terminal", () => {
  test("opens live and fits the page's width", async ({ page }) => {
    await openLive(page);
    const box = await page.getByTestId("terminal").boundingBox();
    const viewport = page.viewportSize();
    expect(box?.width).toBeGreaterThan(200);
    expect(box?.width).toBeLessThanOrEqual(viewport?.width ?? 0);
    // The terminal was resized to this viewer's size, so it is narrower than the core's 200 columns.
    await expect.poll(async () => (await qaCore().call("terminal.get", { terminal: beta })).cols).toBeLessThan(200);
  });

  test("accepts typing", async ({ page }) => {
    await openLive(page);
    await page.keyboard.type("echo f3-$((20+22))");
    await page.keyboard.press("Enter");
    await expect.poll(screen).toContain("f3-42");
    await expect(page.getByTestId("terminal-text")).toContainText("f3-42");
  });

  test("keys bar sends Esc, Tab, arrows and Ctrl", async ({ page }) => {
    await openLive(page);
    await page.keyboard.type("cat -v");
    await page.keyboard.press("Enter");
    const bar = page.getByTestId("keys-bar");
    await expect(bar.getByRole("button")).toHaveText(["Esc", "Tab", "Ctrl", "←", "↑", "↓", "→", "Paste"]);
    await bar.locator('[data-key="escape"]').click();
    await bar.locator('[data-key="tab"]').click();
    await bar.locator('[data-key="arrow-up"]').click();
    await page.keyboard.press("Enter");
    // cat -v shows the bytes it received: Esc, Tab (as itself), Up.
    await expect.poll(screen).toMatch(/\^\[\s+\^\[\[A/u);

    // Sticky Ctrl turns the next typed key into a control character: Ctrl-D ends cat.
    await bar.locator('[data-key="ctrl"]').click();
    await expect(bar.locator('[data-key="ctrl"]')).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.type("d");
    await expect(bar.locator('[data-key="ctrl"]')).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.type("echo after-$((1+1))");
    await page.keyboard.press("Enter");
    await expect.poll(screen).toContain("after-2");
  });

  test("holding an on-screen arrow repeats it and stops on release", async ({ page }) => {
    await openLive(page);
    await page.keyboard.type("cat -v");
    await page.keyboard.press("Enter");
    const up = page.getByTestId("keys-bar").locator('[data-key="arrow-up"]');
    const count = async () => (((await screen()).match(/\^\[\[A/gu)) ?? []).length;
    // A single tap sends exactly one.
    await up.click();
    await expect.poll(count).toBe(1);
    await page.waitForTimeout(700);
    expect(await count()).toBe(1);
    // Holding repeats.
    const box = await up.boundingBox();
    if (box === null) throw new Error("no key box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect.poll(count, { timeout: 5000 }).toBeGreaterThan(5);
    await page.mouse.up();
    // Release stops it.
    await page.waitForTimeout(300);
    const after = await count();
    await page.waitForTimeout(700);
    expect(await count()).toBe(after);
  });

  test("arrow repeat stops when the pointer leaves the key; physical keys and keyboard activation work", async ({ page }) => {
    await openLive(page);
    await page.keyboard.type("cat -v");
    await page.keyboard.press("Enter");
    const up = page.getByTestId("keys-bar").locator('[data-key="arrow-up"]');
    const count = async () => (((await screen()).match(/\^\[\[A/gu)) ?? []).length;
    const box = await up.boundingBox();
    if (box === null) throw new Error("no key box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect.poll(count, { timeout: 5000 }).toBeGreaterThan(3);
    await page.mouse.move(box.x + box.width / 2, box.y - 200);
    await page.waitForTimeout(300);
    const after = await count();
    await page.waitForTimeout(700);
    expect(await count()).toBe(after);
    await page.mouse.up();
    // Physical keyboard: a held key (repeated keydowns) reaches the terminal repeatedly.
    const before = await count();
    await page.keyboard.down("ArrowUp");
    for (let i = 0; i < 5; i++) await page.keyboard.down("ArrowUp");
    await page.keyboard.up("ArrowUp");
    await expect.poll(count).toBeGreaterThanOrEqual(before + 6);
  });

  test("reconnects when the connection drops and shows the same screen", async ({ page }) => {
    // Proxy the terminal socket so the test can drop the first connection.
    const routes: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/api\/terminal\//u, (ws) => {
      ws.connectToServer();
      routes.push(ws);
    });
    await openLive(page);
    await page.keyboard.type("echo before-drop");
    await page.keyboard.press("Enter");
    await expect.poll(screen).toContain("before-drop");
    await routes[0]?.close({ code: 1006, reason: "dropped by test" });
    // The program kept running in herdr-core; the second attach paints the same screen again.
    await expect.poll(() => routes.length).toBe(2);
    await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live");
    await expect(page.getByTestId("terminal-text")).toContainText("before-drop");
    await page.keyboard.type("echo after-drop");
    await page.keyboard.press("Enter");
    await expect.poll(screen).toContain("after-drop");
  });
});
