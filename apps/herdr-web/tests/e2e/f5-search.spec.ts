import { expect, test, type Page } from "@playwright/test";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F5: typing in the search box filters the tree to matching spaces and sessions by name.

test.beforeEach(async () => {
  await seed(qaCore());
});

const ids = (page: Page, kind: "space" | "pane") => page.locator(`[data-testid="tree-${kind}"] .row-name`).allTextContents();

test("@F5 filters spaces by name, then restores the tree", async ({ page }) => {
  await page.goto("/");
  const box = page.getByTestId("search-box");
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  expect(await ids(page, "space")).toEqual(["beta", "delta-from-where", "gamma", "alpha"]);
  await box.fill("GAM");
  // gamma sits in group work: the group stays so the match has its place.
  await expect(page.locator('[data-testid="tree-space"] .row-name')).toHaveText(["gamma"]);
  await expect(page.locator('[data-testid="tree-group"] .row-name')).toHaveText(["work"]);
  await box.fill("");
  await expect(page.locator('[data-testid="tree-space"] .row-name')).toHaveCount(4);
  await expect(page.locator(`[data-id="${IDS.empty}"]`)).toBeVisible();
});

test("@F5 filters sessions by name and shows them", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("search-box").fill("beta-b");
  // Only the matching session, with the space and tab that hold it, opened so it is visible.
  await expect(page.locator('[data-testid="tree-space"] .row-name')).toHaveText(["beta"]);
  await expect(page.locator('[data-testid="tree-pane"] .row-name')).toHaveText(["beta-b"]);
  await expect(page.locator('[data-testid="tree-pane"] .row-name', { hasText: "beta-a" })).toHaveCount(0);
});

test("@F5 says when nothing matches", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("search-box").fill("no-such-thing");
  await expect(page.getByTestId("search-empty")).toBeVisible();
  await expect(page.getByTestId("tree-space")).toHaveCount(0);
});
