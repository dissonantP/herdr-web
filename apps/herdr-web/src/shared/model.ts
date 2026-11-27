// The tree the UI draws, as the HTTP API sends it. Shared by the server and the UI; the UI imports
// nothing else from the server side.
//
// Order is meaningful everywhere: it is Herdr Desktop's sidebar order. Inside a group, its spaces
// come before the groups nested in it, as Desktop draws them.

import type { ClaudeStart, Created, PaneStatus } from "@herdr/server/model.ts";

// The package's part of the model, re-exported so the UI still imports only this folder.
export { CLAUDE_EFFORTS, CLAUDE_MODELS, CLAUDE_PERMISSIONS, type ClaudeStart, type Conversation, type Created, type PaneStatus } from "@herdr/server/model.ts";

/** A colour token as Desktop's palette and `group-color` / `space-color` take it: ansi1-ansi6 or `#rrggbb`, optional `inv:`, or `dim`. */
export function validColour(token: string): boolean {
  const base = token.startsWith("inv:") ? token.slice(4) : token;
  return token === "dim" || /^ansi[1-6]$/.test(base) || /^#[0-9a-f]{6}$/i.test(base);
}

export interface PaneNode {
  /** Stable id: the terminal address for a terminal pane, the layout block id for a mod pane. */
  readonly id: string;
  readonly kind: "terminal" | "mod";
  readonly name: string;
  /** The agent running in it (`"claude"`), or `null` for a shell or anything else. */
  readonly agent: string | null;
  readonly status: PaneStatus | null;
  /** Its agent can chat (the pane opens as a chat view with a switch to its terminal). */
  readonly chat: boolean;
  /**
   * Put to sleep (F50; herdr or an external `hc-sleep`): the agent ended to free memory and its session is kept
   * (`sleep.session` label); the pane holds a shell until it is woken. `agent` is `null` meanwhile.
   */
  readonly asleep: boolean;
  /** Being woken (a message or Resume was sent) and Claude is not up yet; the pane still shows as a chat. */
  readonly waking?: boolean;
  /** Labelled `herdr.inbox=hide` (AutoDev builders): the Inbox skips it. */
  readonly inboxHidden?: boolean;
  /** Finished and not yet viewed (herdr-core `done` with a turn past `herdr.seen`); cleared when a viewer opens the pane. */
  readonly unseen?: boolean;
  /** Dismissed from the Inbox; hidden there until the pane does something new. */
  readonly dismissed?: boolean;
}

export interface TabNode {
  readonly id: string;
  readonly name: string;
  readonly panes: readonly PaneNode[];
}

export interface SpaceNode {
  readonly id: string;
  readonly name: string;
  /** Quiet: it never pushes for itself; its parent orchestrator reports. */
  readonly quiet: boolean;
  /** The space's own Desktop colour token (see GroupNode.color), or `null` to follow its group. */
  readonly color: string | null;
  readonly tabs: readonly TabNode[];
  /** Spaces nested in it (`herdr-tree`), in the layout doc's order; never drawn as tabs. */
  readonly children: readonly SpaceNode[];
}

export interface GroupNode {
  readonly id: string;
  readonly name: string;
  /** Desktop's colour token (`ansi1`..`ansi6`, `#rrggbb`, optional `inv:` prefix, `dim`), or `null`. */
  readonly color: string | null;
  readonly spaces: readonly SpaceNode[];
  readonly groups: readonly GroupNode[];
}

export interface Tree {
  /**
   * Top-level spaces in no group; Desktop draws these first. A nested space is only ever in its parent's `children`.
   */
  readonly spaces: readonly SpaceNode[];
  readonly groups: readonly GroupNode[];
}

/** What `GET /api/tree` and each `/api/events` message carry. */
export type TreeMessage = { readonly ok: true; readonly tree: Tree } | { readonly ok: false; readonly error: string };

/**
 * A change to the hierarchy, as `POST /api/actions` takes it. Names are trimmed; `""` lets Herdr
 * name a space after its folder and a tab after its place.
 */
export type AdminAction =
  | { readonly type: "group.create"; readonly name: string; readonly parentId: string | null }
  | { readonly type: "group.rename"; readonly id: string; readonly name: string }
  /** `lift`: what is inside moves up a level; `delete`: it all goes and its programs end. */
  | { readonly type: "group.delete"; readonly id: string; readonly children: "lift" | "delete" }
  /** `parentId`: nested in that space (its group is then ignored); `null`: top level. */
  | { readonly type: "space.create"; readonly name: string; readonly folder: string; readonly groupId: string | null; readonly parentId: string | null; readonly claude?: ClaudeStart }
  /** A Desktop colour token (`ansi1`..`ansi6`, `#rrggbb`, optional `inv:`), or `null` for none. */
  | { readonly type: "group.color"; readonly id: string; readonly color: string | null }
  /** As a group's, plus `dim` (no colour even in a coloured group); `null`: same as its group. */
  | { readonly type: "space.color"; readonly id: string; readonly color: string | null }
  | { readonly type: "space.rename"; readonly id: string; readonly name: string }
  /** `children` (when it has nested spaces): `lift` moves them up a level; `delete` deletes the whole subtree. */
  | { readonly type: "space.delete"; readonly id: string; readonly children: "lift" | "delete" }
  /** Put a top-level space in a group (`null`: in no group). */
  | { readonly type: "space.move"; readonly id: string; readonly groupId: string | null }
  /** Nest a space in another (`null`: top level). A move that would make a cycle is refused. */
  | { readonly type: "space.reparent"; readonly id: string; readonly parentId: string | null }
  | { readonly type: "space.quiet"; readonly id: string; readonly quiet: boolean }
  /** A new tab at the end of the space: a terminal, or (`claude`) a Claude session started as the form says. */
  | { readonly type: "tab.create"; readonly spaceId: string; readonly name: string; readonly claude?: ClaudeStart }
  | { readonly type: "tab.rename"; readonly id: string; readonly name: string }
  | { readonly type: "tab.delete"; readonly id: string }
  | { readonly type: "pane.close"; readonly id: string }
  /** End an idle agent to free memory, keeping its session (as `hc-sleep` does). */
  | { readonly type: "pane.sleep"; readonly id: string }
  /** Bring a sleeping agent back in its pane, resuming its session (as `hc-wake` does). */
  | { readonly type: "pane.wake"; readonly id: string }
  /** A viewer saw the pane's latest turn: sets `herdr.seen` as Herdr Desktop does. */
  | { readonly type: "pane.seen"; readonly id: string }
  /** Hide the pane from the Inbox (and mark it seen) until it does something new. */
  | { readonly type: "pane.dismiss"; readonly id: string };

/** What `POST /api/actions` answers: what a create made (to open it), or why it failed. */
export type ActionResult =
  | { readonly ok: true; readonly created: Created }
  | { readonly ok: false; readonly error: string };
