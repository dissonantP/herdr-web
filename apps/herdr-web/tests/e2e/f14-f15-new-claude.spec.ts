import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { dialog, submitDialog } from "../support/admin-ui.ts";
import { writeTranscript } from "../support/claude.ts";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F14: + in a space's tab strip offers a terminal or a Claude session; the Claude form (folder, model,
// effort, permission mode) starts it and opens its chat. F15: "Resume a conversation" lists the past
// Claude conversations (the QA config folder's projects) and resumes one in the space. The `claude`
// started is a stand-in that logs its folder and arguments (tests/support/fake-bin/claude).

const argsLog = () => {
  const file = join(qaCore().env.CLAUDE_CONFIG_DIR, "fake-claude-args.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l !== "") : [];
};

async function plus(page: Page, item: string) {
  await page.goto(`/s/${IDS.alpha}`);
  await page.getByTestId("tab-add").click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test.beforeEach(async () => {
  await seed(qaCore());
});

test.describe("@F14 new tab: terminal or Claude session", () => {
  test("the + offers a terminal, a Claude session and resume", async ({ page }) => {
    await page.goto(`/s/${IDS.alpha}`);
    await page.getByTestId("tab-add").click();
    for (const name of ["Terminal", "Claude session…", "Resume a conversation…"]) await expect(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
  });

  test("the Claude form starts a session with the chosen flags and opens its chat", async ({ page }) => {
    const folder = join(qaCore().env.CLAUDE_CONFIG_DIR, "work");
    mkdirSync(folder, { recursive: true });
    const before = argsLog().length;
    await plus(page, "Claude session…");
    await expect(dialog(page).getByLabel("Folder", { exact: true })).toHaveValue("~");
    await expect(dialog(page).getByLabel("Model", { exact: true }).locator("option")).toHaveText(["default", "opus", "sonnet", "haiku"]);
    await submitDialog(page, { Folder: folder, Model: "sonnet", Effort: "high", "Permission mode": "plan" }, "Start");
    // The new tab is selected and shows the chat view.
    const view = page.getByTestId("pane-view");
    await expect(view).toHaveAttribute("data-view", "chat");
    await expect(page.getByTestId("chat-view")).toBeVisible();
    await expect.poll(argsLog).toHaveLength(before + 1);
    expect(argsLog().at(-1)).toBe(`${folder}|--model sonnet --effort high --permission-mode plan -n alpha`);
  });

  test("defaults pass no flags, and a bad folder is refused in the dialog", async ({ page }) => {
    const before = argsLog().length;
    await plus(page, "Claude session…");
    await dialog(page).getByLabel("Folder", { exact: true }).fill("relative/dir");
    await dialog(page).getByRole("button", { name: "Start", exact: true }).click();
    await expect(dialog(page)).toContainText("The folder must start with / or ~.");
    await dialog(page).getByLabel("Folder", { exact: true }).fill(qaCore().env.CLAUDE_CONFIG_DIR);
    await dialog(page).getByRole("button", { name: "Start", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(argsLog).toHaveLength(before + 1);
    expect(argsLog().at(-1)).toBe(`${qaCore().env.CLAUDE_CONFIG_DIR}|-n alpha`);
  });
});

test.describe("@F14 Claude named after its space", () => {
  const hcNames = async () => (((await qaCore().call("terminal.list", {})).terminals ?? []) as { name: string; state: string }[]).filter((t) => t.state === "live").map((t) => t.name);

  test("a new tab's Claude is named after the space; a second one gets a distinct hc name", async ({ page }) => {
    const before = argsLog().length;
    await plus(page, "Claude session…");
    await submitDialog(page, {}, "Start");
    await plus(page, "Claude session…");
    await submitDialog(page, {}, "Start");
    await expect.poll(argsLog).toHaveLength(before + 2);
    expect(argsLog().slice(-2).map((l) => l.split("|")[1])).toEqual(["-n alpha", "-n alpha"]);
    await expect.poll(hcNames).toEqual(expect.arrayContaining(["alpha", "alpha-2"]));
  });

  test("a new space can start Claude instead of a terminal, named after it; the terminal option still works", async ({ page }) => {
    const before = argsLog().length;
    await page.goto("/");
    await page.getByTestId("add-node").click();
    await page.getByRole("menuitem", { name: "New space", exact: true }).click();
    await expect(dialog(page).getByLabel("Start with", { exact: true })).toHaveValue("terminal");
    await submitDialog(page, { Name: "Fresh Claude", Folder: "/tmp", "Start with": "claude" }, "Create");
    await expect(page.getByTestId("pane-view")).toHaveAttribute("data-view", "chat");
    await expect.poll(argsLog).toHaveLength(before + 1);
    expect(argsLog().at(-1)).toBe("/tmp|-n Fresh Claude");
    await expect.poll(hcNames).toContain("fresh-claude");

    await page.goto("/");
    await page.getByTestId("add-node").click();
    await page.getByRole("menuitem", { name: "New space", exact: true }).click();
    await submitDialog(page, { Name: "Plain", Folder: "/tmp" }, "Create");
    await expect(page.getByTestId("pane-view")).toHaveClass(/pane-terminal/u);
    expect(argsLog()).toHaveLength(before + 1);
  });
});

test.describe("@F15 resume a past conversation", () => {
  const SESSION = "12345678-1234-4234-8234-123456789abc";

  test("lists past conversations and resumes the chosen one in a new tab of the space", async ({ page }) => {
    rmSync(join(qaCore().env.CLAUDE_CONFIG_DIR, "projects"), { recursive: true, force: true }); // other tests' transcripts
    const cwd = join(qaCore().env.CLAUDE_CONFIG_DIR, "old-proj");
    mkdirSync(cwd, { recursive: true });
    writeTranscript(qaCore(), cwd, SESSION, [
      JSON.stringify({ type: "user", cwd, isSidechain: false, message: { role: "user", content: "Refactor the parser" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
    ]);
    const before = argsLog().length;
    await plus(page, "Resume a conversation…");
    const pick = dialog(page).getByLabel("Conversation", { exact: true });
    await expect(pick.locator("option")).toHaveCount(1);
    await expect(pick).toContainText("Refactor the parser");
    await expect(pick).toContainText(cwd);
    await dialog(page).getByRole("button", { name: "Resume", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId("pane-view")).toHaveAttribute("data-view", "chat");
    await expect.poll(argsLog).toHaveLength(before + 1);
    expect(argsLog().at(-1)).toBe(`${cwd}|--resume ${SESSION}`);
  });

  test("says so when there is nothing to resume", async ({ page }) => {
    rmSync(join(qaCore().env.CLAUDE_CONFIG_DIR, "projects"), { recursive: true, force: true }); // other tests' transcripts
    await plus(page, "Resume a conversation…");
    await expect(dialog(page)).toContainText("There are no past Claude conversations to resume.");
  });
});
