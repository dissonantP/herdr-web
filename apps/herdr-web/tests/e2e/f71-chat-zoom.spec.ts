import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { writeTranscript } from "../support/claude.ts";
import { addTab, controlledClaude, IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 071: a pinch (or Ctrl+wheel) over the chat scales the chat text only, never the page,
// and the size survives a reload.

const SESSION = "cccccccc-bbbb-4ccc-8ddd-eeeeeeee7171";
const CWD = "/tmp/herdr-qa-f71";
const canned = readFileSync(new URL(import.meta.resolve("@herdr/server/fixtures/claude/session.jsonl")), "utf8").split("\n").filter((l) => l !== "");
let dir = "";
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function open(page: Page) {
  dir = mkdtempSync(join(tmpdir(), "herdr-f71-"));
  writeFileSync(join(dir, "state"), "working");
  const core = qaCore();
  const seeded = await seed(core);
  writeTranscript(core, CWD, SESSION, canned);
  await addTab(core, seeded, "alpha", "zoomy", controlledClaude(join(dir, "state")), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
  await page.goto(`/s/${IDS.alpha}`);
  await page.getByRole("tab", { name: "zoomy", exact: true }).click();
  await expect(page.getByTestId("chat-message").first()).toBeVisible({ timeout: 5000 });
}

const fontSize = (page: Page) =>
  page.getByTestId("chat-message").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

test.use({ hasTouch: true });

test("@F71 a two-finger pinch over the chat changes its text size, not the page scale, and persists", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "touch pinch is phone-only");
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page);
  const before = await fontSize(page);
  const list = (await page.getByTestId("chat-list").boundingBox())!;
  const cx = list.x + list.width / 2;
  const cy = list.y + 100;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", d: number) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }],
    });
  await touch("touchStart", 40);
  for (const d of [60, 80, 100]) await touch("touchMove", d);
  await touch("touchEnd", 0);
  await expect.poll(() => fontSize(page)).toBeGreaterThan(before * 1.5);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  await page.reload();
  await page.getByRole("tab", { name: "zoomy", exact: true }).click();
  await expect(page.getByTestId("chat-message").first()).toBeVisible({ timeout: 5000 });
  expect(await fontSize(page)).toBeGreaterThan(before * 1.5);
});

test("@F71 Ctrl+wheel over the chat zooms the chat text", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Ctrl+wheel is desktop-only");
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const before = await fontSize(page);
  const list = (await page.getByTestId("chat-list").boundingBox())!;
  await page.mouse.move(list.x + list.width / 2, list.y + 100);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect.poll(() => fontSize(page)).toBeGreaterThan(before);
});
