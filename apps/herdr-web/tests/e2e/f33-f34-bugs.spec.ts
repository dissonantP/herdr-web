import { expect, test } from "@playwright/test";
import { home, row, rowAction, submitDialog } from "../support/admin-ui.ts";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F33: a space made from a group's menu lands inside that group, in groups.json and in the tree.

test("@F33 new space from a group lands in the group, in the file and in the tree", async ({ page, isMobile }) => {
  const core = qaCore();
  await seed(core);
  await home(page);
  await rowAction(row(page, "group", IDS.inner), "New space here");
  // The Group field starts on the group it was opened from.
  await expect(page.getByTestId("dialog").getByLabel("Group", { exact: true })).toHaveValue(IDS.inner);
  await submitDialog(page, { Name: "", Folder: "/tmp" }, "Create");
  const known = new Set<string>(Object.values(IDS));
  const space = (await core.layout()).spaces.find((s) => !known.has(s.id));
  expect(space).toBeDefined();
  const id = space?.id ?? "";
  if (isMobile) await page.getByRole("button", { name: "Back to spaces" }).click();
  expect(core.readGroups().spaces[id]?.groupId).toBe(IDS.inner);
  const inGroup = page.locator(`.group:has([data-testid="tree-group"][data-id="${IDS.inner}"]) [data-testid="tree-space"][data-id="${id}"]`);
  await expect(inGroup).toBeVisible();
  await expect(row(page, "space", id)).toHaveAttribute("data-depth", "2");
});

// F34: the actions menu opens where you tapped or clicked, stays on screen, and closes on an
// outside tap or Esc.

test("@F34 actions menu is anchored at the tap, on screen, and closes outside or on Esc", async ({ page }) => {
  await seed(qaCore());
  await home(page);
  const view = page.viewportSize() ?? { width: 0, height: 0 };
  const menu = page.getByTestId("action-menu");
  const onScreen = async () => {
    const b = await menu.boundingBox();
    expect(b).not.toBeNull();
    expect(b?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(b?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((b?.x ?? 0) + (b?.width ?? 0)).toBeLessThanOrEqual(view.width);
    expect((b?.y ?? 0) + (b?.height ?? 0)).toBeLessThanOrEqual(view.height);
    return b;
  };

  // A right-click (the long-press path) on the first space row: the menu starts at the pointer.
  const target = row(page, "space", IDS.beta).locator(".row-name");
  const box = await target.boundingBox();
  const at = { x: 20, y: Math.min(10, (box?.height ?? 20) / 2) };
  await target.click({ button: "right", position: at });
  await expect(menu).toBeVisible();
  const b = await onScreen();
  expect(Math.abs((b?.x ?? 0) - ((box?.x ?? 0) + at.x))).toBeLessThanOrEqual(2);
  // Not the old centered/bottom sheet.
  expect(Math.abs((b?.x ?? 0) + (b?.width ?? 0) / 2 - view.width / 2) > 4 || (b?.width ?? 0) < view.width * 0.9).toBe(true);

  // Outside tap closes.
  await page.mouse.click(view.width - 2, 2);
  await expect(menu).toHaveCount(0);

  // The ⋯ button anchors at the button; Esc closes.
  const more = row(page, "space", IDS.beta).getByTestId("row-actions");
  await more.click();
  await expect(menu).toBeVisible();
  const mb = await onScreen();
  const moreBox = await more.boundingBox();
  // Starts at the click (inside the button), or flipped so it ends there.
  const lo = (moreBox?.y ?? 0) - 2;
  const hi = (moreBox?.y ?? 0) + (moreBox?.height ?? 0) + 2;
  const top = mb?.y ?? 0;
  const bottom = top + (mb?.height ?? 0);
  expect((top >= lo && top <= hi) || (bottom >= lo && bottom <= hi)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // Near the right and bottom edges it flips and clamps instead of leaving the screen.
  await page.evaluate(() => {
    const x = window.innerWidth - 3;
    const y = window.innerHeight - 3;
    document.body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: x, clientY: y }));
  });
  await row(page, "space", IDS.beta).getByTestId("row-actions").evaluate((el) => {
    const x = window.innerWidth - 3;
    const y = window.innerHeight - 3;
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y }));
    (el as HTMLElement).click();
  });
  await expect(menu).toBeVisible();
  await onScreen();
});
