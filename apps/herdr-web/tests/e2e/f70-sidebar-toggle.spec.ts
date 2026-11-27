import { expect, test } from "@playwright/test";
import { seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 70: a top-bar button hides and shows the sidebar; the width comes back and the state survives a reload.

test.beforeEach(async () => {
  await seed(qaCore());
});

const width = async (page: import("@playwright/test").Page) =>
  Math.round((await page.locator(".sidebar").boundingBox())!.width);

for (const [name, w] of [["tablet", 900], ["desktop", 1280]] as const) {
  test(`@F70 the button hides and shows the sidebar (${name})`, async ({ page }, info) => {
    await page.setViewportSize({ width: w, height: 800 });
    await page.goto("/");
    await expect(page.getByTestId("tree-space").first()).toBeVisible();
    const toggle = page.getByTestId("sidebar-toggle");
    await expect(toggle).toHaveAttribute("title", /Hide sidebar.*Ctrl\+B/);
    await page.screenshot({ path: info.outputPath(`${name}-shown.png`) });
    const b = (await page.getByTestId("sidebar-handle").boundingBox())!;
    await page.mouse.move(b.x + 1, b.y + 100);
    await page.mouse.down();
    await page.mouse.move(380, b.y + 100, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => width(page)).toBe(380);
    await toggle.click();
    await expect(page.locator(".sidebar")).toHaveCount(0);
    expect(Math.round((await page.locator(".main").boundingBox())!.width)).toBe(w);
    await page.screenshot({ path: info.outputPath(`${name}-hidden.png`) });
    await page.reload();
    await expect(page.getByTestId("sidebar-toggle")).toHaveAttribute("title", /Show sidebar/);
    await expect(page.locator(".sidebar")).toHaveCount(0);
    await page.getByTestId("sidebar-toggle").click();
    await expect(page.locator(".sidebar")).toBeVisible();
    expect(await width(page)).toBe(380);
    await page.reload();
    await expect(page.locator(".sidebar")).toBeVisible();
  });
}

test("@F70 Ctrl+B toggles the sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  await page.keyboard.press("Control+b");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.keyboard.press("Control+b");
  await expect(page.locator(".sidebar")).toBeVisible();
});

test("@F70 the phone layout has no toggle", async ({ page }, info) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  await expect(page.getByTestId("sidebar-toggle")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("phone.png") });
  await page.keyboard.press("Control+b");
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".sidebar")).toBeVisible();
});
