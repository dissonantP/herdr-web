import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { prepareRealClaude } from "../support/claude.ts";
import { addTab, IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

let cwd = "";
test.afterEach(() => rmSync(cwd, { recursive: true, force: true }));
const claudeBinary = join(homedir(), ".local", "bin", "claude");

test("F45: with Claude's suggestion in its box, a message from the chat still sends (real haiku session)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one real session per run is enough");
  test.setTimeout(240_000);
  const core = qaCore();
  const seeded = await seed(core);
  cwd = mkdtempSync(join(tmpdir(), "herdr-qa-f45-"));
  if (!prepareRealClaude(core, cwd)) test.skip(true, "no Claude sign-in on this machine");
  const address = await addTab(core, seeded, "alpha", "real", ["env", "-u", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1", claudeBinary, "--model", "haiku"], {}, cwd);
  await page.goto(`/s/${IDS.alpha}`);
  await page.getByRole("tab", { name: "real", exact: true }).click();
  await expect.poll(async () => /❯/u.test(await core.screen(address)), { timeout: 60_000 }).toBe(true);
  await page.getByTestId("composer-text").fill("Write a tiny hello world function in python in a file hello.py, then stop.");
  await page.getByTestId("send").click();
  // After the turn Claude pre-fills a suggestion in its box; wait for it (plain read: the box has text).
  const boxText = async () => /^❯ (\S.*)$/mu.exec(await core.screen(address))?.[1] ?? "";
  await expect.poll(boxText, { timeout: 120_000, intervals: [2000] }).not.toBe("");
  const suggestion = await boxText();
  // Sending from the chat works: the message replaces the suggestion and goes to Claude.
  await page.getByTestId("composer-text").fill("Reply with only the word pineapple.");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("composer-text")).toHaveValue("");
  await expect.poll(async () => (await core.screen(address)).includes("pineapple"), { timeout: 60_000 }).toBe(true);
  expect(await core.screen(address)).not.toContain(`${suggestion}Reply`);
});
