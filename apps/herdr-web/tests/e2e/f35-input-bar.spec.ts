import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { writeTranscript } from "../support/claude.ts";
import { addTab, claudeProgram, IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F35: the chat input bar is comfortably sized, grows with its text up to a limit, is set apart from
// the transcript with room above it, and the transcript stays at the bottom as the bar grows (also
// when the on-screen keyboard shrinks the viewport). Screenshots go to the test output folder.

const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CWD = "/tmp/herdr-qa-chat-proj";
const canned = readFileSync(new URL(import.meta.resolve("@herdr/server/fixtures/claude/session.jsonl")), "utf8").split("\n").filter((l) => l !== "");

async function open(page: Page) {
  const core = qaCore();
  const seeded = await seed(core);
  writeTranscript(core, CWD, SESSION, canned);
  await addTab(core, seeded, "alpha", "chatty", claudeProgram("idle"), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
  await page.goto(`/s/${IDS.alpha}`);
  await page.getByRole("tab", { name: "chatty", exact: true }).click();
  await expect(page.getByTestId("chat-view")).toHaveAttribute("data-state", "live");
  await expect(page.getByTestId("composer-text")).toBeVisible();
}

const metrics = (page: Page) =>
  page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-testid="chat-list"]');
    const box = document.querySelector<HTMLElement>('[data-testid="composer-text"]');
    const bar = document.querySelector<HTMLElement>('[data-testid="chat-input"]');
    const last = list?.lastElementChild?.getBoundingClientRect();
    if (!list || !box || !bar || !last) throw new Error("chat not drawn");
    return {
      fromBottom: list.scrollHeight - list.scrollTop - list.clientHeight,
      overflows: list.scrollHeight > list.clientHeight,
      boxH: box.getBoundingClientRect().height,
      barTop: bar.getBoundingClientRect().top,
      lastBottom: last.bottom,
      viewportH: window.innerHeight,
      barBottom: bar.getBoundingClientRect().bottom,
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
    };
  });

test("@F35 the input bar is roomy, grows with its text to a limit, and the transcript stays at the bottom", async ({ page }, info) => {
  await open(page);
  const before = await metrics(page);
  // Taller than the old 44 px bar, and clear space between the last message and the bar.
  expect(before.boxH).toBeGreaterThanOrEqual(50);
  expect(before.barTop - before.lastBottom).toBeGreaterThanOrEqual(16);
  expect(before.fromBottom).toBeLessThan(2);
  await page.screenshot({ path: info.outputPath(`f35-${info.project.name}-rest.png`) });

  const box = page.getByTestId("composer-text");
  await box.fill("one\ntwo\nthree\nfour");
  await expect.poll(async () => (await metrics(page)).fromBottom).toBeLessThan(2);
  const grown = await metrics(page);
  expect(grown.boxH).toBeGreaterThan(before.boxH + 40);
  expect(grown.fromBottom).toBeLessThan(2); // still at the bottom after the bar grew
  expect(grown.barTop - grown.lastBottom).toBeGreaterThanOrEqual(16);

  await box.fill(Array.from({ length: 60 }, (_, i) => `line ${String(i)}`).join("\n"));
  const capped = await metrics(page);
  expect(capped.boxH).toBeLessThanOrEqual(page.viewportSize()!.height * 0.4 + 2); // the limit
  expect(capped.fromBottom).toBeLessThan(2);
  expect(capped.pageScrolls).toBe(false);
  await page.screenshot({ path: info.outputPath(`f35-${info.project.name}-capped.png`) });

  await box.fill("");
  expect((await metrics(page)).boxH).toBeLessThan(grown.boxH);
});

test("@F35 with the on-screen keyboard open (short viewport) the bar stays in view and the transcript at the bottom", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone only");
  await open(page);
  await page.setViewportSize({ width: 360, height: 420 });
  await page.getByTestId("composer-text").fill("one\ntwo\nthree");
  await expect.poll(async () => (await metrics(page)).fromBottom).toBeLessThan(2); // the observer settles a frame later
  const m = await metrics(page);
  expect(m.barBottom).toBeLessThanOrEqual(m.viewportH + 1);
  expect(m.barTop - m.lastBottom).toBeGreaterThanOrEqual(16);
  await page.screenshot({ path: info.outputPath("f35-phone-keyboard.png") });
});
