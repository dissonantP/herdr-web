import { expect, test, type Page } from "@playwright/test";
import { home, row } from "../support/admin-ui.ts";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 64: action menus are split into titled sections with dividers, red items sit together at the
// end, and a gear in the sidebar header opens Settings.

const sizes = [
  { name: "phone", width: 360, height: 800 },
  { name: "desktop", width: 1280, height: 800 },
];

/** Section titles in order, and whether every red item comes after every non-red one. */
async function inspect(page: Page) {
  const menu = page.getByTestId("action-menu");
  const titles = await menu.getByTestId("menu-section-title").allTextContents();
  const dangers = await menu.getByRole("menuitem").evaluateAll((els) => els.map((el) => el.classList.contains("danger")));
  const firstDanger = dangers.indexOf(true);
  return { titles, dangers, tail: firstDanger === -1 || dangers.slice(firstDanger).every(Boolean) };
}

test.describe("@F64 sectioned menus and a findable Settings", () => {
  test.beforeEach(async () => {
    await seed(qaCore());
  });

  for (const size of sizes) {
    test(`space menu has titled sections, red items last (${size.name})`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await home(page);
      await row(page, "space", IDS.beta).getByTestId("row-actions").click();
      await expect(page.getByTestId("action-menu")).toBeVisible();
      const r = await inspect(page);
      expect(r.titles.slice(0, 1)).toEqual(["Space"]);
      expect(r.titles.at(-1)).toBe("Danger");
      expect(r.dangers).toContain(true);
      expect(r.tail).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`menu-${size.name}.png`) });
    });

    test(`the gear opens Settings (${size.name})`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await home(page);
      await page.getByTestId("open-settings").click();
      await expect(page.getByTestId("settings-page")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`settings-${size.name}.png`) });
    });
  }

  test("no app menu in the sidebar header; Settings has Log out last, in red", async ({ page }) => {
    await home(page);
    await expect(page.getByTestId("app-menu")).toHaveCount(0);
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("push-device")).toBeVisible();
    await expect(page.getByTestId("push-paused")).toHaveCount(1);
    const out = page.getByTestId("logout");
    await expect(out).toBeVisible();
    expect(await out.evaluate((e) => e.matches(".danger"))).toBe(true);
    expect(await page.locator("[data-testid=settings-page] .settings-group").last().getByTestId("logout").count()).toBe(1);
    await page.screenshot({ path: test.info().outputPath(`settings-logout-${test.info().project.name}.png`) });
  });
});
