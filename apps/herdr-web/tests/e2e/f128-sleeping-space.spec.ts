import { expect, test } from "@playwright/test";
import { addTab, IDS, seed } from "../support/fixture.ts";
import { authed } from "../support/auth.ts";
import { SESSION, sleepingShell } from "../support/sleep.ts";
import { qaCore } from "../support/world.ts";

// Task 128: a space whose Claude sessions are all asleep shows it in the sidebar row and in the dock chip; waking clears it.

const base = () => `http://127.0.0.1:${String(process.env.HERDR_QA_PORT)}`;
const pinApi = (body: unknown) => fetch(`${base()}/api/pins`, { method: "POST", headers: authed({ "content-type": "application/json", origin: base() }), body: JSON.stringify(body) });

test("@F128 a sleeping space shows an asleep mark in the sidebar and the dock, gone once woken", async ({ page }) => {
  const core = qaCore();
  const seeded = await seed(core);
  const address = await addTab(core, seeded, "alpha", "napper", sleepingShell(), { "sleep.session": SESSION, "sleep.cwd": "/tmp" });
  try {
    await pinApi({ pin: IDS.alpha });
    await page.goto("/");
    await expect(page.getByTestId("pin").filter({ hasText: "alpha" }).getByTestId("pin-asleep")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("row-asleep").first()).toBeVisible();
    // Woken: the label is cleared and the mark goes away everywhere.
    core.label(address, { "sleep.session": "", "sleep.cwd": "" });
    await expect(page.getByTestId("pin-asleep")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("row-asleep")).toHaveCount(0);
  } finally {
    await pinApi({ unpin: IDS.alpha });
  }
});
