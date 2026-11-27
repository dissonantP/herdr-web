// The conversation of an agent pane, as the chat stream sends it. Shared by the server and the UI.
// Agent-neutral: an agent adapter turns its own transcript format into these.

/** One hunk of a file edit, in unified-diff form: lines start with `+`, `-` or a space. */
export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly string[];
}

export type ChatPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "image"; readonly note: string }
  | {
      readonly kind: "tool";
      /** The tool call's id; a result is folded into the call that asked for it. */
      readonly id: string;
      readonly name: string;
      /** One line: the command, file or pattern the call is about. */
      readonly summary: string;
      /** A subagent run (Claude's Task/Agent tool); its own activity is not shown, only its result. */
      readonly subagent: boolean;
      /** The call's input as pretty text, clamped. */
      readonly input: string;
      /** Absent until the result arrives. */
      readonly result?: { readonly text: string; readonly isError: boolean };
      /** A file edit's diff, when the transcript carries one. */
      readonly diff?: readonly DiffHunk[];
      readonly file?: string;
    };

export interface ChatMessage {
  /** Stable; a message that grows or gets a tool result is sent again under the same id. */
  readonly id: string;
  /** `note`: something that is neither speech nor Claude's answer (a command's output, a summary). */
  readonly role: "user" | "assistant" | "note";
  /** ISO time, or `""`. */
  readonly at: string;
  readonly parts: readonly ChatPart[];
}

/** What `GET /api/chat/<pane id>` (Server-Sent Events) sends, one per message. */
export type ChatEvent =
  /** The pane has no conversation to show yet (no session reported, or its transcript is missing). */
  | { readonly type: "none"; readonly reason: string }
  /** A conversation starts (or a different one replaces it): these messages are all of it, in order. */
  | { readonly type: "reset"; readonly session: string; readonly messages: readonly ChatMessage[]; readonly truncated: boolean }
  /** Messages that are new or changed since the last event; replace by id, append unknown ids. */
  | { readonly type: "upsert"; readonly messages: readonly ChatMessage[] }
  /** The menu now on the agent's screen, or `null` once none is (sent when it changes). */
  | { readonly type: "menu"; readonly menu: ChatMenu | null };

// ── Input (F17, F18) ─────────────────────────────────────────────────────────────────────────────
// What the chat sends back: text, stop, attachments, and answers to the menus an agent shows on its
// screen (a permission prompt, a question, a plan approval). Agent-neutral: the agent adapter reads
// its own screen into a `ChatMenu` and turns a `MenuAnswer` into its own keystrokes.

/** One choice of a menu. `n` is the number the agent prints beside it. */
export interface MenuOption {
  readonly n: number;
  readonly label: string;
  /** The grey lines under it, joined, or `""`. */
  readonly detail: string;
  /** A multiple-choice option's tick; `null` on a single-choice menu. */
  readonly checked: boolean | null;
}

/** One question of a multi-step question, as the step strip shows it. */
export interface MenuStep {
  readonly label: string;
  readonly answered: boolean;
}

/**
 * A menu waiting on the agent's screen. `id` names this exact menu; an answer quotes it and is refused
 * when the screen shows something else by then (someone answered at the desk, the next step came).
 */
export interface ChatMenu {
  readonly id: string;
  /** `review`: a multi-step question's last step (submit or cancel the answers). `trust`: a folder-trust prompt. */
  readonly kind: "permission" | "question" | "plan" | "review" | "trust";
  /** Several options can be ticked, then submitted. */
  readonly multi: boolean;
  /** The question itself. */
  readonly title: string;
  /** What it is about (the command, the file, the plan), clamped; `""` when none. */
  readonly detail: string;
  readonly options: readonly MenuOption[];
  /**
   * The "Other" answer: `field`, typed into the menu's own answer field (`value` is what it holds now,
   * `""` when empty); `message`, the menu is dismissed and the text sent as a message. `null`: none.
   */
  readonly other: { readonly mode: "field" | "message"; readonly value: string } | null;
  /** A multiple-choice menu's submit row (`Submit`, `Next`), or `null`. */
  readonly submit: string | null;
  /** The questions of a multi-step question, in order; empty for a single question. */
  readonly steps: readonly MenuStep[];
}

/** An answer to a `ChatMenu` (`POST /api/chat/<pane>/answer`). */
export type MenuAnswer =
  | { readonly id: string; readonly action: "pick"; readonly n: number }
  | { readonly id: string; readonly action: "toggle"; readonly n: number }
  | { readonly id: string; readonly action: "submit" }
  | { readonly id: string; readonly action: "other"; readonly text: string };

/** An answer before the menu id is added (what a tap means). */
export type MenuChoice = { [K in MenuAnswer["action"]]: Omit<Extract<MenuAnswer, { action: K }>, "id"> }[MenuAnswer["action"]];

/** A slash command the agent knows, for autocomplete. */
export interface SlashCommand {
  /** With the slash: `/compact`. */
  readonly name: string;
  readonly description: string;
  /** What it takes after it, e.g. `[instructions]`; `""` when nothing. */
  readonly arg: string;
}

/** What the input endpoints answer. */
export type InputResult =
  /** `path`: where an upload landed; `outcome`: what stop did; `menu`: the menu on screen after an answer. */
  | { readonly ok: true; readonly path?: string; readonly outcome?: string; readonly menu?: ChatMenu | null }
  | { readonly ok: false; readonly error: string };
