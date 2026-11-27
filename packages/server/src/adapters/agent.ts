import type { ClaudeStart, Conversation, PaneStatus } from "../model.ts";
import type { ProgramFacts } from "./backend.ts";
import type { AgentInput, PaneFacts, TranscriptParser, TranscriptSource } from "./chat.ts";

// The agent-adapter interface: which coding agent runs in a pane and what it is doing. Claude Code
// is the one implementation today; another agent is another adapter in the list main.ts builds.

export interface AgentReading {
  /** The agent's name, e.g. `"claude"`. */
  readonly agent: string;
  readonly status: PaneStatus | null;
}

export interface AgentAdapter extends AgentInput {
  /** The agent's name as `AgentReading.agent` carries it (`"claude"`). */
  readonly name: string;
  /** Its panes open as a chat (conversation, input, menus) rather than only a terminal. */
  readonly chat: boolean;
  /** This adapter's reading of the program, or `null` when the program is not its agent. */
  recognise(program: ProgramFacts): AgentReading | null;
  /**
   * Whether the agent's screen (plain text) shows a permission prompt, question or plan approval
   * waiting for an answer. Detects what herdr-core's own status cannot (a program that did not
   * report itself blocked).
   */
  needsInput(screen: string): boolean;
  /** Where this pane's conversation is written, or `null` when it has none yet (no session reported, file missing). */
  transcript(pane: PaneFacts): Promise<TranscriptSource | null>;
  /** The session a running agent process has open and its folder (for sleep), or `null` when it can't be told. */
  runningSession(pid: number): Promise<{ readonly id: string; readonly cwd: string } | null>;
  /** The command line that starts (or, with `resume`, resumes) a session as the new-session form says. */
  startCommand(start: ClaudeStart): readonly string[];
  /** Past conversations that can be resumed, newest first (F15); a failure to read them is an empty list. */
  conversations(): Promise<readonly Conversation[]>;
  /** A fresh parser for one conversation's transcript lines. */
  parser(): TranscriptParser;
}
