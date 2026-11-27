import { expect, test } from "@playwright/test";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F2: phone navigation (tree home, space full screen with a tab strip, pane switcher for splits,
// back to the tree) and the desktop layout (tree sidebar beside the selected pane).

test.beforeEach(async () => {
  await seed(qaCore());
});

test.describe("@F2 phone", () => {
  test.skip(({ isMobile }) => !isMobile, "phone layout");

  test("tree home, space full screen with tabs and a pane switcher, back to the tree", async ({ page }) => {
    await page.goto("/");
    const tree = page.getByRole("navigation", { name: "Spaces" });
    await expect(tree).toBeVisible();
    await expect(page.getByTestId("space-view")).toHaveCount(0);

    await page.locator(`[data-id="${IDS.beta}"] .row-name`).click();
    const space = page.getByTestId("space-view");
    await expect(space).toBeVisible();
    await expect(tree).toHaveCount(0);
    const box = await space.boundingBox();
    expect(box?.width).toBe(360);

    // Only this space's own tabs are tabs.
    const tabs = page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
    await expect(tabs).toHaveText(["main", "2"]);
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");

    // A split tab: a switcher, one pane at a time.
    const panes = page.getByRole("tablist", { name: "Panes" }).getByRole("tab");
    await expect(panes).toHaveText(["beta-a", "beta-b"]);
    await expect(page.getByTestId("pane-view")).toHaveCount(1);
    await expect(page.getByTestId("pane-view").locator(".pane-title")).toHaveText("beta-a");
    await panes.nth(1).click();
    await expect(page.getByTestId("pane-view").locator(".pane-title")).toHaveText("beta-b");

    // An unsplit tab: no switcher.
    await tabs.nth(1).click();
    await expect(page.getByRole("tablist", { name: "Panes" })).toHaveCount(0);
    await expect(page.getByTestId("pane-view").locator(".pane-title")).toHaveText("beta-c");

    await page.getByRole("button", { name: "Back to spaces" }).click();
    await expect(tree).toBeVisible();
    await expect(page).toHaveURL(/\/$/u);
  });

  test("the phone's back gesture returns to the tree too", async ({ page }) => {
    await page.goto("/");
    await page.locator(`[data-id="${IDS.gamma}"] .row-name`).click();
    await expect(page.getByTestId("space-view")).toBeVisible();
    await page.getByRole("tab", { name: "1" }).click();
    await page.goBack();
    await expect(page.getByRole("navigation", { name: "Spaces" })).toBeVisible();
  });

  test("a pane opened from the tree shows that pane", async ({ page }) => {
    await page.goto("/");
    await page.locator(`[data-id="${IDS.beta}"] .chevron`).click();
    await page.locator('[data-testid="tree-pane"]', { hasText: "beta-b" }).locator(".row-name").click();
    await expect(page.getByTestId("pane-view").locator(".pane-title")).toHaveText("beta-b");
  });
});

test.describe("@F2 desktop", () => {
  test.skip(({ isMobile }) => isMobile, "desktop layout");

  test("tree in a sidebar, the selected pane beside it", async ({ page }) => {
    await page.goto("/");
    const tree = page.getByRole("navigation", { name: "Spaces" });
    await expect(tree).toBeVisible();

    await page.locator(`[data-id="${IDS.beta}"] .chevron`).click();
    await page.locator('[data-testid="tree-pane"]', { hasText: "beta-b" }).locator(".row-name").click();
    const pane = page.getByTestId("pane-view");
    await expect(pane.locator(".pane-title")).toHaveText("beta-b");
    await expect(tree).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to spaces" })).toHaveCount(0);

    const treeBox = await tree.boundingBox();
    const paneBox = await pane.boundingBox();
    expect(treeBox !== null && paneBox !== null && paneBox.x >= treeBox.x + treeBox.width).toBe(true);
    await expect(page.locator('[data-testid="tree-pane"].selected')).toHaveText("beta-b");
  });
});
