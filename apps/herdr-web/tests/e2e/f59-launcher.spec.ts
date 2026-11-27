import { expect, test } from "@playwright/test";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 59: the quick launcher. Ctrl+K opens it (also from a focused terminal), typing filters,
// Enter navigates, Escape closes; a header button opens it too (the phone has no hotkey).

test.beforeEach(async () => {
  await seed(qaCore());
});

const box = (page: import("@playwright/test").Page) => page.getByTestId("launcher-input");

test("@F59 the hotkey opens it from the tree, typing filters, Enter opens the space, Escape closes", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(box(page)).toBeFocused();
  await expect(page.getByTestId("launcher-result").first()).toBeVisible();
  await page.keyboard.type("gam");
  await expect(page.getByTestId("launcher-result").first()).toHaveAttribute("data-name", "gamma");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/s/${IDS.gamma}$`));
  await expect(page.getByTestId("launcher")).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("launcher")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("launcher")).toHaveCount(0);
});

test("@F59 the hotkey works while a terminal has focus, and arrow keys pick a result", async ({ page }) => {
  await page.goto(`/s/${IDS.beta}`);
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live");
  await page.getByTestId("terminal").click();
  await page.keyboard.press("Control+k");
  await expect(box(page)).toBeFocused();
  await page.keyboard.type("a");
  await expect(page.getByTestId("launcher-result").nth(1)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("launcher-result").nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("launcher-result").first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  const second = await page.getByTestId("launcher-result").nth(1).getAttribute("data-name");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/s/${IDS[second as "alpha" | "beta" | "gamma"]}$`));
});

test("@F59 empty box lists recently opened spaces first; results are spaces only", async ({ page }) => {
  await page.goto(`/s/${IDS.gamma}`);
  await expect(page.getByTestId("space-view")).toBeVisible();
  await page.goto(`/s/${IDS.alpha}`);
  await expect(page.getByTestId("space-view")).toBeVisible();
  await page.getByTestId("launcher-open").click();
  await expect(page.getByTestId("launcher-result").first()).toHaveAttribute("data-name", "alpha");
  await expect(page.getByTestId("launcher-result").nth(1)).toHaveAttribute("data-name", "gamma");
  const kinds = await page.getByTestId("launcher-result").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
  expect(new Set(kinds)).toEqual(new Set(["space"]));
  await page.keyboard.type("beta-b");
  await expect(page.getByTestId("launcher-empty")).toBeVisible();
});

test("@F61 Ctrl+P opens it (also from a terminal) without the print dialog; the button has a hotkey tooltip", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => {
      (window as unknown as { __printed: number }).__printed++;
    };
  });
  await page.goto(`/s/${IDS.beta}`);
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live");
  await expect(page.getByTestId("launcher-open")).toHaveAttribute("title", /Ctrl\+P/);
  await page.getByTestId("terminal").click();
  await page.keyboard.press("Control+p");
  await expect(box(page)).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(0);
  await page.keyboard.press("Escape");
  await page.getByTestId("launcher-open").hover();
  await page.keyboard.press("Control+p");
  await expect(page.getByTestId("launcher")).toBeVisible();
});

test("@F59 the header button opens it and fits the screen", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("launcher-open").click();
  await expect(box(page)).toBeFocused();
  const b = await page.getByTestId("launcher").boundingBox();
  expect(b?.x).toBeGreaterThanOrEqual(0);
  expect((b?.x ?? 0) + (b?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  await page.keyboard.type("zzzzzz");
  await expect(page.getByTestId("launcher-empty")).toBeVisible();
});
