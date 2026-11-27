import { appendFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectDirName } from "@herdr/server/claude/agent.ts";
import type { QaCore } from "./qa-core.ts";

// Claude Code inside the isolated QA core. Everything Claude writes goes to the QA config folder
// (CLAUDE_CONFIG_DIR, in the QA temp dir), never the real ~/.claude; the backend reads transcripts from there.

export const realCredentials = join(homedir(), ".claude", ".credentials.json");

/** The transcript file for a session of a working directory, creating its folder. */
export function transcriptPath(core: QaCore, cwd: string, session: string): string {
  const dir = join(core.env.CLAUDE_CONFIG_DIR, "projects", projectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  return join(dir, `${session}.jsonl`);
}

export function writeTranscript(core: QaCore, cwd: string, session: string, lines: readonly string[]): string {
  const path = transcriptPath(core, cwd, session);
  writeFileSync(path, lines.map((l) => `${l}\n`).join(""));
  return path;
}

export function appendTranscript(path: string, lines: readonly string[]): void {
  appendFileSync(path, lines.map((l) => `${l}\n`).join(""));
}

/** A SessionStart hook like the one in the user's global settings, used to tell herdr-core the session (the app relies on it). */
const LABEL_HOOK = `[ -n "\${HC_TERMINAL_ID-}" ] && python3 -c 'import json,os,subprocess,sys;d=json.load(sys.stdin);subprocess.run(["hc","label",os.environ["HC_TERMINAL_ID"],"claude.session="+d["session_id"],"claude.cwd="+d.get("cwd","")],capture_output=True,timeout=4)' >/dev/null 2>&1; exit 0`;

/**
 * Make the QA config folder a working Claude Code home: the user's sign-in (linked, not copied), the label
 * hook, onboarding done and `cwd` trusted. Returns false when there is no sign-in to use.
 */
export function prepareRealClaude(core: QaCore, cwd: string): boolean {
  if (!existsSync(realCredentials)) return false;
  const dir = core.env.CLAUDE_CONFIG_DIR;
  mkdirSync(dir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (!existsSync(join(dir, ".credentials.json"))) symlinkSync(realCredentials, join(dir, ".credentials.json"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: LABEL_HOOK, timeout: 5 }] }] } }));
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: { [cwd]: { hasTrustDialogAccepted: true, allowedTools: [] } } }));
  return true;
}
