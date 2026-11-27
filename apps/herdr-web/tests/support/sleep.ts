import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Session sleep and wake in the isolated core (F50, task 067). The "Claude" is the stand-in `claude` in
// fake-bin (it writes the session file sleep reads, and is what the backend's HERDR_CLAUDE_COMMAND
// runs, so waking resumes it). External `hc-sleep` / `hc-wake` scripts, where installed, run
// against the QA core only (its HC_SESSION) to check the two stay compatible.

export const fakeBin = join(dirname(fileURLToPath(import.meta.url)), "fake-bin");
export const fakeClaude = join(fakeBin, "claude");

export const hcSleep = join(homedir(), ".local", "bin", "hc-sleep");
export const hcWake = join(homedir(), ".local", "bin", "hc-wake");
export const haveSleepScripts = (): boolean => existsSync(hcSleep) && existsSync(hcWake);

export const SESSION = "22222222-2222-4222-8222-222222222222";

type State = "idle" | "working" | "blocked";
const withBin = (state: State, session: string, screen?: string, inputLog?: string) => ["env", `PATH=${fakeBin}:${process.env.PATH ?? ""}`, `FAKE_CLAUDE_SESSION=${session}`, `FAKE_CLAUDE_STATE=${state}`, ...(screen === undefined ? [] : [`FAKE_SCREEN=${screen}`]), ...(inputLog === undefined ? [] : [`FAKE_INPUT_LOG=${inputLog}`])];

/** A shell running the stand-in Claude, which gets its shell back when Claude is ended. `screen`: a fixture screen it draws. */
export const awakeClaude = (state: State = "idle", session = SESSION, screen?: string): string[] => [...withBin(state, session, screen), "bash", "--norc", "-i", "-c", "claude; exec bash --norc -i"];

/** A Claude screen with a question menu up, although the program reports itself idle (the app sees it waiting). */
export const MENU_SCREEN = fileURLToPath(import.meta.resolve("@herdr/server/fixtures/claude/screens/collie/claude-lab--ask-single-v2296--w82.txt"));

/** A terminal whose own program is the stand-in Claude (sleep must SIGKILL it so keep gives it a shell). */
export const ownClaude = (state: State = "idle", session = SESSION): string[] => [...withBin(state, session), fakeClaude];

/** The shell a slept session leaves behind, with `claude` on its PATH. */
export const sleepingShell = (screen?: string, inputLog?: string): string[] => [...withBin("idle", SESSION, screen, inputLog), "bash", "--norc", "-i"];
