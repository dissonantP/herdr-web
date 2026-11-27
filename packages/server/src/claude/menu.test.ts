import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MenuChoice } from "../chat.ts";
import { claudeAnswerSteps, readClaudeDraft, readClaudeMenu, type ClaudeMenu } from "./menu.ts";

// Fixture tests for every menu type (F18; F4's "needs input"). `live/` are screens of Claude Code
// 2.1.325 read with herdr-core's terminal.read in the isolated core; `collie/` are AltanS/collie's
// fixtures (web/src/fixtures/panes, commit 62e638c, MIT) with their colours stripped, which is what
// terminal.read gives. A Claude UI change that breaks the grammar shows up here.

const dir = new URL("../../tests/fixtures/claude/screens/", import.meta.url).pathname;
const screen = (name: string) => readFileSync(`${dir}${name}.txt`, "utf8");
const read = (name: string): ClaudeMenu => {
  const m = readClaudeMenu(screen(name));
  if (m === null) throw new Error(`no menu in ${name}`);
  return m;
};
const labels = (m: ClaudeMenu) => m.menu.options.map((o) => o.label);
const steps = (m: ClaudeMenu, answer: MenuChoice) => claudeAnswerSteps(m, { ...answer, id: m.menu.id });
const keysOf = (result: ReturnType<typeof claudeAnswerSteps>) => ("refused" in result ? result : result.map((s) => (s.kind === "keys" ? s.keys.join(" ") : s.kind === "until" ? "until" : `${s.kind}:${s.text}`)));

describe("permission prompts", () => {
  it.each(["live/permission-bash", "collie/claude--permission-bash", "collie/claude-lab--permission-bash-v2291--w82", "collie/claude-lab--permission-dangerous-rm--w82"])("%s: a Bash prompt", (name) => {
    const m = read(name);
    expect(m.menu).toMatchObject({ kind: "permission", multi: false, title: "Do you want to proceed?", other: { mode: "message", value: "" }, submit: null, steps: [] });
    expect(labels(m)[0]).toBe("Yes");
    expect(labels(m).at(-1)).toBe("No");
    expect(m.menu.detail).toMatch(/Bash command/u);
  });
  it("shows the command it asks about", () => {
    expect(read("live/permission-bash").menu.detail).toContain("mkdir newdir");
  });
  it("reads an edit prompt, a narrow one and one with no footer at all (WebFetch)", () => {
    const edit = read("collie/claude--permission-edit");
    expect(edit.menu).toMatchObject({ kind: "permission", title: "Do you want to create hello.txt?" });
    expect(edit.menu.detail).toContain("hello.txt");
    expect(read("collie/claude-lab--permission-write--w40").menu.title).toBe("Do you want to create lab-notes.md?");
    const fetch = read("collie/claude-lab--permission-webfetch--w82");
    expect(fetch.menu.kind).toBe("permission");
    expect(labels(fetch)).toEqual(["Yes", "Yes, and don't ask again for example.com", "No, and tell Claude what to do differently (esc)"]);
  });
  it("reads the amend state (Tab) too", () => {
    expect(labels(read("collie/claude--v2283-permission-amend-focused"))[0]).toBe("Yes, and tell Claude what to do next");
  });
  it("answers with the option's digit; Other declines (Esc), waits for the prompt to close, then sends a message", () => {
    const m = read("live/permission-bash");
    expect(keysOf(steps(m, { action: "pick", n: 1 }))).toEqual(["1"]);
    expect(keysOf(steps(m, { action: "pick", n: 4 }))).toEqual(["4"]);
    expect(keysOf(steps(m, { action: "other", text: "use mkdir -p" }))).toEqual(["esc", "until", "send:use mkdir -p"]);
    const result = steps(m, { action: "other", text: "x" });
    const until = "refused" in result ? undefined : result.find((s) => s.kind === "until");
    expect(until?.kind === "until" && until.test(screen("collie/claude--done"))).toBe(true);
    expect(until?.kind === "until" && until.test(screen("live/permission-bash"))).toBe(false);
    expect(steps(m, { action: "pick", n: 9 })).toHaveProperty("refused");
    expect(steps(m, { action: "toggle", n: 1 })).toHaveProperty("refused");
    expect(steps(m, { action: "other", text: "  " })).toHaveProperty("refused");
  });
});

describe("questions (AskUserQuestion)", () => {
  it.each(["live/ask-single", "collie/claude-lab--ask-single-v2296--w82", "collie/claude-lab--ask-single-v2296--w40"])("%s: one question, its options, the field and Chat about this", (name) => {
    const m = read(name);
    expect(m.menu).toMatchObject({ kind: "question", multi: false, other: { mode: "field", value: "" }, steps: [], submit: null });
    expect(m.menu.title).toMatch(/colour\?$/u);
    expect(labels(m)).toEqual(["Red", "Blue", "Chat about this"]);
    expect(m.field).toBe(3);
  });
  it("keeps option descriptions and a two-row question", () => {
    expect(read("live/ask-single").menu.options[0]).toMatchObject({ label: "Red", detail: "Pick red." });
    expect(read("collie/claude--v2283-ask-two-line-question").menu.title).toBe("Which fruit do you want? Pick the one you like best.");
    expect(labels(read("collie/claude--select-menu"))).toEqual(["Red", "Green", "Blue", "Chat about this"]);
  });
  it("answers with the digit; Other focuses the empty field with its digit, waits for focus, then types and Enters", () => {
    const m = read("live/ask-single");
    expect(keysOf(steps(m, { action: "pick", n: 2 }))).toEqual(["2"]);
    expect(keysOf(steps(m, { action: "other", text: "Teal\nlike the sea" }))).toEqual(["3", "until", "send:Teal like the sea"]);
    // The field itself is never a pick: its digit answers with whatever it holds.
    expect(steps(m, { action: "pick", n: 3 })).toHaveProperty("refused");
    const result = steps(m, { action: "other", text: "x" });
    const until = "refused" in result ? undefined : result.find((s) => s.kind === "until");
    expect(until?.kind === "until" && until.test(screen("live/ask-single-field-focused"))).toBe(true);
    expect(until?.kind === "until" && until.test(screen("live/ask-single"))).toBe(false);
  });
  it("a focused empty field skips the digit; a field holding desk text is never touched", () => {
    const focused = read("live/ask-single-field-focused");
    expect(focused).toMatchObject({ pointer: 3, fieldFocused: true });
    expect(keysOf(steps(focused, { action: "other", text: "Teal" }))).toEqual(["until", "send:Teal"]);
    const typed = read("collie/claude--v2299-ask-field-single-focused-typed");
    expect(typed.menu.other).toEqual({ mode: "field", value: "Teal, like the sea" });
    expect(steps(typed, { action: "other", text: "Navy" })).toHaveProperty("refused");
    expect(read("collie/claude--v2299-ask-field-single-focused-empty").menu.other).toEqual({ mode: "field", value: "" });
  });
});

describe("multiple choice", () => {
  it.each(["live/ask-multi", "collie/claude-lab--ask-multi-v2296--w82", "collie/claude--select-multiselect-single"])("%s: ticks, the field and Submit", (name) => {
    const m = read(name);
    expect(m.menu).toMatchObject({ kind: "question", multi: true, submit: "Submit", other: { mode: "field", value: "" } });
    expect(m.menu.options.filter((o) => o.checked !== null).every((o) => o.checked === false)).toBe(true);
    expect(labels(m).at(-1)).toBe("Chat about this");
  });
  it("reads what is ticked", () => {
    const m = read("live/ask-multi-ticked");
    expect(m.menu.options.map((o) => o.checked)).toEqual([true, false, true, null]);
    expect(read("collie/claude--select-multiselect-checked").menu.options.map((o) => o.checked)).toEqual([false, true, true, false, null]);
  });
  it("toggles with the digit while the pointer rests on an option; walks there from the field or Submit", () => {
    const m = read("live/ask-multi");
    expect(keysOf(steps(m, { action: "toggle", n: 2 }))).toEqual(["2"]);
    expect(keysOf(steps(m, { action: "submit" }))).toEqual(["down down down down enter"]);
    expect(steps(m, { action: "pick", n: 1 })).toHaveProperty("refused");
    const inField = read("live/ask-multi-field-typed");
    expect(inField).toMatchObject({ pointer: 4, fieldFocused: true });
    expect(keysOf(steps(inField, { action: "toggle", n: 1 }))).toEqual(["up up up 1"]);
    expect(keysOf(steps(inField, { action: "submit" }))).toEqual(["down enter"]);
  });
  it("Other walks onto the field (its digit would only tick it), waits for focus and types without Enter", () => {
    const m = read("live/ask-multi");
    expect(keysOf(steps(m, { action: "other", text: "Mango" }))).toEqual(["down down down", "until", "type:Mango"]);
    expect(read("live/ask-multi-field-typed").menu.other).toEqual({ mode: "field", value: "mango" });
    expect(steps(read("live/ask-multi-field-typed"), { action: "other", text: "Kiwi" })).toHaveProperty("refused");
  });
});

describe("scrolled multiple choice", () => {
  // Capture of a real session: option 5 (the answer field) is scrolled off, "↓ 4." marks it.
  it("reads the visible options and keeps the real numbers", () => {
    const m = read("live/ask-multi-scrolled");
    expect(m.menu).toMatchObject({ kind: "question", multi: true, submit: "Submit" });
    expect(m.menu.title).toContain("Which accounts should");
    expect(m.menu.options.map((o) => o.n)).toEqual([1, 2, 3, 4, 6]);
    expect(m.field).toBe(5);
  });
  it("toggles by digit and walks over the hidden row to Submit", () => {
    const m = read("live/ask-multi-scrolled");
    expect(keysOf(steps(m, { action: "toggle", n: 4 }))).toEqual(["4"]);
    expect(keysOf(steps(m, { action: "submit" }))).toEqual(["down down down down down enter"]);
  });
});

describe("scrolled down past the first options", () => {
  const down = screen("live/ask-multi-scrolled").replace(/^❯ 1\. \[ \] Checking accounts\n.*\n {2}2\..*\n.*\n/mu, "").replace("  3. [ ]", "↑ 3. [ ]");
  it("starts at the first visible row; a pointer on a hidden row refuses to walk", () => {
    const m = readClaudeMenu(down);
    expect(m?.menu.options.map((o) => o.n)).toEqual([3, 4, 6]);
    expect(m?.pointer).toBeNull();
    expect(m === null ? null : steps(m, { action: "submit" })).toHaveProperty("refused");
  });
});

describe("multi-step questions", () => {
  it("shows the steps and the current question", () => {
    const q1 = read("live/ask-wizard-q1");
    expect(q1.menu).toMatchObject({ kind: "question", title: "Pick a colour?", steps: [{ label: "Colour", answered: false }, { label: "Size", answered: false }] });
    const q2 = read("live/ask-wizard-q2");
    expect(q2.menu).toMatchObject({ title: "Pick a size?", steps: [{ label: "Colour", answered: true }, { label: "Size", answered: false }] });
    expect(labels(q2)).toEqual(["Small", "Large", "Chat about this"]);
    expect(read("collie/claude--select-multi").menu.steps.map((s) => s.label)).toEqual(["Focus area", "Scope", "Workflow"]);
    expect(read("collie/claude-lab--ask-wizard-v2296--w82").menu.steps).toHaveLength(2);
  });
  it("answers a step like a single question (the digit answers and advances)", () => {
    expect(keysOf(steps(read("live/ask-wizard-q2"), { action: "other", text: "Huge" }))).toEqual(["3", "until", "send:Huge"]);
    expect(keysOf(steps(read("live/ask-wizard-q1"), { action: "pick", n: 2 }))).toEqual(["2"]);
  });
  it("a revisited step whose field holds a typed answer refuses Other", () => {
    const m = read("collie/claude--v2299-ask-field-wizard-revisit-typed");
    expect(m.menu.other).toEqual({ mode: "field", value: "Mango" });
    expect(steps(m, { action: "other", text: "Kiwi" })).toHaveProperty("refused");
  });
  it.each(["live/ask-wizard-review", "live/ask-multi-review", "collie/claude--select-multiselect-review", "collie/claude-lab--ask-wizard-review-v2296--w82"])("%s: the review step submits or cancels", (name) => {
    const m = read(name);
    expect(m.menu).toMatchObject({ kind: "review", title: "Ready to submit your answers?", other: null });
    expect(labels(m)).toEqual(["Submit answers", "Cancel"]);
    expect(keysOf(steps(m, { action: "pick", n: 1 }))).toEqual(["1"]);
    expect(steps(m, { action: "other", text: "x" })).toHaveProperty("refused");
  });
  it("the review lists the answers", () => {
    expect(read("live/ask-wizard-review").menu.detail).toMatch(/Pick a colour\?\s+→ Blue[\s\S]*Pick a size\?\s+→ Huge/u);
  });
});

describe("plan approval", () => {
  it.each(["live/plan", "collie/claude--plan-approval--three-row", "collie/claude-lab--plan-approval-v2291--w82", "collie/claude-lab--plan-approval--w40"])("%s: the plan, its options and the feedback field", (name) => {
    const m = read(name);
    expect(m.menu).toMatchObject({ kind: "plan", multi: false, other: { mode: "field", value: "" } });
    expect(m.menu.title).toMatch(/Would you like to proceed\?$/u);
    expect(labels(m)).toEqual(["Yes, and use auto mode", "Yes, manually approve edits"]);
    expect(m.menu.detail).toMatch(/^Here is Claude's plan:/u);
  });
  it("shows the plan's own text", () => {
    expect(read("live/plan").menu.detail).toContain('Create notes.txt in the working directory with the content "hi".');
  });
  it("an older four-row dialog and feedback typed at the desk", () => {
    expect(labels(read("collie/claude--plan-approval"))).toHaveLength(3);
    const typed = read("collie/claude--plan-approval--feedback-typed");
    expect(typed.menu.other).toEqual({ mode: "field", value: "use a guard clause instead" });
    expect(steps(typed, { action: "other", text: "x" })).toHaveProperty("refused");
  });
  it("approves with the digit; Other focuses the feedback row with its digit, then types and Enters", () => {
    const m = read("live/plan");
    expect(keysOf(steps(m, { action: "pick", n: 2 }))).toEqual(["2"]);
    expect(keysOf(steps(m, { action: "other", text: "use hello" }))).toEqual(["3", "until", "send:use hello"]);
    expect(read("live/plan-field-focused")).toMatchObject({ pointer: 3, fieldFocused: true });
  });
});

describe("folder trust", () => {
  it("is a menu with no typed answer", () => {
    const m = read("collie/claude--trust-prompt");
    expect(m.menu).toMatchObject({ kind: "trust", other: null });
    expect(m.menu.title).toMatch(/one you trust\?/u);
    expect(labels(m)).toEqual(["Yes, I trust this folder", "No, exit"]);
  });
});

describe("no menu", () => {
  it.each([
    "collie/claude--done",
    "collie/claude--fresh-idle",
    "collie/claude-lab--working-spinner--w82",
    "collie/claude-lab--idle-after-turn--w82",
    "collie/claude-lab--draft-adversarial--w82",
    "collie/claude-lab--popup-slash-all--w82",
    // Claude echoing "1. Yes / 2. No / Enter to select" in its answer is not a menu.
    "collie/claude-lab--transcript-dialog-lookalike--w82",
  ])("%s", (name) => {
    expect(readClaudeMenu(screen(name))).toBeNull();
  });
  it("a menu that scrolled up under later output is not waiting", () => {
    expect(readClaudeMenu(`${screen("live/ask-single")}\n● Pear, got it.\n\n❯ \n`)).toBeNull();
  });
  it("every fixture reads without throwing", () => {
    for (const sub of ["live", "collie"]) for (const f of readdirSync(`${dir}${sub}`)) readClaudeMenu(readFileSync(`${dir}${sub}/${f}`, "utf8"));
  });
});

describe("a session-name rule under the menu (claude -n <name>)", () => {
  const named = (name: string) => `${screen(name).trimEnd()}\n${"─".repeat(45)} autodev ─\n`;
  it("the live review step still reads as a review", () => {
    const m = read("review-under-session-name-rule");
    expect(m.menu).toMatchObject({ kind: "review", title: "Ready to submit your answers?" });
    expect(labels(m)).toEqual(["Submit answers", "Cancel"]);
    expect(keysOf(steps(m, { action: "pick", n: 1 }))).toEqual(["1"]);
  });
  it.each(["live/ask-single", "live/ask-multi", "live/ask-wizard-q2", "live/ask-wizard-review", "live/plan", "live/permission-bash", "collie/claude-lab--permission-webfetch--w82", "collie/claude--select-multiselect-review"])(
    "%s reads the same with the rule under it",
    (name) => {
      const under = readClaudeMenu(`${named(name)}\n\n`);
      expect(under?.family).toBe(read(name).family);
      expect(under?.menu.options).toEqual(read(name).menu.options);
    },
  );
  it("a plain rule under a menu, or output under an old menu, still counts as no menu", () => {
    expect(readClaudeMenu(`${screen("live/ask-wizard-review").trimEnd()}\n${"─".repeat(45)}\n`)).toBeNull();
    expect(readClaudeMenu(`${named("live/ask-single")}\n● Pear, got it.\n\n❯ \n`)).toBeNull();
  });
});

describe("menu ids", () => {
  it("stay put when only the pointer moves, change with the question", () => {
    const a = read("live/ask-single").menu.id;
    expect(readClaudeMenu(screen("live/ask-single").replace("❯ 1. Red", "  1. Red").replace("  2. Blue", "❯ 2. Blue"))?.menu.id).toBe(a);
    expect(read("live/ask-wizard-q2").menu.id).not.toBe(read("live/ask-wizard-q1").menu.id);
  });
});

describe("the prompt box (a draft typed at the desk)", () => {
  it("is empty on an idle screen, also showing the fresh-session hint", () => {
    expect(readClaudeDraft(screen("collie/claude--fresh-idle"))).toBe("");
    expect(readClaudeDraft(screen("collie/claude-lab--idle-fresh--w82"))).toBe("");
  });
  it("reads typed text, wrapped onto several rows too", () => {
    expect(readClaudeDraft(screen("collie/claude--v2283-draft-prompt"))).toBe("my shell said:\n❯ ls -la\nand then nothing");
    expect(readClaudeDraft(screen("collie/claude--draft-footer-wrapped"))).toMatch(/^this stranded draft[\s\S]*footer sits below the box$/u);
    expect(readClaudeDraft(screen("collie/claude-lab--draft-adversarial--w82"))).toMatch(/^compare these two lines:/u);
  });
  it("reads a suggestion Claude shows after a turn as a draft too (a plain read can't tell them apart)", () => {
    expect(readClaudeDraft(screen("collie/claude-lab--idle-after-turn--w82"))).toMatch(/^Nothing obvious follows/u);
  });
  it("is not there while a menu replaces it", () => {
    expect(readClaudeDraft(screen("live/permission-bash"))).toBeNull();
  });
});
