import type { ChatMenu, ChatMessage, MenuAnswer, SlashCommand } from "../chat.ts";

// The chat half of the agent adapter: where an agent's conversation is written, and how to read it.
// Input: the agent reads its own screen into a menu and says which keystrokes answer it.

/** What the backend knows about a pane that locates its conversation. */
export interface PaneFacts {
  readonly labels: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/** Where one pane's conversation is. `key` changes when a different conversation takes over (`/clear`, resume). */
export interface TranscriptSource {
  readonly key: string;
  readonly path: string;
}

/** Turns an agent's transcript lines into messages, one conversation per parser. */
export interface TranscriptParser {
  /** One complete line of the transcript; returns the messages it created or changed (maybe none). */
  feed(line: string): readonly ChatMessage[];
}

/**
 * One step of answering a menu, done by the input service through the backend in order:
 *   keys     named keys pressed (`1`, `down`, `enter`, `esc`)
 *   type     text typed as is, nothing pressed after it
 *   send     text pasted, then Enter, even while the program reports itself blocked (it answers the
 *            focused field, or follows an `until` that saw the menu gone while the status lags)
 *   until    re-read the screen until `test` holds, or fail with `error`
 */
export type InputStep =
  | { readonly kind: "keys"; readonly keys: readonly string[] }
  | { readonly kind: "type"; readonly text: string }
  | { readonly kind: "send"; readonly text: string }
  | { readonly kind: "until"; readonly test: (screen: string) => boolean; readonly timeoutMs: number; readonly error: string };

/** The input half of the agent adapter. */
export interface AgentInput {
  /** The menu waiting on this screen (plain text), or `null`. */
  readMenu(screen: string): ChatMenu | null;
  /** The steps that answer the menu on `screen` with `answer`, or why it can't be (refused when that menu is not `answer.id`). */
  answerSteps(screen: string, answer: MenuAnswer): readonly InputStep[] | { readonly refused: string };
  /**
   * What the person has typed into the agent's own prompt box on this screen (`""` when empty), or
   * `null` when no prompt box shows. A message is not sent over a draft typed at the desk.
   */
  draft(screen: string): string | null;
  /** Slash commands for autocomplete in this pane (built in, plus the user's and the project's own). */
  commands(pane: PaneFacts): Promise<readonly SlashCommand[]>;
}
