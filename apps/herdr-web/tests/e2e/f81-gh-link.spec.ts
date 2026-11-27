import { expect, test } from "@playwright/test";
import { seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 81: a GitHub link at the right end of the top bar, opening the public repo in a new tab.

test.beforeEach(async () => {
  await seed(qaCore());
});

for (const [name, w] of [["desktop", 1280], ["phone", 360]] as const) {
  test(`@F81 the GitHub link ends the top bar (${name})`, async ({ page }, info) => {
    await page.setViewportSize({ width: w, height: 800 });
    await page.goto("/");
    const link = page.getByTestId("gh-link");
    await expect(link).toHaveAttribute("href", "https://github.com/dissonantP/herdr-web");
    await expect(link).toHaveAttribute("target", "_blank");
    const l = (await link.boundingBox())!;
    const bar = (await page.locator(".topbar").boundingBox())!;
    expect(Math.round(l.x + l.width)).toBe(Math.round(bar.x + bar.width));
    const pins = (await page.getByTestId("pin-bar").boundingBox())!;
    expect(pins.x + pins.width).toBeLessThanOrEqual(l.x + 1);
    await page.screenshot({ path: info.outputPath(`${name}.png`) });
  });
}
