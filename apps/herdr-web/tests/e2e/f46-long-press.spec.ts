import { expect, test, type Locator, type Page } from "@playwright/test";
import { IDS, seed } from "../support/fixture.ts";
import { authed } from "../support/auth.ts";
import { row } from "../support/admin-ui.ts";
import { qaCore } from "../support/world.ts";

// F46: iOS Safari never fires `contextmenu` for a touch, so a ~500 ms finger rest opens the same
// menu (tree rows, tabs, pins, graph nodes). Real touches can't be held in Playwright, so these
// dispatch the touch pointer events (what iOS sends) and, like a real release, a click after them.
// A scroll or drag must not open it, a tap must still open the row, and the mouse right-click stays.

const base = () => `http://127.0.0.1:${String(process.env.HERDR_QA_PORT)}`;
const unpinAll = async () => {
  const pins = (await fetch(`${base()}/api/pins`, { headers: authed({}) }).then((r) => r.json())) as { pins: string[] };
  for (const unpin of pins.pins) await fetch(`${base()}/api/pins`, { method: "POST", headers: authed({ "content-type": "application/json", origin: base() }), body: JSON.stringify({ unpin }) });
};

test.beforeEach(async () => {
  await seed(qaCore());
  await unpinAll();
});
test.afterEach(unpinAll);

const menu = (page: Page) => page.getByTestId("action-menu");

interface PressOpts {
  readonly holdMs: number;
  /** Finger drift while down. */
  readonly moveBy?: number;
  /** Fire the cancel a browser sends when it takes the touch over to scroll. */
  readonly cancel?: boolean;
}

/** A finger on `target`: down, rest, optional drift, up, then the click a release produces. */
async function touch(target: Locator, { holdMs, moveBy = 0, cancel = false }: PressOpts): Promise<void> {
  await target.evaluate(
    async (el, o) => {
      const r = el.getBoundingClientRect();
      const x = r.left + Math.min(20, r.width / 2);
      const y = r.top + r.height / 2;
      const ev = (type: string, dx = 0) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: "touch", isPrimary: true, pointerId: 41, button: 0, clientX: x + dx, clientY: y });
      el.dispatchEvent(ev("pointerdown"));
      if (o.moveBy !== 0) el.dispatchEvent(ev("pointermove", o.moveBy));
      await new Promise((resolve) => setTimeout(resolve, o.holdMs));
      if (o.cancel) {
        el.dispatchEvent(ev("pointercancel"));
        return;
      }
      el.dispatchEvent(ev("pointerup", o.moveBy));
      if (o.moveBy !== 0) return; // a drag or scroll makes no click
      // A real release's click comes a moment later and lands on whatever is under the finger by
      // then: the menu's scrim, if the release itself opened the menu (task 046's pin bug).
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      (document.elementFromPoint(x, y) ?? el).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, detail: 1 }));
    },
    { holdMs, moveBy, cancel },
  );
}

const LONG = 650;

test("@F46 long-press on a tree row opens its menu and doesn't also open the row", async ({ page }) => {
  await page.goto("/");
  const space = row(page, "space", IDS.beta);
  await touch(space.locator(".row-name"), { holdMs: LONG });
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("menuitem", { name: "Rename", exact: true })).toBeVisible();
  // The click ending the press didn't navigate, nor close the menu through the scrim.
  await expect(page).not.toHaveURL(new RegExp(IDS.beta));
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
});

test("@F46 a quick tap still opens the row; a scroll or drift doesn't open the menu", async ({ page }) => {
  await page.goto("/");
  const name = row(page, "space", IDS.beta).locator(".row-name");
  await touch(name, { holdMs: 150 });
  await expect(page).toHaveURL(new RegExp(IDS.beta));
  await expect(menu(page)).toHaveCount(0);
  await page.goto("/");
  await expect(name).toBeVisible();
  await touch(name, { holdMs: LONG, moveBy: 30 });
  await expect(menu(page)).toHaveCount(0);
  await touch(name, { holdMs: 200, cancel: true });
  await page.waitForTimeout(LONG); // past where the hold would have fired
  await expect(menu(page)).toHaveCount(0);
});

test("@F46 right-click (and Android's contextmenu) still opens the menu", async ({ page }) => {
  await page.goto("/");
  await row(page, "space", IDS.beta).locator(".row-name").dispatchEvent("contextmenu", { clientX: 40, clientY: 100 });
  await expect(menu(page)).toBeVisible();
});

test("@F46 long-press works on a group row, a tab and a pin", async ({ page }) => {
  await page.goto("/");
  await touch(row(page, "group", IDS.work).locator(".row-name"), { holdMs: LONG });
  await expect(menu(page).getByRole("menuitem", { name: "New space here", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto(`/s/${IDS.beta}`);
  await touch(page.locator(".tab").first(), { holdMs: LONG });
  await expect(menu(page).getByRole("menuitem", { name: "Rename tab", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);

  // A pin: the hold arms the drag, releasing in place opens the menu (and doesn't switch space).
  await touch(page.getByTestId("pin").first().locator(".pin-name"), { holdMs: LONG });
  await expect(menu(page).getByRole("menuitem", { name: "Unpin", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(new RegExp(IDS.beta));
});

test.skip("@F46 long-press works on a graph node", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("view-graph").click();
  const node = page.locator(`[data-testid="graph-node"][data-kind="space"][data-id="${IDS.beta}"]`);
  await expect(node).toBeVisible();
  await touch(node, { holdMs: LONG });
  await expect(menu(page).getByRole("menuitem", { name: "Rename", exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(IDS.beta));
});

test("@F46 a very long hold still swallows the release click; Android's contextmenu first doesn't open it twice", async ({ page }) => {
  await page.goto("/");
  const name = row(page, "space", IDS.beta).locator(".row-name");
  await touch(name, { holdMs: 1500 });
  await expect(menu(page)).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(IDS.beta));
  await page.keyboard.press("Escape");

  // contextmenu arrives first (as on Android), then the timer would fire: one menu, no reopen after Escape.
  await name.evaluate(async (el) => {
    const r = el.getBoundingClientRect();
    const p = { bubbles: true, cancelable: true, composed: true, clientX: r.left + 20, clientY: r.top + 10 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...p, pointerType: "touch", isPrimary: true, pointerId: 43, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    el.dispatchEvent(new MouseEvent("contextmenu", p));
  });
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await page.waitForTimeout(LONG);
  await expect(menu(page)).toHaveCount(0);
});
