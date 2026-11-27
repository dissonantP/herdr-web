import { expect, test } from "@playwright/test";
import { dialog, home, row, rowAction, unfoldAll } from "../support/admin-ui.ts";
import { seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F13: close a pane, ending its program; finished sessions and terminals drop out of the tree.

test.describe("@F13 close a pane", () => {
  test("closing ends the program and the pane leaves the tree", async ({ page }) => {
    const core = qaCore();
    const seeded = await seed(core);
    const betaB = seeded.terminals.betaB ?? "";
    await home(page);
    await unfoldAll(page);
    await rowAction(row(page, "pane", betaB), "Close pane…");
    await expect(dialog(page)).toContainText("This ends beta-b");
    await dialog(page).getByRole("button", { name: "Close" }).click();
    await expect(row(page, "pane", betaB)).toHaveCount(0);
    // The row goes at once (task 142); the server ends it as it answers.
    await expect.poll(() => core.state(betaB)).toBe("finished");
    await expect.poll(async () => JSON.stringify(await core.layout())).not.toContain(`"${betaB}"`);
    await expect(row(page, "pane", seeded.terminals.betaA ?? "")).toBeVisible();
  });

  test("a session that finishes on its own drops out of the tree", async ({ page }) => {
    const core = qaCore();
    const seeded = await seed(core);
    await home(page);
    await unfoldAll(page);
    const gamma = seeded.terminals.gamma ?? "";
    await expect(row(page, "pane", gamma)).toBeVisible();
    await core.kill(gamma);
    await expect(row(page, "pane", gamma)).toHaveCount(0);
  });
});
