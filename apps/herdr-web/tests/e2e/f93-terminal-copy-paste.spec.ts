import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 093: select text in a terminal and copy it, and paste text into it, on desktop and phone.
// Desktop: drag-select copies (Ghostty copies on mouse-up), Ctrl+V pastes. Phone: a long press then
// drag selects and copies on release (the touch handlers in the renderer), and the keys bar's Paste
// key pastes. A real finger on a real phone is left unverified (see the task's Unverified notes).

let beta: string;
test.beforeEach(async () => {
  const seeded = await seed(qaCore());
  beta = seeded.terminals.betaA ?? "";
});

async function openAndEcho(page: Page, context: BrowserContext) {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/s/${IDS.beta}`);
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live");
  await page.getByTestId("terminal").click();
  await page.keyboard.type("echo copyme-$((20+22))");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal-text")).toContainText("copyme-42");
  // The layout (sidebar) settles after load; measure after it.
  await page.waitForTimeout(600);
  await page.evaluate(() => navigator.clipboard.writeText(""));
  return (await page.getByTestId("terminal").boundingBox())!;
}

test("@F93 desktop: drag-select copies, Ctrl+V pastes", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "desktop run");
  const box = await openAndEcho(page, context);
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 8, box.y + 70, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("copyme-42");

  await page.evaluate(() => navigator.clipboard.writeText("echo pasted-$((1+2))"));
  await page.keyboard.press("Control+V");
  await page.keyboard.press("Enter");
  await expect.poll(() => qaCore().screen(beta)).toContain("pasted-3");
});

test("@F93 desktop: selecting works when the terminal had lost focus", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "desktop run");
  const box = await openAndEcho(page, context);
  await page.locator(".terminal-view").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 8, box.y + 70, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("copyme-42");
  // The press also gives the terminal's text input focus back (the delayed retry must still run).
  await expect(page.locator("textarea.ghostty-keyboard-input")).toBeFocused();
});

test("@F93 phone: long-press and drag selects and copies; the Paste key pastes", async ({ page, context }, info) => {
  test.skip(info.project.name !== "phone", "phone run");
  const box = await openAndEcho(page, context);
  const cdp = await context.newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  const x0 = box.x + 10;
  const y0 = box.y + 8;
  await touch("touchStart", x0, y0);
  await page.waitForTimeout(800);
  await touch("touchMove", x0 + 150, y0 + 30);
  await touch("touchMove", box.x + box.width - 10, y0 + 40);
  await touch("touchEnd", 0, 0);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("copyme-42");
  await expect(page.getByTestId("terminal-notice")).toHaveText("Copied");

  await page.evaluate(() => navigator.clipboard.writeText("echo pasted-$((1+2))"));
  await page.getByTestId("keys-bar").getByRole("button", { name: "Paste" }).click();
  // The paste is async (clipboard read); wait for the text before pressing Enter.
  await expect.poll(() => qaCore().screen(beta)).toContain("echo pasted-$((1+2))");
  await page.keyboard.press("Enter");
  await expect.poll(() => qaCore().screen(beta)).toContain("pasted-3");
});

// Task 094: a paste is wrapped in bracketed-paste markers when the program in the terminal turned the mode on.
test("@F93 desktop: Ctrl+V is bracketed when the shell asks for it, plain otherwise", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "desktop run");
  await openAndEcho(page, context);
  // A tiny reader: bracketed paste on, show the raw bytes of the next line of input as hex, then off.
  await page.keyboard.type("printf '\\033[?2004h'; stty -echo -icanon; head -c 15 | od -An -c | tr -d ' \\n'; echo; stty echo; printf '\\033[?2004l'");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await page.evaluate(() => navigator.clipboard.writeText("a\nb"));
  await page.keyboard.press("Control+V");
  await expect.poll(() => qaCore().screen(beta)).toContain("033[200~a\\nb033[201~");
  // Mode is off now: plain text, no markers.
  await page.keyboard.type("clear");
  await page.keyboard.press("Enter");
  await page.keyboard.type("stty -echo -icanon; head -c 3 | od -An -c | tr -d ' \\n'; echo; stty echo");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await page.evaluate(() => navigator.clipboard.writeText("xyz"));
  await page.keyboard.press("Control+V");
  await expect.poll(() => qaCore().screen(beta)).toContain("xyz");
  expect(await qaCore().screen(beta)).not.toContain("033[200~");
});
