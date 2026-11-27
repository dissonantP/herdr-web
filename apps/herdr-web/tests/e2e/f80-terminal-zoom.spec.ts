import { expect, test, type Page } from "@playwright/test";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 080: a pinch (or Ctrl+wheel) over the terminal changes its font size only (not the chat
// zoom or the UI), survives a reload, and the refit size reaches the core.

let beta = "";
test.beforeEach(async () => {
  beta = (await seed(qaCore())).terminals.betaA ?? "";
});
test.use({ hasTouch: true });

async function open(page: Page) {
  await page.goto(`/s/${IDS.beta}`);
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live");
}
const zoomOf = (page: Page) => page.getByTestId("terminal-view").getAttribute("data-zoom");
const cols = async () => (await qaCore().call("terminal.get", { terminal: beta })).cols as number;
const chatZoom = (page: Page) => page.evaluate(() => window.localStorage.getItem("herdr.chatZoom"));

test("@F80 Ctrl+wheel over the terminal zooms its text, refits, persists", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Ctrl+wheel is desktop-only");
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const before = await cols();
  const box = (await page.getByTestId("terminal").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect.poll(() => zoomOf(page)).not.toBe("1");
  await expect.poll(cols).toBeLessThan(before);
  expect(await chatZoom(page)).toBeNull();
  const zoomed = await zoomOf(page);
  await page.reload();
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live");
  expect(await zoomOf(page)).toBe(zoomed);
  await expect.poll(cols).toBeLessThan(before);
});

test("@F80 a two-finger pinch over the terminal zooms its text", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "touch pinch is phone-only");
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page);
  const before = await cols();
  const box = (await page.getByTestId("terminal").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + 100;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", d: number) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }],
    });
  await touch("touchStart", 40);
  for (const d of [60, 80, 100]) await touch("touchMove", d);
  await touch("touchEnd", 0);
  await expect.poll(async () => Number(await zoomOf(page))).toBeGreaterThan(1.5);
  await expect.poll(cols).toBeLessThan(before);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  expect(await chatZoom(page)).toBeNull();
});
