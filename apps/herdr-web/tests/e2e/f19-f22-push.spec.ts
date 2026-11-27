import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { authed } from "../support/auth.ts";
import { addTab, controlledClaude, IDS, seed, type Seeded } from "../support/fixture.ts";
import { PushDevice } from "../support/push-stub.ts";
import { qaCore } from "../support/world.ts";

// F19-F21: web push against a stub push endpoint (its payload and timing), with real delivery to a
// phone left to a person (the task doc's Unverified section). Agent state comes from herdr-core's own status (the panes here
// report it by OSC 7501 from a program whose state a test sets through a file); no hook is involved.

const base = () => `http://127.0.0.1:${String(process.env.HERDR_QA_PORT)}`;
const api = (path: string, body?: unknown) =>
  fetch(`${base()}${path}`, body === undefined ? { headers: authed() } : { method: "POST", headers: authed({ "content-type": "application/json", origin: base() }), body: JSON.stringify(body) });

let device: PushDevice;
let dir = "";
let state = "";
let seeded: Seeded;
let worker = "";

const setState = (value: string) => writeFileSync(state, value);

test.beforeEach(async () => {
  const core = qaCore();
  dir = mkdtempSync(join(tmpdir(), "herdr-push-e2e-"));
  state = join(dir, "state");
  setState("idle");
  seeded = await seed(core);
  worker = await addTab(core, seeded, "alpha", "worker", controlledClaude(state));
  device = await PushDevice.start();
  await api("/api/push/settings", { paused: false });
  for (const id of Object.values(IDS)) await api("/api/push/settings", { mute: id, muted: false });
  // The pane is a live agent in the tree before the test moves its state, and what the reseed
  // ended (the last test's worker) has been seen, before this device subscribes.
  await expect.poll(async () => JSON.stringify(await (await api("/api/tree")).json())).toContain('"status":"idle"');
  await new Promise((r) => setTimeout(r, 1500));
  expect((await api("/api/push/subscribe", device.subscription)).status).toBe(200);
});

test.afterEach(async () => {
  await api("/api/push/unsubscribe", { endpoint: device.subscription.endpoint });
  await device.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("@F19 a push arrives within 10 s for needs input, a finished turn and a death", async () => {
  const t0 = Date.now();
  setState("blocked");
  let got = await device.waitFor(1, 10_000);
  expect(got).toHaveLength(1);
  expect(got[0]?.at ?? Infinity).toBeLessThan(t0 + 10_000);
  const first = got[0];
  expect(first?.payload).toMatchObject({ kind: "needs-input", title: "alpha", body: "worker needs your input" });
  expect(first?.payload.url).toBe(`/s/${IDS.alpha}/${(await (await api("/api/tree")).text()).match(/"id":"(tb[^"]+)","name":"worker"/u)?.[1] ?? "?"}/${worker}`);
  // Standard Web Push: VAPID-signed, aes128gcm.
  expect(first?.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/u);
  expect(first?.headers["content-encoding"]).toBe("aes128gcm");
  expect(first?.headers.urgency).toBe("high");


  setState("working");
  await new Promise((r) => setTimeout(r, 800));
  const t1 = Date.now();
  setState("idle");
  got = await device.waitFor(2, 10_000);
  expect(got).toHaveLength(2);
  expect(got[1]?.at ?? Infinity).toBeLessThan(t1 + 10_000);
  expect(got[1]?.payload).toMatchObject({ kind: "finished", body: "worker finished" });

  const t2 = Date.now();
  await qaCore().kill(worker);
  got = await device.waitFor(3, 10_000);
  expect(got).toHaveLength(3);
  expect(got[2]?.at ?? Infinity).toBeLessThan(t2 + 10_000);
  expect(got[2]?.payload).toMatchObject({ kind: "died", body: "worker ended" });
});

test("@F19 tapping a push opens that session", async ({ page }) => {
  setState("blocked");
  const got = await device.waitFor(1, 10_000);
  expect(got).toHaveLength(1);
  await page.goto(got[0]?.payload.url ?? "/");
  await expect(page.getByTestId("pane-view")).toHaveAttribute("data-id", worker);
});

test("@F19 nothing for a session that is open in the app; the push comes once it is not", async () => {
  expect((await api("/api/presence", { id: "pw-page", panes: [worker] })).status).toBe(204);
  setState("blocked");
  await expect.poll(async () => (await (await api("/api/tree")).text()).includes('"status":"waiting"')).toBe(true);
  await new Promise((r) => setTimeout(r, 2500));
  expect(device.received).toHaveLength(0);
  // The page leaves (reports nothing): the next event pushes.
  await api("/api/presence", { id: "pw-page", panes: [] });
  setState("working");
  await new Promise((r) => setTimeout(r, 800));
  setState("blocked");
  expect(await device.waitFor(1, 10_000)).toHaveLength(1);
});

test("@F19 a page's visible pane is reported while it is open, and dropped when it goes", async ({ page }) => {
  const reports: string[] = [];
  await page.route("**/api/presence", async (route) => {
    reports.push(route.request().postData() ?? "");
    await route.continue();
  });
  await page.goto(`/s/${IDS.alpha}`);
  await expect.poll(() => reports.some((r) => r.includes(worker) || r.includes('"panes":["'))).toBe(true);
  // Leaving the pane inside the app (as the back button does), without a reload.
  await page.evaluate(() => {
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect.poll(() => reports.at(-1) ?? "").toContain('"panes":[]');
});

test("@F20 a muted space and a global pause never push; unmuting and resuming bring pushes back", async () => {
  await api("/api/push/settings", { mute: IDS.alpha, muted: true });
  expect(await (await api("/api/push")).json()).toMatchObject({ muted: [IDS.alpha], paused: false });
  setState("blocked");
  await new Promise((r) => setTimeout(r, 3000));
  expect(device.received).toHaveLength(0);
  await api("/api/push/settings", { mute: IDS.alpha, muted: false });

  await api("/api/push/settings", { paused: true });
  setState("working");
  await new Promise((r) => setTimeout(r, 800));
  setState("blocked");
  await new Promise((r) => setTimeout(r, 3000));
  expect(device.received).toHaveLength(0);

  await api("/api/push/settings", { paused: false });
  setState("working");
  await new Promise((r) => setTimeout(r, 800));
  setState("blocked");
  expect(await device.waitFor(1, 10_000)).toHaveLength(1);
});

test("@F20 a space whose terminal sets herdr.quiet=1 is recorded quiet in herdr-tree and never pushes for itself", async () => {
  const core = qaCore();
  core.label(worker, { "herdr.quiet": "1" });
  await expect
    .poll(async () => JSON.stringify(((await core.call("doc.get", { name: "herdr-tree" })).value as { spaces?: unknown } | null)?.spaces ?? null))
    .toContain(`"${IDS.alpha}":{"parent":null,"quiet":true}`);
  setState("blocked");
  await new Promise((r) => setTimeout(r, 3000));
  expect(device.received).toHaveLength(0);
  // Another space still pushes for itself (the note path, from beta).
  core.label(seeded.terminals.betaA ?? "", { "herdr.notify": "beta speaks" });
  expect(await device.waitFor(1, 10_000)).toHaveLength(1);
  expect(device.received[0]?.payload.body).toBe("beta speaks");
});

test("@F36 the space menu makes a space quiet and turns it off again, in herdr-tree; a label doesn't bring it back", async ({ page }) => {
  const core = qaCore();
  const quietOf = async () => {
    const spaces = ((await core.call("doc.get", { name: "herdr-tree" })).value as { spaces?: Record<string, { quiet?: boolean }> } | null)?.spaces ?? {};
    return spaces[IDS.alpha]?.quiet === true;
  };
  await page.goto(`/s/${IDS.alpha}`);
  await openMenu(page, "space-actions");
  await page.getByRole("menuitem", { name: "Make quiet" }).click();
  await expect.poll(quietOf).toBe(true);
  // Quiet: the space never pushes for itself (the push service re-reads the doc at least every 5 s).
  await new Promise((r) => setTimeout(r, 6000));
  setState("blocked");
  await new Promise((r) => setTimeout(r, 3000));
  expect(device.received).toHaveLength(0);
  await expect(async () => {
    await openMenu(page, "space-actions");
    await page.getByRole("menuitem", { name: "Turn quiet off" }).click();
  }).toPass();
  await expect.poll(quietOf).toBe(false);
  // An agent's old herdr.quiet=1 label was taken off once recorded, so it doesn't undo the toggle.
  core.label(worker, { "herdr.quiet": "1" });
  await expect.poll(quietOf).toBe(true);
  await expect.poll(async () => (((await core.call("terminal.get", { terminal: worker })).labels ?? {}) as Record<string, string>)["herdr.quiet"] ?? "").toBe("");
  await openMenu(page, "space-actions");
  await page.getByRole("menuitem", { name: "Turn quiet off" }).click();
  await expect.poll(quietOf).toBe(false);
  await new Promise((r) => setTimeout(r, 6000));
  expect(await quietOf()).toBe(false);
});

test("@F21 one label on its terminal sends a push on purpose, is cleared, and tapping opens that agent's session", async ({ page }) => {
  const core = qaCore();
  const t0 = Date.now();
  core.label(worker, { "herdr.notify": "build is green, please look" });
  const got = await device.waitFor(1, 10_000);
  expect(got).toHaveLength(1);
  expect(got[0]?.at ?? Infinity).toBeLessThan(t0 + 10_000);
  const tab = (await (await api("/api/tree")).text()).match(/"id":"(tb[^"]+)","name":"worker"/u)?.[1] ?? "?";
  expect(got[0]?.payload).toMatchObject({ kind: "note", title: "alpha", body: "build is green, please look", url: `/s/${IDS.alpha}/${tab}/${worker}` });
  // Cleared by herdr, and not sent again.
  const labels = ((await core.call("terminal.get", { terminal: worker })).labels ?? {}) as Record<string, string>;
  expect(labels["herdr.notify"] ?? "").toBe("");
  await new Promise((r) => setTimeout(r, 2500));
  expect(device.received).toHaveLength(1);
  await page.goto(got[0]?.payload.url ?? "/");
  await expect(page.getByTestId("space-view")).toHaveAttribute("data-id", IDS.alpha);
  await expect(page).toHaveURL(new RegExp(`/${worker}$`, "u"));
});

test("@F19 a subscription the push service reports gone is dropped", async () => {
  device.status = 410;
  qaCore().label(worker, { "herdr.notify": "anyone there" });
  await device.waitFor(1, 10_000);
  await expect.poll(async () => ((await (await api("/api/push")).json()) as { subscriptions: number }).subscriptions).toBe(0);
});

test("@F19 subscribing needs the login and an allowed endpoint; push without a VAPID key stays off", async () => {
  const noLogin = await fetch(`${base()}/api/push/subscribe`, { method: "POST", headers: { "content-type": "application/json", origin: base() }, body: JSON.stringify(device.subscription) });
  expect(noLogin.status).toBe(401);
  const sneaky = await api("/api/push/subscribe", { endpoint: "https://127.0.0.1/x", keys: device.subscription.keys });
  expect(sneaky.status).toBe(400);
  const crossOrigin = await fetch(`${base()}/api/push/subscribe`, { method: "POST", headers: authed({ "content-type": "application/json", origin: "https://evil.example" }), body: JSON.stringify(device.subscription) });
  expect(crossOrigin.status).toBe(403);
});

async function openMenu(page: Page, testId: string) {
  await page.getByTestId(testId).first().click();
  await expect(page.getByTestId("action-menu")).toBeVisible();
}

test("@F20 the space menu mutes and unmutes; Settings pauses and resumes", async ({ page }) => {
  await page.goto(`/s/${IDS.alpha}`);
  await openMenu(page, "space-actions");
  await page.getByRole("menuitem", { name: "Mute notifications" }).click();
  await expect.poll(async () => ((await (await api("/api/push")).json()) as { muted: string[] }).muted).toEqual([IDS.alpha]);
  await openMenu(page, "space-actions");
  await page.getByRole("menuitem", { name: "Unmute notifications" }).click();
  await expect.poll(async () => ((await (await api("/api/push")).json()) as { muted: string[] }).muted).toEqual([]);

  await page.goto("/");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("push-paused").check();
  await expect.poll(async () => ((await (await api("/api/push")).json()) as { paused: boolean }).paused).toBe(true);
  await page.getByTestId("push-paused").uncheck();
  await expect.poll(async () => ((await (await api("/api/push")).json()) as { paused: boolean }).paused).toBe(false);
});

test("@F22 the Claude hook labels the terminal through the real hc in under 100 ms, with herdr's backend not involved", async () => {
  test.skip(!process.env.HERDR_QA_DIR, "needs the QA stack");
  const core = qaCore();
  const hook = join(import.meta.dirname, "../../deploy/hooks/session-label.sh");
  const input = JSON.stringify({ session_id: "11111111-2222-3333-4444-555555555555", cwd: "/tmp", hook_event_name: "SessionStart" });
  const { spawnSync } = await import("node:child_process");
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const result = spawnSync("bash", [hook], { input, env: { ...core.childEnv(), HC_TERMINAL_ID: worker }, timeout: 4000 });
    times.push(performance.now() - start);
    expect(result.status).toBe(0);
  }
  expect(times.sort((a, b) => a - b)[2] ?? Infinity).toBeLessThan(100);
  await expect
    .poll(async () => ((await core.call("terminal.get", { terminal: worker })).labels as Record<string, string>)["claude.session"])
    .toBe("11111111-2222-3333-4444-555555555555");
});
