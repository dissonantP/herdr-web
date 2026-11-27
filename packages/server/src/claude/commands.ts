import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { SlashCommand } from "../chat.ts";
import type { PaneFacts } from "../adapters/chat.ts";

// Slash commands for the chat's autocomplete: Claude Code's built-in ones, then the user's and the
// project's own (commands/*.md and skills/*/SKILL.md under the config folder and the pane's
// .claude folder). The built-in catalog is borrowed from AltanS/collie (MIT, Copyright (c) 2026 Altan
// Sarisin; notice in third_party/collie-LICENSE), web/src/lib/agent-commands.ts at commit
// 62e638c59770bb1ec58412732f59c102a717ede2, reduced to name, description and argument hint.

/** [name, description, argument hint] */
const BUILT_IN: readonly (readonly [string, string, string])[] = [
  ["/compact", "Summarize the conversation to free up context; optional focus", "[instructions]"],
  ["/clear", "Start a fresh conversation with empty context", ""],
  ["/model", "Switch the model; opens a picker if no name given", "[model]"],
  ["/resume", "Resume a previous conversation by id, name, or picker", "[session]"],
  ["/init", "Generate a starter CLAUDE.md for this project", ""],
  ["/review", "Review a GitHub pull request by number (lists open PRs if none)", "[PR]"],
  ["/status", "Show version, model, account, and connectivity info", ""],
  ["/usage", "Show session cost, plan limits, and activity stats", ""],
  ["/context", "Visualize context-window usage with optimization hints", ""],
  ["/memory", "Edit CLAUDE.md memory files and auto-memory entries", ""],
  ["/help", "Show help and list available commands", ""],
  ["/add-dir", "Add an extra working directory for file access", "<path>"],
  ["/agents", "Manage subagent configurations and view running agents", ""],
  ["/branch", "Fork the conversation here to explore a different direction", "[name]"],
  ["/btw", "Ask a quick side question without adding it to history", "<question>"],
  ["/cd", "Move the session to a new working directory", "<path>"],
  ["/code-review", "Review the current diff for bugs and cleanups", "[level]"],
  ["/config", "Open settings, or set a value with key=value", "[key=value]"],
  ["/copy", "Copy the last assistant response to the clipboard", "[N]"],
  ["/cost", "Show token cost and usage for the current session", ""],
  ["/deep-research", "Fan out web searches and synthesize a cited report", "<question>"],
  ["/diff", "Open an interactive viewer of uncommitted changes", ""],
  ["/doctor", "Diagnose and verify your Claude Code installation", ""],
  ["/effort", "Set the model reasoning effort level", "[low|medium|high|max]"],
  ["/export", "Export the conversation as plain text", "[filename]"],
  ["/fast", "Toggle fast mode on or off", "[on|off]"],
  ["/feedback", "Submit feedback or report a bug to Anthropic", "[report]"],
  ["/fork", "Spawn a background subagent that inherits this conversation", "<directive>"],
  ["/goal", "Set a completion condition; keep working until it is met", "[condition|clear]"],
  ["/hooks", "View hook configurations for tool events", ""],
  ["/ide", "Manage IDE integrations and show connection status", ""],
  ["/login", "Sign in to your Anthropic account", ""],
  ["/logout", "Sign out from your Anthropic account", ""],
  ["/loop", "Run a prompt repeatedly on an interval (self-paced if none)", "[interval] [prompt]"],
  ["/mcp", "Manage MCP server connections and auth", "[subcommand]"],
  ["/permissions", "Manage allow, ask, and deny rules for tools", ""],
  ["/plan", "Switch into plan mode; optionally seed a description", "[description]"],
  ["/plugin", "Manage plugins — list, install, enable, or disable", "[subcommand]"],
  ["/recap", "Generate a one-line summary of the current session", ""],
  ["/release-notes", "View the changelog in a version picker", ""],
  ["/rename", "Rename the current session", "[name]"],
  ["/rewind", "Roll back code and conversation to a checkpoint", ""],
  ["/security-review", "Analyze pending changes for security vulnerabilities", ""],
  ["/simplify", "Review changed code for cleanups and apply fixes", "[target]"],
  ["/skills", "List available skills and toggle their visibility", ""],
  ["/statusline", "Configure the shell status line display", "[description]"],
  ["/tasks", "View and manage background tasks for this session", ""],
  ["/terminal-setup", "Configure terminal keybindings (e.g. Shift+Enter)", ""],
  ["/theme", "Change the color theme", ""],
  ["/vim", "Toggle Vim editing mode for the prompt", ""],
  ["/exit", "Exit the CLI (detaches if attached to a background session)", ""],
];

/** At most this many custom commands are read per folder. */
const MAX_CUSTOM = 300;

/** The `description:` line of a markdown file's front matter, or `""`. */
export function frontMatterDescription(text: string): string {
  const fm = /^---\n([\s\S]*?)\n---/u.exec(text.replace(/\r/gu, ""));
  const line = fm === null ? undefined : /^description:\s*(.*)$/mu.exec(fm[1] ?? "");
  return (line?.[1] ?? "").replace(/^["']|["']$/gu, "").trim().slice(0, 200);
}

async function listMarkdown(dir: string, depth = 0): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    if (out.length >= MAX_CUSTOM) break;
    const path = join(dir, e.name);
    if (e.isDirectory() && depth < 2) out.push(...(await listMarkdown(path, depth + 1)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(path);
  }
  return out;
}

/** Custom commands (`commands/a/b.md` is `/a:b`) and skills (`skills/x/SKILL.md` is `/x`) under one `.claude`-like folder. */
async function customIn(root: string): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  const commands = join(root, "commands");
  for (const file of await listMarkdown(commands)) {
    const name = relative(commands, file).replace(/\.md$/u, "").split("/").join(":");
    out.push({ name: `/${name}`, description: frontMatterDescription(await readFile(file, "utf8").catch(() => "")), arg: "" });
  }
  const skills = join(root, "skills");
  for (const e of await readdir(skills, { withFileTypes: true }).catch(() => [])) {
    if (out.length >= MAX_CUSTOM * 2) break;
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const text = await readFile(join(skills, e.name, "SKILL.md"), "utf8").catch(() => null);
    if (text !== null) out.push({ name: `/${e.name}`, description: frontMatterDescription(text), arg: "" });
  }
  return out;
}

/** Every command for a pane: built in first, then the project's, then the user's; a name appears once. */
export async function claudeCommands(configDir: string, pane: PaneFacts): Promise<SlashCommand[]> {
  const cwd = pane.labels["claude.cwd"] ?? pane.cwd;
  const found = [
    ...BUILT_IN.map(([name, description, arg]) => ({ name, description, arg })),
    ...(cwd === "" ? [] : await customIn(join(cwd, ".claude"))),
    ...(configDir === "" ? [] : await customIn(configDir)),
  ];
  const seen = new Set<string>();
  return found.filter((c) => {
    if (seen.has(c.name) || !/^\/[\w:.-]+$/u.test(c.name)) return false;
    seen.add(c.name);
    return true;
  });
}
