import { expect, test, type Locator } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTab, controlledClaude, IDS, seed } from "../support/fixture.ts";
import { authed } from "../support/auth.ts";
import { qaCore } from "../support/world.ts";

// Task 089: a session state looks the same in the Inbox, the dock pins, tabs and the tree roll-up.

const base = () => `http://127.0.0.1:${String(process.env.HERDR_QA_PORT)}`;
const pinApi = (body: unknown) => fetch(`${base()}/api/pins`, { method: "POST", headers: authed({ "content-type": "application/json", origin: base() }), body: JSON.stringify(body) });

const look = (dot: Locator) => dot.evaluate((el) => {
  const s = getComputedStyle(el);
  return { cls: [...el.classList].filter((c) => c.startsWith("status")).join(" "), bg: s.backgroundColor, anim: s.animationName, w: s.width };
});

test("@F89 a working session's dot looks the same in the Inbox, dock, tab and tree roll-up", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-f89-"));
  const state = join(dir, "state");
  writeFileSync(state, "working");
  try {
    const core = qaCore();
    const seeded = await seed(core);
    await addTab(core, seeded, "alpha", "busy", controlledClaude(state));
    await pinApi({ pin: IDS.alpha });
    await page.goto("/");
    const dock = page.getByTestId("pin").filter({ hasText: "alpha" }).getByTestId("pin-working");
    await expect(dock).toBeVisible({ timeout: 5000 });
    const ref = await look(dock);
    expect(ref.anim).not.toBe("none");
    expect(ref.cls).toBe("status status-working");

    // A collapsed space row in the tree rolls the working dot up.
    await expect(page.getByTestId("row-working").first()).toBeVisible({ timeout: 5000 });
    expect(await look(page.getByTestId("row-working").first())).toEqual(ref);

    await page.goto(`/s/${IDS.alpha}`);
    expect(await look(page.getByRole("tab", { name: "busy", exact: true }).getByTestId("tab-working"))).toEqual(ref);

    await page.goto("/");
    await page.evaluate(async () => {
      await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ inbox: true }) });
    });
    await page.reload();
    await page.getByTestId("view-inbox").click();
    const row = page.getByTestId("inbox-item").first().locator(".status");
    await expect(row).toBeVisible({ timeout: 5000 });
    expect(await look(row)).toEqual(ref);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await pinApi({ unpin: IDS.alpha });
    await page.goto("/");
    await page.evaluate(async () => {
      await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ inbox: false }) });
    });
  }
});

test("@F89 a pane that finishes again while it is open has its finished dot cleared again", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-f89-"));
  const state = join(dir, "state");
  writeFileSync(state, "idle");
  try {
    const core = qaCore();
    const seeded = await seed(core);
    await addTab(core, seeded, "alpha", "busy", controlledClaude(state));
    await pinApi({ pin: IDS.alpha });
    await page.goto(`/s/${IDS.alpha}`);
    await page.getByRole("tab", { name: "busy", exact: true }).click();
    const pin = page.getByTestId("pin").filter({ hasText: "alpha" });
    for (let turn = 0; turn < 3; turn++) {
      writeFileSync(state, "working");
      await expect(page.getByTestId("tab-working")).toBeVisible({ timeout: 5000 });
      writeFileSync(state, "done");
      await expect(page.getByTestId("tab-working")).toHaveCount(0, { timeout: 5000 });
      // Viewing it clears the finished dot again, each turn, on the tab and the pin.
      await expect(page.getByTestId("tab-finished")).toHaveCount(0, { timeout: 5000 });
      await expect(pin.getByTestId("pin-finished")).toHaveCount(0, { timeout: 5000 });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await pinApi({ unpin: IDS.alpha });
  }
});
