import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { authed, login } from "../support/auth.ts";
import { appendTranscript, prepareRealClaude, writeTranscript } from "../support/claude.ts";
import { addTab, claudeProgram, IDS, seed, type Seeded } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F16: a Claude tab opens as a chat view of the conversation (from the session's transcript), live;
// markdown rendered; thinking, tool calls and subagents collapsed; file edits as collapsible diffs.
// A terminal tab stays a terminal. The canned transcript is packages/server/tests/fixtures/claude/session.jsonl; the
// last test drives a real, short Claude session (cheap model) in the isolated core.

const claudeBinary = join(homedir(), ".local", "bin", "claude");
const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CWD = "/tmp/herdr-qa-chat-proj";
const canned = readFileSync(new URL(import.meta.resolve("@herdr/server/fixtures/claude/session.jsonl")), "utf8").split("\n").filter((l) => l !== "");

let seeded: Seeded;
test.beforeEach(async () => {
  seeded = await seed(qaCore());
});

async function openTab(page: Page, name: string) {
  await page.goto(`/s/${IDS.alpha}`);
  await page.getByRole("tab", { name, exact: true }).click();
}

test.describe("@F16 chat view", () => {
  test("shows the conversation: markdown rendered; tools, thinking and subagents collapsed; edits as diffs", async ({ page }) => {
    const core = qaCore();
    writeTranscript(core, CWD, SESSION, canned);
    await addTab(core, seeded, "alpha", "chatty", claudeProgram("idle"), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
    await openTab(page, "chatty");

    const view = page.getByTestId("chat-view");
    await expect(view).toHaveAttribute("data-state", "live");
    // Markdown is rendered, not shown as source.
    await expect(view.locator("strong", { hasText: "greeting" })).toBeVisible();
    await expect(view.locator("li", { hasText: "step one" })).toBeVisible();
    await expect(view).not.toContainText("**");
    // Thinking, tool calls and the subagent are folded until tapped.
    const thinking = page.getByTestId("chat-thinking");
    await expect(thinking).toBeVisible();
    await expect(thinking).not.toHaveAttribute("open", "");
    await expect(thinking.locator(".chat-thinking")).toBeHidden();
    const tools = page.getByTestId("chat-tool");
    await expect(tools).toHaveCount(3); // Read, Edit, Bash (the Task call is the subagent)
    for (const tool of await tools.all()) await expect(tool).not.toHaveAttribute("open", "");
    const subagent = page.getByTestId("chat-subagent");
    await expect(subagent).toHaveCount(1);
    await expect(subagent).not.toHaveAttribute("open", "");
    await expect(subagent).toContainText("Check spelling elsewhere");
    await expect(view).not.toContainText("subagent internal chatter");
    // Opening a tool shows its result; its diff is itself collapsed.
    await tools.filter({ hasText: "Edit" }).locator("summary").first().click();
    const diffFold = tools.filter({ hasText: "Edit" }).locator(".diff-fold");
    await expect(diffFold).toBeVisible();
    await expect(page.getByTestId("chat-diff")).toBeHidden();
    await diffFold.locator("summary").click();
    await expect(page.getByTestId("chat-diff")).toContainText("+hello world");
    await expect(page.getByTestId("chat-diff").locator(".diff-del")).toContainText("-hello wrold");
    // Plumbing stays hidden.
    await expect(view).not.toContainText("hidden");
  });

  test("updates live as the transcript grows, and follows a new session", async ({ page }) => {
    const core = qaCore();
    const path = writeTranscript(core, CWD, SESSION, canned.slice(0, 2));
    const address = await addTab(core, seeded, "alpha", "chatty", claudeProgram("idle"), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
    await openTab(page, "chatty");
    const messages = page.getByTestId("chat-message");
    await expect(messages).toHaveCount(1);
    appendTranscript(path, [JSON.stringify({ type: "assistant", uuid: "n1", message: { id: "msg_new", content: [{ type: "text", text: "A brand new *answer*" }] } })]);
    await expect(page.getByTestId("chat-view").locator("em", { hasText: "answer" })).toBeVisible();
    await expect(messages).toHaveCount(2);
    // /clear or resume: Claude reports another session and the view switches to it.
    const other = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    writeTranscript(core, CWD, other, [JSON.stringify({ type: "user", uuid: "o1", message: { role: "user", content: "second conversation" } })]);
    core.label(address, { "claude.session": other });
    await expect(page.getByTestId("chat-view")).toContainText("second conversation");
    await expect(page.getByTestId("chat-view")).not.toContainText("A brand new");
  });

  test("reply text followed by a trailing tool call shows live and after reload (task 085)", async ({ page }) => {
    const core = qaCore();
    const path = writeTranscript(core, CWD, SESSION, canned.slice(0, 2));
    await addTab(core, seeded, "alpha", "chatty", claudeProgram("idle"), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
    await openTab(page, "chatty");
    await expect(page.getByTestId("chat-message")).toHaveCount(1);
    // Claude Code writes each block of one API message as its own row, seconds apart: empty thinking, text, then the tool call.
    const row = (uuid: string, block: unknown) => JSON.stringify({ type: "assistant", uuid, message: { id: "msg_trail", role: "assistant", stop_reason: "tool_use", content: [block] } });
    appendTranscript(path, [row("r1", { type: "thinking", thinking: "", signature: "sig" })]);
    await page.waitForTimeout(500);
    appendTranscript(path, [row("r2", { type: "text", text: "Reply before the status call" })]);
    await expect(page.getByTestId("chat-view")).toContainText("Reply before the status call");
    appendTranscript(path, [row("r3", { type: "tool_use", id: "toolu_trail", name: "Bash", input: { command: "hc label x" } })]);
    await expect(page.getByTestId("chat-tool").last()).toContainText("hc label x");
    await expect(page.getByTestId("chat-view")).toContainText("Reply before the status call");
    appendTranscript(path, [JSON.stringify({ type: "user", uuid: "r4", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_trail", content: "ok" }] } }), JSON.stringify({ type: "assistant", uuid: "r5", message: { id: "msg_empty", role: "assistant", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "", signature: "sig" }] } })]);
    await expect(page.getByTestId("chat-tool").last()).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("chat-view")).toContainText("Reply before the status call");
    await page.reload();
    await page.getByRole("tab", { name: "chatty", exact: true }).click();
    await expect(page.getByTestId("chat-view")).toContainText("Reply before the status call");
  });

  test("@F116 the chosen Chat/Terminal view carries over to another space and survives a reload", async ({ page }) => {
    const core = qaCore();
    writeTranscript(core, CWD, SESSION, canned.slice(0, 2));
    await addTab(core, seeded, "alpha", "chatty", claudeProgram("idle"), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
    await addTab(core, seeded, "beta", "chatty2", claudeProgram("idle"), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
    await openTab(page, "chatty");
    await page.getByTestId("view-terminal").click();
    await page.goto(`/s/${IDS.beta}`);
    await page.getByRole("tab", { name: "chatty2", exact: true }).click();
    await expect(page.getByTestId("terminal-view")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("terminal-view")).toBeVisible();
    await page.getByTestId("view-chat").click();
    await page.goto(`/s/${IDS.alpha}`);
    await page.getByRole("tab", { name: "chatty", exact: true }).click();
    await expect(page.getByTestId("chat-view")).toBeVisible();
  });

  test("a Claude tab can switch to its raw terminal and back; a terminal tab has no chat", async ({ page }) => {
    const core = qaCore();
    writeTranscript(core, CWD, SESSION, canned.slice(0, 2));
    await addTab(core, seeded, "alpha", "chatty", claudeProgram("idle"), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
    await openTab(page, "chatty");
    await expect(page.getByTestId("chat-view")).toBeVisible();
    await expect(page.getByTestId("terminal-view")).toHaveCount(0);
    await page.getByTestId("view-terminal").click();
    await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live");
    await expect(page.getByTestId("chat-view")).toHaveCount(0);
    await page.getByTestId("view-chat").click();
    await expect(page.getByTestId("chat-view")).toHaveAttribute("data-state", "live");
    // A plain shell tab is the terminal, with no switch.
    await page.goto(`/s/${IDS.beta}`);
    await expect(page.getByTestId("terminal-view")).toBeVisible();
    await expect(page.getByTestId("view-chat")).toHaveCount(0);
  });

  test("a Claude pane with no session yet says so, then shows the conversation once it starts", async ({ page }) => {
    const core = qaCore();
    const address = await addTab(core, seeded, "alpha", "chatty", claudeProgram("idle"), {}, "/tmp");
    await openTab(page, "chatty");
    await expect(page.getByTestId("chat-none")).toContainText("Waiting for the session");
    writeTranscript(core, CWD, SESSION, canned.slice(0, 2));
    core.label(address, { "claude.session": SESSION, "claude.cwd": CWD });
    await expect(page.getByTestId("chat-view")).toContainText("Fix the");
  });

  test("the chat stream needs a login and a pane with an agent", async ({ request, playwright }) => {
    const base = process.env.HERDR_QA_PORT === undefined ? "" : `http://127.0.0.1:${process.env.HERDR_QA_PORT}`;
    const anon = await playwright.request.newContext({ baseURL: base, storageState: { cookies: [], origins: [] } });
    expect((await anon.get("/api/chat/t1")).status()).toBe(401);
    await anon.dispose();
    expect((await request.get(`/api/chat/${encodeURIComponent(seeded.terminals.alpha ?? "")}`)).status()).toBe(404); // a shell
    expect((await request.get("/api/chat/nope")).status()).toBe(404);
  });

  test("logging out closes the chat stream; a client that leaves early costs nothing", async () => {
    const core = qaCore();
    writeTranscript(core, CWD, SESSION, canned.slice(0, 2));
    const address = await addTab(core, seeded, "alpha", "chatty", claudeProgram("idle"), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
    const base = `http://127.0.0.1:${process.env.HERDR_QA_PORT ?? ""}`;
    const url = `${base}/api/chat/${encodeURIComponent(address)}`;
    // Many clients that abort at once, then more than the stream cap in a row: none may leak a slot.
    for (let i = 0; i < 30; i++) {
      const abort = new AbortController();
      const pending = fetch(url, { headers: authed(), signal: abort.signal }).catch(() => null);
      abort.abort();
      await pending;
    }
    const token = await login(base);
    const res = await fetch(url, { headers: authed({}, token) });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain("retry");
    const out = await fetch(`${base}/api/logout`, { method: "POST", headers: authed({ origin: base }, token) });
    expect(out.status).toBe(204);
    const ended = (async () => {
      while (reader !== undefined && !(await reader.read()).done);
      return true;
    })();
    expect(await ended).toBe(true);
  });

  test("a real short Claude session (cheap model) shows up in the chat", async ({ page }) => {
    test.setTimeout(150_000);
    const core = qaCore();
    const cwd = core.env.CLAUDE_CONFIG_DIR.replace(/claude$/u, "work");
    if (!prepareRealClaude(core, cwd)) test.skip(true, "no Claude sign-in on this machine");
    const word = `pong${String(Date.now() % 100000)}`;
    // (env: tests may themselves run inside a Claude session, whose marker would stop transcripts being saved.)
    // Claude Code's own SessionStart hook (in the QA config folder) labels the terminal with its session.
    const address = await addTab(core, seeded, "alpha", "real", ["env", "-u", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1", claudeBinary, "--model", "haiku", `Reply with exactly the single word ${word} and nothing else.`], {}, cwd);
    await openTab(page, "real");
    try {
      await expect(page.getByTestId("chat-view")).toContainText(word, { timeout: 60_000 });
    } catch (err) {
      // What Claude's own screen and labels show says why (a dialog, a sign-in problem, no hook).
      const info = (await core.call("terminal.get", { terminal: address })) as { labels?: unknown };
      console.log(`real Claude screen:\n${await core.screen(address)}\nlabels: ${JSON.stringify(info.labels)}`);
      throw err;
    }
    await expect(page.getByTestId("chat-message").first()).toHaveAttribute("data-role", "user");
    await expect(page.getByTestId("chat-message").last()).toHaveAttribute("data-role", "assistant");
  });
});
