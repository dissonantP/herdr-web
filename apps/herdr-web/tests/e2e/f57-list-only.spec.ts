import { expect, test } from "@playwright/test";
import { seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 57: the Graph/List switch is hidden; the app always shows the List, even with "graph" stored.

test.beforeEach(async () => {
  await seed(qaCore());
});

test("@F57 no view switch is rendered and a stored graph preference still shows the List", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("herdr.graph", JSON.stringify({ mode: "graph", sessions: false })));
  await page.goto("/");
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  await expect(page.getByTestId("graph-view")).toHaveCount(0);
  await expect(page.getByTestId("view-list")).toHaveCount(0);
  await expect(page.getByTestId("view-graph")).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "Hierarchy view" })).toHaveCount(0);
});
