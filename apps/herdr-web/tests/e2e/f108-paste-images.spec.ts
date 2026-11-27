import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addTab, controlledClaude, IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 108: Ctrl+V of an image attaches it like the attach button (composer, with its thumbnail),
// and in a terminal view uploads it and types its path. Text paste is unchanged.
// A real Windows clipboard is left unverified; here a paste event carries a File in clipboardData.

// 1x1 PNG.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Fire a paste event at the selector with the given image (and optional text) on its clipboardData. */
async function pasteAt(page: Page, selector: string, opts: { image?: boolean; text?: string }) {
  await page.evaluate(([sel, b64, image, text]) => {
    const dt = new DataTransfer();
    if (image) {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
    }
    if (text !== "") dt.setData("text/plain", text);
    document.querySelector(sel)?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [selector, PNG_B64, opts.image === true, opts.text ?? ""] as const);
}

let dir = "";
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("@F108 pasting an image into the composer attaches it with a thumbnail; text paste is untouched", async ({ page }) => {
  dir = mkdtempSync(join(tmpdir(), "herdr-f108-"));
  writeFileSync(join(dir, "state"), "idle");
  const core = qaCore();
  const seeded = await seed(core);
  await addTab(core, seeded, "alpha", "paste", controlledClaude(join(dir, "state")), {}, "/tmp");
  await page.goto(`/s/${IDS.alpha}`);
  await page.getByRole("tab", { name: "paste", exact: true }).click();
  const box = page.getByTestId("composer-text");
  await box.focus();
  await pasteAt(page, '[data-testid="composer-text"]', { image: true });
  await expect(page.getByTestId("attach-preview")).toHaveCount(1);
  await expect(box).toHaveValue(/pasted-\d+-0\.png $/u);
  // Text with an image alongside (a spreadsheet copy): the text path wins, no new attachment.
  await pasteAt(page, '[data-testid="composer-text"]', { image: true, text: "hello" });
  await expect(page.getByTestId("attach-preview")).toHaveCount(1);
});

test("@F108 pasting an image in a Claude tab's terminal view types its uploaded path; text paste still works", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop run");
  dir = mkdtempSync(join(tmpdir(), "herdr-f108-"));
  writeFileSync(join(dir, "state"), "idle");
  const core = qaCore();
  const seeded = await seed(core);
  await addTab(core, seeded, "alpha", "paste", controlledClaude(join(dir, "state")), {}, "/tmp");
  await page.goto(`/s/${IDS.alpha}`);
  await page.getByRole("tab", { name: "paste", exact: true }).click();
  await page.getByTestId("view-terminal").click();
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live");
  await pasteAt(page, "textarea.ghostty-keyboard-input", { image: true });
  await expect(page.getByTestId("terminal-text")).toContainText(/pasted-\d+-0\.png/u);
  await pasteAt(page, "textarea.ghostty-keyboard-input", { text: "texty-3" });
  await expect(page.getByTestId("terminal-text")).toContainText("texty-3");
});
