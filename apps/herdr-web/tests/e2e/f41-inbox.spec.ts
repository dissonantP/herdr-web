import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addTab, claudeProgram, controlledClaude, IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F41 + task 60: the "needs you" inbox, a List | Inbox switch (Graph is parked): waiting first, then working, then
// idle; tapping one opens it. A setting turns it on; it is off by default.

async function setInbox(page: Page, on: boolean): Promise<void> {
  await page.evaluate(async (inbox) => {
    await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ inbox }) });
  }, on);
}

// Idle sessions show in the Inbox only in pinned spaces, so tests that expect an idle row pin its space.
async function setPin(page: Page, id: string, on: boolean): Promise<void> {
  await page.evaluate(async ([space, pin]) => {
    await fetch("/api/pins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pin ? { pin: space } : { unpin: space }) });
  }, [id, on] as const);
}

test.beforeEach(async () => {
  await seed(qaCore());
});
test.afterEach(async ({ page }) => {
  await page.goto("/");
  await setInbox(page, false);
  await page.evaluate(() => window.localStorage.removeItem("herdr.graph"));
  await setPin(page, IDS.alpha, false);
  for (const id of [IDS.beta, IDS.gamma, IDS.delta]) await setPin(page, id, false);
});

test("@F111 idle sessions of unpinned spaces are left out of the Inbox; waiting, working and unseen-reply ones stay; pinning brings idle back", async ({ page }) => {
  const core = qaCore();
  const seeded = await seed(core);
  await addTab(core, seeded, "alpha", "calm", claudeProgram("idle"));
  await addTab(core, seeded, "alpha", "busy", claudeProgram("working"));
  await addTab(core, seeded, "alpha", "needy", claudeProgram("blocked"));
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await setInbox(page, true);
  await page.reload();
  await page.getByTestId("inbox-open").click();
  await page.getByTestId("view-inbox").click(); // the button opens the last-picked view (task 112), List by default
  await expect(page.getByTestId("inbox-item").filter({ hasText: "needy" })).toBeVisible();
  await expect(page.getByTestId("inbox-item").filter({ hasText: "busy" })).toBeVisible();
  await expect(page.getByTestId("inbox-item").filter({ hasText: "calm" })).toHaveCount(0);
  await setPin(page, IDS.alpha, true);
  await page.reload();
  await page.getByTestId("inbox-open").click();
  await expect(page.getByTestId("inbox-item").filter({ hasText: "calm" })).toBeVisible();
});

test("@F41 off by default: no view switch", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  await expect(page.getByTestId("view-list")).toHaveCount(0);
  await expect(page.getByTestId("view-inbox")).toHaveCount(0);
});

test("@F41 turning the setting on shows a List | Inbox switch (no Graph); waiting sessions come first, then working, then idle", async ({ page }) => {
  const core = qaCore();
  const seeded = await seed(core);
  await addTab(core, seeded, "alpha", "calm", claudeProgram("idle"));
  await addTab(core, seeded, "gamma", "busy", claudeProgram("working"));
  await addTab(core, seeded, "delta", "needy", claudeProgram("blocked"));
  await page.goto("/");
  await setPin(page, IDS.alpha, true);
  await setInbox(page, true);
  await page.reload();
  await expect(page.getByTestId("view-list")).toBeVisible();
  await expect(page.getByTestId("view-inbox")).toBeVisible();
  await expect(page.getByTestId("view-graph")).toHaveCount(0);
  await page.getByTestId("view-inbox").click();
  await expect(page.getByTestId("inbox-view")).toBeVisible();
  await expect(page.getByTestId("tree-space")).toHaveCount(0);
  await expect(page.getByTestId("inbox-item")).toHaveCount(3);
  await expect.poll(() => page.getByTestId("inbox-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))).toEqual(["waiting", "working", "idle"]);
  await expect(page.getByTestId("inbox-item").first()).toContainText("needy");
  // The other views are one tap away, and the pin bar is there too.
  await expect(page.getByTestId("pin-bar")).toBeVisible();
  await page.getByTestId("view-list").click();
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  await page.getByTestId("view-inbox").click();
  // Tapping a session opens it.
  await page.getByTestId("inbox-item").filter({ hasText: "busy" }).click();
  await expect(page.getByTestId("space-view")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/s/${IDS.gamma}/`));
});

test("@F41 turning the setting off drops the view, and a stored inbox choice falls back to the list", async ({ page }) => {
  await page.goto("/");
  await setInbox(page, true);
  await page.reload();
  await page.getByTestId("view-inbox").click();
  await expect(page.getByTestId("inbox-view")).toBeVisible();
  await setInbox(page, false);
  await page.reload();
  await expect(page.getByTestId("view-inbox")).toHaveCount(0);
  await expect(page.getByTestId("inbox-view")).toHaveCount(0);
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
});

test("@F77 a tapped notification bundle lands on /inbox: the Inbox when it is on, else the list; the URL is replaced with /", async ({ page }) => {
  await page.goto("/");
  await setInbox(page, true);
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-view")).toBeVisible();
  await expect(page).toHaveURL(/\/$/u);
  await page.getByTestId("view-list").click();
  await setInbox(page, false);
  await page.goto("/inbox");
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  await expect(page.getByTestId("inbox-view")).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/u);
});

test("@F77 a running page told to open /inbox (the bundle tap) shows the Inbox", async ({ page }) => {
  await page.goto("/");
  await setInbox(page, true);
  await page.reload();
  await expect(page.getByTestId("view-inbox")).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "open", url: "/inbox" } })));
  await expect(page.getByTestId("inbox-view")).toBeVisible();
});

test("@F41 phone: the top-bar Inbox button opens the Inbox in one tap from the list, a space and a terminal; its badge counts waiting sessions; desktop has none", async ({ page }) => {
  const core = qaCore();
  const seeded = await seed(core);
  await addTab(core, seeded, "alpha", "calm", claudeProgram("idle"));
  await addTab(core, seeded, "delta", "needy", claudeProgram("blocked"));
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await expect(page.getByTestId("inbox-open")).toHaveCount(0); // setting off
  await setPin(page, IDS.alpha, true);
  await setInbox(page, true);
  await page.reload();
  const button = page.getByTestId("inbox-open");
  await expect(button).toBeVisible();
  await expect(page.getByTestId("inbox-badge")).toHaveText("1");
  await expect(button).toHaveAttribute("data-waiting", "1");
  // From the space list (Inbox picked in the view switch).
  await page.getByTestId("view-inbox").click();
  await page.goto("/");
  await button.click();
  await expect(page.getByTestId("inbox-view")).toBeVisible();
  // From a chat view (an agent pane), a terminal view (a shell pane) and a space: one tap each.
  const betaTab = seeded.layout.spaces.find((sp) => sp.id === IDS.beta)?.tabs[0] as { id: string } | undefined;
  const shellPane = `pa${seeded.terminals["beta-a"] ?? ""}`;
  const views: [() => Promise<unknown>, string][] = [
    [() => page.getByTestId("inbox-item").filter({ hasText: "calm" }).click(), "chat-view"],
    [() => page.goto(`/s/${IDS.beta}/${betaTab?.id ?? ""}/${shellPane}`), "terminal-view"],
    [() => page.goto(`/s/${IDS.beta}/`), "space-view"],
  ];
  for (const [open, view] of views) {
    await open();
    await expect(page.getByTestId(view)).toBeVisible();
    await page.getByTestId("inbox-open").click();
    await expect(page.getByTestId("inbox-view")).toBeVisible();
  }
  // A second tap returns to where you were (chat, terminal, space, list); opening something from the Inbox resets that.
  const back: [string, () => Promise<unknown>, string][] = [
    ["chat", () => page.goto("/").then(() => page.getByTestId("inbox-open").click()).then(() => page.getByTestId("inbox-item").filter({ hasText: "calm" }).click()), "chat-view"],
    ["terminal", () => page.goto(`/s/${IDS.beta}/${betaTab?.id ?? ""}/${shellPane}`), "terminal-view"],
    ["space", () => page.goto(`/s/${IDS.beta}/`), "space-view"],
  ];
  for (const [, open, view] of back) {
    await open();
    await expect(page.getByTestId(view).first()).toBeVisible();
    const url = new URL(page.url()).pathname.replace(/\/$/u, "");
    await page.getByTestId("inbox-open").click();
    await expect(page.getByTestId("inbox-view")).toBeVisible();
    await page.getByTestId("inbox-open").click();
    await expect(page.getByTestId("inbox-view")).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).pathname.replace(/\/$/u, "")).toBe(url);
    await expect(page.getByTestId(view).first()).toBeVisible();
  }
  // Opened something from the Inbox in between: the next tap opens the Inbox again.
  await page.getByTestId("inbox-open").click();
  await page.getByTestId("inbox-item").filter({ hasText: "calm" }).click();
  await expect(page.getByTestId("chat-view")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("inbox-view")).toBeVisible();
  await page.getByTestId("inbox-open").click();
  await expect(page.getByTestId("inbox-view")).toBeVisible();
  await page.getByTestId("inbox-item").first().screenshot({ path: "test-results/inbox-phone.png" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId("inbox-open")).toHaveCount(0);
});

// Task 112: the button opens whichever of List and Inbox was last picked.
test("@F112 phone: the top-bar button opens the last-picked view (List or Inbox), a second tap returns, the pick survives a reload", async ({ page }) => {
  await seed(qaCore());
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await setInbox(page, true);
  await page.reload();
  const button = page.getByTestId("inbox-open");
  const space = `/s/${IDS.beta}/`;
  await page.getByTestId("view-list").click();
  await page.goto(space);
  await expect(page.getByTestId("space-view")).toBeVisible();
  await button.click();
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  await expect(page.getByTestId("inbox-view")).toHaveCount(0);
  await button.click();
  await expect(page.getByTestId("space-view")).toBeVisible();
  await page.goto("/");
  await page.getByTestId("view-inbox").click();
  await page.reload();
  await page.goto(space);
  await button.click();
  await expect(page.getByTestId("inbox-view")).toBeVisible();
  await button.click();
  await expect(page.getByTestId("space-view")).toBeVisible();
});

// Task 109: dismiss a session from the Inbox (swipe, or the x button), shared across browsers; it returns on a new reply.
test.describe("@F109 dismiss from the Inbox", () => {
  let dir = "";
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "herdr-f109-"));
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function open(page: Page, state: string): Promise<void> {
    const core = qaCore();
    const seeded = await seed(core);
    const file = join(dir, "state");
    writeFileSync(file, state);
    await addTab(core, seeded, "alpha", "calm", controlledClaude(file));
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/");
    await setPin(page, IDS.alpha, true);
    await setInbox(page, true);
    await page.reload();
    await page.getByTestId("inbox-open").click();
    await page.getByTestId("view-inbox").click(); // the button opens the last-picked view (task 112), List by default
    await expect(page.getByTestId("inbox-item").filter({ hasText: "calm" })).toBeVisible();
  }

  test("a touch swipe dismisses it, a tap still opens a session, a new reply brings it back, and another browser sees the same", async ({ page, browser, isMobile }) => {
    test.skip(!isMobile, "touch swipe: phone project only");
    await open(page, "idle");
    const row = page.getByTestId("inbox-row-wrap").filter({ hasText: "calm" });
    const box = (await row.boundingBox())!;
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    await touch("touchStart", box.x + 40);
    for (const dx of [40, 80, 120, 160]) await touch("touchMove", box.x + 40 + dx);
    await touch("touchEnd", 0);
    await expect(page.getByTestId("inbox-item").filter({ hasText: "calm" })).toHaveCount(0);
    // Another browser (a fresh context) sees the same Inbox.
    const other = await browser.newPage({ viewport: { width: 360, height: 800 }, storageState: await page.context().storageState() });
    await other.goto("/");
    await other.getByTestId("inbox-open").click();
    await expect(other.getByTestId("inbox-view")).toBeVisible();
    await expect(other.getByTestId("inbox-item").filter({ hasText: "calm" })).toHaveCount(0);
    await other.close();
    // A new reply brings it back.
    writeFileSync(join(dir, "state"), "working");
    await expect(page.getByTestId("inbox-working")).toBeVisible({ timeout: 10_000 });
    writeFileSync(join(dir, "state"), "idle");
    await expect(page.getByTestId("inbox-item").filter({ hasText: "calm" })).toBeVisible({ timeout: 10_000 });
  });

  test("a tap opens the session", async ({ page }) => {
    await open(page, "idle");
    await page.getByTestId("inbox-item").filter({ hasText: "calm" }).click();
    await expect(page.getByTestId("chat-view")).toBeVisible();
  });

  test("the dismiss button does the same on desktop", async ({ page }) => {
    await open(page, "blocked");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Dismiss calm" }).click();
    await expect(page.getByTestId("inbox-item").filter({ hasText: "calm" })).toHaveCount(0);
    await page.reload();
    await page.getByTestId("view-inbox").click();
    await expect(page.getByTestId("inbox-item")).toHaveCount(0);
  });
});

test("@F114 Pinned view lists only pinned spaces, tap opens, swipe unpins; the top-bar button follows it", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await setInbox(page, true);
  for (const id of [IDS.alpha, IDS.beta, IDS.gamma, IDS.delta]) await setPin(page, id, false); // opening a space pins it: start clean
  await setPin(page, IDS.alpha, true);
  await setPin(page, IDS.beta, true);
  await page.reload();
  await page.getByTestId("inbox-open").click();
  await page.getByTestId("view-pinned").click();
  await expect(page.getByTestId("pinned-item")).toHaveCount(2);
  await expect(page.getByTestId("pinned-item").filter({ hasText: "gamma" })).toHaveCount(0);
  const row = page.getByTestId("pinned-row-wrap").filter({ hasText: "beta" });
  const box = (await row.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 100, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 250, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("pinned-item")).toHaveCount(1);
  await expect(page.getByTestId("pinned-item").filter({ hasText: "alpha" })).toBeVisible();
  const pins = await page.evaluate(async () => ((await (await fetch("/api/pins")).json()) as { pins: string[] }).pins);
  expect(pins).toEqual([IDS.alpha]);
  // the session's space still exists
  await page.getByTestId("view-list").click();
  await expect(page.getByTestId("tree-space").filter({ hasText: "beta" })).toBeVisible();
  // the button opens the last-picked view
  await page.getByTestId("view-pinned").click();
  await page.getByTestId("pinned-item").click();
  const button = page.getByTestId("inbox-open");
  await expect(button).toHaveAttribute("aria-label", "Pinned");
  await button.click();
  await expect(page.getByTestId("pinned-view")).toBeVisible();
  await button.click();
  await expect(page.getByTestId("pinned-view")).toHaveCount(0);
});
