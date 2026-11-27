import { expect, test } from "@playwright/test";
import { home, row, rowAction, submitDialog } from "../support/admin-ui.ts";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F11: move a top-level space to another group, or out of groups; it persists in the groups file.

test("@F11 move a space into a group and out of groups", async ({ page }) => {
  const core = qaCore();
  await seed(core);
  await home(page);
  await rowAction(row(page, "space", IDS.beta), "Move to group…");
  await submitDialog(page, { "To group": IDS.inner }, "Move");
  expect(core.readGroups().spaces[IDS.beta]).toEqual({ name: "beta", group: "inner", groupId: IDS.inner, color: null });
  await expect(page.locator(`.group:has([data-testid="tree-group"][data-id="${IDS.inner}"]) [data-testid="tree-space"][data-id="${IDS.beta}"]`)).toBeVisible();

  await rowAction(row(page, "space", IDS.gamma), "Move to group…");
  await submitDialog(page, { "To group": "" }, "Move");
  expect(core.readGroups().spaces[IDS.gamma]).toEqual({ name: "gamma", group: null, groupId: null, color: null });
  // Out of groups: drawn with the loose spaces at depth 0.
  await expect(row(page, "space", IDS.gamma)).toHaveAttribute("data-depth", "0");

  // delta had no entry in the file: moving it adds one with exactly Desktop's fields.
  await rowAction(row(page, "space", IDS.delta), "Move to group…");
  await submitDialog(page, { "To group": IDS.empty }, "Move");
  expect(Object.keys(core.readGroups().spaces[IDS.delta] ?? {}).sort()).toEqual(["color", "group", "groupId", "name"]);
  await expect(row(page, "space", IDS.delta)).toHaveAttribute("data-depth", "1");
});
