import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F51: the settings page, stored on the server: auto-sleep on/off, idle threshold, the inbox view, the
// global push pause; never-sleep is per space, in the space menu. The auto-sleep job reads the same file.

const file = () => qaCore().env.HERDR_SETTINGS_FILE;
const onDisk = () => JSON.parse(readFileSync(file(), "utf8")) as { version: number; autosleep: { enabled: boolean; idle: string; every: string; neverSleep: string[] }; inbox: boolean };

/** Back to the defaults through the API, from the page (same origin), whatever the test left. */
async function reset(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const post = (body: unknown) => fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const now = (await (await fetch("/api/settings")).json()) as { autosleep: { neverSleep: string[] } };
    await post({ autosleep: { enabled: true, idle: "3h", every: "30m" } });
    await post({ inbox: false });
    for (const space of now.autosleep.neverSleep) await post({ neverSleep: { space, never: false } });
    await fetch("/api/push/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused: false }) });
  });
}

test.beforeEach(async () => {
  await seed(qaCore());
});
test.afterEach(async ({ page }) => {
  await page.goto("/");
  await reset(page);
});

async function openSettings(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-page")).toBeVisible();
}

/** Toggle never-sleep from a space's own menu (`label` is the item shown: "Never sleep" or "Allow sleep"). */
async function menuNeverSleep(page: Page, spaceId: string, label: string): Promise<void> {
  await page.goto(`/s/${spaceId}`);
  await page.getByTestId("space-actions").first().click();
  await expect(page.getByTestId("action-menu")).toBeVisible();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

test("@F51 the settings file exists with the defaults, and the page shows them", async ({ page }) => {
  await openSettings(page);
  expect(onDisk()).toEqual({ version: 1, autosleep: { enabled: true, idle: "3h", every: "30m", neverSleep: [] }, inbox: false });
  await expect(page.getByTestId("autosleep-enabled")).toBeChecked();
  await expect(page.getByTestId("autosleep-every")).toHaveValue("30m");
  await expect(page.getByText("Checked every 30m")).toBeVisible();
  await expect(page.getByTestId("autosleep-idle")).toHaveValue("3h");
  await expect(page.getByTestId("inbox-enabled")).not.toBeChecked();
  await expect(page.getByTestId("push-paused")).not.toBeChecked();
});

test("@F51 changes save to the file at once and survive a reload", async ({ page }) => {
  await openSettings(page);
  await page.getByTestId("autosleep-enabled").uncheck();
  await expect.poll(() => onDisk().autosleep.enabled).toBe(false);
  await page.getByTestId("autosleep-idle").fill("90m");
  await page.getByTestId("autosleep-idle").press("Enter");
  await expect.poll(() => onDisk().autosleep.idle).toBe("90m");
  await page.getByTestId("autosleep-every").fill("2h");
  await page.getByTestId("autosleep-every").press("Enter");
  await expect.poll(() => onDisk().autosleep.every).toBe("2h");
  await expect(page.getByText("Checked every 2h")).toBeVisible();
  await page.getByTestId("inbox-enabled").check();
  await expect.poll(() => onDisk().inbox).toBe(true);
  await page.reload();
  await expect(page.getByTestId("autosleep-every")).toHaveValue("2h");
  await expect(page.getByTestId("autosleep-enabled")).not.toBeChecked();
  await expect(page.getByTestId("autosleep-idle")).toHaveValue("90m");
  await expect(page.getByTestId("inbox-enabled")).toBeChecked();
});

test("@F51 @F66 the page holds only global settings; never sleep is toggled in the space menu and saved in neverSleep", async ({ page }) => {
  await openSettings(page);
  await expect(page.getByTestId("never-sleep-row")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Never sleep" })).toHaveCount(0);
  await menuNeverSleep(page, IDS.beta, "Never sleep");
  await expect.poll(() => onDisk().autosleep.neverSleep).toEqual(["beta"]);
  await menuNeverSleep(page, IDS.beta, "Allow sleep");
  await expect.poll(() => onDisk().autosleep.neverSleep).toEqual([]);
});

test("@F66 the settings page scrolls on a short viewport and its last control can be used", async ({ page }) => {
  await page.setViewportSize({ width: page.viewportSize()?.width ?? 1280, height: 300 });
  await openSettings(page);
  const last = page.getByTestId("push-paused");
  await expect(last).not.toBeInViewport();
  // Scroll the way a user does (wheel or drag), not by a script, which can scroll even a clipped box.
  const box = await page.getByTestId("settings-page").boundingBox();
  await page.mouse.move((box?.x ?? 0) + 40, 150);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 200);
  await expect(last).toBeInViewport();
  await last.check();
  await expect.poll(async () => ((await (await page.request.get("/api/push")).json()) as { paused: boolean }).paused).toBe(true);
});

test("@F51 a bad idle threshold is refused with a message and the old one stays", async ({ page }) => {
  await openSettings(page);
  await page.getByTestId("autosleep-idle").fill("soon");
  await page.getByTestId("autosleep-idle").press("Enter");
  await expect(page.getByRole("alert")).toContainText("90m, 3h or 1d");
  expect(onDisk().autosleep.idle).toBe("3h");
});

test("@F51 the page pauses and resumes all push notifications", async ({ page }) => {
  await openSettings(page);
  await page.getByTestId("push-paused").check();
  await expect.poll(async () => ((await (await page.request.get("/api/push")).json()) as { paused: boolean }).paused).toBe(true);
  await page.getByTestId("push-paused").uncheck();
  await expect.poll(async () => ((await (await page.request.get("/api/push")).json()) as { paused: boolean }).paused).toBe(false);
});

test("@F51 renaming a space keeps its never-sleep exemption", async ({ page }) => {
  await menuNeverSleep(page, IDS.gamma, "Never sleep");
  await expect.poll(() => onDisk().autosleep.neverSleep).toEqual(["gamma"]);
  const spaces = ((await qaCore().layout()).spaces);
  const gamma = spaces.find((s) => s.name === "gamma");
  expect(gamma).toBeDefined();
  const res = await page.evaluate(async (id) => (await fetch("/api/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "space.rename", id, name: "gamma2" }) })).status, gamma?.id ?? "");
  expect(res).toBe(200);
  await expect.poll(() => onDisk().autosleep.neverSleep).toEqual(["gamma2"]);
});

test("@F51 the auto-sleep job reads the file herdr wrote (settings win, --idle is the fallback)", async ({ page }) => {
  // An external auto-sleep script (sessions.py beside an installed hc-sleep) that reads the same file; skipped where it is not installed.
  const link = join(homedir(), ".local", "bin", "hc-sleep");
  test.skip(!existsSync(link), "hc-sleep and its sessions.py are not installed on this machine");
  const sessions = join(dirname(realpathSync(link)), "sessions.py");
  const read = (path: string) =>
    JSON.parse(execFileSync("python3", ["-I", "-c", "import importlib.util,json,sys;s=importlib.util.spec_from_file_location('s',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);r=m.herdr_settings();print(json.dumps(None if r is None else {'enabled':r['enabled'],'idle':r['idle'],'never':sorted(r['never'])}))", sessions], { env: { ...process.env, HERDR_SETTINGS_FILE: path }, encoding: "utf8" })) as unknown;
  await openSettings(page);
  await page.getByTestId("autosleep-idle").fill("45m");
  await page.getByTestId("autosleep-idle").press("Enter");
  await expect.poll(() => onDisk().autosleep.idle).toBe("45m");
  await menuNeverSleep(page, IDS.beta, "Never sleep");
  await expect.poll(() => onDisk().autosleep.neverSleep).toEqual(["beta"]);
  expect(read(file())).toEqual({ enabled: true, idle: "45m", never: ["beta"] });
  expect(read("/nonexistent/settings.json")).toBeNull(); // herdr not installed: the job falls back to --idle
});

test("@F51 closing settings returns to the space it was opened from", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByText("beta", { exact: true }).first().click();
  await expect(page).toHaveURL(/\/s\//u);
  const before = new URL(page.url()).pathname;
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-page")).toBeHidden();
  expect(new URL(page.url()).pathname).toBe(before);
});

for (const [name, size] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 360, height: 740 }]] as const) {
  test(`@F51 the gear toggles settings open and closed (${name})`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    const gear = page.getByTestId("open-settings");
    for (let i = 0; i < 2; i++) {
      await gear.click();
      await expect(page.getByTestId("settings-page")).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/settings");
      await gear.click(); // on the phone the gear is in the Settings top bar
      await expect(page.getByTestId("settings-page")).toBeHidden();
      expect(new URL(page.url()).pathname).toBe("/");
    }
  });
}
