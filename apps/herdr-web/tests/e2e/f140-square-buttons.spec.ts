import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { writeTranscript } from "../support/claude.ts";
import { addTab, claudeProgram, IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 140: the attach, mic and send buttons are square and as tall as the text field at rest. Screenshots go to the test output folder.

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

test("@T140 the attach, mic and send buttons are square and line up with the text field", async ({ page }, info) => {
  await open(page);
  const size = async (id: string) => {
    const b = await page.getByTestId(id).boundingBox();
    if (!b) throw new Error(`${id} not drawn`);
    return b;
  };
  const text = await size("composer-text");
  for (const id of ["attach", "conv-start", "send"]) {
    const b = await size(id);
    expect(Math.abs(b.width - b.height), id).toBeLessThan(1);
    expect(Math.abs(b.height - text.height), id).toBeLessThan(1);
    expect(Math.abs(b.y - text.y), id).toBeLessThan(1);
  }
  await page.screenshot({ path: info.outputPath(`t140-${info.project.name}.png`) });
});
