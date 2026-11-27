import type { GroupNode, PaneNode, SpaceNode, Tree } from "../shared/model.ts";
import { dotState, type DotState } from "./tree-utils.ts";

// The node graph's data, laid out compactly with nesting drawn as boxes instead of edges: a group
// (and a nested group, from groups.json) is a labelled bordered container around its spaces; a space
// with child spaces (`herdr-tree`) or, when shown, sessions has a subtler box around itself and its
// subtree, its own node at the top of the box. Children inside a box are packed into rows that wrap
// at a width chosen so the whole drawing suits the viewport's aspect ratio (tall on a phone, wide on
// desktop): a wide fan-out becomes a compact grid, not one long row. Every node has two lines, the
// whole title (wrapped, the node grows to fit) and then its status, so a node's height is worked out
// here from the wrapped title.

export const SPACE_W = 140;
export const SESSION_W = 112;
const GAP = 6; // between siblings and rows, and between a node and its children
const BOX_PAD = 5; // inside a space's subtree box
const GROUP_PAD = 6; // inside a group box
const GROUP_LINE = 18; // a group label line (12px text)
const MARGIN = 8;
const PAD = 8; // matches --space-3 (node padding, sides)
const PAD_Y = 5; // matches --graph-pad-y (node padding, top and bottom)
const BORDER = 1;
const DOT_GAP = 16; // the status dot (8px) and the gap after it
const TITLE_LINE = 18; // 14px text
const STATUS_LINE = 14; // 12px text
const SESSION_TITLE_LINE = 16; // 12px text
let canvas: CanvasRenderingContext2D | null | undefined;

/** Width of text in the UI font, from a canvas when there is one, else a generous guess. */
function textWidth(text: string, px: number, weight = 400): number {
  if (canvas === undefined) {
    canvas = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  if (canvas === null) return text.length * px * 0.62;
  const family = typeof document === "undefined" ? "sans-serif" : getComputedStyle(document.body).fontFamily;
  canvas.font = `${String(weight)} ${String(px)}px ${family}`;
  return canvas.measureText(text).width;
}

/** How many lines a title takes at a width, wrapping at spaces and breaking a word that doesn't fit. */
export function titleLines(name: string, px: number, width: number, weight = 400): number {
  let lines = 1;
  let used = 0;
  const space = textWidth(" ", px, weight);
  for (const word of name.split(/\s+/u).filter((w) => w !== "")) {
    const w = textWidth(word, px, weight);
    if (used > 0 && used + space + w <= width) {
      used += space + w;
    } else if (used === 0 && w <= width) {
      used = w;
    } else {
      if (used > 0) lines += 1;
      // A word wider than a line breaks wherever it hits the edge.
      const extra = Math.floor(w / width);
      lines += extra;
      used = w - extra * width;
    }
  }
  return lines;
}

function nodeHeight(name: string, kind: "space" | "session", w: number, dot: boolean): number {
  const px = kind === "session" ? 12 : 14;
  const room = w - 2 * (PAD + BORDER) - (dot ? DOT_GAP : 0) - 2; // slack for rounding
  const line = kind === "session" ? SESSION_TITLE_LINE : TITLE_LINE;
  return titleLines(name, px, room, 400) * line + STATUS_LINE + 2 * (PAD_Y + BORDER);
}

/** What a space node shows: the most urgent state of its own sessions. */
export type SpaceStatus = DotState;

export function spaceStatus(space: SpaceNode): SpaceStatus {
  const panes = space.tabs.flatMap((t) => t.panes).filter((p) => p.kind === "terminal");
  if (panes.some((p) => !p.asleep && p.status === "waiting")) return "waiting";
  if (panes.some((p) => !p.asleep && p.status === "working")) return "working";
  if (panes.some((p) => dotState(p) === "finished")) return "finished";
  if (panes.some((p) => !p.asleep && p.status === "idle")) return "idle";
  if (panes.some((p) => p.asleep)) return "asleep";
  return "none";
}

/** The label a status goes by in the UI (`waiting` is "needs input"). */
export const STATUS_LABEL: Record<SpaceStatus, string> = { waiting: "needs input", working: "working", finished: "finished", idle: "idle", asleep: "asleep", none: "" };

export function paneState(pane: PaneNode): SpaceStatus {
  return dotState(pane);
}

export interface GraphNode {
  readonly id: string;
  /**
   * A group is a labelled container (no sessions of its own, not a place to open); a box is the
   * subtler container around a space and its subtree (`spaceId` is that space); a space or session
   * is a node.
   */
  readonly kind: "group" | "box" | "space" | "session";
  readonly name: string;
  /** The second line: a space's or session's status (empty when there is none). */
  readonly detail: string;
  readonly status: SpaceStatus;
  /** For a session: the space it belongs to and its tab (to open it). */
  readonly spaceId: string;
  readonly tabId: string | null;
  readonly paneId: string | null;
  /** For a group: its id in groups.json. */
  readonly groupId: string | null;
  /** The container this one is drawn in, or `null` at the top level. */
  readonly parent: string | null;
  /** How many containers deep it is; a container draws above the ones around it. */
  readonly depth: number;
  /** For a container: the height of its label strip. */
  readonly labelH: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface GraphModel {
  readonly nodes: readonly GraphNode[];
}

/** Session node ids can't clash with space ids: they carry the pane id under a prefix. */
export const sessionNodeId = (paneId: string) => `pane:${paneId}`;
export const groupNodeId = (groupId: string) => `group:${groupId}`;
export const boxNodeId = (spaceId: string) => `box:${spaceId}`;

type Item = Omit<GraphNode, "depth">;

/** What a block is laid out as: its size and the nodes inside it, placed from its own top-left corner. */
interface Block {
  readonly w: number;
  readonly h: number;
  readonly items: readonly Item[];
}

interface Shelf {
  readonly w: number;
  readonly h: number;
  readonly at: readonly { x: number; y: number }[];
}

/**
 * Lay blocks out, in order, each at the highest spot (then the leftmost) where it clears every block it overlaps horizontally inside
 * `width` without touching one already placed, so a short block's neighbour fills the space under
 * it instead of leaving a gap (like a masonry grid, but with blocks of any width).
 */
function shelf(blocks: readonly Block[], width: number): Shelf {
  const at: { x: number; y: number }[] = [];
  let w = 0;
  let h = 0;
  for (const b of blocks) {
    const xs = [0, ...at.map((p, i) => p.x + blocks[i]!.w + GAP)].filter((x) => x + b.w <= width || x === 0);
    let best = { x: 0, y: Infinity };
    for (const x of xs) {
      let y = 0;
      at.forEach((p, i) => {
        const o = blocks[i]!;
        if (x < p.x + o.w + GAP && p.x < x + b.w + GAP) y = Math.max(y, p.y + o.h + GAP);
      });
      if (y < best.y || (y === best.y && x < best.x)) best = { x, y };
    }
    at.push(best);
    w = Math.max(w, best.x + b.w);
    h = Math.max(h, best.y + b.h);
  }
  return { w, h, at };
}

/**
 * Pack blocks into the arrangement that would fill a viewport of this aspect (width / height) at
 * the largest zoom: the wrap width is tried from the widest block up to everything in one row.
 */
function pack(blocks: readonly Block[], aspect: number): Shelf {
  if (blocks.length === 0) return { w: 0, h: 0, at: [] };
  const widest = Math.max(...blocks.map((b) => b.w));
  const total = blocks.reduce((sum, b) => sum + b.w + GAP, -GAP);
  let best = shelf(blocks, widest);
  const cost = (r: Shelf) => Math.max(r.w, r.h * aspect);
  for (let width = widest + 8; width <= total; width += 8) {
    const r = shelf(blocks, width);
    if (cost(r) < cost(best) - 0.5 || (Math.abs(cost(r) - cost(best)) <= 0.5 && r.w * r.h < best.w * best.h)) best = r;
  }
  return best;
}

const shift = (items: readonly Item[], dx: number, dy: number): Item[] => items.map((i) => ({ ...i, x: i.x + dx, y: i.y + dy }));

/** Items with no container yet go in this one. */
const adopt = (items: readonly Item[], parent: string): Item[] => items.map((i) => (i.parent === null && i.id !== parent ? { ...i, parent } : i));

const base = (kind: GraphNode["kind"]) => ({ kind, status: "none" as SpaceStatus, spaceId: "", tabId: null, paneId: null, groupId: null, parent: null, labelH: 0, detail: "", x: 0, y: 0 });

export function buildGraph(tree: Tree, showSessions: boolean, aspect = 1.5): GraphModel {
  const spaceBlock = (space: SpaceNode): Block => {
    const status = spaceStatus(space);
    const head: Item = { ...base("space"), id: space.id, name: space.name, detail: STATUS_LABEL[status] || "no sessions", status, spaceId: space.id, w: SPACE_W, h: nodeHeight(space.name, "space", SPACE_W, status !== "none") };
    const inside: Block[] = [];
    if (showSessions) {
      for (const tab of space.tabs) {
        for (const pane of tab.panes) {
          const state = paneState(pane);
          const item: Item = { ...base("session"), id: sessionNodeId(pane.id), name: pane.name, detail: STATUS_LABEL[state] || "shell", status: state, spaceId: space.id, tabId: tab.id, paneId: pane.id, w: SESSION_W, h: nodeHeight(pane.name, "session", SESSION_W, state !== "none") };
          inside.push({ w: item.w, h: item.h, items: [item] });
        }
      }
    }
    for (const child of space.children) inside.push(spaceBlock(child));
    if (inside.length === 0) return { w: head.w, h: head.h, items: [head] };
    // The head sits above its children's rows, all inside the space's own box.
    const grid = pack(inside, aspect);
    const w = Math.max(head.w, grid.w) + 2 * BOX_PAD;
    const h = BOX_PAD + head.h + GAP + grid.h + BOX_PAD;
    const id = boxNodeId(space.id);
    const box: Item = { ...base("box"), id, name: space.name, spaceId: space.id, w, h };
    const items: Item[] = [box, ...shift([head], BOX_PAD, BOX_PAD)];
    inside.forEach((b, i) => items.push(...shift(b.items, BOX_PAD + grid.at[i]!.x, BOX_PAD + head.h + GAP + grid.at[i]!.y)));
    return { w, h, items: adopt(items, id) };
  };

  const groupBlock = (group: GroupNode): Block => {
    const inside = [...group.spaces.map(spaceBlock), ...group.groups.map(groupBlock)];
    const grid = pack(inside, aspect);
    const w = Math.max(grid.w, SPACE_W) + 2 * GROUP_PAD;
    const labelH = titleLines(group.name, 12, w - 2 * GROUP_PAD - 2, 600) * GROUP_LINE + GROUP_PAD;
    const h = labelH + (inside.length > 0 ? grid.h + GROUP_PAD : 0);
    const id = groupNodeId(group.id);
    const box: Item = { ...base("group"), id, name: group.name, groupId: group.id, w, h, labelH };
    const items: Item[] = [box];
    inside.forEach((b, i) => items.push(...shift(b.items, GROUP_PAD + grid.at[i]!.x, labelH + grid.at[i]!.y)));
    return { w, h, items: adopt(items, id) };
  };

  const top = [...tree.spaces.map(spaceBlock), ...tree.groups.map(groupBlock)];
  const grid = pack(top, aspect);
  const items: Item[] = [];
  top.forEach((b, i) => items.push(...shift(b.items, MARGIN + grid.at[i]!.x, MARGIN + grid.at[i]!.y)));
  // A container draws above the ones around it, the nodes above every container.
  const depthOf = new Map<string, number>();
  const nodes = items.map((i): GraphNode => {
    const depth = i.parent === null ? 0 : (depthOf.get(i.parent) ?? 0) + 1;
    depthOf.set(i.id, depth);
    return { ...i, depth };
  });
  return { nodes };
}
