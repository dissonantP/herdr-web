import type { ChatMessage, ChatPart, DiffHunk } from "../chat.ts";
import type { TranscriptParser } from "../adapters/chat.ts";

// Claude Code's transcript (`~/.claude/projects/<proj>/<session>.jsonl`) as chat messages.
//
// Borrowed from AltanS/collie `bridge/journal/claude.ts` (MIT, notice in third_party/collie-LICENSE),
// pinned at commit 62e638c59770bb1ec58412732f59c102a717ede2: how rows are classified (`classifyUserText`
// and its envelopes, pasted-content unwrapping), that a `user` row with list content is tool-result
// traffic folded into the call it answers, and that `toolUseResult.structuredPatch` is the diff Claude
// computed. Reduced to what this app shows and rewritten against this app's types. If Claude Code changes
// the format, `transcript.test.ts` and its fixtures (tests/fixtures/claude/) are what should break first.
//
// Shape (Claude Code 2.1.x): `{"type":"user"|"assistant","message":{...},"uuid","timestamp",
// "isSidechain","isMeta","toolUseResult"}`; every other row type is bookkeeping and is ignored. Claude
// writes each content block of one API message as its own `assistant` row sharing `message.id`; they
// become one chat message here, growing as rows arrive.

type Json = unknown;
type Obj = Record<string, Json>;

const MAX_RESULT_CHARS = 4000;
const MAX_INPUT_CHARS = 2000;
const MAX_TEXT_CHARS = 60_000;
const SUMMARY_CHARS = 140;

const isObj = (v: Json): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: Json): string => (typeof v === "string" ? v : "");

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${String(text.length - max)} more characters)`;
}

// eslint-disable-next-line no-control-regex -- ANSI escapes in command output
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
const stripAnsi = (s: string) => s.replace(ANSI, "");

/** Inner text of the first `<tag>…</tag>`, trimmed; `null` when absent. */
function inner(tag: string, text: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "u").exec(text);
  return m ? (m[1] ?? "").trim() : null;
}
const isEnvelope = (tag: string, text: string) => text.trimStart().startsWith(`<${tag}>`);

const PASTED = /(^|\n)<pasted_content id="([0-9a-f]+)">\n?([\s\S]*?)\n?<\/pasted_content(?:\s+id="\2")?>/gu;
function unwrapPastes(text: string): string {
  return text.includes("<pasted_content ") ? text.replace(PASTED, "$1$3").trim() : text;
}

/** A `user` row's string content: speech, a note, or `null` for plumbing addressed to the model. */
export function classifyUserText(raw: string): { role: "user" | "note"; text: string } | null {
  const text = stripAnsi(raw);
  if (isEnvelope("system-reminder", text) || isEnvelope("local-command-caveat", text)) return null;
  if (isEnvelope("command-name", text)) {
    const line = `${inner("command-name", text) ?? ""} ${inner("command-args", text) ?? ""}`.trim();
    return line === "" ? null : { role: "user", text: line };
  }
  if (isEnvelope("local-command-stdout", text)) {
    const out = inner("local-command-stdout", text) ?? "";
    return out === "" ? null : { role: "note", text: out };
  }
  if (isEnvelope("task-notification", text)) {
    const summary = inner("summary", text);
    return summary ? { role: "note", text: summary } : null;
  }
  const spoken = unwrapPastes(text);
  return spoken.trim() === "" ? null : { role: "user", text: spoken };
}

function toolResultText(content: Json): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (isObj(b) && typeof b.text === "string" ? b.text : isObj(b) && b.type === "image" ? "[image]" : ""))
    .filter((t) => t !== "")
    .join("\n");
}

/** One line saying what a tool call is about. */
export function summarizeTool(name: string, input: Obj): string {
  const pick = (...keys: string[]) => keys.map((k) => str(input[k])).find((v) => v !== "") ?? "";
  let line = pick("command", "file_path", "path", "pattern", "url", "query", "description", "prompt", "skill");
  if (line === "") line = Object.values(input).find((v): v is string => typeof v === "string" && v !== "") ?? "";
  line = line.replace(/\s+/gu, " ").trim();
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line;
}

const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function pretty(input: Obj): string {
  try {
    return clamp(JSON.stringify(input, null, 2), MAX_INPUT_CHARS);
  } catch {
    return "";
  }
}

/** The diff Claude computed (`structuredPatch`), as hunks; `[]` when there is none. */
function hunksOf(patch: Json): DiffHunk[] {
  if (!Array.isArray(patch)) return [];
  const hunks: DiffHunk[] = [];
  for (const h of patch) {
    if (!isObj(h)) continue;
    const lines = Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === "string") : [];
    if (lines.length === 0) continue;
    hunks.push({ header: `@@ -${String(h.oldStart ?? 0)},${String(h.oldLines ?? 0)} +${String(h.newStart ?? 0)},${String(h.newLines ?? 0)} @@`, lines });
  }
  return hunks;
}

/** A diff from an Edit's own input, for a call whose result carries none (e.g. one that was denied). */
function hunksFromInput(name: string, input: Obj): DiffHunk[] {
  const lines = (s: string) => (s === "" ? [] : s.split("\n"));
  if (name === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    return [{ header: "@@", lines: [...lines(input.old_string).map((l) => `-${l}`), ...lines(input.new_string).map((l) => `+${l}`)] }];
  }
  if (name === "Write" && typeof input.content === "string") {
    return [{ header: "@@ new file @@", lines: lines(input.content).slice(0, 200).map((l) => `+${l}`) }];
  }
  return [];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type ToolPart = Extract<ChatPart, { kind: "tool" }>;

interface Draft {
  id: string;
  role: ChatMessage["role"];
  at: string;
  parts: Mutable<ChatPart>[];
}

const MAX_TRACKED = 400;

export class ClaudeTranscriptParser implements TranscriptParser {
  private readonly byId = new Map<string, Draft>();
  /** Tool call id -> id of the draft holding it, so a later result row finds it (and a draft evicted from `byId` is gone for good). */
  private readonly toolOwner = new Map<string, string>();
  private anon = 0;

  feed(line: string): readonly ChatMessage[] {
    if (line.trim() === "") return [];
    let row: Json;
    try {
      row = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isObj(row)) return [];
    if (row.isSidechain === true) return []; // a subagent's own traffic
    const message = row.message;
    if (row.type === "assistant" && isObj(message)) return this.assistant(row, message);
    if (row.type === "user" && isObj(message)) return this.user(row, message);
    return [];
  }

  private draft(id: string, role: Draft["role"], at: string): Draft {
    const known = this.byId.get(id);
    if (known !== undefined) return known;
    const draft: Draft = { id, role, at, parts: [] };
    this.byId.set(id, draft);
    if (this.byId.size > MAX_TRACKED) {
      const oldest = this.byId.keys().next().value;
      if (oldest !== undefined) this.byId.delete(oldest);
    }
    return draft;
  }

  private assistant(row: Obj, message: Obj): ChatMessage[] {
    const content = message.content;
    if (!Array.isArray(content)) return [];
    const id = `a:${str(message.id) || str(row.uuid) || String(this.anon++)}`;
    const draft = this.draft(id, "assistant", str(row.timestamp));
    let changed = false;
    for (const block of content) {
      if (!isObj(block)) continue;
      if (block.type === "text") {
        const text = str(block.text);
        if (text.trim() === "") continue;
        draft.parts.push({ kind: "text", text: clamp(text, MAX_TEXT_CHARS) });
        changed = true;
      } else if (block.type === "thinking") {
        // Claude often stores thinking as an empty string with only a signature; nothing to show then.
        // With `thinkingDisplay: "updates"` a non-empty block is the reply text the terminal shows
        // (e.g. just before an AskUserQuestion), so it is speech, not folded thinking.
        const text = str(block.thinking);
        if (text.trim() === "") continue;
        draft.parts.push({ kind: row.thinkingDisplay === "updates" ? "text" : "thinking", text: clamp(text, MAX_TEXT_CHARS) });
        changed = true;
      } else if (block.type === "tool_use") {
        const name = str(block.name) || "tool";
        const input = isObj(block.input) ? block.input : {};
        const toolId = str(block.id) || `${id}:${String(draft.parts.length)}`;
        const part: Mutable<ToolPart> = { kind: "tool", id: toolId, name, summary: summarizeTool(name, input), subagent: SUBAGENT_TOOLS.has(name), input: pretty(input) };
        if (EDIT_TOOLS.has(name)) {
          const file = str(input.file_path) || str(input.notebook_path);
          if (file !== "") part.file = file;
          const diff = hunksFromInput(name, input);
          if (diff.length > 0) part.diff = diff;
        }
        draft.parts.push(part);
        this.toolOwner.set(toolId, draft.id);
        if (this.toolOwner.size > MAX_TRACKED * 4) {
          const oldest = this.toolOwner.keys().next().value;
          if (oldest !== undefined) this.toolOwner.delete(oldest);
        }
        changed = true;
      }
    }
    return changed ? [snapshot(draft)] : [];
  }

  private user(row: Obj, message: Obj): ChatMessage[] {
    const content = message.content;
    const at = str(row.timestamp);
    const uuid = str(row.uuid) || String(this.anon++);
    if (typeof content === "string") {
      if (row.isMeta === true && row.promptSource !== "system") return [];
      if (row.isCompactSummary === true) return [this.whole(`u:${uuid}`, "note", at, [{ kind: "text", text: "Conversation compacted." }])];
      const c = classifyUserText(content);
      return c === null ? [] : [this.whole(`u:${uuid}`, c.role, at, [{ kind: "text", text: clamp(c.text, MAX_TEXT_CHARS) }])];
    }
    if (!Array.isArray(content)) return [];
    const out = new Set<Draft>();
    const parts: Mutable<ChatPart>[] = [];
    for (const block of content) {
      if (!isObj(block)) continue;
      if (block.type === "tool_result") {
        const owner = this.byId.get(this.toolOwner.get(str(block.tool_use_id)) ?? "");
        const call = owner?.parts.find((p): p is Mutable<ToolPart> => p.kind === "tool" && p.id === str(block.tool_use_id));
        if (owner === undefined || call === undefined) continue;
        call.result = { text: clamp(stripAnsi(toolResultText(block.content)), MAX_RESULT_CHARS), isError: block.is_error === true };
        const result = row.toolUseResult;
        if (isObj(result) && EDIT_TOOLS.has(call.name)) {
          const diff = hunksOf(result.structuredPatch);
          if (diff.length > 0) call.diff = diff;
        }
        out.add(owner);
      } else if (block.type === "text" && row.isMeta !== true) {
        const c = classifyUserText(str(block.text));
        if (c?.role === "user") parts.push({ kind: "text", text: clamp(c.text, MAX_TEXT_CHARS) });
      } else if (block.type === "image" && row.isMeta !== true) {
        parts.push({ kind: "image", note: "image attached" });
      }
    }
    const messages = [...out].map(snapshot);
    if (parts.length > 0) messages.push(this.whole(`u:${uuid}`, "user", at, parts));
    return messages;
  }

  private whole(id: string, role: Draft["role"], at: string, parts: Mutable<ChatPart>[]): ChatMessage {
    return { id, role, at, parts };
  }
}

function snapshot(draft: Draft): ChatMessage {
  return { id: draft.id, role: draft.role, at: draft.at, parts: draft.parts.map((p) => ({ ...p })) };
}
