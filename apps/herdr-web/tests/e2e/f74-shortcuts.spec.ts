import { expect, test } from "@playwright/test";
import { seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 74: Settings lists the keyboard shortcuts and lets each be changed (kept per browser): the new keys
// work and the old don't, it survives a reload, Reset restores the defaults, and a conflict is refused.

test.beforeEach(async () => {
  await seed(qaCore());
});

test("@F74 rebind, persist, refuse a conflict, reset", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "keyboard shortcuts are a desktop feature");
  await page.goto("/settings");
  const section = page.getByTestId("shortcuts");
  const launcher = section.getByTestId("shortcut-launcher");
  const sidebar = section.getByTestId("shortcut-sidebar");
  await expect(launcher.getByTestId("shortcut-key")).toHaveText(["Ctrl+K", "Ctrl+P"]);
  await expect(sidebar.getByTestId("shortcut-key")).toHaveText(["Ctrl+B"]);
  await page.screenshot({ path: info.outputPath("desktop.png") });

  // A conflict is refused and recording goes on.
  await sidebar.getByRole("button", { name: "Change Ctrl+B" }).click();
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("shortcut-error")).toContainText("already used for “Open the quick launcher”");
  await expect(page.getByTestId("launcher")).toHaveCount(0);
  await page.keyboard.press("Control+w").catch(() => undefined);
  await expect(page.getByTestId("shortcut-error")).toContainText("browser or system");
  // Then a free one is taken.
  await page.keyboard.press("Control+Shift+j");
  await expect(sidebar.getByTestId("shortcut-key")).toHaveText(["Ctrl+Shift+J"]);
  await expect(page.getByTestId("shortcut-error")).toHaveCount(0);
  // The launcher's Ctrl+P goes; Ctrl+K stays.
  await launcher.getByRole("button", { name: "Remove Ctrl+P" }).click();
  await launcher.getByTestId("shortcut-add").click();
  await page.keyboard.press("Alt+l");
  await expect(launcher.getByTestId("shortcut-key")).toHaveText(["Ctrl+K", "Alt+L"]);

  await page.reload();
  await expect(sidebar.getByTestId("shortcut-key")).toHaveText(["Ctrl+Shift+J"]);
  await page.goto("/");
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  await expect(page.getByTestId("sidebar-toggle")).toHaveAttribute("title", "Hide sidebar (Ctrl+Shift+J)");
  await expect(page.getByTestId("launcher-open")).toHaveAttribute("title", "Quick launcher (Ctrl+K or Alt+L)");
  await page.keyboard.press("Control+b");
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.keyboard.press("Control+Shift+j");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+j");
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.keyboard.press("Control+p");
  await expect(page.getByTestId("launcher")).toHaveCount(0);
  await page.keyboard.press("Alt+l");
  await expect(page.getByTestId("launcher")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto("/settings");
  await page.getByTestId("shortcuts-reset").click();
  await expect(launcher.getByTestId("shortcut-key")).toHaveText(["Ctrl+K", "Ctrl+P"]);
  await expect(sidebar.getByTestId("shortcut-key")).toHaveText(["Ctrl+B"]);
  await expect(page.getByTestId("shortcuts-reset")).toBeDisabled();
  await page.reload();
  await expect(sidebar.getByTestId("shortcut-key")).toHaveText(["Ctrl+B"]);
  await page.goto("/");
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  await page.keyboard.press("Control+b");
  await expect(page.locator(".sidebar")).toHaveCount(0);
});

test("@F74 the section is readable at phone width", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone layout");
  await page.goto("/settings");
  const section = page.getByTestId("shortcuts");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByTestId("shortcut-key").first()).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(360);
  for (const row of await section.locator(".shortcut").all()) {
    const b = (await row.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(360);
  }
  await section.screenshot({ path: info.outputPath("phone.png") });
});
