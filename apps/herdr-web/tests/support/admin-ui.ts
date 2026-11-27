import { expect, type Locator, type Page } from "@playwright/test";

// Driving the admin UI the way a person does: a row's ⋯ (or long-press), a menu item, a dialog.

export function row(page: Page, kind: "group" | "space" | "tab" | "pane", id: string): Locator {
  return page.locator(`[data-testid="tree-${kind}"][data-id="${id}"]`);
}

export function rowByName(page: Page, kind: "group" | "space" | "tab" | "pane", name: string): Locator {
  return page.locator(`[data-testid="tree-${kind}"]`).filter({ has: page.locator(".row-name", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u") }) });
}

/** Open a row's actions menu and pick an item. `longPress`: the way a phone user does (contextmenu). */
export async function rowAction(target: Locator, item: string, longPress = false): Promise<void> {
  if (longPress) await target.locator(".row-name").click({ button: "right" });
  else await target.getByTestId("row-actions").click();
  await target.page().getByRole("menuitem", { name: item, exact: true }).click();
}

export function dialog(page: Page): Locator {
  return page.getByTestId("dialog");
}

/**
 * Fill a dialog's text fields and selects by label, then press a button; waits for it to close and for the server's
 * answer (a predicted change closes the dialog before the server has it, task 142).
 */
export async function submitDialog(page: Page, values: Record<string, string>, button: string): Promise<void> {
  const d = dialog(page);
  for (const [label, value] of Object.entries(values)) {
    const field = d.getByLabel(label, { exact: true });
    if ((await field.evaluate((el) => el.tagName)) === "SELECT") await field.selectOption(value); // by value (a group id) or label
    else await field.fill(value);
  }
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/actions"));
  await d.getByRole("button", { name: button, exact: true }).click();
  await expect(d).toHaveCount(0);
  await answered;
}

/** Every group folded open and every space unfolded, so all rows show. */
export async function unfoldAll(page: Page): Promise<void> {
  for (;;) {
    const folded = page.locator('[data-testid^="tree-"] .chevron[aria-expanded="false"]');
    if ((await folded.count()) === 0) return;
    await folded.first().click();
  }
}

/** The tree as the home screen (phone) or sidebar (desktop) shows it. */
export async function home(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
}
