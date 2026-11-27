import { expect, test, type Page } from "@playwright/test";
import { groupsFixture, IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F1: the tree shows the same groups (nested), spaces, tabs and panes as Herdr Desktop, with the
// same names and order, and follows Desktop's changes to the groups file and the herdr-app doc.

test.describe("@F1 tree matches Herdr Desktop", () => {
  let seeded: Awaited<ReturnType<typeof seed>>;
  test.beforeEach(async () => {
    seeded = await seed(qaCore());
  });

  async function unfoldAll(page: Page) {
    for (;;) {
      const folded = page.locator('[data-testid="tree-space"] .chevron[aria-expanded="false"]');
      if ((await folded.count()) === 0) return;
      await folded.first().click();
    }
  }

  async function rows(page: Page): Promise<string[]> {
    return page.locator('[data-testid^="tree-"]').evaluateAll((els) =>
      els.map((el) => `${"  ".repeat(Number(el.getAttribute("data-depth")))}${el.getAttribute("data-testid")?.slice(5) ?? ""} ${el.querySelector(".row-name")?.textContent ?? ""}`),
    );
  }

  test("same groups, spaces, tabs and panes, names and order", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("tree-space").first()).toBeVisible();
    await unfoldAll(page);
    expect(await rows(page)).toEqual([
      "space beta",
      "  tab main",
      "    pane beta-a",
      "    pane beta-b",
      "  tab 2",
      "    pane beta-c",
      "space delta-from-where",
      "  tab 1",
      "    pane delta-shell",
      "group work",
      "  space gamma",
      "    tab 1",
      "      pane gamma-shell",
      "  group inner",
      "    space alpha",
      "      tab 1",
      "        pane alpha-shell",
      "group empty",
    ]);
  });

  test("follows Desktop rewriting the groups file", async ({ page }) => {
    await page.goto("/");
    const empty = page.locator(`.group:has(> [data-id="${IDS.empty}"])`);
    await expect(empty.getByTestId("tree-space")).toHaveCount(0);
    const groups = groupsFixture();
    groups.spaces[IDS.delta] = { name: "delta-from-where", group: "empty", groupId: IDS.empty, color: null };
    qaCore().writeGroups(groups);
    await expect(empty.getByTestId("tree-space").locator(".row-name")).toHaveText(["delta-from-where"], { timeout: 2500 });
  });

  test("follows Desktop changing the herdr-app doc and terminals ending", async ({ page }) => {
    await page.goto("/");
    await unfoldAll(page);
    const layout = structuredClone(seeded.layout);
    const gamma = layout.spaces.find((s) => s.id === IDS.gamma);
    if (gamma === undefined) throw new Error("fixture changed");
    gamma.name = "gamma renamed";
    await qaCore().setLayout(layout);
    await expect(page.locator(`[data-id="${IDS.gamma}"] .row-name`)).toHaveText("gamma renamed", { timeout: 2500 });

    await qaCore().kill(seeded.terminals.betaB ?? "");
    await expect(page.locator('[data-testid="tree-pane"]', { hasText: "beta-b" })).toHaveCount(0, { timeout: 2500 });
  });
});
