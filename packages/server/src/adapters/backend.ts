import type { Created } from "../model.ts";
import type { PaneFacts } from "./chat.ts";

export type { Created };

// The backend-adapter interface: where sessions live (herdr-core today). Everything above it, the
// HTTP API included, depends on this file only; `src/server/main.ts` picks the implementation.

/** The facts about a pane's program an agent adapter needs to recognise it. */
export interface ProgramFacts {
  /** The program's own report of what it is (`claude-code`), or `""`. */
  readonly app: string;
  /** The program's own state word (`idle`, `working`, `done`, `blocked`, ...), or `""`. */
  readonly state: string;
  /** Why it is blocked (`permission`, `question`, `auth`), or `""`. */
  readonly blockedOn: string;
  /** The foreground process name, or `""`. */
  readonly foreground: string;
  /** Finished (`done`) with a turn Desktop or this app has not seen yet: `turn` is past `herdr.seen`. */
  readonly unseen?: boolean;
  /** Dismissed from the Inbox and nothing new since (`herdr.dismissed` matches the turn and state). */
  readonly dismissed?: boolean;
}

export interface RawPane {
  readonly id: string;
  readonly kind: "terminal" | "mod";
  readonly name: string;
  /** `null` for a mod pane. */
  readonly program: ProgramFacts | null;
  /** Put to sleep: the session is kept in its labels and the agent is not running. */
  readonly asleep: boolean;
  /** Labelled `herdr.inbox=hide`. */
  readonly inboxHidden?: boolean;
}

export interface RawTab {
  readonly id: string;
  readonly name: string;
  readonly panes: readonly RawPane[];
}

export interface RawSpace {
  readonly id: string;
  readonly name: string;
  /** Marked quiet in the shared tree doc: it never pushes for itself. */
  readonly quiet: boolean;
  /** Its own colour token in the groups file, or `null`. */
  readonly color: string | null;
  readonly tabs: readonly RawTab[];
  /** Spaces nested in it, in display order. */
  readonly children: readonly RawSpace[];
}

export interface RawGroup {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly spaces: readonly RawSpace[];
  readonly groups: readonly RawGroup[];
}

/** The hierarchy as the backend has it, in display order, before any agent is recognised. */
export interface RawTree {
  readonly spaces: readonly RawSpace[];
  readonly groups: readonly RawGroup[];
}

/** A live view of one terminal: what to type into it, how to resize it, and how to leave. */
export interface TerminalStream {
  /** Raw input bytes, as typed. Queued until the stream is open. */
  write(bytes: Uint8Array): void;
  /** Make this viewer's size the terminal's. */
  resize(cols: number, rows: number): void;
  close(): void;
}

/** Who hears the terminal's output (raw VT bytes). `onClose` fires exactly once, for any reason. */
export interface AttachOptions {
  onData(bytes: Uint8Array): void;
  /** `ended`: the terminal itself finished; otherwise the stream failed and may be re-attached. */
  onClose(reason: string, ended: boolean): void;
}


/** A program to run in a new tab instead of the machine's shell. */
export interface TabProgram {
  readonly folder: string;
  /**
   * The command line. `title` is the space's name: an agent session is named after its space
   * (the terminal's hc name is its slug, `-n` for Claude is the name itself).
   */
  readonly argv: (title: string) => readonly string[];
}

/**
 * A request the backend refuses for a reason the person can act on (a name it does not know, a
 * file it will not overwrite). The message is shown as is.
 */
export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminError";
  }
}

/**
 * Changing the hierarchy (M2). Every change must keep concurrent edits made elsewhere (Herdr
 * Desktop) and show in the tree through `watch`. Deleting ends every program in what goes.
 */
export interface BackendAdmin {
  createGroup(name: string, parentId: string | null): Promise<Created>;
  renameGroup(id: string, name: string): Promise<void>;
  /** Write a group's colour token (`null`: none) to the groups file. */
  setGroupColor(id: string, color: string | null): Promise<void>;
  /** Write a space's own colour token (`null`: follow its group, `"dim"`: none) to the groups file. */
  setSpaceColor(id: string, color: string | null): Promise<void>;
  /** `lift`: what is inside moves up a level and nothing ends; `delete`: everything inside goes and its programs end. */
  deleteGroup(id: string, children: "lift" | "delete"): Promise<void>;
  /**
   * A new space with one terminal tab, started in `folder`, in a group or none, nested in
   * `parentId` or top level (a nested space's group is ignored). `name` `""`: named after its folder.
   * With `program`, its first tab runs that (in `folder`) instead of the shell.
   */
  createSpace(name: string, folder: string, groupId: string | null, parentId: string | null, program?: TabProgram): Promise<Created>;
  renameSpace(id: string, name: string): Promise<void>;
  /** Delete a space, ending its programs; its nested spaces move up a level (`lift`) or go too (`delete`). */
  deleteSpace(id: string, children: "lift" | "delete"): Promise<void>;
  /** Put a top-level space in a group (`null`: in no group). */
  moveSpace(id: string, groupId: string | null): Promise<void>;
  /** Nest a space in another (`null`: top level); refuses a move that would make a cycle. */
  reparentSpace(id: string, parentId: string | null): Promise<void>;
  /** Mark a space quiet (or not) in the shared tree doc (F36). */
  setQuiet(id: string, quiet: boolean): Promise<void>;
  /**
   * A new tab at the end of the space: a terminal, or with `program` that program run in its folder
   * (`~`-relative or absolute). `name` `""`: called by its place.
   */
  createTab(spaceId: string, name: string, program?: TabProgram): Promise<Created>;
  renameTab(id: string, name: string): Promise<void>;
  deleteTab(id: string): Promise<void>;
  /** End the pane's program (a terminal) and take the pane out of its tab. */
  closePane(id: string): Promise<void>;
}

/**
 * Talking to the program in a terminal pane (the chat's input, F17/F18). Each rejects when the
 * terminal is gone or the backend refuses (a send to a program blocked on a dialog, without `force`).
 */
export interface BackendInput {
  /** The screen as plain text, one row per line. */
  readScreen(paneId: string): Promise<string>;
  /** Named keys, in order (`1`, `down`, `enter`, `esc`). */
  pressKeys(paneId: string, keys: readonly string[]): Promise<void>;
  /** Text typed as is, nothing pressed after it. */
  typeText(paneId: string, text: string): Promise<void>;
  /** Text pasted, then Enter. `force`: even while the program waits on a dialog. */
  sendText(paneId: string, text: string, force: boolean): Promise<void>;
  /** Press the program's stop key; a word for what happened (`stopped`, `still_working`, ...). */
  interrupt(paneId: string): Promise<string>;
  /** Write a file beside the terminal, where its program can read it; the path it got. */
  putFile(paneId: string, name: string, bytes: Uint8Array): Promise<string>;
}

/** One agent's deliberate push: what it set on its own terminal, not yet sent. */
export interface PaneNote {
  readonly paneId: string;
  readonly text: string;
}

/** What agents have asked of herdr through their terminal's labels, and which spaces are marked quiet. */
export interface PushFacts {
  /** Terminals asking for a push on purpose (`herdr.notify`). */
  readonly notes: readonly PaneNote[];
  /** Terminals that marked their space quiet (`herdr.quiet=1`). */
  readonly quietPanes: readonly string[];
  /** Spaces already recorded as quiet in the shared tree doc. */
  readonly quietSpaces: ReadonlySet<string>;
}

/** Push controls that live in the backend's own data (F20, F21). */
export interface BackendNotes {
  readPushFacts(): Promise<PushFacts>;
  /** Take the note off the terminal once it is sent. */
  clearNote(paneId: string): Promise<void>;
  /** Record a space as quiet (it never pushes for itself) in the shared tree doc. */
  markQuiet(spaceId: string): Promise<void>;
  /** Take `herdr.quiet` off a terminal once the doc holds it, so the app's toggle can turn it off. */
  clearQuietLabel(paneId: string): Promise<void>;
}

export interface BackendAdapter extends BackendAdmin, BackendInput, BackendNotes {
  /** Put an idle agent to sleep (its session is kept, its memory freed; as hc-sleep does). Refuses when it can't be (working, waiting, not an agent). */
  sleepPane(id: string): Promise<void>;
  /** A viewer saw the pane's latest turn: record it (`herdr.seen`) so it stops showing as finished, here and in Desktop. */
  markSeen(id: string): Promise<void>;
  /** Dismiss the pane from the Inbox (`herdr.dismissed`, shared by every viewer) and mark its finished turn seen; it returns when the pane does something new. */
  dismissPane(id: string): Promise<void>;
  /** Wake a sleeping agent in its pane, resuming its session (as hc-wake does). */
  wakePane(id: string): Promise<void>;
  /** A wake whose Claude never came up: give the pane its sleep labels back (no-op when Claude runs by now). */
  restoreSleep(id: string): Promise<void>;
  /** Auto-sleep: sleep every agent idle longer than `idleMs` outside the `neverSleep` spaces (by name) and the `skip` panes; the panes it slept. */
  sleepIdle(idleMs: number, neverSleep: readonly string[], skip?: readonly string[]): Promise<string[]>;
  /** The current hierarchy. Rejects when the backend cannot be reached. */
  readTree(): Promise<RawTree>;
  /**
   * Call `onChange` whenever the hierarchy may have changed (it may also fire when nothing did).
   * Returns a function that stops watching.
   */
  watch(onChange: () => void): () => void;
  /**
   * Open a live view of a terminal pane (a `PaneNode.id` of kind `terminal`). Attaching alone
   * changes nothing on the terminal; only `resize` and typing do.
   */
  attachTerminal(paneId: string, opts: AttachOptions): TerminalStream;
  /** The labels and folder of a terminal pane (they change while it runs); `null` when it is gone. */
  paneFacts(paneId: string): Promise<PaneFacts | null>;
}
