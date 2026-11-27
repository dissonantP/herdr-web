import { expect, test } from "@playwright/test";
import { seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 63: the desktop sidebar's edge drags between 200 and 600 px, the width survives a reload,
// double-click resets it, and the phone layout has no handle.

test.beforeEach(async () => {
  await seed(qaCore());
});

const width = async (page: import("@playwright/test").Page) =>
  Math.round((await page.locator(".sidebar").boundingBox())!.width);

async function dragTo(page: import("@playwright/test").Page, x: number) {
  const b = (await page.getByTestId("sidebar-handle").boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 100);
  await page.mouse.down();
  await page.mouse.move(x, b.y + 100, { steps: 5 });
  await page.mouse.up();
}

test("@F63 dragging resizes within limits, survives reload, double-click resets", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  expect(await width(page)).toBe(300);
  await dragTo(page, 420);
  await expect.poll(() => width(page)).toBe(420);
  await dragTo(page, 20);
  await expect.poll(() => width(page)).toBe(200);
  await dragTo(page, 1200);
  await expect.poll(() => width(page)).toBe(600);
  await dragTo(page, 380);
  await expect.poll(() => width(page)).toBe(380);
  await page.reload();
  await expect(page.getByTestId("sidebar-handle")).toBeVisible();
  expect(await width(page)).toBe(380);
  await page.getByTestId("sidebar-handle").dblclick();
  await expect.poll(() => width(page)).toBe(300);
  await page.reload();
  await expect(page.getByTestId("sidebar-handle")).toBeVisible();
  expect(await width(page)).toBe(300);
});

test("@F63 the phone layout has no handle", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  await expect(page.getByTestId("sidebar-handle")).toHaveCount(0);
});
