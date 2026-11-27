// The model types the session backend and agent adapters share with the apps that use them.

/** What an agent pane is doing, in the app's words. A shell has no status (`null`). */
export type PaneStatus = "working" | "waiting" | "idle";

/** The Claude CLI's model aliases, effort levels and permission modes the new-session form offers (`"default"`: leave the flag out, the CLI's own default). */
export const CLAUDE_MODELS = ["default", "opus", "sonnet", "haiku"] as const;
export const CLAUDE_EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"] as const;
export const CLAUDE_PERMISSIONS = ["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"] as const;

/** How a new Claude session starts (F14), or resumes a past conversation (F15, `resume`: its session id). */
export interface ClaudeStart {
  /** Working folder: absolute, or `~`-relative. */
  readonly folder: string;
  readonly model: (typeof CLAUDE_MODELS)[number];
  readonly effort: (typeof CLAUDE_EFFORTS)[number];
  readonly permission: (typeof CLAUDE_PERMISSIONS)[number];
  readonly resume: string | null;
}

/** A past Claude conversation, from `~/.claude/projects` (`GET /api/conversations`, newest first). */
export interface Conversation {
  readonly session: string;
  /** The folder it ran in. */
  readonly cwd: string;
  /** Its name if it has one, else its first message. */
  readonly title: string;
  /** Last activity, ms since the epoch. */
  readonly updated: number;
}

/** What a create made, so the UI can open it. */
export interface Created {
  readonly groupId?: string;
  readonly spaceId?: string;
  readonly tabId?: string;
  readonly paneId?: string;
}
