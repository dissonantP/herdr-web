import { expect, test } from "@playwright/test";
import { addTab, claudeProgram, IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F4: each agent pane shows its status in the tree (working, waiting, idle); a collapsed group or
// space shows a badge when anything beneath it needs input.

test.beforeEach(async () => {
  const core = qaCore();
  const seeded = await seed(core);
  await addTab(core, seeded, "alpha", "worker", claudeProgram("working"));
  await addTab(core, seeded, "alpha", "asker", claudeProgram("blocked"));
  await addTab(core, seeded, "alpha", "resting", claudeProgram("idle"));
});

const status = (page: import("@playwright/test").Page, name: string) =>
  page.locator('[data-testid="tree-pane"]', { has: page.locator(".row-name", { hasText: new RegExp(`^${name}$`, "u") }) }).getByTestId("pane-status");

test("@F4 agent panes show working, waiting and idle; shells show none", async ({ page }) => {
  await page.goto("/");
  await page.locator(`[data-id="${IDS.alpha}"] .chevron`).click();
  await expect(status(page, "worker")).toHaveAttribute("data-status", "working");
  await expect(status(page, "asker")).toHaveAttribute("data-status", "waiting");
  await expect(status(page, "resting")).toHaveAttribute("data-status", "idle");
  await expect(status(page, "alpha-shell")).toHaveCount(0);
});

test("@F4 a collapsed parent badges when anything beneath needs input", async ({ page }) => {
  await page.goto("/");
  const badge = (id: string) => page.locator(`[data-id="${id}"]`).getByTestId("needs-input-badge");
  // alpha (folded by default) sits in group inner, inside group work: the badge shows on each
  // folded ancestor, counting what is waiting.
  await expect(badge(IDS.alpha)).toHaveText("1");
  await page.locator(`[data-id="${IDS.inner}"] .chevron`).click();
  await expect(badge(IDS.inner)).toHaveText("1");
  await page.locator(`[data-id="${IDS.work}"] .chevron`).click();
  await expect(badge(IDS.work)).toHaveText("1");
  // Unfolded, the pane itself shows it instead.
  await page.locator(`[data-id="${IDS.work}"] .chevron`).click();
  await page.locator(`[data-id="${IDS.inner}"] .chevron`).click();
  await expect(badge(IDS.work)).toHaveCount(0);
  await expect(badge(IDS.inner)).toHaveCount(0);
  // A space with nothing waiting never shows one.
  await expect(badge(IDS.gamma)).toHaveCount(0);
});

test("@F4 the badge goes away when the waiting session ends", async ({ page }) => {
  await page.goto("/");
  const badge = page.locator(`[data-id="${IDS.alpha}"]`).getByTestId("needs-input-badge");
  await expect(badge).toHaveText("1");
  const core = qaCore();
  const list = (await core.call("terminal.list", {})).terminals as { address: string; name: string }[];
  const asker = list.find((t) => t.name === "asker");
  expect(asker).toBeDefined();
  await core.kill(asker?.address ?? "");
  await expect(badge).toHaveCount(0);
});
