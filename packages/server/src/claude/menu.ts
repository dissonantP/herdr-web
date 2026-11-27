import { createHash } from "node:crypto";
import type { ChatMenu, MenuAnswer, MenuOption, MenuStep } from "../chat.ts";
import type { InputStep } from "../adapters/chat.ts";

// Claude Code's on-screen menus (permission prompts, AskUserQuestion single, multiple-choice and
// multi-step, plan approval, folder trust), read from the plain screen text herdr-core's
// `terminal.read` gives, and the keystrokes that answer them.
//
// A plain-text port of the grammar in AltanS/collie (MIT, Copyright (c) 2026 Altan Sarisin; notice in
// third_party/collie-LICENSE) at commit 62e638c59770bb1ec58412732f59c102a717ede2:
// web/src/lib/harness/claude/{markers,prompt-select,wizard,multi-select}.ts, and the keystroke facts in
// web/src/lib/grammar/{ASK_FIELD_NOTES,WIZARD_NOTES,PLAN_FEEDBACK_NOTES}.md and ADR 0113 ("an
// AskUserQuestion answer is typed into its field"). Collie reads styled cells; this reads plain rows,
// so what needed styling (the wizard's current step) is left out. Kept from Collie:
//   - The tail anchor: a menu counts only when its footer is the screen's last non-blank row (a menu
//     that scrolled up under real output is not one), and a footer phrase alone proves nothing for
//     the plan, trust and footerless permission families: the dialog's own words must be there too.
//   - The numbered rows run 1, 2, 3 ... down to the footer with only descriptions, rules and a
//     multiple-choice submit row between them.
//   - One keystroke per tap, against a fresh read (WIZARD_NOTES "incremental"); an answer names the
//     menu it was meant for and is refused when the screen shows another.
//   - The answer field ("Type something.", the plan's "Tell Claude what to change"): its digit is
//     pressed only while it is empty (a filled field's digit submits its text), typing waits for a
//     read showing it focused, and a field holding text typed at the desk is never overwritten.
// Fixtures: tests/fixtures/claude/screens/ (Collie's, converted to plain text, and live captures).

const RULE_GLYPHS = "─━═▔▁╌┄┈";
const SOLID_RULE = /^\s*[─━═▔▁]{8,}\s*$/u;
const ANY_RULE = new RegExp(`^\\s*[${RULE_GLYPHS}]{8,}\\s*$`, "u");
/** The rule a session started with `-n <name>` draws under everything (`──── autodev ─`). */
const NAMED_RULE = /^\s*[─━]{3,}\s+[^─━\s].*?\s+[─━]+\s*$/u;
const OPTION = /^(\s*)(❯\s*|[↑↓]\s*)?(\d{1,2})\.\s+(.*?)\s*$/u;
const CHECKBOX = /^\[([ ✔✓xX])\]\s*(.*)$/u;
const SUBMIT_ROW = /^\s*(❯\s*)?(Submit|Next)\s*$/u;
const STEPPER = /^\s*←\s+(.*?)\s+→\s*$/u;
const LONE_CHIP = /^\s*[☐☒☑]\s+\S.*$/u;
const CHIP = /([☐☒☑✔])\s+(.+?)(?=\s{2,}[☐☒☑✔]|\s*$)/gu;
const GUTTER = /^\s*│\s?/u;
const FIELD_PLACEHOLDER = /^Type something\.?$/u;
const PLAN_FIELD_PLACEHOLDER = /^Tell Claude what to change\b/u;
const CHAT_ESCAPE = /^Chat about this$/u;
const PERMISSION_QUESTION = /^\s*Do you want to\b/u;
const PLAN_WORDS = /Would you like to proceed\?|ready to execute|Here is Claude's plan/u;
const TRUST_WORDS = /is this a project you created or one you trust|Yes,\s*I trust this folder/iu;

/** How far above the footer a menu's first option may sit (a long answer wraps the field). */
const OPTION_SCAN_ROWS = 80;
const DETAIL_MAX_ROWS = 60;
const DETAIL_MAX_CHARS = 6000;

type Family = "select" | "permission" | "plan" | "trust" | "review";

interface Item {
  readonly n: number;
  readonly row: number;
  readonly label: string;
  readonly detail: string[];
  readonly checked: boolean | null;
  readonly pointed: boolean;
}

/** A menu as Claude draws it, with what answering it needs (the pointer, the field). */
export interface ClaudeMenu {
  readonly family: Family;
  readonly menu: ChatMenu;
  readonly items: readonly Item[];
  /** The answer field's number, or `null`. */
  readonly field: number | null;
  /** Where the pointer is: an item's number, `"submit"`, or `null` when no row shows it. */
  readonly pointer: number | "submit" | null;
  /** The footer shows the focused field's editor hint (or the pointer sits on the field). */
  readonly fieldFocused: boolean;
}

const isBlank = (s: string) => s.trim() === "";

function footerOf(rows: readonly string[], end: number): { family: Family; start: number } | null {
  const last = rows[end] ?? "";
  const tail = (k: number) => rows.slice(Math.max(0, end - k + 1), end + 1).map((r) => r.trim()).join(" ");
  // AskUserQuestion: "Enter to select ..." on one row, or wrapped onto two or three by a narrow pane.
  for (let k = 1; k <= 3; k++) {
    if (/\benter to select\b/iu.test(tail(k)) && (k === 1 || !/\benter to select\b/iu.test(tail(k - 1)))) {
      const start = end - k + 1;
      if (k > 1 && rows.slice(start, end + 1).some((r) => isBlank(r) || OPTION.test(r))) return null;
      return { family: "select", start };
    }
  }
  // The multi-step review: no footer, its last rows are "1. Submit answers" over "2. Cancel".
  if (/^\s*(❯\s*)?2\.\s+Cancel\s*$/u.test(last) && rows.slice(Math.max(0, end - 3), end).some((r) => /^\s*(❯\s*)?1\.\s+Submit answers\s*$/u.test(r))) {
    return { family: "review", start: end + 1 };
  }
  const screen = rows.slice(Math.max(0, end - OPTION_SCAN_ROWS), end + 1);
  // Plan approval: "ctrl+g to edit in <editor> · <plan file>" (the path may wrap below), with the dialog's words.
  for (let i = end; i >= Math.max(0, end - 2); i--) {
    const row = rows[i] ?? "";
    if ((/ctrl\+g to edit\b/iu.test(row) || /\/plans\/[\w.-]+\.md\b/u.test(row)) && screen.some((r) => PLAN_WORDS.test(r))) {
      let start = i;
      while (start > end - 2 && /\/plans\//u.test(rows[start] ?? "") && /ctrl\+g to edit\b/iu.test(rows[start - 1] ?? "")) start--;
      if (/ctrl\+g to edit\b/iu.test(rows[start - 1] ?? "")) start--;
      return { family: "plan", start };
    }
  }
  if (/\benter to confirm\b/iu.test(tail(2)) && screen.some((r) => TRUST_WORDS.test(r))) {
    return { family: "trust", start: /\benter to confirm\b/iu.test(last) ? end : end - 1 };
  }
  const permission = screen.some((r) => PERMISSION_QUESTION.test(r));
  if (/\btab to amend\b/iu.test(last)) return { family: "permission", start: end };
  if (/^\s*esc to cancel\s*$/iu.test(last) && permission) return { family: "permission", start: end };
  // A permission dialog with no footer at all (WebFetch): its last row is the "N. No ..." option.
  if (permission && /^\s*(❯\s*)?[2-9]\.\s+No\b/u.test(last)) return { family: "permission", start: end + 1 };
  return null;
}

/** The numbered rows from `first` to the footer, or null when anything else sits among them. */
function readItems(rows: readonly string[], first: number, footer: number): { items: Item[]; submitRow: number; pointerOnSubmit: boolean; ruleBefore: Set<number> } | null {
  const items: { n: number; row: number; label: string; detail: string[]; checked: boolean | null; pointed: boolean; indent: number }[] = [];
  let submitRow = -1;
  let pointerOnSubmit = false;
  let scrolled = false;
  let sawRule = false;
  const ruleBefore = new Set<number>();
  for (let i = first; i < footer; i++) {
    const row = rows[i] ?? "";
    if (isBlank(row)) continue;
    if (ANY_RULE.test(row)) {
      sawRule = true;
      continue;
    }
    const m = OPTION.exec(row);
    const num = m === null ? 0 : Number(m[3]);
    const marker = m?.[2]?.[0];
    if (marker === "↑" || marker === "↓") scrolled = true;
    // Rows scrolled out of the list leave a gap in the numbers (a "↓" or "↑" marker shows it).
    const expected = (items.at(-1)?.n ?? 0) + 1;
    if (m !== null && (num === expected || (scrolled && num > expected) || (items.length === 0 && marker === "↑"))) {
      let label = m[4] ?? "";
      let checked: boolean | null = null;
      const box = CHECKBOX.exec(label);
      if (box !== null) {
        checked = box[1] !== " ";
        label = box[2] ?? "";
      }
      // A revisited step marks the answer it holds with a trailing tick.
      label = label.replace(/\s+✔$/u, "").trim();
      if (sawRule) ruleBefore.add(num);
      sawRule = false;
      // The column the number starts in: a description row is indented at least that far.
      items.push({ n: num, row: i, label, detail: [], checked, pointed: m[2]?.startsWith("❯") === true, indent: (m[1] ?? "").length + (m[2] ?? "").length });
      continue;
    }
    const sub = SUBMIT_ROW.exec(row);
    if (sub !== null && items.some((it) => it.checked !== null) && submitRow < 0) {
      submitRow = i;
      pointerOnSubmit = sub[1] !== undefined;
      continue;
    }
    const prev = items.at(-1);
    const indent = row.length - row.trimStart().length;
    if (prev !== undefined && submitRow < 0 && indent > 0 && indent >= prev.indent) {
      prev.detail.push(row.trim());
      continue;
    }
    return null;
  }
  if (items.length < 2) return null;
  return { items, submitRow, pointerOnSubmit, ruleBefore };
}

function stepsOf(rows: readonly string[]): MenuStep[] {
  for (const row of rows) {
    const m = STEPPER.exec(row);
    if (m === null) continue;
    const steps: MenuStep[] = [];
    for (const chip of (m[1] ?? "").matchAll(CHIP)) {
      if (chip[1] === "✔") continue; // the Submit chip
      steps.push({ label: (chip[2] ?? "").trim(), answered: chip[1] !== "☐" });
    }
    return steps.length >= 2 ? steps : [];
  }
  return [];
}

function dedent(lines: readonly string[]): string {
  const indents = lines.filter((l) => !isBlank(l)).map((l) => l.length - l.trimStart().length);
  const cut = indents.length === 0 ? 0 : Math.min(...indents);
  let text = lines.map((l) => l.slice(cut).trimEnd()).join("\n").replace(/^\n+|\n+$/gu, "");
  if (text.length > DETAIL_MAX_CHARS) text = `${text.slice(0, DETAIL_MAX_CHARS)}…`;
  return text;
}

/** The question and what it is about: the rows between the dialog's top and its first option. */
function titleAndDetail(rows: readonly string[], first: number, family: Family): { title: string; detail: string; top: number } {
  let top = -1;
  for (let i = first - 1; i >= Math.max(0, first - 400); i--) {
    const row = rows[i] ?? "";
    if (family === "plan" && /Ready to code\?/u.test(row)) {
      top = i;
      break;
    }
    if (family !== "plan" && SOLID_RULE.test(row)) {
      top = i;
      break;
    }
  }
  if (top < 0) top = Math.max(-1, first - 30);
  const body = rows.slice(top + 1, first).filter((r) => !ANY_RULE.test(r) && !STEPPER.test(r) && !LONE_CHIP.test(r)).map((r) => r.replace(GUTTER, (g) => " ".repeat(g.length)));
  // The question: the last paragraph above the options (a permission dialog's from its "Do you want").
  let end = body.length;
  while (end > 0 && isBlank(body[end - 1] ?? "")) end--;
  let start = end;
  while (start > 0 && !isBlank(body[start - 1] ?? "")) start--;
  if (family === "permission") {
    for (let i = end - 1; i >= start; i--) {
      if (PERMISSION_QUESTION.test(body[i] ?? "")) {
        start = i;
        break;
      }
    }
  }
  if (family === "trust") {
    const at = body.findIndex((r) => TRUST_WORDS.test(r));
    if (at >= 0) {
      start = at;
      end = at + 1;
    }
  }
  const title = body.slice(start, end).map((r) => r.trim()).join(" ");
  // Blank runs fold to one row; a long plan keeps its start, anything else the rows nearest the question.
  const detailRows = [...body.slice(0, start), ...(family === "trust" ? body.slice(end) : [])].filter((r, i, all) => !isBlank(r) || (i > 0 && !isBlank(all[i - 1] ?? "")));
  const kept = family === "plan" ? detailRows.slice(0, DETAIL_MAX_ROWS) : detailRows.slice(-DETAIL_MAX_ROWS);
  return { title, detail: dedent(kept), top };
}

/** Claude's menu on this screen, or null when none is waiting. */
export function readClaudeMenu(screen: string): ClaudeMenu | null {
  const rows = screen.replace(/\r/gu, "").split("\n").map((r) => r.trimEnd());
  let end = rows.length - 1;
  while (end >= 0 && isBlank(rows[end] ?? "")) end--;
  if (end < 0) return null;
  // A named session's rule sits below the menu's footer: it is not output, so look past it.
  if (NAMED_RULE.test(rows[end] ?? "")) {
    end--;
    while (end >= 0 && isBlank(rows[end] ?? "")) end--;
    if (end < 0) return null;
  }
  const footer = footerOf(rows, end);
  if (footer === null) return null;
  const { family } = footer;
  let parsed: ReturnType<typeof readItems> = null;
  let first = -1;
  for (let i = footer.start - 1; i >= Math.max(0, footer.start - OPTION_SCAN_ROWS) && parsed === null; i--) {
    const m = OPTION.exec(rows[i] ?? "");
    if (m === null || (m[3] !== "1" && !m[2]?.startsWith("↑"))) continue;
    parsed = readItems(rows, i, footer.start);
    first = i;
  }
  if (parsed === null) return null;
  const { items, submitRow, pointerOnSubmit, ruleBefore } = parsed;
  const multi = items.some((it) => it.checked !== null);

  // The answer field: an AskUserQuestion's row just above its "Chat about this" (a rule between), or
  // its placeholder; the plan dialog's last row ("Tell Claude what to change").
  let field: number | null = null;
  if (family === "select") {
    const chat = items.find((it) => CHAT_ESCAPE.test(it.label));
    if (chat !== undefined && ruleBefore.has(chat.n) && chat.n > 1) field = chat.n - 1;
    else field = items.find((it) => FIELD_PLACEHOLDER.test(it.label))?.n ?? null;
  } else if (family === "plan") {
    const last = items.at(-1);
    if (last !== undefined && (PLAN_FIELD_PLACEHOLDER.test(last.label) || last.detail.some((d) => /to approve with this feedback/u.test(d)))) field = last.n;
  }
  const fieldItem = field === null ? undefined : items.find((it) => it.n === field);
  const placeholder = family === "plan" ? PLAN_FIELD_PLACEHOLDER : FIELD_PLACEHOLDER;
  const fieldValue = fieldItem === undefined || placeholder.test(fieldItem.label) ? "" : fieldItem.label;
  const pointed = items.find((it) => it.pointed);
  const pointer = pointerOnSubmit ? "submit" : (pointed?.n ?? null);
  const footerText = rows.slice(footer.start, end + 1).join(" ");
  const fieldFocused = field !== null && pointer === field && (family === "plan" || /ctrl\+g to edit\b/iu.test(footerText));

  const { title, detail, top } = titleAndDetail(rows, first, family);
  const options: MenuOption[] = items
    .filter((it) => it.n !== field)
    .map((it) => ({ n: it.n, label: it.label, detail: family === "plan" ? "" : it.detail.join(" "), checked: it.checked }));
  const kind: ChatMenu["kind"] = family === "select" ? "question" : family;
  const other: ChatMenu["other"] =
    family === "permission" ? { mode: "message", value: "" } : field !== null ? { mode: "field", value: fieldValue } : null;
  // The id: the dialog's own rows (its top rule to the footer, nothing of the transcript above it,
  // which may keep changing) with the pointer glyph blanked, so moving the pointer keeps it.
  const signed = rows.slice(Math.max(0, top), end + 1).map((r) => r.replace(/❯/gu, " ").trimEnd()).join("\n");
  const id = createHash("sha256").update(`${family}\n${signed}`).digest("hex").slice(0, 16);
  const menu: ChatMenu = {
    id,
    kind,
    multi,
    title,
    detail,
    options,
    other,
    submit: submitRow >= 0 ? (rows[submitRow] ?? "").replace(/❯/u, "").trim() : null,
    steps: family === "select" || family === "review" ? stepsOf(rows.slice(Math.max(0, first - 40), first)) : [],
  };
  return { family, menu, items, field, pointer, fieldFocused };
}

/** The keys that move the pointer from where it is to `target` (an item number or the submit row). */
function walk(m: ClaudeMenu, target: number | "submit"): string[] | null {
  // The rows the arrows visit, in order: every item up to the field (or all of them), then the
  // submit row, then whatever follows (Chat about this).
  // Numbers scrolled out of view still count as rows the arrows pass.
  const order: (number | "submit")[] = [];
  const lastBeforeSubmit = m.field ?? m.items.filter((it) => !CHAT_ESCAPE.test(it.label)).at(-1)?.n ?? m.items.length;
  const firstN = m.items[0]?.n ?? 1;
  const lastN = m.items.at(-1)?.n ?? 0;
  for (let n = firstN; n <= lastN; n++) {
    order.push(n);
    if (n === lastBeforeSubmit && m.menu.submit !== null) order.push("submit");
  }
  const from = m.pointer === null ? -1 : order.indexOf(m.pointer);
  const to = order.indexOf(target);
  if (from < 0 || to < 0) return null;
  return Array.from({ length: Math.abs(to - from) }, () => (to > from ? "down" : "up"));
}

const oneLine = (text: string) => text.replace(/\s*\n\s*/gu, " ").trim();

/** The steps that answer `menu` (already checked to be the one on screen) with `answer`, or why not. */
export function claudeAnswerSteps(m: ClaudeMenu, answer: MenuAnswer): readonly InputStep[] | { readonly refused: string } {
  const item = (n: number) => m.items.find((it) => it.n === n);
  const fieldEmpty = m.menu.other?.mode === "field" && m.menu.other.value === "";
  const onField = (screen: string) => {
    const now = readClaudeMenu(screen);
    return now !== null && now.field !== null && now.pointer === now.field && now.fieldFocused;
  };
  switch (answer.action) {
    case "pick": {
      if (m.menu.multi) return { refused: "Tick the options, then submit." };
      if (item(answer.n) === undefined || answer.n === m.field) return { refused: "That option is not on the menu." };
      if (answer.n <= 9) return [{ kind: "keys", keys: [String(answer.n)] }];
      const keys = walk(m, answer.n);
      return keys === null ? { refused: "Can't reach that option." } : [{ kind: "keys", keys: [...keys, "enter"] }];
    }
    case "toggle": {
      const target = item(answer.n);
      // The field is ticked by typing into it (Other), never toggled from here.
      if (!m.menu.multi || target === undefined || target.checked === null || answer.n === m.field) return { refused: "That option can't be ticked." };
      // A digit toggles only while the pointer is on an option row (on the submit row it does nothing,
      // in the focused field it is typed), so walk onto the row first when needed.
      const resting = m.pointer !== null && m.pointer !== "submit" && m.pointer !== m.field;
      if (resting && answer.n <= 9) return [{ kind: "keys", keys: [String(answer.n)] }];
      const keys = walk(m, answer.n);
      if (keys === null) return { refused: "Can't reach that option." };
      return [{ kind: "keys", keys: [...keys, String(answer.n)] }];
    }
    case "submit": {
      if (!m.menu.multi || m.menu.submit === null) return { refused: "There is nothing to submit." };
      const keys = walk(m, "submit");
      return keys === null ? { refused: "Can't reach the submit row." } : [{ kind: "keys", keys: [...keys, "enter"] }];
    }
    case "other": {
      const text = answer.text.trim();
      if (text === "") return { refused: "Type an answer first." };
      if (m.menu.other === null) return { refused: "This menu takes no typed answer." };
      if (m.menu.other.mode === "message") {
        // Esc declines and asks what to do instead; the text then goes as an ordinary message.
        return [
          { kind: "keys", keys: ["esc"] },
          { kind: "until", test: (screen) => readClaudeMenu(screen) === null, timeoutMs: 4000, error: "The prompt did not close." },
          { kind: "send", text },
        ];
      }
      const field = m.field;
      if (field === null) return { refused: "This menu takes no typed answer." };
      if (!fieldEmpty) return { refused: "The answer field already holds text typed at the desk; finish it there." };
      const focus: InputStep[] = [];
      if (!m.fieldFocused) {
        // A multiple-choice field's digit only ticks it: walk onto the row instead. Elsewhere the empty
        // field's digit focuses it and answers nothing.
        const keys = m.menu.multi || field > 9 ? walk(m, field) : [String(field)];
        if (keys === null) return { refused: "Can't reach the answer field." };
        focus.push({ kind: "keys", keys });
      }
      focus.push({ kind: "until", test: onField, timeoutMs: 3000, error: "The answer field did not take focus." });
      // Multiple choice: typing fills and ticks the row; the person still submits. Elsewhere Enter answers.
      return m.menu.multi ? [...focus, { kind: "type", text: oneLine(text) }] : [...focus, { kind: "send", text: oneLine(text) }];
    }
  }
}

const PROMPT_ROW = /^❯(?:\s(.*))?$/u;
/** The box's rules; the top one may carry a session name (`──── auth-refactor ──`). */
const BOX_RULE = /^\s*[─━]{3,}(?:.*[─━]{2,})?\s*$/u;
/** Claude's own hint in an empty box on a fresh session. */
const PLACEHOLDER = /^Try ".*"$/u;
/** The most rows a draft is looked for under the prompt row. */
const DRAFT_MAX_ROWS = 40;

/**
 * What is typed in Claude's prompt box (the `❯` row between two rules, with its indented
 * continuation rows), `""` when it is empty, or `null` when no prompt box is on screen. A plain
 * read cannot tell typed text from a grey hint, so only the fresh-session hint counts as empty.
 */
export function readClaudeDraft(screen: string): string | null {
  const rows = screen.replace(/\r/gu, "").split("\n").map((r) => r.trimEnd());
  for (let i = rows.length - 1; i > 0; i--) {
    const m = PROMPT_ROW.exec(rows[i] ?? "");
    if (m === null || !BOX_RULE.test(rows[i - 1] ?? "")) continue;
    let end = i + 1;
    while (end < rows.length && end - i <= DRAFT_MAX_ROWS && !BOX_RULE.test(rows[end] ?? "")) end++;
    if (end >= rows.length || !BOX_RULE.test(rows[end] ?? "")) continue;
    const text = [m[1] ?? "", ...rows.slice(i + 1, end)].map((r) => r.trim()).join("\n").trim();
    return PLACEHOLDER.test(text) ? "" : text;
  }
  return null;
}
