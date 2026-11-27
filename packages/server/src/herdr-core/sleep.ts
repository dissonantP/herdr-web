import { basename } from "node:path";
import type { WireLayout, WireTerminal } from "./client.ts";
import { CLAUDE_CWD, CLAUDE_SESSION, isAsleep, runsShell } from "./tree.ts";

export { CLAUDE_CWD, CLAUDE_SESSION, runsShell };

// Session sleep and wake (F50, task 067), done by herdr itself and kept compatible with external
// `hc-sleep` / `hc-wake` scripts (sessions.py): the same labels, the same signals, the same
// typed resume line. Sleep ends an idle Claude in its pane, which `terminal.keep` turns into a shell,
// and records its session in `sleep.session` / `sleep.cwd`; wake types `cd <cwd> && <claude> --resume
// <session>` into that shell and clears the labels.

export const SLEEP_SESSION = "sleep.session";
/** A pane label that keeps auto-sleep away from the pane (AutoDev sets it on autopilot sessions). */
export const NOSLEEP_LABEL = "herdr.nosleep";
export const SLEEP_CWD = "sleep.cwd";

/** A Claude session id; ids come from labels any agent can set and are typed into a shell, so nothing else is accepted. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const program = (name: string | undefined): string => basename(name ?? "");

/** Claude is what runs in the terminal now. */
export const runsClaude = (t: WireTerminal): boolean => program(t.foreground?.name) === "claude";

/**
 * The signal that ends Claude so the pane keeps a shell. A terminal whose own program is Claude
 * only gets its shell back when Claude dies by a signal it can't handle (a clean exit ends the
 * terminal), so SIGKILL; it is idle and its log is written as it goes, so nothing is lost. Under a
 * shell, SIGTERM is enough.
 */
export const sleepSignal = (t: WireTerminal): NodeJS.Signals => (t.pid !== null && t.pid === t.foreground?.pid ? "SIGKILL" : "SIGTERM");

/** Space names compared the way sessions.py and the settings store do: ignoring case, spaces, dashes and underscores. */
const norm = (name: string): string => name.toLowerCase().replace(/[\s_-]+/gu, "");

/** The name of the space a terminal is shown in (the layout), else the space part of its `where` label. */
function spaceNames(layout: WireLayout | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const space of layout?.spaces ?? []) for (const tab of space.tabs) for (const block of tab.blocks) if (block.terminal !== "") out.set(block.terminal, space.name);
  return out;
}

export interface AutoSleepRules {
  /** Sleep sessions idle for longer than this. */
  readonly idleMs: number;
  /** Space names whose sessions never auto-sleep. */
  readonly neverSleep: readonly string[];
  readonly now: number;
  /** Panes never slept this round: herdr's own terminal, panes the app sees waiting on a menu. */
  readonly skip?: ReadonlySet<string>;
  /** When the Claude now in the terminal started; idle time counts from this or the status time, whichever is later. */
  readonly awakeSince?: (t: WireTerminal) => number;
}

/**
 * The terminals auto-sleep puts to sleep: live ones on this machine running Claude that has reported
 * idle or done (never working, never blocked on a question) for longer than the idle time, outside
 * the never-sleep spaces, the skipped panes and panes labelled `herdr.nosleep`. A terminal with no time for its status is left alone.
 */
export function autoSleepCandidates(terminals: readonly WireTerminal[], layout: WireLayout | null, rules: AutoSleepRules): string[] {
  const names = spaceNames(layout);
  const never = new Set(rules.neverSleep.map(norm));
  return terminals
    .filter((t) => {
      if (t.state !== "live" || t.address === "" || t.address.includes("/") || rules.skip?.has(t.address) === true) return false;
      if (!runsClaude(t) || isAsleep(t) || (t.labels[NOSLEEP_LABEL] ?? "") !== "") return false;
      const state = t.status?.state;
      if (state !== "idle" && state !== "done") return false;
      // A resumed Claude reports idle again without the core's status time moving, so its start counts too.
      if (t.statusMs === null || rules.now - Math.max(t.statusMs, rules.awakeSince?.(t) ?? 0) <= rules.idleMs) return false;
      const space = names.get(t.address) ?? (t.labels.where ?? "").split(" / ").slice(0, -1).join(" / ");
      return !never.has(norm(space));
    })
    .map((t) => t.address);
}

/** One word quoted for a POSIX shell or fish (`'...'`, a `'` inside as `'\''`, which both read the same). */
const quote = (word: string): string => (/^[\w./:@%+=-]+$/u.test(word) ? word : `'${word.replace(/'/gu, `'\\''`)}'`);

/** The line typed into a sleeping pane's shell to resume its session there. */
export function wakeLine(cwd: string, command: readonly string[]): string {
  return `cd ${quote(cwd)} && ${command.map(quote).join(" ")}`;
}
