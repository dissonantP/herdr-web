import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { prepareRealClaude } from "../support/claude.ts";
import { addTab, IDS, seed, type Seeded } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F17: the chat input sends text, stops Claude, attaches files (put beside the terminal, the path in
// the message) and autocompletes slash commands. F18: permission prompts, questions (multiple choice
// and multi-step too) and plan approval show as tappable options with an Other field, and the
// choice reaches the program. A fake Claude (tests/support/fake-claude.py) draws a fixture screen and
// logs every byte it gets; the last test drives a real, short Claude (cheap model) to a permission
// prompt and approves it from the app.

const fake = new URL("../support/fake-claude.py", import.meta.url).pathname;
const screens = new URL(".", import.meta.resolve("@herdr/server/fixtures/claude/screens/README.md")).pathname;
const fixture = (name: string) => join(screens, `${name}.txt`);
const claudeBinary = join(homedir(), ".local", "bin", "claude");

let seeded: Seeded;
let dir: string;
test.beforeEach(async () => {
  seeded = await seed(qaCore());
  dir = mkdtempSync(join(tmpdir(), "herdr-qa-input-"));
});
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A tab running the fake Claude on these screens; returns its log file and terminal. */
async function fakeTab(page: Page, state: "idle" | "working" | "blocked", ...names: string[]): Promise<{ log: string; address: string }> {
  const log = join(dir, "input.log");
  const address = await addTab(qaCore(), seeded, "alpha", "fake", ["python3", fake, state, log, ...names.map(fixture)], {}, dir);
  await page.goto(`/s/${IDS.alpha}`);
  await page.getByRole("tab", { name: "fake", exact: true }).click();
  await expect(page.getByTestId("chat-view")).toBeVisible();
  return { log, address };
}

const logged = (log: string) => (existsSync(log) ? readFileSync(log, "latin1") : "");

test.describe("@F17 chat input", () => {
  test("sends a message to the session", async ({ page }) => {
    const { log } = await fakeTab(page, "idle", "collie/claude--fresh-idle");
    await page.getByTestId("composer-text").fill("hello from the phone");
    await page.getByTestId("send").click();
    // Pasted, then Enter once the paste has landed.
    await expect.poll(() => logged(log), { timeout: 10_000 }).toMatch(/hello from the phone.*\r/su);
    await expect(page.getByTestId("composer-text")).toHaveValue("", { timeout: 10_000 });
  });

  test("text already in Claude's box (a desk draft or its suggestion) is cleared first, then the message goes", async ({ page }) => {
    const { log } = await fakeTab(page, "idle", "collie/claude--v2283-draft-prompt");
    await page.getByTestId("composer-text").fill("hello from the phone");
    await page.getByTestId("send").click();
    await expect.poll(() => logged(log), { timeout: 10_000 }).toContain("hello from the phone");
    const got = logged(log);
    expect(got.indexOf("\x05\x15")).toBeGreaterThanOrEqual(0);
    expect(got.indexOf("\x05\x15")).toBeLessThan(got.indexOf("hello from the phone"));
    await expect(page.getByTestId("composer-text")).toHaveValue("", { timeout: 10_000 });
  });

  test("the stop button shows while Claude works and interrupts it", async ({ page }) => {
    const { log } = await fakeTab(page, "working", "collie/claude-lab--working-spinner--w82");
    await page.getByTestId("stop").click();
    await expect.poll(() => logged(log)).toContain("\x1b");
  });

  test("attaches a file: it lands beside the terminal and its path goes into the message", async ({ page }) => {
    await fakeTab(page, "idle", "collie/claude--fresh-idle");
    await page.getByTestId("attach-input").setInputFiles({ name: "shot one.png", mimeType: "image/png", buffer: Buffer.from("PNGDATA") });
    const box = page.getByTestId("composer-text");
    await expect(box).toHaveValue(/\/shot_one\.png $/u);
    const path = (await box.inputValue()).trim();
    expect(readFileSync(path, "utf8")).toBe("PNGDATA");
  });

  test("autocompletes slash commands when typing /", async ({ page }) => {
    await fakeTab(page, "idle", "collie/claude--fresh-idle");
    const box = page.getByTestId("composer-text");
    await box.fill("/comp");
    const list = page.getByTestId("slash-list");
    await expect(list).toBeVisible();
    await expect(list.getByTestId("slash-item").first()).toContainText("/compact");
    await list.getByTestId("slash-item").first().click();
    await expect(box).toHaveValue("/compact ");
    await expect(list).toHaveCount(0);
    await box.fill("hello");
    await expect(page.getByTestId("slash-list")).toHaveCount(0);
  });

  test("the input endpoints need a pane that can chat, and the same origin", async ({ request }) => {
    const shell = encodeURIComponent(seeded.terminals.alpha ?? "");
    expect((await request.post(`/api/chat/${shell}/send`, { data: { text: "x" }, headers: { origin: `http://127.0.0.1:${process.env.HERDR_QA_PORT ?? ""}` } })).status()).toBe(404);
    expect((await request.post(`/api/chat/${shell}/send`, { data: { text: "x" }, headers: { origin: "http://evil.example" } })).status()).toBe(403);
    expect((await request.get(`/api/chat/${shell}/commands`)).status()).toBe(404);
  });
});

test.describe("@F18 menus", () => {
  test("a permission prompt: tappable options, and the tap reaches Claude", async ({ page }) => {
    const { log } = await fakeTab(page, "blocked", "live/permission-bash", "collie/claude--done");
    const card = page.getByTestId("menu-card");
    await expect(card).toHaveAttribute("data-kind", "permission");
    await expect(page.getByTestId("menu-title")).toHaveText("Do you want to proceed?");
    await expect(page.getByTestId("menu-detail")).toContainText("mkdir newdir");
    await expect(card.getByTestId("menu-option")).toHaveCount(4);
    await card.getByTestId("menu-option").filter({ hasText: /^Yes$/u }).click();
    await expect.poll(() => logged(log)).toBe("1");
    await expect(page.getByTestId("menu-card")).toHaveCount(0); // the prompt closed on screen
  });

  test("a permission prompt's Other declines it and sends the text as a message", async ({ page }) => {
    const { log } = await fakeTab(page, "blocked", "live/permission-bash", "collie/claude--done");
    await page.getByTestId("menu-other").fill("use mkdir -p instead");
    await page.getByTestId("menu-other-send").click();
    await expect.poll(() => logged(log)).toContain("use mkdir -p instead");
    expect(logged(log).startsWith("\x1b")).toBe(true);
  });

  test("a question: options with descriptions, and Other typed into its field", async ({ page }) => {
    const { log } = await fakeTab(page, "blocked", "live/ask-single", "live/ask-single-field-focused");
    const card = page.getByTestId("menu-card");
    await expect(card).toHaveAttribute("data-kind", "question");
    await expect(page.getByTestId("menu-title")).toHaveText("Pick a colour?");
    await expect(card.getByTestId("menu-option").first()).toContainText("Pick red.");
    await page.getByTestId("menu-other").fill("Teal");
    await page.getByTestId("menu-other-send").click();
    // The empty field's digit focuses it; the text then goes in with Enter.
    await expect.poll(() => logged(log)).toMatch(/^3.*Teal.*\r/su);
  });

  test("multiple choice: tick with taps, then submit", async ({ page }) => {
    const { log } = await fakeTab(page, "blocked", "live/ask-multi", "live/ask-multi-ticked");
    const card = page.getByTestId("menu-card");
    await expect(card).toHaveAttribute("data-multi", "1");
    await expect(card.getByTestId("menu-option").first()).toHaveAttribute("aria-pressed", "false");
    await card.getByTestId("menu-option").first().click();
    await expect.poll(() => logged(log)).toBe("1");
    // The screen now shows Cheese and Olives ticked.
    await expect(card.getByTestId("menu-option").first()).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("menu-submit").click();
    // Four Downs (the cursor key, either encoding) onto Submit, then Enter.
    await expect.poll(() => logged(log).replaceAll("\x1b[B", "D").replaceAll("\x1bOB", "D")).toBe("1DDDD\r");
  });

  test("multiple choice: two quick taps both land, and the Other text survives a tick", async ({ page }) => {
    const { log } = await fakeTab(page, "blocked", "live/ask-multi", "live/ask-multi-ticked");
    const card = page.getByTestId("menu-card");
    await page.getByTestId("menu-other").fill("Mango");
    await card.getByTestId("menu-option").nth(0).click();
    await card.getByTestId("menu-option").nth(2).click();
    await expect.poll(() => logged(log)).toBe("13");
    await expect(page.getByTestId("menu-error")).toHaveCount(0);
    await expect(page.getByTestId("menu-other")).toHaveValue("Mango");
  });

  test("a multi-step question shows its steps and answers the current one", async ({ page }) => {
    const { log } = await fakeTab(page, "blocked", "live/ask-wizard-q1", "live/ask-wizard-q2", "live/ask-wizard-review");
    await expect(page.getByTestId("menu-steps")).toContainText("Colour");
    await expect(page.getByTestId("menu-steps")).toContainText("Size");
    await page.getByTestId("menu-option").filter({ hasText: "Blue" }).click();
    await expect(page.getByTestId("menu-title")).toHaveText("Pick a size?");
    await page.getByTestId("menu-option").filter({ hasText: "Large" }).click();
    await expect(page.getByTestId("menu-card")).toHaveAttribute("data-kind", "review");
    await expect(page.getByTestId("menu-detail")).toContainText("→ Blue");
    await page.getByTestId("menu-option").filter({ hasText: "Submit answers" }).click();
    await expect.poll(() => logged(log)).toBe("221");
  });

  test("plan approval: the plan, the approve options and feedback in Other", async ({ page }) => {
    const { log } = await fakeTab(page, "blocked", "live/plan", "live/plan-field-focused");
    const card = page.getByTestId("menu-card");
    await expect(card).toHaveAttribute("data-kind", "plan");
    await expect(page.getByTestId("menu-detail")).toContainText("Create notes.txt");
    await expect(card.getByTestId("menu-option")).toHaveText(["Yes, and use auto mode", "Yes, manually approve edits"]);
    await page.getByTestId("menu-other").fill("use hello instead");
    await page.getByTestId("menu-other-send").click();
    await expect.poll(() => logged(log)).toMatch(/^3.*use hello instead.*\r/su);
  });

  test("a stale answer is refused: the screen changed before the tap", async ({ page }) => {
    const { log, address } = await fakeTab(page, "blocked", "live/ask-wizard-q1", "live/ask-wizard-q2");
    await expect(page.getByTestId("menu-title")).toHaveText("Pick a colour?");
    const id = await page.getByTestId("menu-card").getAttribute("data-id");
    // Someone at the desk answers the first step; the app's card is now stale.
    await qaCore().call("terminal.keys", { terminal: address, keys: ["2"] });
    await expect.poll(() => logged(log)).toBe("2");
    const res = await page.evaluate(
      async ([pane, menu]) => (await fetch(`/api/chat/${pane}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: menu, action: "pick", n: 1 }) })).status,
      [encodeURIComponent(address), id ?? ""] as const,
    );
    expect(res).toBe(409);
    expect(logged(log)).toBe("2");
  });

  test("a real short Claude session (cheap model): a message from the app hits a permission prompt, approved from the app", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "one real session per run is enough");
    test.setTimeout(180_000);
    const core = qaCore();
    const cwd = core.env.CLAUDE_CONFIG_DIR.replace(/claude$/u, "work-input");
    if (!prepareRealClaude(core, cwd)) test.skip(true, "no Claude sign-in on this machine");
    const made = join(cwd, `made-${String(Date.now() % 100000)}`);
    rmSync(made, { recursive: true, force: true });
    const address = await addTab(core, seeded, "alpha", "real", ["env", "-u", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1", claudeBinary, "--model", "haiku", "--permission-mode", "default"], {}, cwd);
    await page.goto(`/s/${IDS.alpha}`);
    await page.getByRole("tab", { name: "real", exact: true }).click();
    try {
      // Claude's prompt is up once it has drawn its input box.
      await expect.poll(async () => /❯/u.test(await core.screen(address)), { timeout: 60_000 }).toBe(true);
      await page.getByTestId("composer-text").fill(`Run exactly this bash command and nothing else: mkdir ${made}`);
      await page.getByTestId("send").click();
      // Approve every permission prompt Claude shows until the folder exists.
      await expect
        .poll(
          async () => {
            const yes = page.getByTestId("menu-card").getByTestId("menu-option").first();
            if (await yes.isVisible().catch(() => false)) await yes.click().catch(() => undefined);
            return existsSync(made);
          },
          { timeout: 90_000, intervals: [1000] },
        )
        .toBe(true);
    } catch (err) {
      console.log(`real Claude screen:\n${await core.screen(address)}`);
      throw err;
    }
  });
});
