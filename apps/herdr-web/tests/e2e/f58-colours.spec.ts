import { expect, test } from "@playwright/test";
import type { GroupNode, SpaceNode, Tree } from "../../src/shared/model.ts";

// Task 58: group and space rows are coloured like Herdr Desktop's sidebar. The tree is served by a
// stub of the event stream.

const space = (id: string, color: string | null): SpaceNode => ({
  id,
  name: id,
  quiet: false,
  color,
  tabs: [{ id: `t-${id}`, name: "1", panes: [{ id: `p-${id}`, kind: "terminal", name: `${id}-claude`, agent: "claude", status: "idle", chat: true, asleep: false }] }],
  children: [],
});
const group = (id: string, color: string | null, spaces: SpaceNode[]): GroupNode => ({ id, name: id, color, spaces, groups: [] });

const tree: Tree = {
  spaces: [space("plain", null)],
  groups: [
    group("g-blue", "ansi4", [space("inherits", null), space("own-pink", "ansi1"), space("dimmed", "dim"), space("hex", "#d9b54a"), space("inverted", "inv:ansi2")]),
    group("g-inv", "inv:ansi5", [space("inv-inherits", null)]),
    group("g-none", null, [space("none-in-group", null)]),
  ],
};

const bg = (page: import("@playwright/test").Page, id: string) =>
  page.locator(`[data-testid="tree-space"][data-id="${id}"], [data-testid="tree-group"][data-id="${id}"]`).evaluate((el) => getComputedStyle(el).backgroundColor);

for (const size of [{ name: "phone", width: 360, height: 740 }, { name: "desktop", width: 1280, height: 800 }]) {
  test(`@F58 rows are coloured like Desktop (${size.name})`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.route("**/api/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ ok: true, tree })}\n\n` }));
    await page.goto("/");
    await expect(page.getByTestId("tree-space").first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`colours-${size.name}.png`) });
    const plain = await bg(page, "plain");
    expect(await bg(page, "none-in-group")).toBe(plain);
    expect(await bg(page, "dimmed")).toBe(plain);
    const inherited = await bg(page, "inherits");
    expect(inherited).not.toBe(plain);
    expect(await bg(page, "g-blue")).toBe(inherited);
    expect(await bg(page, "own-pink")).not.toBe(inherited);
    expect(await bg(page, "hex")).not.toBe(plain);
    // inv: the full colour (Desktop's ansi2) with dark text, also when inherited from the group.
    expect(await bg(page, "inverted")).toBe("rgb(63, 174, 106)");
    expect(await bg(page, "inv-inherits")).toBe("rgb(139, 124, 246)");
    const ink = await page.locator('[data-testid="tree-space"][data-id="inverted"] .row-name').evaluate((el) => getComputedStyle(el).color);
    expect(ink).toBe("rgb(0, 0, 0)");
    const groupInk = await page.locator('[data-testid="tree-group"][data-id="g-inv"] .row-name').evaluate((el) => getComputedStyle(el).color);
    expect(groupInk).toBe("rgb(0, 0, 0)");
  });
}
