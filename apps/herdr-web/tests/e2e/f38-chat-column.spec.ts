import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { writeTranscript } from "../support/claude.ts";
import { addTab, controlledClaude, IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F38: the transcript, the Working indicator and the input bar share one column that fills the
// pane (comfortable padding), so on desktop the Working row lines up with the messages.

const SESSION = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CWD = "/tmp/herdr-qa-f38";
const canned = readFileSync(new URL(import.meta.resolve("@herdr/server/fixtures/claude/session.jsonl")), "utf8").split("\n").filter((l) => l !== "");
let dir = "";
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("@F38 messages, Working row and input bar share one full-width column", async ({ page }, info) => {
  dir = mkdtempSync(join(tmpdir(), "herdr-f38-"));
  const state = join(dir, "state");
  writeFileSync(state, "working");
  const core = qaCore();
  const seeded = await seed(core);
  writeTranscript(core, CWD, SESSION, canned);
  await addTab(core, seeded, "alpha", "wide", controlledClaude(state), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
  await page.goto(`/s/${IDS.alpha}`);
  await page.getByRole("tab", { name: "wide", exact: true }).click();
  const working = page.getByTestId("chat-working");
  await expect(working).toBeVisible({ timeout: 5000 });
  const box = async (loc: ReturnType<typeof page.locator>) => (await loc.boundingBox()) ?? { x: 0, width: 0 };
  const view = await box(page.getByTestId("chat-view"));
  const msg = await box(page.getByTestId("chat-message").first());
  const work = await box(working);
  const input = await box(page.locator(".composer-wrap"));
  // One left edge for the messages and the Working row, and the input box starts there too.
  expect(Math.abs(work.x - msg.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(input.x - msg.x)).toBeLessThanOrEqual(1);
  // The column fills the pane with only a comfortable gutter at each side (not a narrow centred strip).
  expect(msg.x - view.x).toBeGreaterThanOrEqual(8);
  expect(msg.x - view.x).toBeLessThanOrEqual(32);
  expect(msg.width).toBeGreaterThanOrEqual(view.width - 64);
  expect(work.width).toBeGreaterThanOrEqual(view.width - 64);
  await page.screenshot({ path: info.outputPath(`f38-${info.project.name}.png`) });
});
