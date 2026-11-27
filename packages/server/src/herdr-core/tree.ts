import type { RawGroup, RawPane, RawSpace, RawTab, RawTree } from "../adapters/backend.ts";
import type { WireLayout, WireLayoutSpace, WireTerminal } from "./client.ts";
import { groupForest, type GroupsFile, type GroupTreeNode } from "./groups.ts";
import { effectiveParents, type TreeDoc } from "./tree-doc.ts";

// THE MAPPING, pure: live terminals + herdr-app's layout doc + the groups file in, the tree out.
//
// Names and order follow Herdr Desktop:
// - Spaces and tabs keep the layout doc's order (Desktop keeps the doc sorted to its sidebar).
// - Spaces in no group come first, then each group as Desktop nests them (groups.ts), a group's
//   spaces before the groups inside it. Empty groups still show.
// - An unnamed space is called what herdr-app writes into its terminals' `where` label
//   (`<space> / <tab>`), else after its folder (`~` at home). An unnamed tab is its place, 1, 2, ...
// - A tab's panes are its split tree's leaves; a terminal pane shows only while it is live.
// The `where` and folder rules are adapted from AltanS/collie bridge/mux/herdr-core/layout.ts
// (MIT, commit 62e638c59770bb1ec58412732f59c102a717ede2; notice in third_party/collie-LICENSE).
//
// Only what Herdr Desktop shows appears: a terminal that no layout block holds is left out.
//
// Nesting comes from `herdr-tree` (tree-doc.ts): a nested space is drawn only inside its parent, in
// the layout doc's order. Groups hold top-level spaces only (a nested space's group is ignored).

const WHERE_LABEL = "where";

/** Whether an address names a terminal on THIS machine. Another machine's is `machine/t7`. */
function isLocal(address: string): boolean {
  return address !== "" && !address.includes("/");
}

/** The last part of a path, `~` for the home folder, or `""`. */
export function folderName(path: string, home: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  if (trimmed === "" || trimmed === "~") return trimmed;
  if (home !== "" && trimmed === home.replace(/\/+$/u, "")) return "~";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function whereSpace(terminal: WireTerminal | undefined): string {
  const where = terminal?.labels[WHERE_LABEL] ?? "";
  const cut = where.lastIndexOf(" / ");
  return (cut < 0 ? where : where.slice(0, cut)).trim();
}

/**
 * Asleep: Claude is not what runs in the terminal and the pane remembers a session: `sleep.session`
 * (hc-sleep), or else `claude.session` (set by Claude's SessionStart hook) when a shell is the foreground,
 * as after a reboot or an /exit. The terminal's last reported status (`claude-code`, idle) outlives the
 * killed Claude, so only the foreground process says whether it is back.
 */
export function isAsleep(terminal: WireTerminal): boolean {
  if (basename(terminal.foreground?.name ?? "") === "claude") return false;
  if ((terminal.labels["sleep.session"] ?? "") !== "") return true;
  return (terminal.labels[CLAUDE_SESSION] ?? "") !== "" && runsShell(terminal);
}

/** Pane labels Claude's SessionStart hook sets: the live (or last) session and its folder. */
export const CLAUDE_SESSION = "claude.session";
export const CLAUDE_CWD = "claude.cwd";

/** The shells a woken session's line may be typed into (as sessions.py). */
const SHELLS = new Set(["bash", "fish", "sh", "zsh", "dash"]);

/** A shell is what runs in the terminal now (so a typed line reaches a prompt). */
export const runsShell = (t: WireTerminal): boolean => SHELLS.has(basename(t.foreground?.name ?? ""));

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** herdr-core's mark of the last turn a viewer saw (Herdr Desktop sets it); a `done` terminal past it is unseen. */
export const SEEN_LABEL = "herdr.seen";
/** Set when a viewer dismisses a session from the Inbox, to `<turn>:<state>` at that moment; it holds until the turn or state changes. */
export const DISMISSED_LABEL = "herdr.dismissed";
export const dismissKey = (t: WireTerminal): string => `${String(t.turn ?? 0)}:${t.status?.state ?? ""}`;

function paneOf(terminal: WireTerminal): RawPane {
  return {
    asleep: isAsleep(terminal),
    ...(terminal.labels["herdr.inbox"] === "hide" ? { inboxHidden: true } : {}),
    id: terminal.address,
    kind: "terminal",
    name: terminal.name || terminal.title || terminal.foreground?.name || terminal.address,
    program: {
      app: terminal.status?.app ?? "",
      state: terminal.status?.state ?? "",
      blockedOn: terminal.status?.kind ?? "",
      foreground: terminal.foreground?.name ?? "",
      unseen: terminal.status?.state === "done" && (terminal.turn ?? 0) > (Number(terminal.labels[SEEN_LABEL]) || 0),
      dismissed: terminal.labels[DISMISSED_LABEL] === dismissKey(terminal),
    },
  };
}

function spaceOf(space: WireLayoutSpace, live: ReadonlyMap<string, WireTerminal>, home: string, nest: TreeDoc, groups: GroupsFile, children: readonly RawSpace[]): RawSpace {
  let first: WireTerminal | undefined;
  const tabs: RawTab[] = space.tabs.map((tab, index) => {
    const panes: RawPane[] = [];
    for (const block of tab.blocks) {
      if (block.terminal !== "") {
        const terminal = live.get(block.terminal);
        if (terminal === undefined) continue;
        first ??= terminal;
        panes.push(paneOf(terminal));
      } else {
        panes.push({ id: block.id, kind: "mod", name: block.mod, program: null, asleep: false });
      }
    }
    return { id: tab.id, name: tab.name || String(index + 1), panes };
  });
  const name = space.name || whereSpace(first) || folderName(first?.foreground?.cwd || first?.cwd || space.folder, home) || space.id;
  return { id: space.id, name, quiet: nest.quiet.has(space.id), color: groups.spaceColor.get(space.id) ?? null, tabs, children };
}

export function buildTree(terminals: readonly WireTerminal[], layout: WireLayout | null, groups: GroupsFile, home: string, nest: TreeDoc): RawTree {
  const live = new Map(terminals.filter((t) => isLocal(t.address) && t.state === "live").map((t) => [t.address, t]));
  const wire = layout?.spaces ?? [];
  const parents = effectiveParents(nest, new Set(wire.map((s) => s.id)));
  const build = (space: WireLayoutSpace): RawSpace => spaceOf(space, live, home, nest, groups, wire.filter((s) => parents.get(s.id) === space.id).map(build));
  const top = wire.filter((s) => parents.get(s.id) === null).map(build);
  const loose = top.filter((s) => !groups.groupOf.has(s.id));
  const toGroup = (node: GroupTreeNode): RawGroup => ({
    id: node.group.id,
    name: node.group.name,
    color: node.group.color,
    spaces: top.filter((s) => groups.groupOf.get(s.id) === node.group.id),
    groups: node.children.map(toGroup),
  });
  return { spaces: loose, groups: groupForest(groups.groups).map(toGroup) };
}
