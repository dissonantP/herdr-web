import { expect, test } from "@playwright/test";
import { home, row, rowAction, submitDialog } from "../support/admin-ui.ts";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 62: a group's and a space's actions menu has "Colour…"; picking writes Desktop's groups
// format and the rows recolour at once.

const bg = (page: import("@playwright/test").Page, kind: "group" | "space", id: string) => row(page, kind, id).evaluate((el) => getComputedStyle(el).backgroundColor);

test.describe("@F62 pick group and space colours", () => {
  test.beforeEach(async () => {
    await seed(qaCore());
  });

  test("group and space colours are written and shown", async ({ page }) => {
    const core = qaCore();
    await home(page);
    const plainSpace = await bg(page, "space", IDS.beta);

    await rowAction(row(page, "group", IDS.empty), "Colour…");
    await submitDialog(page, { Colour: "inv:ansi4" }, "Set");
    await expect.poll(() => core.readGroups().groups.find((g) => g.id === IDS.empty)?.color).toBe("inv:ansi4");
    await expect.poll(() => bg(page, "group", IDS.empty)).toBe("rgb(91, 141, 239)");

    await rowAction(row(page, "space", IDS.beta), "Colour…");
    await submitDialog(page, { Colour: "ansi1" }, "Set");
    await expect.poll(() => core.readGroups().spaces[IDS.beta]?.color).toBe("ansi1");
    await expect.poll(() => bg(page, "space", IDS.beta)).not.toBe(plainSpace);

    await rowAction(row(page, "space", IDS.beta), "Colour…");
    await submitDialog(page, { Colour: "dim" }, "Set");
    await expect.poll(() => core.readGroups().spaces[IDS.beta]?.color).toBe("dim");
    await expect.poll(() => bg(page, "space", IDS.beta)).toBe(plainSpace);

    await rowAction(row(page, "space", IDS.beta), "Colour…");
    await submitDialog(page, { Colour: "none" }, "Set");
    await expect.poll(() => core.readGroups().spaces[IDS.beta]?.color).toBeNull();

    // Exactly Desktop's schema.
    for (const g of core.readGroups().groups) expect(Object.keys(g).sort()).toEqual(["color", "id", "name", "parent", "parentId"]);
  });
});
