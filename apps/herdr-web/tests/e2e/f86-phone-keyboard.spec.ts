import { expect, test } from "@playwright/test";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 086: tapping a plain terminal on the phone focuses its text input (which is what raises the
// soft keyboard) and typed text reaches the shell.

let beta: string;
test.beforeEach(async () => {
  const seeded = await seed(qaCore());
  beta = seeded.terminals.betaA ?? "";
});

test.describe("@F86 phone keyboard in a plain terminal", () => {
  test("a touch tap focuses the terminal's text input and typing reaches the shell", async ({ page, isMobile }) => {
    test.skip(!isMobile, "touch tap is a phone behaviour");
    await page.goto(`/s/${IDS.beta}`);
    await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live");
    await page.getByTestId("terminal").tap();
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
    await page.keyboard.type("echo f86-$((40+2))");
    await page.keyboard.press("Enter");
    await expect.poll(() => qaCore().screen(beta)).toContain("f86-42");
  });
});
