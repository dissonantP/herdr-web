import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Adds herdr's one Claude Code hook (SessionStart: session-label.sh) to a Claude settings file, for
// install.sh's `hook` step. Usage:
//   node install-hook.ts check <settings.json> [hook.sh]   0 when a SessionStart hook runs session-label.sh
//                                                          (this hook.sh, when given), 1 when not, 75 when the
//                                                          file is not readable JSON
//   node install-hook.ts apply <settings.json> <hook.sh>   add it when missing (idempotent), replacing any
//                                                          hand-written hook that sets `claude.session=` itself
//                                                          and any session-label.sh at another path (an old
//                                                          checkout layout)
// Other settings and hooks are kept as they are; the file is
// written atomically (tmp + rename) with its mode kept. A file that is not valid JSON is left alone.

interface HookCommand {
  type?: unknown;
  command?: unknown;
}
interface HookGroup {
  hooks?: unknown;
}
type Settings = Record<string, unknown> & { hooks?: Record<string, unknown> };

export function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as Settings;
}

const labelCommand = (hookScript: string) => `bash '${hookScript.replaceAll("'", `'\\''`)}'`;

/** Whether a SessionStart hook runs session-label.sh: exactly `hookScript`'s command, when given. */
export function hasLabelHook(settings: Settings, hookScript?: string): boolean {
  const groups = settings.hooks?.SessionStart;
  if (!Array.isArray(groups)) return false;
  const matches = (c: string) => (hookScript === undefined ? c.includes("session-label.sh") : c === labelCommand(hookScript));
  return groups.some((g: HookGroup) =>
    Array.isArray(g.hooks) &&
    g.hooks.some((h: HookCommand) => typeof h.command === "string" && matches(h.command)),
  );
}

export function withLabelHook(settings: Settings, hookScript: string): Settings {
  if (hasLabelHook(settings, hookScript)) return settings;
  const hooks = { ...(settings.hooks ?? {}) };
  // Drop hand-written equivalents (they set claude.session= themselves) and session-label.sh at another
  // path (a stale checkout layout), so the labels are written once, by this script.
  const existing = (Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as HookGroup[]) : []).flatMap((g) => {
    if (!Array.isArray(g.hooks)) return [g];
    const kept = g.hooks.filter((h: HookCommand) => !(typeof h.command === "string" && (h.command.includes("claude.session=") || h.command.includes("session-label.sh"))));
    return kept.length === g.hooks.length ? [g] : kept.length > 0 ? [{ ...g, hooks: kept }] : [];
  });
  hooks.SessionStart = [...existing, { hooks: [{ type: "command", command: labelCommand(hookScript), timeout: 5 }] }];
  return { ...settings, hooks };
}

/** Where a dangling symlink points, so writing creates its target and keeps the link; `null` if `path` is no link. */
function danglingTarget(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : null;
  } catch {
    return null;
  }
}

function main(argv: readonly string[]): number {
  const [command, path, hookScript] = argv;
  if (command === "check" && path !== undefined) {
    let settings: Settings;
    try {
      settings = readSettings(path);
    } catch (err) {
      console.log(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      return 75;
    }
    const ok = hasLabelHook(settings, hookScript);
    console.log(ok ? `SessionStart label hook present in ${path}` : `no SessionStart label hook in ${path}`);
    return ok ? 0 : 1;
  }
  if (command === "apply" && path !== undefined && hookScript !== undefined) {
    const before = readSettings(path);
    if (hasLabelHook(before, hookScript)) return 0;
    // A symlinked settings file (dotfiles) is written through to its target, so the link stays.
    const target = existsSync(path) ? realpathSync(path) : danglingTarget(path) ?? path;
    const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.herdr-tmp`;
    writeFileSync(tmp, `${JSON.stringify(withLabelHook(before, hookScript), null, 2)}\n`, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, target);
    console.log(`added the SessionStart label hook to ${path}`);
    return 0;
  }
  console.error("usage: install-hook.ts check <settings.json> [hook.sh] | apply <settings.json> <hook.sh>");
  return 2;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
