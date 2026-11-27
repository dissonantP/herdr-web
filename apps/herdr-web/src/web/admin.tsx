import { CLAUDE_EFFORTS, CLAUDE_MODELS, CLAUDE_PERMISSIONS, type ActionResult, type AdminAction, type ClaudeStart, type Conversation, type GroupNode, type PaneNode, type SpaceNode, type TabNode, type Tree } from "../shared/model.ts";
import { openDialog, openMenu, type Field, type MenuItem } from "./overlay.tsx";
import { pushInfo, refreshPushInfo, setMuted } from "./push.ts";
import { goHome, navigate, useRoute, type Route } from "./router.ts";
import { toLogin } from "@herdr/web/session.ts";
import { spaceAndBelow } from "../shared/tree-walk.ts";
import { PALETTE } from "./row-colour.ts";
import { changeSettings, loadSettings, neverSleeps } from "./settings.ts";
import { change, fail } from "./sync.ts";
import { allGroups, groupOfSpace, parentOfSpace, runningIn, spacesWithDepth } from "./tree-utils.ts";

// Every change to the hierarchy the UI offers, as menus and dialogs. Each posts one action to the
// backend (`POST /api/actions`). A change the UI can predict shows at once and its dialog closes without
// waiting (sync.ts); a refusal takes it back with a toast. Creates wait for the server's new ids.

export async function act(action: AdminAction): Promise<ActionResult> {
  try {
    const res = await fetch("/api/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action) });
    if (res.status === 401) {
      toLogin();
      return { ok: false, error: "Logged out." };
    }
    const body = (await res.json().catch(() => null)) as ActionResult | null;
    return body ?? { ok: false, error: `The server answered ${String(res.status)}.` };
  } catch {
    return { ok: false, error: "Can't reach herdr." };
  }
}

/** Make a change through the sync store: shown at once where predictable; `what` heads the toast if refused. */
export const apply = (action: AdminAction, what: string, opts: { quiet?: boolean } = {}): Promise<ActionResult> => change(action, act, what, opts).done;

/**
 * A dialog's change: a predicted one resolves at once (the dialog closes, `after` runs now) and a refusal comes back
 * as a toast; the others wait for the answer, which the dialog shows, and `after` runs only once it is a yes.
 */
function now(action: AdminAction, what: string, after?: () => void): Promise<ActionResult> {
  const { predicted, done } = change(action, act, what);
  if (predicted) {
    after?.();
    return Promise.resolve({ ok: true, created: {} });
  }
  return done.then((result) => {
    if (result.ok) after?.();
    return result;
  });
}

const NO_GROUP = "";

function groupField(tree: Tree, value: string | null, label = "Group"): Field {
  return {
    name: "group",
    label,
    value: value ?? NO_GROUP,
    options: [{ value: NO_GROUP, label: "No group" }, ...allGroups(tree).map(({ group, depth }) => ({ value: group.id, label: `${"\u00a0\u00a0".repeat(depth)}${depth > 0 ? "└ " : ""}${group.name}` }))],
  };
}

const groupValue = (v: string | undefined) => (v === undefined || v === NO_GROUP ? null : v);

const TOP = "";

/** A select of spaces to nest in (`""`: top level), leaving out `except` and everything inside it. */
function parentField(tree: Tree, value: string | null, label: string, except: SpaceNode | null = null): Field {
  const skip = new Set(except === null ? [] : spaceAndBelow(except).map((s) => s.id));
  return {
    name: "parent",
    label,
    value: value ?? TOP,
    options: [
      { value: TOP, label: "Top level" },
      ...spacesWithDepth(tree)
        .filter(({ space }) => !skip.has(space.id))
        .map(({ space, depth }) => ({ value: space.id, label: `${"\u00a0\u00a0".repeat(depth)}${depth > 0 ? "└ " : ""}${space.name}` })),
    ],
  };
}

const NO_COLOUR = "none";

/** The picker's choices: none, (a space: dim,) each colour, and each as a filled `inv:` row. */
function colourOptions(space: boolean, current: string | null): { value: string; label: string }[] {
  const options = [
    { value: NO_COLOUR, label: space ? "None (same as its group)" : "None" },
    ...(space ? [{ value: "dim", label: "Dim (no colour, even in a coloured group)" }] : []),
    ...PALETTE.map(([label, token]) => ({ value: token, label })),
    ...PALETTE.map(([label, token]) => ({ value: `inv:${token}`, label: `${label} (filled)` })),
  ];
  // A token Desktop wrote that is not in the palette stays selectable, so "Set" never changes it silently.
  return current === null || options.some((o) => o.value === current) ? options : [...options, { value: current, label: `Current (${current})` }];
}

function colourDialog(kind: "group" | "space", id: string, name: string, current: string | null) {
  openDialog({
    title: `Colour ${name}`,
    fields: [{ name: "color", label: "Colour", value: current ?? NO_COLOUR, options: colourOptions(kind === "space", current) }],
    buttons: [{ label: "Set", run: (v) => now({ type: kind === "group" ? "group.color" : "space.color", id, color: v.color === undefined || v.color === NO_COLOUR ? null : v.color }, `Couldn't colour ${name}`) }],
  });
}

function renameDialog(what: string, current: string, run: (name: string) => AdminAction, required: boolean) {
  openDialog({
    title: `Rename ${what}`,
    fields: [{ name: "name", label: "Name", value: current, placeholder: required ? "" : "Leave empty for the default" }],
    buttons: [{ label: "Rename", run: (v) => now(run(v.name ?? ""), `Couldn't rename ${current}`) }],
  });
}

/**
 * What a delete will end, for the confirm: the panes the tree shows. The server also ends stray
 * live terminals still labelled with the deleted id (unplaced, so not in the tree), so a few more
 * may end than are listed.
 */
function Running({ panes, lead = "This ends" }: { readonly panes: readonly PaneNode[]; readonly lead?: string }) {
  if (panes.length === 0) return <p>Nothing is running in it.</p>;
  return (
    <>
      <p>{lead} {panes.length === 1 ? "this program" : `these ${String(panes.length)} programs`}:</p>
      <ul className="running" data-testid="running-list">
        {panes.map((p) => (
          <li key={p.id}>
            {p.name}
            {p.agent !== null && <span className="running-agent"> ({p.agent})</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

/** `parentId`: a space to nest it in (then its group is not asked); otherwise at the top, in `groupId`. */
export function newSpaceDialog(tree: Tree, groupId: string | null, parentId: string | null = null) {
  openDialog({
    title: "New space",
    fields: [
      { name: "name", label: "Name", value: "", placeholder: "Named after its folder if empty" },
      { name: "folder", label: "Folder", value: "~" },
      ...(parentId === null ? [groupField(tree, groupId)] : [parentField(tree, parentId, "Inside")]),
      { name: "start", label: "Start with", value: "terminal", options: [{ value: "terminal", label: "Terminal" }, { value: "claude", label: "Claude session" }] },
    ],
    buttons: [
      {
        label: "Create",
        run: async (v) => {
          const parent = parentId === null ? null : groupValue(v.parent);
          const folder = (v.folder ?? "").trim() || "~";
          const claude: ClaudeStart | undefined = v.start === "claude" ? { folder, model: "default", effort: "default", permission: "default", resume: null } : undefined;
          const result = await apply({ type: "space.create", name: v.name ?? "", folder, groupId: parent === null ? groupValue(v.group) : null, parentId: parent, ...(claude === undefined ? {} : { claude }) }, "Couldn't make the space");
          if (result.ok && result.created.spaceId !== undefined) navigate({ space: result.created.spaceId, tab: result.created.tabId ?? null, pane: null });
          return result;
        },
      },
    ],
  });
}

export function newGroupDialog(tree: Tree, parentId: string | null) {
  openDialog({
    title: "New group",
    fields: [{ name: "name", label: "Name", value: "" }, groupField(tree, parentId, "Inside")],
    buttons: [{ label: "Create", run: (v) => apply({ type: "group.create", name: v.name ?? "", parentId: groupValue(v.group) }, "Couldn't make the group") }],
  });
}

/** The + at the top of the tree. */
export function addMenu(tree: Tree) {
  openMenu("New", [
    { section: "Create", label: "New space", run: () => newSpaceDialog(tree, null) },
    { section: "Create", label: "New group", run: () => newGroupDialog(tree, null) },
  ]);
}

/** A message with an OK button. */
function notice(title: string, text: string) {
  openDialog({ title, body: <p>{text}</p>, buttons: [{ label: "OK", run: () => Promise.resolve({ ok: true, created: {} }) }] });
}

export const openSettings = (): void => navigate({ space: null, tab: null, pane: null, settings: true });

/** The gear in the sidebar header, beside +. */
export function SettingsButton() {
  const open = useRoute().settings === true;
  // Open settings; with settings already open, go back to where it was opened from.
  return (
    <button type="button" className="add gear" aria-label="Settings" aria-pressed={open} data-testid="open-settings" onClick={open ? goHome : openSettings}>
      ⚙
    </button>
  );
}

function showNewTab(space: SpaceNode, result: ActionResult): ActionResult {
  if (result.ok) navigate({ space: space.id, tab: result.created.tabId ?? null, pane: null }, { replace: true });
  return result;
}

/** A new terminal tab at the end of the space, opened at once. */
export async function newTab(space: SpaceNode): Promise<void> {
  const result = showNewTab(space, await apply({ type: "tab.create", spaceId: space.id, name: "" }, "Couldn't make the tab"));
  if (!result.ok) notice("Couldn't make a tab", result.error);
}

const options = (values: readonly string[], labels: Record<string, string> = {}) => values.map((v) => ({ value: v, label: labels[v] ?? v }));

/** The form for a new Claude session; the chat opens in its tab for the first message. */
export function newClaudeDialog(space: SpaceNode) {
  openDialog({
    title: "New Claude session",
    fields: [
      { name: "folder", label: "Folder", value: "~" },
      { name: "model", label: "Model", value: "default", options: options(CLAUDE_MODELS) },
      { name: "effort", label: "Effort", value: "default", options: options(CLAUDE_EFFORTS) },
      { name: "permission", label: "Permission mode", value: "default", options: options(CLAUDE_PERMISSIONS) },
    ],
    buttons: [
      {
        label: "Start",
        run: async (v) => {
          const claude: ClaudeStart = { folder: (v.folder ?? "").trim() || "~", model: (v.model ?? "default") as ClaudeStart["model"], effort: (v.effort ?? "default") as ClaudeStart["effort"], permission: (v.permission ?? "default") as ClaudeStart["permission"], resume: null };
          return showNewTab(space, await apply({ type: "tab.create", spaceId: space.id, name: "", claude }, "Couldn't make the tab"));
        },
      },
    ],
  });
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Pick a past Claude conversation (from `~/.claude/projects`) and resume it in a new tab of this space. */
export async function resumeConversationDialog(space: SpaceNode): Promise<void> {
  let list: Conversation[] = [];
  try {
    const res = await fetch("/api/conversations");
    if (res.status === 401) return toLogin();
    list = res.ok ? ((await res.json()) as Conversation[]) : [];
  } catch {
    return notice("Couldn't list conversations", "Can't reach herdr.");
  }
  if (list.length === 0) return notice("Resume a conversation", "There are no past Claude conversations to resume.");
  openDialog({
    title: "Resume a conversation",
    fields: [{ name: "conversation", label: "Conversation", value: list[0]?.session ?? "", options: list.map((c) => ({ value: c.session, label: `${c.title} · ${c.cwd} · ${when(c.updated)}` })) }],
    buttons: [
      {
        label: "Resume",
        run: async (v) => {
          const chosen = list.find((c) => c.session === v.conversation);
          if (chosen === undefined) return { ok: false, error: "Pick a conversation." };
          const claude: ClaudeStart = { folder: chosen.cwd, model: "default", effort: "default", permission: "default", resume: chosen.session };
          return showNewTab(space, await apply({ type: "tab.create", spaceId: space.id, name: "", claude }, "Couldn't make the tab"));
        },
      },
    ],
  });
}

/** What a new tab is: a terminal, a new Claude session, or a past conversation resumed. */
export function newTabMenu(space: SpaceNode) {
  openMenu("New tab", [
    { section: "New tab", label: "Terminal", run: () => void newTab(space) },
    { section: "New tab", label: "Claude session…", run: () => newClaudeDialog(space) },
    { section: "New tab", label: "Resume a conversation…", run: () => void resumeConversationDialog(space) },
  ]);
}

export function deleteSpaceDialog(space: SpaceNode, route: Route) {
  const below = spaceAndBelow(space);
  const remove = (children: "lift" | "delete") => {
    const gone = children === "delete" ? below : [space];
    return now({ type: "space.delete", id: space.id, children }, `Couldn't delete ${space.name}`, () => {
      if (gone.some((s) => s.id === route.space)) goHome();
    });
  };
  const own = space.tabs.flatMap(runningIn);
  if (space.children.length === 0) {
    openDialog({
      title: `Delete space ${space.name}?`,
      body: <Running panes={own} />,
      buttons: [{ label: own.length > 0 ? `Delete and end ${String(own.length)}` : "Delete", danger: true, run: () => remove("lift") }],
    });
    return;
  }
  const all = runningIn(space);
  const n = below.length - 1;
  openDialog({
    title: `Delete space ${space.name}?`,
    body: (
      <>
        <p>
          It holds {n === 1 ? "1 space" : `${String(n)} spaces`}. Move them up a level, or delete the whole subtree?
        </p>
        <Running panes={own} lead="Moving them up ends" />
        <Running panes={all} lead="Deleting all ends" />
      </>
    ),
    buttons: [
      { label: own.length > 0 ? `Move them up, end ${String(own.length)}` : "Move them up", run: () => remove("lift") },
      { label: all.length > 0 ? `Delete all, end ${String(all.length)}` : "Delete all", danger: true, run: () => remove("delete") },
    ],
  });
}

export function deleteGroupDialog(group: GroupNode, route: Route) {
  const running = runningIn(group);
  const spaces = group.spaces.length;
  const groups = group.groups.length;
  const holds = [spaces > 0 ? `${String(spaces)} space${spaces === 1 ? "" : "s"}` : "", groups > 0 ? `${String(groups)} group${groups === 1 ? "" : "s"}` : ""].filter((s) => s !== "").join(" and ");
  const deleteAll = () =>
    now({ type: "group.delete", id: group.id, children: "delete" }, `Couldn't delete ${group.name}`, () => {
      if (route.space !== null && containsSpace(group, route.space)) goHome();
    });
  if (holds === "") {
    openDialog({ title: `Delete group ${group.name}?`, body: <p>It is empty.</p>, buttons: [{ label: "Delete", danger: true, run: deleteAll }] });
    return;
  }
  openDialog({
    title: `Delete group ${group.name}?`,
    body: (
      <>
        <p>
          It holds {holds}. Move them up a level, or delete everything in it?
        </p>
        <Running panes={running} lead="Deleting all ends" />
      </>
    ),
    buttons: [
      { label: "Move them up", run: () => now({ type: "group.delete", id: group.id, children: "lift" }, `Couldn't delete ${group.name}`) },
      { label: running.length > 0 ? `Delete all, end ${String(running.length)}` : "Delete all", danger: true, run: deleteAll },
    ],
  });
}

function containsSpace(group: GroupNode, spaceId: string): boolean {
  return group.spaces.some((s) => s.id === spaceId) || group.groups.some((g) => containsSpace(g, spaceId));
}

export function moveSpaceDialog(tree: Tree, space: SpaceNode) {
  openDialog({
    title: `Move ${space.name}`,
    fields: [groupField(tree, groupOfSpace(tree, space.id)?.id ?? null, "To group")],
    buttons: [{ label: "Move", run: (v) => now({ type: "space.move", id: space.id, groupId: groupValue(v.group) }, `Couldn't move ${space.name}`) }],
  });
}

/** Nest a space in another, or bring it to the top level. Its own subtree is not offered (a cycle). */
export function reparentDialog(tree: Tree, space: SpaceNode) {
  openDialog({
    title: `Move ${space.name}`,
    fields: [parentField(tree, parentOfSpace(tree, space.id)?.id ?? null, "Inside", space)],
    buttons: [{ label: "Move", run: (v) => now({ type: "space.reparent", id: space.id, parentId: groupValue(v.parent) }, `Couldn't move ${space.name}`) }],
  });
}

export function deleteTabDialog(space: SpaceNode, tab: TabNode, route: Route) {
  const running = runningIn(tab);
  openDialog({
    title: `Close tab ${tab.name}?`,
    body: <Running panes={running} />,
    buttons: [
      {
        label: running.length > 0 ? `Close and end ${String(running.length)}` : "Close",
        danger: true,
        run: () =>
          now({ type: "tab.delete", id: tab.id }, `Couldn't close ${tab.name}`, () => {
            if (route.tab === tab.id) navigate({ space: space.id, tab: null, pane: null }, { replace: true });
          }),
      },
    ],
  });
}

export function closePaneDialog(pane: PaneNode) {
  const ends = pane.kind === "terminal";
  openDialog({
    title: `Close ${pane.name}?`,
    body: <p>{ends ? `This ends ${pane.name}${pane.agent !== null ? ` (${pane.agent})` : ""}.` : "This takes the pane out of its tab."}</p>,
    buttons: [{ label: "Close", danger: true, run: () => now({ type: "pane.close", id: pane.id }, `Couldn't close ${pane.name}`) }],
  });
}

export function groupItems(tree: Tree, group: GroupNode, route: Route): MenuItem[] {
  return [
    { section: "Group", label: "New space here", run: () => newSpaceDialog(tree, group.id) },
    { section: "Group", label: "New group inside", run: () => newGroupDialog(tree, group.id) },
    { section: "Group", label: "Rename", run: () => renameDialog("group", group.name, (name) => ({ type: "group.rename", id: group.id, name }), true) },
    { section: "Group", label: "Colour…", run: () => colourDialog("group", group.id, group.name, group.color) },
    { section: "Group", label: "Delete…", danger: true, run: () => deleteGroupDialog(group, route) },
  ];
}

export function spaceItems(tree: Tree, space: SpaceNode, route: Route): MenuItem[] {
  void refreshPushInfo();
  void loadSettings();
  const never = neverSleeps(space.name);
  const muted = pushInfo()?.muted.includes(space.id) === true;
  const top = parentOfSpace(tree, space.id) === null;
  return [
    { section: "Space", label: "New tab…", run: () => newTabMenu(space) },
    { section: "Space", label: "New space inside", run: () => newSpaceDialog(tree, null, space.id) },
    { section: "Space", label: "Rename", run: () => renameDialog("space", space.name, (name) => ({ type: "space.rename", id: space.id, name }), false) },
    { section: "Space", label: "Colour…", run: () => colourDialog("space", space.id, space.name, space.color) },
    { section: "Space", label: "Move to space…", run: () => reparentDialog(tree, space) },
    ...(top ? [{ section: "Space", label: "Move to group…", run: () => moveSpaceDialog(tree, space) }] : []),
    ...(pushInfo()?.enabled === true ? [{ section: "Notifications", label: muted ? "Unmute notifications" : "Mute notifications", run: () => void setMuted(space.id, !muted) }] : []),
    { section: "Notifications", label: space.quiet ? "Turn quiet off" : "Make quiet", run: () => void apply({ type: "space.quiet", id: space.id, quiet: !space.quiet }, `Couldn't change quiet for ${space.name}`) },
    { section: "Sleep", label: never ? "Allow sleep" : "Never sleep", run: () => void toggleNeverSleep(space.name, !never) },
    { section: "Space", label: "Delete…", danger: true, run: () => deleteSpaceDialog(space, route) },
  ];
}

/** Put a space on or off the auto-sleep job's never-sleep list; a refusal shows as a message. */
async function toggleNeverSleep(name: string, never: boolean): Promise<void> {
  const result = await changeSettings({ neverSleep: { space: name, never } });
  if (typeof result === "string") fail(`Couldn't change never sleep: ${result}`);
}

export function tabItems(space: SpaceNode, tab: TabNode, route: Route): MenuItem[] {
  return [
    { section: "Tab", label: "Rename tab", run: () => renameDialog("tab", tab.name, (name) => ({ type: "tab.rename", id: tab.id, name }), false) },
    { section: "Tab", label: "Close tab…", danger: true, run: () => deleteTabDialog(space, tab, route) },
  ];
}

/** Wake a sleeping session: it shows as waking at once; a refusal puts it back to sleep with a toast. The chat opens by itself once Claude is back. */
export async function resumePane(pane: PaneNode): Promise<void> {
  await apply({ type: "pane.wake", id: pane.id }, `Couldn't resume ${pane.name}`);
}

async function sleepPane(pane: PaneNode): Promise<void> {
  await apply({ type: "pane.sleep", id: pane.id }, `Couldn't put ${pane.name} to sleep`);
}

export function paneItems(pane: PaneNode): MenuItem[] {
  return [
    ...(pane.asleep ? [{ section: "Pane", label: "Resume", run: () => void resumePane(pane) }] : []),
    // An awake Claude that isn't working or waiting for an answer can sleep; the server refuses the others.
    ...(pane.agent === "claude" && pane.status !== "working" && pane.status !== "waiting" ? [{ section: "Pane", label: "Sleep", run: () => void sleepPane(pane) }] : []),
    { section: "Pane", label: "Close pane…", danger: true, run: () => closePaneDialog(pane) },
  ];
}
