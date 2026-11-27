import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { writeTranscript } from "../support/claude.ts";
import { addTab, claudeProgram, IDS, seed } from "../support/fixture.ts";
import { authed } from "../support/auth.ts";
import { qaCore } from "../support/world.ts";

// Task 97: Ctrl+[ / Ctrl+] switch tab in the space, Ctrl+Shift+[ / ] switch pinned space, Ctrl+Shift+1-9 go to
// that pin (by key code), the dock shows index badges only while Ctrl+Shift is held, and after any switch on
// desktop the new pane's input has focus (never on touch).

const base = () => `http://127.0.0.1:${String(process.env.HERDR_QA_PORT)}`;
const pinApi = (body?: unknown) =>
  fetch(`${base()}/api/pins`, body === undefined ? { headers: authed({}) } : { method: "POST", headers: authed({ "content-type": "application/json", origin: base() }), body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ pins: string[] }>);
const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CWD = "/tmp/herdr-qa-chat-proj";
const canned = readFileSync(new URL(import.meta.resolve("@herdr/server/fixtures/claude/session.jsonl")), "utf8").split("\n").filter((l) => l !== "");

test.beforeEach(async () => {
  await seed(qaCore());
  for (const id of (await pinApi()).pins) await pinApi({ unpin: id });
  for (const id of [IDS.alpha, IDS.beta, IDS.gamma]) await pinApi({ pin: id });
});
test.afterEach(async () => {
  for (const id of (await pinApi()).pins) await pinApi({ unpin: id });
});

const tabs = (page: Page) => page.locator(".tabs [role=tab]:not(.tab-add)");
const selectedTab = (page: Page) => page.locator(".tabs [role=tab][aria-selected=true]");
const onSpace = (page: Page, id: string) => expect(page).toHaveURL(new RegExp(`/s/${id}(/|$)`));

test("@F97 tab and pin shortcuts, with wrapping, from a focused terminal", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "keyboard shortcuts are a desktop feature");
  await page.goto(`/s/${IDS.beta}`);
  await expect(tabs(page)).toHaveCount(2);
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live");
  await page.getByTestId("terminal").click(); // a terminal has focus
  await expect(selectedTab(page)).toHaveText("main");
  await page.keyboard.press("Control+]");
  await expect(selectedTab(page)).not.toHaveText("main");
  const second = (await selectedTab(page).textContent()) ?? "";
  await page.keyboard.press("Control+]"); // wraps to the first
  await expect(selectedTab(page)).toHaveText("main");
  await page.keyboard.press("Control+[");
  await expect(selectedTab(page)).toHaveText(second);
  await page.keyboard.press("Control+[");
  await expect(selectedTab(page)).toHaveText("main");

  // Pins: alpha, beta, gamma. Next from beta is gamma, then it wraps to alpha; Shift+[ goes back round.
  await page.keyboard.press("Control+Shift+BracketRight");
  await onSpace(page, IDS.gamma);
  await page.keyboard.press("Control+Shift+BracketRight");
  await onSpace(page, IDS.alpha);
  await page.keyboard.press("Control+Shift+BracketLeft");
  await onSpace(page, IDS.gamma);
  await page.keyboard.press("Control+Shift+Digit2");
  await onSpace(page, IDS.beta);
  await page.keyboard.press("Control+Shift+Digit1");
  await onSpace(page, IDS.alpha);
  await page.keyboard.press("Control+Shift+Digit9"); // no ninth pin: nothing happens
  await onSpace(page, IDS.alpha);
});

test("@F97 index badges show only while Ctrl+Shift is held", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "keyboard shortcuts are a desktop feature");
  await page.goto(`/s/${IDS.alpha}`);
  await expect(page.getByTestId("pin")).toHaveCount(3);
  const badges = page.getByTestId("pin-index");
  await expect(badges).toHaveCount(0);
  await page.keyboard.down("Control");
  await expect(badges).toHaveCount(0);
  await page.keyboard.down("Shift");
  await expect(badges).toHaveText(["1", "2", "3"]);
  await page.screenshot({ path: info.outputPath("badges.png"), clip: { x: 0, y: 0, width: 1280, height: 60 } });
  await page.keyboard.up("Shift");
  await expect(badges).toHaveCount(0);
  await page.keyboard.down("Shift");
  await expect(badges).toHaveCount(3);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(badges).toHaveCount(0);
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
});

test("@F97 the new pane's input has focus after a switch (terminal and chat)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "focus on switch is desktop only");
  const core = qaCore();
  const seeded = await seed(core);
  writeTranscript(core, CWD, SESSION, canned);
  await addTab(core, seeded, "alpha", "chatty", claudeProgram("idle"), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
  await page.goto(`/s/${IDS.beta}`);
  await expect(page.getByTestId("terminal")).toBeVisible();
  // Switch to alpha by shortcut, then to its chat tab: typing lands in the composer.
  await page.keyboard.press("Control+Shift+Digit1");
  await onSpace(page, IDS.alpha);
  await page.keyboard.press("Control+]");
  await expect(page.getByTestId("composer-text")).toBeFocused();
  // Back to beta by clicking its pin: typing goes into the terminal's input.
  await page.getByTestId("pin").filter({ hasText: "beta" }).locator(".pin-name").click();
  await expect(page.getByTestId("terminal")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-testid=terminal]") !== null)).toBe(true);
});

test("@F97 no focus grab on a touch device", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "touch only");
  const core = qaCore();
  const seeded = await seed(core);
  writeTranscript(core, CWD, SESSION, canned);
  await addTab(core, seeded, "alpha", "chatty", claudeProgram("idle"), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
  await page.goto(`/s/${IDS.alpha}`);
  await page.getByRole("tab", { name: "chatty", exact: true }).click();
  await expect(page.getByTestId("composer-text")).toBeVisible();
  await expect(page.getByTestId("composer-text")).not.toBeFocused();
});
