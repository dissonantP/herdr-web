import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { writeTranscript } from "../support/claude.ts";
import { addTab, IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 101: with the per-device setting on, an agent answering (or needing input) shows a banner at the top; tapping
// it opens a modal with the last reply and the chat's own composer, or the answer picker for a question; "Open space"
// navigates; swiping the banner dismisses it. Not for the pane in view, nor `herdr.inbox=hide` panes. Off: nothing.

const SESSION = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CWD = "/tmp/herdr-qa-reply";
const canned = readFileSync(new URL(import.meta.resolve("@herdr/server/fixtures/claude/session.jsonl")), "utf8").split("\n").filter((l) => l !== "");
const screens = new URL(".", import.meta.resolve("@herdr/server/fixtures/claude/screens/README.md")).pathname;
const fakeSh = new URL("../support/fake-sh/claude", import.meta.url).pathname;

let dir = "";
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-f101-"));
});
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A fake Claude that reports `working`, waits for `go`, then draws `screen` (if any) and reports `after`, then echoes and
 * logs whatever it is sent (raw, so a menu answer's digit arrives at once).
 */
function agent(after: "idle" | "blocked", screen?: string): string[] {
  const draw = screen === undefined ? "" : `printf '\\033[2J\\033[H'; cat '${screens}${screen}.txt'; `;
  const kind = after === "blocked" ? ":kind=question" : "";
  const script = `printf '\\033]7501;state=working:app=claude-code\\a'; while [ ! -f '${dir}/go' ]; do sleep 0.2; done; ${draw}printf '\\033]7501;state=${after}:app=claude-code${kind}\\a'; stty raw -echo; tee -a '${dir}/log'`;
  return [fakeSh, "-c", script];
}
const go = () => writeFileSync(join(dir, "go"), "1");
const logged = () => (existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "latin1") : "");

async function setup(page: Page, program: string[], labels: Record<string, string> = {}, enabled = true, start = "/") {
  const core = qaCore();
  const seeded = await seed(core);
  writeTranscript(core, CWD, SESSION, canned);
  await addTab(core, seeded, "alpha", "busy", program, { "claude.session": SESSION, "claude.cwd": CWD, ...labels }, "/tmp");
  await page.goto("/");
  await page.evaluate((on) => window.localStorage.setItem("herdr.replyNotify", on ? "1" : "0"), enabled);
  await page.goto(start);
  await expect(page.getByTestId(start === "/" ? "tree-space" : "space-view").first()).toBeVisible();
}

test("@F101 @F115 a finished agent shows a banner; tap opens the modal with the last reply; a typed reply reaches the agent", async ({ page }) => {
  await setup(page, agent("idle"));
  await expect(page.getByTestId("reply-banner")).toHaveCount(0);
  go();
  const banner = page.getByTestId("reply-banner");
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText("busy");
  await banner.click();
  await expect(banner).toHaveCount(0);
  const modal = page.getByTestId("reply-modal");
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("reply-last")).toContainText("fixed the typo");
  // The history holds earlier exchanges too, but no thinking or tool parts.
  await expect(page.getByTestId("reply-last")).toContainText("Fix the greeting in hello.txt");
  await expect(page.getByTestId("reply-last")).not.toContainText("hello.txt changed");
  await page.getByTestId("composer-text").fill("thanks from the banner");
  await page.getByTestId("send").click();
  // @F115 It shows in the modal's history at once (the fake agent never writes it to the transcript), exactly once.
  await expect(page.getByTestId("reply-last").getByText("thanks from the banner")).toHaveCount(1);
  await expect.poll(logged, { timeout: 10_000 }).toContain("thanks from the banner");
  // Close works.
  await page.getByTestId("reply-close").click();
  await expect(modal).toHaveCount(0);
});

test("@F101 'Open space' goes to the pane's space", async ({ page }) => {
  await setup(page, agent("idle"));
  go();
  await page.getByTestId("reply-banner").click();
  await page.getByTestId("reply-open-space").click();
  await expect(page.getByTestId("reply-modal")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/s/${IDS.alpha}/`));
  await expect(page.getByTestId("space-view")).toBeVisible();
});

test("@F101 a structured question shows the answer picker in the modal and answering works", async ({ page }) => {
  await setup(page, agent("blocked", "live/ask-single"));
  go();
  const banner = page.getByTestId("reply-banner");
  await expect(banner).toHaveAttribute("data-kind", "waiting", { timeout: 10_000 });
  await banner.click();
  const card = page.getByTestId("reply-modal").getByTestId("menu-card");
  await expect(card).toHaveAttribute("data-kind", "question");
  await expect(card.getByTestId("menu-title")).toHaveText("Pick a colour?");
  await card.getByTestId("menu-option").first().click();
  await expect.poll(logged, { timeout: 10_000 }).toContain("1");
});

test("@F101 swiping the banner dismisses it; a short drag does not", async ({ page }) => {
  await setup(page, agent("idle"));
  go();
  const banner = page.getByTestId("reply-banner");
  await expect(banner).toBeVisible({ timeout: 10_000 });
  const box = (await banner.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 40, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, y, { steps: 3 });
  await page.mouse.up();
  await expect(banner).toBeVisible();
  await expect(page.getByTestId("reply-modal")).toHaveCount(0);
  await page.mouse.move(box.x + 40, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, y, { steps: 8 });
  await page.mouse.up();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("reply-modal")).toHaveCount(0);
});

test("@F101 no banner for the pane in view", async ({ page }) => {
  await setup(page, agent("idle"), {}, true, `/s/${IDS.alpha}`);
  await page.getByRole("tab", { name: "busy", exact: true }).click();
  await expect(page.getByTestId("chat-view")).toBeVisible();
  go();
  await expect(page.getByTestId("chat-working")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("reply-banner")).toHaveCount(0);
});

test("@F101 no banner for herdr.inbox=hide panes", async ({ page }) => {
  await setup(page, agent("idle"), { "herdr.inbox": "hide" });
  go();
  await page.waitForTimeout(3000);
  await expect(page.getByTestId("reply-banner")).toHaveCount(0);
});

test("@F101 with the setting off nothing shows, and Settings has the switch", async ({ page }) => {
  await setup(page, agent("idle"), {}, false);
  go();
  await page.waitForTimeout(3000);
  await expect(page.getByTestId("reply-banner")).toHaveCount(0);
  await page.goto("/settings");
  const box = page.getByTestId("reply-banners-enabled");
  await expect(box).not.toBeChecked();
  await box.check();
  await page.reload();
  await expect(page.getByTestId("reply-banners-enabled")).toBeChecked();
});

// Task 104: on a real phone a touch tap fires pointerup, then a click at the same spot; the modal must survive it.
test.describe("touch", () => {
  test.use({ hasTouch: true });
  test("@F101 @F104 a touch tap on the banner opens the modal and it stays open", async ({ page }) => {
    await setup(page, agent("idle"));
    go();
    const banner = page.getByTestId("reply-banner");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await banner.tap();
    await expect(page.getByTestId("reply-modal")).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.getByTestId("reply-modal")).toBeVisible();
    await expect(page).not.toHaveURL(new RegExp(`/s/${IDS.alpha}/`));
    await page.getByTestId("reply-close").tap();
    await expect(page.getByTestId("reply-modal")).toHaveCount(0);
  });

  test("@F104 a touch swipe on the banner dismisses it without opening the modal", async ({ page }) => {
    await setup(page, agent("idle"));
    go();
    const banner = page.getByTestId("reply-banner");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    const box = (await banner.boundingBox())!;
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    await touch("touchStart", box.x + 40);
    for (const dx of [40, 80, 120, 160]) await touch("touchMove", box.x + 40 + dx);
    await touch("touchEnd", 0);
    await expect(banner).toHaveCount(0);
    await expect(page.getByTestId("reply-modal")).toHaveCount(0);
  });
});

// Task 105: a reply that arrives while the pane's modal is open is seen there: no banner for it, during or after closing.
test("@F105 a reply that arrives while its modal is open leaves no banner after closing", async ({ page }) => {
  const sh = (state: string) => `printf '\\033]7501;state=${state}:app=claude-code\\a'`;
  const wait = (f: string) => `while [ ! -f '${dir}/${f}' ]; do sleep 0.2; done`;
  const script = `${sh("working")}; ${wait("go")}; ${sh("idle")}; ${wait("go2")}; ${sh("working")}; ${wait("go3")}; ${sh("idle")}; sleep 600`;
  await setup(page, [fakeSh, "-c", script]);
  go();
  await page.getByTestId("reply-banner").click();
  await expect(page.getByTestId("reply-modal")).toBeVisible();
  writeFileSync(join(dir, "go2"), "1");
  await page.waitForTimeout(1500);
  writeFileSync(join(dir, "go3"), "1");
  await page.waitForTimeout(2500);
  await expect(page.getByTestId("reply-banner")).toHaveCount(0);
  await page.getByTestId("reply-close").click();
  await expect(page.getByTestId("reply-modal")).toHaveCount(0);
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("reply-banner")).toHaveCount(0);
});

// Task 106: the modal shows the conversation (user and text only), opens at the latest reply and scrolls up.
test("@F106 the modal scrolls back through earlier exchanges, text only, composer fixed", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  const lines: string[] = [];
  const ts = (i: number) => new Date(Date.UTC(2026, 10, 14, 7, 0, i)).toISOString();
  for (let i = 0; i < 20; i++) {
    lines.push(JSON.stringify({ type: "user", uuid: `u${i}`, timestamp: ts(i * 3), message: { role: "user", content: `question number ${i}` } }));
    lines.push(JSON.stringify({ type: "assistant", uuid: `t${i}`, timestamp: ts(i * 3 + 1), message: { id: `mt${i}`, role: "assistant", content: [{ type: "thinking", thinking: `secret thought ${i}`, signature: "x" }, { type: "tool_use", id: `tool${i}`, name: "Bash", input: { command: `echo hidden-tool-${i}` } }] } }));
    lines.push(JSON.stringify({ type: "assistant", uuid: `a${i}`, timestamp: ts(i * 3 + 2), message: { id: `ma${i}`, role: "assistant", content: [{ type: "text", text: `answer number ${i}` }] } }));
  }
  const core = qaCore();
  const seeded = await seed(core);
  writeTranscript(core, CWD, SESSION, lines);
  await addTab(core, seeded, "alpha", "busy", agent("idle"), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("herdr.replyNotify", "1"));
  await page.goto("/");
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  go();
  await page.getByTestId("reply-banner").click();
  const last = page.getByTestId("reply-last");
  await expect(last).toContainText("answer number 19");
  // Opens scrolled to the latest reply.
  await expect.poll(() => last.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(4);
  await expect(last).not.toContainText("secret thought");
  await expect(last).not.toContainText("hidden-tool");
  // Long history stays inside the modal and the composer stays on screen.
  const modalBox = (await page.getByTestId("reply-modal").boundingBox())!;
  expect(modalBox.y).toBeGreaterThanOrEqual(0);
  expect(modalBox.y + modalBox.height).toBeLessThanOrEqual(700);
  const composerBefore = (await page.getByTestId("composer-text").boundingBox())!;
  await last.evaluate((el) => (el.scrollTop = 0));
  await expect(last.getByText("question number 0", { exact: true })).toBeInViewport();
  const composerAfter = (await page.getByTestId("composer-text").boundingBox())!;
  expect(composerAfter.y).toBe(composerBefore.y);
  await expect(page.getByTestId("reply-close")).toBeInViewport();
});
