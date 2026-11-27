import { listConversations } from "./conversations.ts";
import type { ClaudeStart, Conversation, PaneStatus } from "../model.ts";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter, AgentReading } from "../adapters/agent.ts";
import type { ProgramFacts } from "../adapters/backend.ts";
import type { InputStep, PaneFacts, TranscriptParser, TranscriptSource } from "../adapters/chat.ts";
import type { ChatMenu, MenuAnswer, SlashCommand } from "../chat.ts";
import { claudeCommands } from "./commands.ts";
import { claudeAnswerSteps, readClaudeDraft, readClaudeMenu } from "./menu.ts";
import { ClaudeTranscriptParser } from "./transcript.ts";

// The Claude Code implementation of the agent adapter. Claude Code reports itself as `claude-code`
// (OSC 7501, read by herdr-core into the terminal's status); before its first report, the
// foreground process name `claude` still identifies it.

const APP = "claude-code";
const PROCESS = "claude";

function statusOf(state: string): PaneStatus | null {
  switch (state) {
    case "working":
      return "working";
    case "blocked":
      return "waiting";
    case "idle":
    case "done":
      return "idle";
    default:
      return null;
  }
}

/** A session id as Claude writes it; anything else never reaches the filesystem. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Claude's folder name for a working directory: every character that is not a letter or digit becomes `-`. */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/gu, "-");
}

export class ClaudeCodeAgent implements AgentAdapter {
  readonly name = "claude";
  readonly chat = true;
  private readonly projects: string;
  private readonly configDir: string;
  private readonly command: readonly string[];

  /** `configDir`: Claude's config folder (`~/.claude`); transcripts are in its `projects`, commands and skills beside them. */
  constructor(configDir = "", command: readonly string[] = ["claude"]) {
    this.configDir = configDir;
    this.command = command;
    this.projects = configDir === "" ? "" : join(configDir, "projects");
  }

  /**
   * The pane's session comes from the `claude.session` label (set by Claude's SessionStart hook, with
   * `claude.cwd`). The file is `<projects>/<mangled cwd>/<session>.jsonl`; when the folder guess misses
   * (the label's cwd can differ from where the transcript went, e.g. after a worktree switch) every
   * project folder is searched for that one file name.
   */
  async transcript(pane: PaneFacts): Promise<TranscriptSource | null> {
    // A sleeping pane keeps its session in sleep.session (claude.session may be gone), so its history still reads.
    const session = (pane.labels["sleep.session"] ?? "") || (pane.labels["claude.session"] ?? "");
    if (this.projects === "" || !SESSION_ID.test(session)) return null;
    const file = `${session}.jsonl`;
    for (const cwd of [pane.labels["sleep.cwd"] ?? "", pane.labels["claude.cwd"] ?? "", pane.cwd]) {
      if (cwd === "") continue;
      const path = join(this.projects, projectDirName(cwd), file);
      if (await stat(path).then((i) => i.isFile(), () => false)) return { key: session, path };
    }
    const dirs = await readdir(this.projects).catch(() => [] as string[]);
    for (const dir of dirs) {
      const path = join(this.projects, dir, file);
      if (await stat(path).then((i) => i.isFile(), () => false)) return { key: session, path };
    }
    return null;
  }

  /** Claude writes `<config>/sessions/<pid>.json` (`{sessionId, cwd}`) for each running process; external hc-sleep scripts read the same file. */
  async runningSession(pid: number): Promise<{ readonly id: string; readonly cwd: string } | null> {
    if (this.configDir === "" || !Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
      const raw = JSON.parse(await readFile(join(this.configDir, "sessions", `${String(pid)}.json`), "utf8")) as { sessionId?: unknown; cwd?: unknown };
      if (typeof raw.sessionId !== "string" || !SESSION_ID.test(raw.sessionId)) return null;
      return { id: raw.sessionId, cwd: typeof raw.cwd === "string" ? raw.cwd : "" };
    } catch {
      return null;
    }
  }

  startCommand(c: ClaudeStart): readonly string[] {
    const argv = [...this.command];
    if (c.model !== "default") argv.push("--model", c.model);
    if (c.effort !== "default") argv.push("--effort", c.effort);
    if (c.permission !== "default") argv.push("--permission-mode", c.permission);
    if (c.resume !== null) argv.push("--resume", c.resume);
    return argv;
  }

  conversations(): Promise<readonly Conversation[]> {
    return listConversations(this.configDir);
  }

  parser(): TranscriptParser {
    return new ClaudeTranscriptParser();
  }

  /** A permission prompt, question or plan approval on the screen (menu.ts, Collie's grammar). */
  needsInput(screen: string): boolean {
    return readClaudeMenu(screen) !== null;
  }

  readMenu(screen: string): ChatMenu | null {
    return readClaudeMenu(screen)?.menu ?? null;
  }

  answerSteps(screen: string, answer: MenuAnswer): readonly InputStep[] | { readonly refused: string } {
    const menu = readClaudeMenu(screen);
    if (menu === null || menu.menu.id !== answer.id) return { refused: "The question on screen has changed." };
    return claudeAnswerSteps(menu, answer);
  }

  draft(screen: string): string | null {
    return readClaudeDraft(screen);
  }

  commands(pane: PaneFacts): Promise<readonly SlashCommand[]> {
    return claudeCommands(this.configDir, pane);
  }

  recognise(program: ProgramFacts): AgentReading | null {
    const app = program.app.trim().toLowerCase();
    if (app === APP) return { agent: "claude", status: statusOf(program.state) };
    if (app === "" && program.foreground === PROCESS) return { agent: "claude", status: null };
    return null;
  }
}
