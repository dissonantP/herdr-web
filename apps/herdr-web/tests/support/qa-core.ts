import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { defaultHcSocket } from "@herdr/server/herdr-core/client.ts";

// The isolated herdr-core QA and tests run against (SPEC § How QA drives it): its own HC_SESSION
// and XDG_STATE_HOME, so its socket, state, terminals and herdr-app doc are separate from the user's
// live core, and a temp groups file. Nothing here may ever reach the `default` session or
// ~/.local/state/herdr-groups.
//
// It also simulates Herdr Desktop: it writes the herdr-app doc (as herdr-app does, with a version
// check) and rewrites the groups file whole, tmp + mv, as the spaces-grouped mod does.

export interface QaEnv {
  readonly HC_SESSION: string;
  readonly XDG_STATE_HOME: string;
  readonly HERDR_GROUPS_FILE: string;
  /** The QA login (tests/support/auth.ts), never the user's. */
  readonly HERDR_CREDENTIALS_FILE: string;
  readonly HERDR_SESSIONS_FILE: string;
  /** The web push key pair and the push state (subscriptions, mutes), temp files. */
  readonly HERDR_VAPID_FILE: string;
  readonly HERDR_PUSH_FILE: string;
  /** The settings page's file, which auto-sleep (and external sleep scripts) read (F51). */
  readonly HERDR_SETTINGS_FILE: string;
  /** The pin bar's list (F40). */
  readonly HERDR_PINS_FILE: string;
  /** Claude Code's config folder for the backend and any real Claude the tests start: transcripts land here, never in the user's ~/.claude. */
  readonly CLAUDE_CONFIG_DIR: string;
}

/** The env for an isolated core rooted at `dir` (a fresh temp folder). */
export function qaEnv(dir: string, session: string): QaEnv {
  return { HC_SESSION: session, XDG_STATE_HOME: join(dir, "state"), HERDR_GROUPS_FILE: join(dir, "groups.json"), HERDR_CREDENTIALS_FILE: join(dir, "credentials.json"), HERDR_SESSIONS_FILE: join(dir, "sessions.json"), HERDR_VAPID_FILE: join(dir, "vapid.json"), HERDR_PUSH_FILE: join(dir, "push.json"), HERDR_SETTINGS_FILE: join(dir, "settings.json"), HERDR_PINS_FILE: join(dir, "pins.json"), CLAUDE_CONFIG_DIR: join(dir, "claude") };
}

/** Refuse anything that could be the user's live core or files. */
export function assertIsolated(env: QaEnv): void {
  if (!/^herdr-qa/u.test(env.HC_SESSION)) throw new Error(`refusing a QA core on session ${env.HC_SESSION}`);
  if (env.HERDR_GROUPS_FILE.includes("/.local/state/herdr-groups/")) throw new Error("refusing the live groups file");
  if (/\/\.claude\/?$/u.test(env.CLAUDE_CONFIG_DIR)) throw new Error("refusing the live Claude config");
  if (env.HERDR_CREDENTIALS_FILE.includes("/.config/herdr/") || env.HERDR_SESSIONS_FILE.includes("/.local/state/herdr/") || env.HERDR_VAPID_FILE.includes("/.config/herdr/") || env.HERDR_PUSH_FILE.includes("/.local/state/herdr/") || env.HERDR_SETTINGS_FILE.includes("/.local/state/herdr/") || env.HERDR_PINS_FILE.includes("/.local/state/herdr/")) throw new Error("refusing the live login files");
}

export class QaCore {
  readonly env: QaEnv;
  readonly socket: string;

  constructor(env: QaEnv) {
    assertIsolated(env);
    this.env = env;
    // Only HC_SESSION and XDG_STATE_HOME pick the socket; an inherited HC_SOCKET would not be ours.
    this.socket = defaultHcSocket({ ...process.env, HC_SOCKET: "", ...env }, process.getuid?.() ?? 0);
    if (!this.socket.endsWith(`/${env.HC_SESSION}.sock`)) throw new Error(`unexpected QA socket ${this.socket}`);
  }

  /** The env a child process (the backend, `hc`) needs to use this core and nothing else. */
  childEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.env, HC_SOCKET: this.socket };
  }

  private hc(args: string[]): string {
    return execFileSync("hc", args, { env: this.childEnv(), encoding: "utf8" });
  }

  start(): void {
    this.hc(["server", "start"]);
  }

  async stop(): Promise<void> {
    await this.killAll();
    this.hc(["server", "stop"]);
  }

  /** One plain JSON-RPC call on this core's socket. */
  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socket);
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`));
      socket.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        socket.destroy();
        const message = JSON.parse(buf.slice(0, nl)) as { result?: Record<string, unknown>; error?: unknown };
        if (message.error !== undefined) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
        else resolve(message.result ?? {});
      });
      socket.on("error", reject);
    });
  }

  /** Start a program (a long-running dummy by default) in a terminal with these labels; its address. */
  async run(name: string, labels: Record<string, string>, argv: string[] = ["sleep", "3600"], cwd?: string): Promise<string> {
    const result = await this.call("terminal.run", { argv, name, labels, no_parent: true, no_notify: true, ...(cwd === undefined ? {} : { cwd }) });
    return String(result.address);
  }

  /** Set labels on a terminal, as an agent's hook does. */
  label(address: string, labels: Record<string, string>): void {
    this.hc(["label", address, ...Object.entries(labels).map(([k, v]) => `${k}=${v}`)]);
  }

  /** What the terminal shows now, as plain text. */
  async screen(address: string): Promise<string> {
    const result = await this.call("terminal.read", { terminal: address, lines: 60 });
    return String(result.text ?? "");
  }

  async kill(address: string): Promise<void> {
    await this.call("terminal.kill", { terminal: address });
  }

  async killAll(): Promise<void> {
    const list = await this.call("terminal.list", {});
    const terminals = (list.terminals ?? []) as { address: string }[];
    await Promise.all(terminals.map((t) => this.kill(t.address)));
  }

  /** Desktop: replace the herdr-app doc, checking the version as herdr-app does. */
  async setLayout(value: unknown): Promise<void> {
    const current = await this.call("doc.get", { name: "herdr-app" });
    await this.call("doc.set", { name: "herdr-app", version: current.version, value });
  }

  /** The herdr-app doc's value now. */
  async layout(): Promise<{ spaces: { id: string; name: string; folder: string; tabs: { id: string; name: string; root: unknown }[] }[] }> {
    return (await this.call("doc.get", { name: "herdr-app" })).value as never;
  }

  /** `live` or `finished`. */
  async state(address: string): Promise<string> {
    return String((await this.call("terminal.get", { terminal: address })).state);
  }

  /** The groups file now, parsed. */
  readGroups(): { version: number; groups: { id: string; name: string; parent: string | null; parentId: string | null; color: string | null }[]; spaces: Record<string, { name: string; group: string | null; groupId: string | null; color: string | null }> } {
    return JSON.parse(readFileSync(this.env.HERDR_GROUPS_FILE, "utf8")) as never;
  }

  /** Desktop: rewrite the whole groups file atomically (tmp + mv). */
  writeGroups(value: unknown): void {
    const tmp = `${this.env.HERDR_GROUPS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, this.env.HERDR_GROUPS_FILE);
  }
}
