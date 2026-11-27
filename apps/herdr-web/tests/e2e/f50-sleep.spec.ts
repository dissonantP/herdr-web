import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { home, row, rowAction, unfoldAll } from "../support/admin-ui.ts";
import { addTab, claudeProgram, IDS, seed } from "../support/fixture.ts";
import { awakeClaude, haveSleepScripts, hcSleep, hcWake, MENU_SCREEN, ownClaude, SESSION, sleepingShell } from "../support/sleep.ts";
import { qaCore } from "../support/world.ts";
import { writeTranscript } from "../support/claude.ts";
import { tmpdir } from "node:os";

// F50 and task 067: herdr sleeps and wakes Claude sessions itself. A sleeping session (sleep.session
// label, Claude not running) shows as asleep in the tree and its tab, with a Resume button that types
// `claude --resume <session>` into its pane; an awake idle session has a Sleep action; auto-sleep, in
// the backend, sleeps sessions idle longer than the settings' idle time outside never-sleep spaces.
// External hc-sleep / hc-wake scripts stay compatible. Only the isolated core is touched (support/sleep.ts).

const terminal = async (address: string) => qaCore().call("terminal.get", { terminal: address });
const labels = async (address: string) => ((await terminal(address)).labels ?? {}) as Record<string, string>;
const foreground = async (address: string) => ((await terminal(address)).foreground as { name?: string } | null)?.name;

/** The shell has started and reports its foreground program, as one a person left sleeping long ago does. */
const shellReady = (address: string) => expect.poll(() => foreground(address)).toBe("bash");
/** The stand-in Claude has started and written its session file. */
const claudeReady = (address: string) => expect.poll(() => foreground(address)).toBe("claude");

/** The arguments each stand-in Claude started with (fake-bin/claude's log). */
const startedWith = (): string => {
  try {
    return readFileSync(join(qaCore().env.CLAUDE_CONFIG_DIR, "fake-claude-args.log"), "utf8");
  } catch {
    return "";
  }
};

/** An external hc-sleep / hc-wake script, against the QA core only. */
function runSleepScript(command: string, address: string): string {
  const env = { ...qaCore().childEnv() };
  delete env.HC_TERMINAL_ID;
  return execFileSync(command, [address], { env, encoding: "utf8" });
}

async function act(page: Page, action: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate(async (body) => (await fetch("/api/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<{ ok: boolean; error?: string }>, action);
}

async function settings(page: Page, body: Record<string, unknown>): Promise<void> {
  const status = await page.evaluate(async (b) => (await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).status, body);
  expect(status).toBe(200);
}

test("@F50 an idle Claude session can be put to sleep from its menu and shows as asleep", async ({ page }) => {
  const core = qaCore();
  const seeded = await seed(core);
  const address = await addTab(core, seeded, "alpha", "sleeper", awakeClaude());
  await claudeReady(address);
  await home(page);
  await unfoldAll(page);
  const status = row(page, "pane", address).getByTestId("pane-status");
  await expect(status).toHaveAttribute("data-status", "idle");
  await rowAction(row(page, "pane", address), "Sleep");
  await expect(status).toHaveAttribute("data-status", "asleep");
  await expect.poll(() => labels(address)).toMatchObject({ "sleep.session": SESSION, "sleep.cwd": expect.any(String) as unknown }); // shown at once (task 142), labelled as the server answers
  await expect.poll(() => foreground(address)).toBe("bash");
  // Asleep, its menu offers Resume instead of Sleep.
  await row(page, "pane", address).getByTestId("row-actions").click();
  await expect(page.getByRole("menuitem", { name: "Resume", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Sleep", exact: true })).toHaveCount(0);
});

test("@F50 a working or waiting session has no Sleep action, and the server refuses to sleep it", async ({ page }) => {
  const core = qaCore();
  const seeded = await seed(core);
  const busy = await addTab(core, seeded, "alpha", "busy", awakeClaude("working"));
  const asking = await addTab(core, seeded, "alpha", "asking", claudeProgram("blocked"));
  await claudeReady(busy);
  await home(page);
  await unfoldAll(page);
  for (const address of [busy, asking]) {
    await row(page, "pane", address).getByTestId("row-actions").click();
    await expect(page.getByRole("menuitem", { name: "Close pane…" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Sleep", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
  }
  expect((await act(page, { type: "pane.sleep", id: busy })).ok).toBe(false);
  expect(await foreground(busy)).toBe("claude");
});

test("@F50 Resume wakes a sleeping session in its pane and opens its chat once Claude is back", async ({ page }) => {
  const core = qaCore();
  const seeded = await seed(core);
  const address = await addTab(core, seeded, "alpha", "napper", sleepingShell(), { "sleep.session": SESSION, "sleep.cwd": "/tmp" });
  await shellReady(address);
  await page.goto(`/s/${IDS.alpha}`);
  const tab = page.getByRole("tab", { name: "napper", exact: true });
  await expect(tab).toHaveAttribute("data-asleep", "true");
  await tab.click();
  await expect(page.getByTestId("asleep-card")).toBeVisible();
  await page.getByTestId("resume").click();
  // Claude is back: the asleep banner is gone, and the tab no longer says asleep.
  await expect(page.getByTestId("asleep-card")).toHaveCount(0, { timeout: 30_000 });
  await expect(tab).not.toHaveAttribute("data-asleep", "true");
  expect((await labels(address))["sleep.session"] ?? "").toBe("");
  // It resumed that session, in that folder, with the configured Claude command.
  await expect.poll(startedWith).toContain(`/tmp|--resume ${SESSION}\n`);
});

test("@F50 a shell with only claude.session/claude.cwd labels (after a reboot) shows Resume and resumes that session", async ({ page }) => {
  const core = qaCore();
  const seeded = await seed(core);
  const address = await addTab(core, seeded, "alpha", "rebooted", sleepingShell(), { "claude.session": SESSION, "claude.cwd": "/tmp" });
  await shellReady(address);
  await page.goto(`/s/${IDS.alpha}`);
  const tab = page.getByRole("tab", { name: "rebooted", exact: true });
  await expect(tab).toHaveAttribute("data-asleep", "true");
  await tab.click();
  await page.getByTestId("resume").click();
  await expect(page.getByTestId("asleep-card")).toHaveCount(0, { timeout: 30_000 });
  await expect(tab).not.toHaveAttribute("data-asleep", "true");
  await expect.poll(startedWith).toContain(`/tmp|--resume ${SESSION}\n`);
});

test("@F50 a terminal whose own program is Claude sleeps to a shell and wakes in the same pane", async ({ page }) => {
  const core = qaCore();
  const seeded = await seed(core);
  const session = "33333333-3333-4333-8333-333333333333";
  const address = await addTab(core, seeded, "alpha", "own", ownClaude("idle", session));
  await claudeReady(address);
  await page.goto("/");
  expect((await act(page, { type: "pane.sleep", id: address })).ok).toBe(true);
  await expect.poll(() => labels(address)).toMatchObject({ "sleep.session": session });
  expect((await terminal(address)).state).toBe("live");
  await expect.poll(async () => ["bash", "fish", "sh", "zsh", "dash"].includes((await foreground(address)) ?? "")).toBe(true);
  expect((await act(page, { type: "pane.wake", id: address })).ok).toBe(true);
  await claudeReady(address);
  expect(startedWith()).toContain(`--resume ${session}\n`);
});

test("@F50 the tree shows a slept session as asleep, not as ended", async ({ page }) => {
  const core = qaCore();
  const seeded = await seed(core);
  const address = await addTab(core, seeded, "alpha", "napper", sleepingShell(), { "sleep.session": SESSION, "sleep.cwd": "/tmp" });
  await home(page);
  await unfoldAll(page);
  await expect(row(page, "pane", address).getByTestId("pane-status")).toHaveAttribute("data-status", "asleep");
  await expect(row(page, "pane", address).getByTestId("pane-status")).toHaveText("asleep");
});

test.describe("auto-sleep", () => {
  test.afterEach(async ({ page }) => {
    await page.goto("/");
    await settings(page, { autosleep: { enabled: true, idle: "3h" } });
    await settings(page, { neverSleep: { space: "beta", never: false } });
  });

  test("@F50 auto-sleep sleeps an idle session after the idle time, but never a working or waiting one or one in a never-sleep space", async ({ page }) => {
    test.setTimeout(150_000);
    const core = qaCore();
    const seeded = await seed(core);
    const idle = await addTab(core, seeded, "alpha", "idle", awakeClaude());
    const busy = await addTab(core, seeded, "alpha", "busy", awakeClaude("working"));
    const asking = await addTab(core, seeded, "alpha", "asking", awakeClaude("blocked"));
    const kept = await addTab(core, seeded, "beta", "kept", awakeClaude());
    // Reports idle, but has a question menu on screen: the app shows it waiting, so it never sleeps.
    const menu = await addTab(core, seeded, "alpha", "menu", awakeClaude("idle", SESSION, MENU_SCREEN));
    for (const a of [idle, busy, asking, kept, menu]) await claudeReady(a);
    await home(page);
    await unfoldAll(page);
    await expect(row(page, "pane", menu).getByTestId("pane-status")).toHaveAttribute("data-status", "waiting", { timeout: 15_000 });
    expect((await act(page, { type: "pane.sleep", id: menu })).ok).toBe(false);
    await settings(page, { neverSleep: { space: "beta", never: true } });
    await settings(page, { autosleep: { enabled: true, idle: "1m" } });
    // Idle for a minute (the shortest setting), then the next round (every 2 s here) sleeps it.
    await expect.poll(() => labels(idle), { timeout: 100_000, intervals: [2000] }).toMatchObject({ "sleep.session": SESSION });
    await expect.poll(() => foreground(idle)).toBe("bash");
    // A few more rounds: the others are still awake.
    await page.waitForTimeout(5000);
    for (const a of [busy, asking, kept, menu]) {
      expect(await foreground(a)).toBe("claude");
      expect((await labels(a))["sleep.session"] ?? "").toBe("");
    }
    // Woken, it reports idle again with the old status time; it stays awake until idle for the idle time again.
    expect((await act(page, { type: "pane.wake", id: idle })).ok).toBe(true);
    await claudeReady(idle);
    expect((await labels(idle))["sleep.session"] ?? "").toBe("");
    await page.waitForTimeout(8000);
    expect(await foreground(idle)).toBe("claude");
  });
});

test.describe("hc-sleep / hc-wake compatibility", () => {
  test.skip(!haveSleepScripts(), "hc-sleep and hc-wake are not installed on this machine");

  test("@F50 a session slept by hc-sleep is woken by herdr", async ({ page }) => {
    const core = qaCore();
    const seeded = await seed(core);
    const address = await addTab(core, seeded, "alpha", "theirs", awakeClaude());
    await claudeReady(address);
    expect(runSleepScript(hcSleep, address)).toMatch(/: asleep$/mu);
    await page.goto(`/s/${IDS.alpha}`);
    await page.getByRole("tab", { name: "theirs", exact: true }).click();
    await page.getByTestId("resume").click();
    await expect(page.getByTestId("pane-view")).toHaveAttribute("data-view", "chat", { timeout: 30_000 });
    expect(startedWith()).toContain(`--resume ${SESSION}\n`);
  });

  test("@F50 a session slept by herdr is woken by hc-wake", async ({ page }) => {
    const core = qaCore();
    const seeded = await seed(core);
    const address = await addTab(core, seeded, "alpha", "ours", awakeClaude());
    await claudeReady(address);
    await page.goto("/");
    expect((await act(page, { type: "pane.sleep", id: address })).ok).toBe(true);
    await shellReady(address);
    expect(runSleepScript(hcWake, address)).toMatch(/: waking$/mu);
    await claudeReady(address);
    expect(startedWith()).toContain(`-r ${SESSION}\n`);
    expect((await labels(address))["sleep.session"] ?? "").toBe("");
  });
});

// Task 137: a sleeping session's chat shows its saved history without waking it; sending wakes it behind the scenes.
test("@F50 @T137 a sleeping session's chat shows its history, and sending a message wakes it and delivers it once", async ({ page }) => {
  const core = qaCore();
  const seeded = await seed(core);
  const log = join(mkdtempSync(join(tmpdir(), "herdr-qa-wake-")), "input.log");
  const screen = join(fileURLToPath(new URL(".", import.meta.resolve("@herdr/server/fixtures/claude/screens/README.md"))), "collie", "claude--fresh-idle.txt");
  writeTranscript(core, "/tmp", SESSION, [
    JSON.stringify({ type: "user", uuid: "u0", message: { role: "user", content: "what did we decide" } }),
    JSON.stringify({ type: "assistant", uuid: "a0", message: { id: "m0", content: [{ type: "text", text: "We decided to ship it." }] } }),
  ]);
  const address = await addTab(core, seeded, "alpha", "dozer", sleepingShell(screen, log), { "sleep.session": SESSION, "sleep.cwd": "/tmp" });
  await shellReady(address);
  await page.goto(`/s/${IDS.alpha}`);
  const tab = page.getByRole("tab", { name: "dozer", exact: true });
  await tab.click();
  // History shows, the marker stays, nothing was woken.
  await expect(page.getByTestId("chat-message").filter({ hasText: "We decided to ship it." })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("asleep-card")).toBeVisible();
  await expect(tab).toHaveAttribute("data-asleep", "true");
  expect(await foreground(address)).toBe("bash");
  expect(existsSync(log)).toBe(false);
  // Sending wakes it, and the message reaches Claude once.
  await page.getByTestId("composer-text").fill("hello after the nap");
  await page.getByTestId("send").click();
  // Task 139: a visible waking state with the message shown as pending, until Claude has it.
  await expect(page.getByTestId("pending-message")).toContainText("hello after the nap");
  await expect(page.getByTestId("waking-card")).toBeVisible({ timeout: 10_000 });
  // The chat and composer stay up while it wakes (the message isn't lost if the wake fails).
  await expect(page.getByTestId("composer-text")).toBeVisible();
  await expect(page.getByTestId("composer-text")).toHaveValue("", { timeout: 40_000 });
  await expect(page.getByTestId("chat-message").filter({ hasText: "We decided to ship it." })).toBeVisible();
  await expect(tab).not.toHaveAttribute("data-asleep", "true");
  await expect.poll(() => (existsSync(log) ? readFileSync(log, "latin1") : ""), { timeout: 10_000 }).toContain("hello after the nap");
  expect(readFileSync(log, "latin1").split("hello after the nap").length - 1).toBe(1);
  await expect.poll(startedWith).toContain(`/tmp|--resume ${SESSION}\n`);
  await expect(page.getByTestId("waking-card")).toHaveCount(0);
  await expect(page.getByTestId("pending-message")).toHaveCount(0);
});

// Task 141: an image attached to a sleeping session goes through with the message that wakes it.
test("@F50 @T141 an image attached while a session sleeps arrives with the message, once; an image-only message too", async ({ page }) => {
  const core = qaCore();
  const seeded = await seed(core);
  const log = join(mkdtempSync(join(tmpdir(), "herdr-qa-wake-")), "input.log");
  const screen = join(fileURLToPath(new URL(".", import.meta.resolve("@herdr/server/fixtures/claude/screens/README.md"))), "collie", "claude--fresh-idle.txt");
  const address = await addTab(core, seeded, "alpha", "dozer", sleepingShell(screen, log), { "sleep.session": SESSION, "sleep.cwd": "/tmp" });
  await shellReady(address);
  await page.goto(`/s/${IDS.alpha}`);
  const tab = page.getByRole("tab", { name: "dozer", exact: true });
  await tab.click();
  await expect(page.getByTestId("asleep-card")).toBeVisible();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  await page.getByTestId("attach-input").setInputFiles({ name: "napshot.png", mimeType: "image/png", buffer: png });
  await expect(page.getByTestId("composer-error")).toHaveCount(0);
  await expect(page.getByTestId("attach-preview")).toHaveCount(1);
  await expect(page.getByTestId("composer-text")).toHaveValue(/napshot\.png/u);
  expect(await foreground(address)).toBe("bash"); // still asleep: attaching doesn't wake it
  await page.getByTestId("composer-text").pressSequentially(" look at this");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("composer-text")).toHaveValue("", { timeout: 40_000 });
  await expect.poll(() => (existsSync(log) ? readFileSync(log, "latin1") : ""), { timeout: 10_000 }).toContain("look at this");
  const got = readFileSync(log, "latin1");
  expect(got.split("napshot.png").length - 1).toBe(1);
  expect(got.split("look at this").length - 1).toBe(1);
});

test("@F50 @T141 an image-only message to a sleeping session wakes it and delivers the image path", async ({ page }) => {
  const core = qaCore();
  const seeded = await seed(core);
  const log = join(mkdtempSync(join(tmpdir(), "herdr-qa-wake-")), "input.log");
  const screen = join(fileURLToPath(new URL(".", import.meta.resolve("@herdr/server/fixtures/claude/screens/README.md"))), "collie", "claude--fresh-idle.txt");
  const address = await addTab(core, seeded, "alpha", "dozer", sleepingShell(screen, log), { "sleep.session": SESSION, "sleep.cwd": "/tmp" });
  await shellReady(address);
  await page.goto(`/s/${IDS.alpha}`);
  await page.getByRole("tab", { name: "dozer", exact: true }).click();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  await page.getByTestId("attach-input").setInputFiles({ name: "only.png", mimeType: "image/png", buffer: png });
  await expect(page.getByTestId("attach-preview")).toHaveCount(1);
  await page.getByTestId("send").click();
  await expect(page.getByTestId("composer-text")).toHaveValue("", { timeout: 40_000 });
  await expect.poll(() => (existsSync(log) ? readFileSync(log, "latin1") : ""), { timeout: 10_000 }).toContain("only.png");
  expect(readFileSync(log, "latin1").split("only.png").length - 1).toBe(1);
});
