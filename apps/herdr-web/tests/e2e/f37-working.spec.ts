import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { addTab, controlledClaude, IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F37: a chat shows a live "working" indicator at the bottom of the transcript while herdr-core
// reports the agent working (within about a second), and none when the turn ends or it waits.

const SESSION = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
let dir = "";

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("@F37 the working indicator follows the pane's status and ends the list", async ({ page }) => {
  dir = mkdtempSync(join(tmpdir(), "herdr-f37-"));
  const state = join(dir, "state");
  writeFileSync(state, "idle");
  const core = qaCore();
  const seeded = await seed(core);
  await addTab(core, seeded, "alpha", "busy", controlledClaude(state), { "claude.session": SESSION, "claude.cwd": "/tmp/herdr-f37" }, "/tmp");
  await page.goto(`/s/${IDS.alpha}`);
  await page.getByRole("tab", { name: "busy", exact: true }).click();
  await expect(page.getByTestId("chat-view")).toBeVisible();
  const working = page.getByTestId("chat-working");
  await expect(working).toHaveCount(0);

  writeFileSync(state, "working");
  await expect(working).toBeVisible({ timeout: 3000 });
  await expect(working).toContainText("Working");
  // It is the last thing in the transcript list.
  expect(await page.getByTestId("chat-list").evaluate((el) => el.lastElementChild?.getAttribute("data-testid"))).toBe("chat-working");

  writeFileSync(state, "blocked");
  await expect(working).toHaveCount(0, { timeout: 3000 });
  writeFileSync(state, "working");
  await expect(working).toBeVisible({ timeout: 3000 });
  writeFileSync(state, "idle");
  await expect(working).toHaveCount(0, { timeout: 3000 });
});
