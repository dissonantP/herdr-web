import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { writeTranscript } from "../support/claude.ts";
import { addTab, controlledClaude, IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 090: a code block in the chat has a copy button that puts exactly the code on the clipboard.

const SESSION = "cccccccc-bbbb-4ccc-8ddd-eeeeeeee9090";
const CWD = "/tmp/herdr-qa-f90";
const CODE = "echo one\nif true; then\n  echo two\nfi";
const lines = [
  JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-11-16T07:00:00.000Z", isSidechain: false, message: { role: "user", content: "show code" } }),
  JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-11-16T07:00:01.000Z", message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: `Here:\n\n\`\`\`bash\n${CODE}\n\`\`\`\n\nand \`inline\` code.` }] } }),
];
let dir = "";
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

for (const [name, w] of [["desktop", 1280], ["phone", 360]] as const) {
  test(`@F90 the copy button copies the exact code (${name})`, async ({ page, context }, info) => {
    test.skip(info.project.name !== name, "one run per viewport");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    dir = mkdtempSync(join(tmpdir(), "herdr-f90-"));
    writeFileSync(join(dir, "state"), "idle");
    const core = qaCore();
    const seeded = await seed(core);
    writeTranscript(core, CWD, SESSION, lines);
    await addTab(core, seeded, "alpha", "copier", controlledClaude(join(dir, "state")), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
    await page.setViewportSize({ width: w, height: 800 });
    await page.goto(`/s/${IDS.alpha}`);
    await page.getByRole("tab", { name: "copier", exact: true }).click();
    const button = page.getByTestId("code-copy");
    await expect(button).toHaveCount(1);
    await button.click();
    await expect(button).toHaveText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CODE);
    await page.screenshot({ path: info.outputPath(`${name}.png`) });
    await expect(button).toHaveText("Copy", { timeout: 4000 });
  });
}
