import { expect, test } from "@playwright/test";
import { dialog, home, row, rowAction } from "../support/admin-ui.ts";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F12: deleting a space or group with running sessions confirms, listing what runs, then ends every
// program in it; a group with things inside asks whether to move them up a level or delete it all.

test.describe("@F12 delete with running sessions", () => {
  let seeded: Awaited<ReturnType<typeof seed>>;
  test.beforeEach(async () => {
    seeded = await seed(qaCore());
  });

  test("a space: the confirm lists its programs, then they all end", async ({ page }) => {
    const core = qaCore();
    await home(page);
    await rowAction(row(page, "space", IDS.beta), "Delete…");
    await expect(dialog(page).getByTestId("running-list").locator("li")).toHaveText(["beta-a", "beta-b", "beta-c"]);
    // Cancel changes nothing.
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    expect(await core.state(seeded.terminals.betaA ?? "")).toBe("live");

    await rowAction(row(page, "space", IDS.beta), "Delete…");
    await dialog(page).getByRole("button", { name: "Delete and end 3" }).click();
    await expect(row(page, "space", IDS.beta)).toHaveCount(0);
    // The row goes at once (task 142); the server ends the programs as it answers.
    for (const t of [seeded.terminals.betaA, seeded.terminals.betaB, seeded.terminals.betaC]) await expect.poll(() => core.state(t ?? "")).toBe("finished");
    await expect.poll(() => core.readGroups().spaces[IDS.beta]).toBeUndefined();
  });

  test("a group: move what is inside up a level; nothing ends", async ({ page }) => {
    const core = qaCore();
    await home(page);
    await rowAction(row(page, "group", IDS.work), "Delete…");
    await expect(dialog(page)).toContainText("It holds 1 space and 1 group");
    await dialog(page).getByRole("button", { name: "Move them up" }).click();
    await expect(row(page, "group", IDS.work)).toHaveCount(0);
    await expect(row(page, "space", IDS.gamma)).toHaveAttribute("data-depth", "0");
    await expect(row(page, "group", IDS.inner)).toHaveAttribute("data-depth", "0");
    expect(core.readGroups().groups.find((g) => g.id === IDS.inner)?.parentId).toBeNull();
    expect(await core.state(seeded.terminals.gamma ?? "")).toBe("live");
  });

  test("a group: delete the whole subtree, listing and ending every program in it", async ({ page }) => {
    const core = qaCore();
    await home(page);
    await rowAction(row(page, "group", IDS.work), "Delete…");
    await expect(dialog(page).getByTestId("running-list").locator("li")).toHaveText(["gamma-shell", "alpha-shell"]);
    await dialog(page).getByRole("button", { name: "Delete all, end 2" }).click();
    await expect(row(page, "group", IDS.work)).toHaveCount(0);
    await expect(row(page, "group", IDS.inner)).toHaveCount(0);
    await expect(row(page, "space", IDS.alpha)).toHaveCount(0);
    expect(await core.state(seeded.terminals.alpha ?? "")).toBe("finished");
    expect(await core.state(seeded.terminals.gamma ?? "")).toBe("finished");
    expect((await core.layout()).spaces.map((s) => s.id)).toEqual([IDS.beta, IDS.delta]);
    expect(core.readGroups().groups.map((g) => g.id)).toEqual([IDS.empty]);
  });
});
