import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { IDS, seed } from "../support/fixture.ts";
import { usageCountFile } from "../support/global-setup.ts";
import { qaCore } from "../support/world.ts";

// Task 098: the usage bar at the bottom: a one-liner with the 5-hour and weekly % (what `claude -p /usage`
// prints; the backend runs it through a fake here), a popup with every limit, and a cache so the source
// runs at most once per TTL however often pages load.

const runs = () => (existsSync(usageCountFile(Number(process.env.HERDR_QA_PORT))) ? readFileSync(usageCountFile(Number(process.env.HERDR_QA_PORT)), "utf8").split("\n").filter((l) => l !== "").length : 0);

test.beforeEach(async () => {
  await seed(qaCore());
});

test("@F53 the one-liner shows the 5-hour and weekly %, and tapping it opens and closes the popup", async ({ page }) => {
  await page.goto("/");
  const line = page.getByTestId("usage-line");
  await expect(line).toHaveText("5h 10% · wk 2%");
  await expect(page.getByTestId("usage-popup")).toHaveCount(0);
  await line.click();
  const pop = page.getByTestId("usage-popup");
  await expect(pop).toBeVisible();
  await expect(pop).toContainText("week (Fable)");
  await expect(pop).toContainText("resets Nov 24, 1am");
  await expect(pop).toContainText("times in America/Los_Angeles");
  await page.screenshot({ path: test.info().outputPath("usage-popup.png") });
  await line.click();
  await expect(pop).toHaveCount(0);
  await line.click();
  await expect(pop).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
});

test("@F53 on the home screen the bar is at the bottom of the window, not under a short list", async ({ page }) => {
  await page.goto("/");
  const line = page.getByTestId("usage-line");
  await expect(line).toBeVisible();
  const box = await line.boundingBox();
  expect(box!.y + box!.height).toBeCloseTo(page.viewportSize()!.height, 0);
});

test("@F53 the bar sits at the bottom and covers neither the space's content nor the terminal keys", async ({ page }) => {
  await page.goto(`/s/${IDS.alpha}`);
  const line = page.getByTestId("usage-line");
  await expect(line).toBeVisible();
  const box = await line.boundingBox();
  const vh = page.viewportSize()!.height;
  expect(box!.y + box!.height).toBeCloseTo(vh, 0);
  // Nothing of the space view reaches under it.
  const viewBottom = await page.evaluate(() => document.querySelector(".space-view")!.getBoundingClientRect().bottom);
  expect(viewBottom).toBeLessThanOrEqual(box!.y + 1);
  await page.screenshot({ path: test.info().outputPath("usage-space.png") });
});

test("@F53 the source runs once, not on every page load", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("usage-line")).toHaveText("5h 10% · wk 2%");
  const before = runs();
  expect(before).toBeGreaterThanOrEqual(1);
  await page.reload();
  await expect(page.getByTestId("usage-line")).toHaveText("5h 10% · wk 2%");
  expect(runs()).toBe(before);
});
