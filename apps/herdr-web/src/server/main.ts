import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Auth } from "./auth/auth.ts";
import { CredentialsFile, credentialsPath } from "./auth/credentials.ts";
import { SessionStore, sessionsPath } from "./auth/sessions.ts";
import { ClaudeCodeAgent } from "@herdr/server/claude/agent.ts";
import { HerdrCoreBackend } from "@herdr/server/herdr-core/adapter.ts";
import { ParentLabelWatcher } from "@herdr/server/herdr-core/parent-label.ts";
import { defaultHcSocket, HcClient } from "@herdr/server/herdr-core/client.ts";
import { groupsFilePath } from "@herdr/server/herdr-core/groups.ts";
import { migrateTreeDoc } from "@herdr/server/herdr-core/tree-doc.ts";
import { createHttpServer } from "./http.ts";
import { uploadsRoot } from "./upload-file.ts";
import { Presence } from "./push/presence.ts";
import { PushService } from "./push/service.ts";
import { PushStore, pushStatePath } from "./push/store.ts";
import { PinsStore, pinsPath } from "./pins/store.ts";
import { runCommand, UsageService } from "./usage/usage.ts";
import { SettingsStore, settingsPath } from "./settings/store.ts";
import { readVapid, vapidPath } from "./push/vapid.ts";
import { AutoSleep } from "./sleep/auto-sleep.ts";
import { TreeService } from "./tree-service.ts";

// The composition root: the one place that picks the backend and agent implementations.
//
// Environment:
//   HERDR_HOST, HERDR_PORT   where to listen (default 127.0.0.1:7317)
//   HERDR_ALLOWED_SOURCE     the only source address served (default 127.0.0.1, the proxy on this machine)
//   HERDR_STREAM_MAX_MS      longest an SSE/terminal stream lives before the server closes it (default 15 min)
//   HERDR_GROUPS_FILE        Herdr Desktop's groups file (default ~/.local/state/herdr-groups/groups.json)
//   HC_SOCKET, HC_SESSION, XDG_RUNTIME_DIR, XDG_STATE_HOME   which herdr-core to use, as hc picks it
//   HERDR_CREDENTIALS_FILE   the app login (default ~/.config/herdr/credentials.json, written by
//                            `install.sh apply login`); without it every request is refused
//   HERDR_SESSIONS_FILE      login sessions, hashed (default ~/.local/state/herdr/sessions.json)
//   HERDR_VAPID_FILE         the web push key pair (default ~/.config/herdr/vapid.json, made by
//                            `install.sh apply vapid`); without a valid one push is off (fail closed)
//   HERDR_PUSH_FILE          push subscriptions, mutes and pause (default ~/.local/state/herdr/push.json)
//   HERDR_PUSH_SUBJECT       the VAPID contact the push services see (default mailto:herdr@herdr.invalid)
//   HERDR_PUSH_ALLOW_INSECURE=1   tests only: accept http push endpoints on loopback
//   CLAUDE_CONFIG_DIR        Claude Code's config folder; chat reads <it>/projects, slash commands its
//                            commands and skills (default ~/.claude)
//   HERDR_WEB_ROOT           the built UI (default dist/web; "none" serves only the API)
//   HERDR_USAGE_COMMAND      what prints the plan limits (default: `claude -p /usage` in its own systemd scope, see usage/usage.ts), a JSON array or words.
//   HERDR_PINS_FILE          the pin bar's list (default ~/.local/state/herdr/pins.json)
//   HERDR_SETTINGS_FILE      the settings page's file: auto-sleep and the inbox view
//                            (default ~/.local/state/herdr/settings.json; shape in settings/store.ts)
//   HERDR_CLAUDE_COMMAND     what a new Claude tab runs, a JSON array or words (default ~/.local/bin/claude); the form's flags are appended.
//                            Waking a sleeping session types it with `--resume <session>`.
//   HERDR_AUTOSLEEP_EVERY_MS how often auto-sleep looks for idle sessions (overrides the settings page; tests set it shorter)
//   (always on) an agent's `herdr.parent` label moves its space (parent-label.ts)

const home = homedir();
const env = process.env;
const socket = defaultHcSocket(env, process.getuid?.() ?? 0);
const groupsFile = groupsFilePath(env, home);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const webRootSetting = env.HERDR_WEB_ROOT ?? join(repoRoot, "dist/web");
const webRoot = webRootSetting === "none" || !existsSync(webRootSetting) ? null : webRootSetting;

const credentials = new CredentialsFile(credentialsPath(env, home));
const auth = new Auth({ credentials, sessions: new SessionStore(sessionsPath(env, home)) });
credentials.get(); // logs at once when the login is not set up (fail closed)

const claudeConfigDir = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
const claude = new ClaudeCodeAgent(claudeConfigDir, commandLine("HERDR_CLAUDE_COMMAND", env.HERDR_CLAUDE_COMMAND, [join(home, ".local/bin/claude")]));
const agents = [claude];
const sessions = {
  runningSession: (pid: number) => claude.runningSession(pid),
  resumeCommand: (session: string) => claude.startCommand({ folder: "", model: "default", effort: "default", permission: "default", resume: session }),
};
const backend = new HerdrCoreBackend({ rpc: new HcClient(socket), groupsFile, home, sessions });
const tree = new TreeService(backend, agents);
tree.start();

/** A command line from the environment: a JSON array of words, or words split on spaces. */
function commandLine(name: string, value: string | undefined, fallback: readonly string[]): readonly string[] {
  if (value === undefined || value.trim() === "") return fallback;
  if (value.trim().startsWith("[")) {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((w) => typeof w === "string")) return parsed as string[];
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return value.trim().split(/\s+/u);
}

/** An empty private folder for the usage command to run in (Claude reads project config from its cwd; /tmp is world-writable). */
function usageCwd(e: NodeJS.ProcessEnv, h: string): string {
  const dir = join(e.XDG_STATE_HOME ?? join(h, ".local/state"), "herdr", "usage-cwd");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const presence = new Presence();
// An older `herdr-tree` doc still names a root space: drop it and make its children top level.
migrateTreeDoc(new HcClient(socket)).catch((err: unknown) => console.error(`herdr-tree migration: ${err instanceof Error ? err.message : String(err)}`));

const parentLabels = new ParentLabelWatcher({ apply: () => backend.applyParentLabels() });
parentLabels.start();
const stopParentWatch = backend.watch(() => parentLabels.poke());
// `group=` labels (task 083): file a new space in its group without Herdr Desktop running.
const groupLabels = new ParentLabelWatcher({ apply: () => backend.applyGroupLabels(), label: "group=" });
groupLabels.start();
const stopGroupWatch = backend.watch(() => groupLabels.poke());

// Task 087: tabs of removed terminals leave the layout.
const deadTabs = new ParentLabelWatcher({ apply: () => backend.dropRemovedTerminals(), label: "removed terminals" });
deadTabs.start();
const stopDeadTabsWatch = backend.watch(() => deadTabs.poke());

const settings = new SettingsStore(settingsPath(env, home));
settings.ensureFile();
const autoSleepEvery = Number(env.HERDR_AUTOSLEEP_EVERY_MS ?? "");
const autoSleep = new AutoSleep({
  backend,
  settings,
  waiting: () => tree.waitingPanes(),
  ...(Number.isSafeInteger(autoSleepEvery) && autoSleepEvery >= 1000 ? { everyMs: autoSleepEvery } : {}),
  ...(env.HC_TERMINAL_ID === undefined ? {} : { self: env.HC_TERMINAL_ID }),
});
autoSleep.start();
const vapid = readVapid(vapidPath(env, home));
if (!vapid.ok) console.error(`push is off: ${vapid.error}`);
const pushStore = new PushStore(pushStatePath(env, home));
const allowInsecure = env.HERDR_PUSH_ALLOW_INSECURE === "1";
const push = new PushService({ tree, backend, store: pushStore, vapid, presence, subject: env.HERDR_PUSH_SUBJECT ?? "mailto:herdr@herdr.invalid", allowInsecure });
push.start();

const host = env.HERDR_HOST ?? "127.0.0.1";
const port = Number(env.HERDR_PORT ?? "7317");
const streamMaxMs = env.HERDR_STREAM_MAX_MS === undefined ? undefined : Number(env.HERDR_STREAM_MAX_MS);
const streamMaxOk = streamMaxMs !== undefined && Number.isSafeInteger(streamMaxMs) && streamMaxMs >= 1000 && streamMaxMs <= 2_147_483_647;
if (streamMaxMs !== undefined && !streamMaxOk) console.warn(`ignoring HERDR_STREAM_MAX_MS=${env.HERDR_STREAM_MAX_MS ?? ""} (want 1000..2147483647); using the default`);
const server = createHttpServer({
  tree,
  backend,
  agents,
  webRoot,
  auth,
  push: { push, store: pushStore, allowInsecure },
  settings: { settings, push: pushStore },
  pins: new PinsStore(pinsPath(env, home)),
  usage: new UsageService(
    runCommand(
      // The flags keep it sealed: no settings, hooks or MCP servers, and no session file (as AutoDev's read of the plan usage).
      commandLine("HERDR_USAGE_COMMAND", env.HERDR_USAGE_COMMAND, ["systemd-run", "--user", "--scope", "--quiet", "--collect", join(home, ".local/bin/claude"), "-p", "/usage", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config"]),
      usageCwd(env, home),
    ),
  ),
  uploadsRoot: uploadsRoot(env, home),
  ...(env.HERDR_ALLOWED_SOURCE === undefined ? {} : { allowedSource: env.HERDR_ALLOWED_SOURCE }),
  ...(streamMaxOk ? { streamMaxMs } : {}),
});
server.listen(port, host, () => {
  console.log(`herdr listening on http://${host}:${String(port)} (core ${socket}, groups ${groupsFile}, UI ${webRoot ?? "none"}, login ${credentials.path})`);
});

const shutdown = () => {
  parentLabels.stop();
  stopParentWatch();
  groupLabels.stop();
  stopGroupWatch();
  deadTabs.stop();
  stopDeadTabsWatch();
  tree.stop();
  push.stop();
  autoSleep.stop();
  server.close();
  server.closeAllConnections();
  server.closeTerminals();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
