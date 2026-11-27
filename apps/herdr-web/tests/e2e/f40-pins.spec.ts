import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTab, controlledClaude, IDS, seed } from "../support/fixture.ts";
import { authed } from "../support/auth.ts";
import { qaCore } from "../support/world.ts";

// F40: the pin bar. A horizontal bar at the top of every view; opening any space pins it at the
// end and makes it active (so the bar doubles as recents); tapping a pin switches space; pins drag
// to reorder; the unpin button shows only on the active pinned space; the list is kept on the server
// (shared by devices), what is active is per device (the route).

const base = () => `http://127.0.0.1:${String(process.env.HERDR_QA_PORT)}`;
const api = (body?: unknown) =>
  fetch(`${base()}/api/pins`, body === undefined ? { headers: authed({}) } : { method: "POST", headers: authed({ "content-type": "application/json", origin: base() }), body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ pins: string[] }>);

const pins = (page: Page) => page.getByTestId("pin");
const names = (page: Page) => pins(page).locator(".pin-name").allTextContents();

async function clear(): Promise<void> {
  for (const id of (await api()).pins) await api({ unpin: id });
}

test.beforeEach(async () => {
  await seed(qaCore());
  await clear();
});
test.afterEach(clear);

test("@F40 opening a space pins it at the end and makes it active; the list lives on the server", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("pin-bar")).toBeVisible();
  await expect(pins(page)).toHaveCount(0);
  await page.goto(`/s/${IDS.beta}`);
  await expect(pins(page)).toHaveCount(1);
  await expect(pins(page).first()).toHaveAttribute("aria-selected", "true");
  await page.goto(`/s/${IDS.alpha}`);
  await expect(pins(page)).toHaveCount(2);
  expect(await names(page)).toEqual(["beta", "alpha"]);
  expect((await api()).pins).toEqual([IDS.beta, IDS.alpha]);
  // Opening an already pinned space doesn't move it.
  await page.getByTestId("pin").filter({ hasText: "beta" }).locator(".pin-name").click();
  await expect(page).toHaveURL(new RegExp(`/s/${IDS.beta}$`));
  expect(await names(page)).toEqual(["beta", "alpha"]);
  expect((await api()).pins).toEqual([IDS.beta, IDS.alpha]);
});

test.skip("@F40 the bar shows in the list, the graph and the inbox, and tapping a pin switches space", async ({ page }) => {
  await api({ pin: IDS.alpha });
  await api({ pin: IDS.beta });
  await page.goto("/");
  await expect(pins(page)).toHaveCount(2);
  await page.getByTestId("view-graph").click();
  await expect(page.getByTestId("graph-view")).toBeVisible();
  await expect(page.getByTestId("pin-bar")).toBeVisible();
  await expect(pins(page)).toHaveCount(2);
  await pins(page).filter({ hasText: "alpha" }).locator(".pin-name").click();
  await expect(page).toHaveURL(new RegExp(`/s/${IDS.alpha}$`));
  await expect(pins(page).filter({ hasText: "alpha" })).toHaveAttribute("aria-selected", "true");
  await expect(pins(page).filter({ hasText: "beta" })).toHaveAttribute("aria-selected", "false");
  await pins(page).filter({ hasText: "beta" }).locator(".pin-name").click();
  await expect(page).toHaveURL(new RegExp(`/s/${IDS.beta}$`));
});

test("@F40 the unpin button shows only on the active pin, and unpinning removes it everywhere", async ({ page }) => {
  await api({ pin: IDS.alpha });
  await api({ pin: IDS.beta });
  await page.goto(`/s/${IDS.alpha}`);
  await expect(page.getByTestId("pin-unpin")).toHaveCount(1);
  await expect(pins(page).filter({ hasText: "alpha" }).getByTestId("pin-unpin")).toBeVisible();
  await expect(pins(page).filter({ hasText: "beta" }).getByTestId("pin-unpin")).toHaveCount(0);
  await page.getByTestId("pin-unpin").click();
  await expect(pins(page)).toHaveCount(1);
  expect(await names(page)).toEqual(["beta"]);
  await expect.poll(async () => (await api()).pins).toEqual([IDS.beta]);
  // Not re-pinned behind its back.
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  await page.waitForTimeout(500);
  expect((await api()).pins).toEqual([IDS.beta]);
});

test("@F40 another device's pins show up when this one looks again", async ({ page }) => {
  await page.goto("/");
  await expect(pins(page)).toHaveCount(0);
  await api({ pin: IDS.gamma });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(pins(page)).toHaveCount(1);
});

test("@F40 pins drag to reorder, and the order is kept on the server", async ({ page }, info) => {
  for (const id of [IDS.alpha, IDS.beta, IDS.gamma]) await api({ pin: id });
  await page.goto("/");
  await expect(pins(page)).toHaveCount(3);
  expect(await names(page)).toEqual(["alpha", "beta", "gamma"]);
  const a = await pins(page).nth(0).boundingBox();
  const g = await pins(page).nth(2).boundingBox();
  if (a === null || g === null) throw new Error("pins not visible");
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const end = { x: g.x + g.width - 2, y: g.y + g.height / 2 };
  const steps = 10;
  const at = (i: number) => ({ x: start.x + ((end.x - start.x) * i) / steps, y: start.y });
  if (info.project.name === "phone") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
    await page.waitForTimeout(500); // hold first
    for (let i = 1; i <= steps; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [at(i)] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) await page.mouse.move(at(i).x, at(i).y);
    await page.mouse.up();
  }
  await expect.poll(() => names(page)).toEqual(["beta", "gamma", "alpha"]);
  await expect.poll(async () => (await api()).pins).toEqual([IDS.beta, IDS.gamma, IDS.alpha]);
  // The drag didn't open the dragged space.
  await expect(page).toHaveURL(/\/$/u);
  await page.reload();
  await expect.poll(() => names(page)).toEqual(["beta", "gamma", "alpha"]);
});

test("@F40 a pin of a deleted space isn't shown", async ({ page }) => {
  await api({ pin: IDS.alpha });
  await api({ pin: "spgone" });
  await page.goto("/");
  await expect(pins(page)).toHaveCount(1);
  expect(await names(page)).toEqual(["alpha"]);
});

test("@F40 task 078: a pin shows a working indicator while an agent works in it; the waiting alert wins", async ({ page }, info) => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-f40-"));
  const state = join(dir, "state");
  writeFileSync(state, "idle");
  try {
    const core = qaCore();
    const seeded = await seed(core);
    await addTab(core, seeded, "alpha", "busy", controlledClaude(state));
    await api({ pin: IDS.alpha });
    await page.goto("/");
    const pin = pins(page).filter({ hasText: "alpha" });
    const dot = pin.getByTestId("pin-working");
    await expect(pin).toBeVisible();
    await expect(dot).toHaveCount(0);

    writeFileSync(state, "working");
    await expect(dot).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: info.outputPath(`pin-working-${info.project.name}.png`) });
    // The space's own tab shows it too (alert wins there as well).
    await page.goto(`/s/${IDS.alpha}`);
    const tabDot = page.getByRole("tab", { name: "busy", exact: true }).getByTestId("tab-working");
    await expect(tabDot).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: info.outputPath(`tab-working-${info.project.name}.png`) });
    await page.goto("/");

    writeFileSync(state, "blocked");
    await expect(pin.locator(".badge")).toBeVisible({ timeout: 5000 });
    await expect(dot).toHaveCount(0);
    await page.goto(`/s/${IDS.alpha}`);
    await expect(page.getByRole("tab", { name: "busy", exact: true }).getByTestId("tab-badge")).toBeVisible();
    await expect(page.getByTestId("tab-working")).toHaveCount(0);
    await page.goto("/");

    writeFileSync(state, "working");
    await expect(dot).toBeVisible({ timeout: 5000 });
    writeFileSync(state, "idle");
    await expect(dot).toHaveCount(0, { timeout: 5000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("@F40 task 078: a finished, unseen pane shows a finished dot on its pin, tab and tree row until viewed", async ({ page }, info) => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-f40-"));
  const state = join(dir, "state");
  writeFileSync(state, "idle");
  try {
    const core = qaCore();
    const seeded = await seed(core);
    await addTab(core, seeded, "alpha", "busy", controlledClaude(state));
    await api({ pin: IDS.alpha });
    await page.goto("/");
    const pin = pins(page).filter({ hasText: "alpha" });
    await expect(pin).toBeVisible();
    writeFileSync(state, "working");
    await expect(pin.getByTestId("pin-working")).toBeVisible({ timeout: 5000 });
    writeFileSync(state, "done");
    await expect(pin.getByTestId("pin-finished")).toBeVisible({ timeout: 5000 });
    await expect(pin.getByTestId("pin-working")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`pin-finished-${info.project.name}.png`) });
    // Opening the space shows it on the tab until the pane is viewed, then it clears everywhere.
    await page.goto(`/s/${IDS.alpha}`);
    await page.getByRole("tab", { name: "busy", exact: true }).click();
    await expect(pin.getByTestId("pin-finished")).toHaveCount(0, { timeout: 5000 });
    await expect(page.getByTestId("tab-finished")).toHaveCount(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("@F40 task 082: a space row rolls up its sessions' working and finished dots, folded or expanded", async ({ page }, info) => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-f40-"));
  const state = join(dir, "state");
  writeFileSync(state, "idle");
  try {
    const core = qaCore();
    const seeded = await seed(core);
    await addTab(core, seeded, "alpha", "busy", controlledClaude(state));
    await page.goto("/");
    const row = page.locator(`[data-testid="tree-space"][data-id="${IDS.alpha}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("row-working")).toHaveCount(0);

    writeFileSync(state, "working");
    await expect(row.getByTestId("row-working")).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: info.outputPath(`row-working-${info.project.name}.png`) });
    await row.getByRole("button", { name: /^Unfold/ }).click();
    await expect(row.getByTestId("row-working")).toBeVisible();
    await expect(page.locator('[data-testid="pane-status"][data-status="working"]').first()).toBeVisible();
    await row.getByRole("button", { name: /^Fold/ }).click();

    writeFileSync(state, "done");
    await expect(row.getByTestId("row-finished")).toBeVisible({ timeout: 5000 });
    await expect(row.getByTestId("row-working")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`row-finished-${info.project.name}.png`) });
    await row.getByRole("button", { name: /^Unfold/ }).click();
    await expect(row.getByTestId("row-finished")).toBeVisible();
    await expect(page.locator('[data-testid="pane-status"][data-status="finished"]').first()).toBeVisible();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
