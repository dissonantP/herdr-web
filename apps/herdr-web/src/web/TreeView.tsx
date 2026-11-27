import { useState } from "react";
import { resolveColour, rowStyle, type RowColour } from "./row-colour.ts";
import type { GroupNode, PaneNode, SpaceNode, TabNode, Tree } from "../shared/model.ts";
import { addMenu, SettingsButton, groupItems, paneItems, spaceItems, tabItems } from "./admin.tsx";
import { useLongPress } from "./longpress.ts";
import { openMenu, type MenuItem } from "./overlay.tsx";
import { ViewSwitch } from "./ViewSwitch.tsx";
import { navigate, type Route } from "./router.ts";
import { dotState, filterTree, isSleeping, unseenIn, waitingIn, workingIn } from "./tree-utils.ts";
import { StatusDot } from "./StatusDot.tsx";

// The collapsible tree: group > space > tab > pane, in Herdr Desktop's order, with spaces nested in
// spaces (`herdr-tree`) under their parent's tabs. Groups start open, spaces start folded; the chevron folds, the name opens. Fold state is kept per browser.
// Every row's actions open from its ⋯ button, a long-press (phone) or a right-click; the + by the
// search box makes a space or group.

const FOLD_KEY = "herdr.tree.toggled";

function loadToggled(): Set<string> {
  try {
    const raw = window.localStorage.getItem(FOLD_KEY);
    return new Set(raw === null ? [] : (JSON.parse(raw) as string[]));
  } catch {
    return new Set();
  }
}

function saveToggled(toggled: Set<string>): void {
  try {
    window.localStorage.setItem(FOLD_KEY, JSON.stringify([...toggled]));
  } catch {
    // Storage blocked: folds just don't persist.
  }
}

interface RowProps {
  readonly depth: number;
  readonly kind: "group" | "space" | "tab" | "pane";
  readonly id: string;
  readonly name: string;
  readonly open?: boolean;
  readonly onToggle?: () => void;
  readonly onOpen?: () => void;
  readonly selected?: boolean;
  readonly colour?: RowColour | null;
  readonly extra?: React.ReactNode;
  /** The row's actions, for its ⋯ button, long-press and right-click. */
  readonly actions: () => readonly MenuItem[];
}

function Row({ depth, kind, id, name, open, onToggle, onOpen, selected, colour = null, extra, actions }: RowProps) {
  const menu = () => openMenu(`${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)} ${name}`, actions());
  const press = useLongPress(menu);
  return (
    <div
      className={`row row-${kind}${selected === true ? " selected" : ""}${colour === null ? "" : colour.inverted ? " row-inv" : " row-tint"}`}
      style={{ ...rowStyle(colour), paddingLeft: `calc(var(--indent) * ${String(depth)} + var(--space-2))` }}
      data-testid={`tree-${kind}`}
      data-id={id}
      data-depth={depth}
      {...press}
    >
      {onToggle === undefined ? (
        <span className="chevron-spacer" />
      ) : (
        <button type="button" className="chevron" aria-label={open === true ? `Fold ${name}` : `Unfold ${name}`} aria-expanded={open} onClick={onToggle}>
          {open === true ? "▾" : "▸"}
        </button>
      )}
      <button type="button" className="row-name" onClick={onOpen ?? onToggle}>
        {name}
      </button>
      {extra}
      {/* The ⋯ is drawn by CSS, so the row's text stays its name. */}
      <button type="button" className="row-more" aria-label={`Actions for ${name}`} data-testid="row-actions" onClick={menu} />
    </div>
  );
}

function paneStatus(pane: PaneNode) {
  const state = dotState(pane);
  if (state === "none") return null;
  return (
    <span className="status-wrap" data-testid="pane-status" data-status={state}>
      <StatusDot state={state} />
      <span className="status-text">{state}</span>
    </span>
  );
}

/** On a folded group or space: how many panes beneath it need input. */
function needsInputBadge(node: GroupNode | SpaceNode, open: boolean) {
  const count = open ? 0 : waitingIn(node);
  if (count === 0) return null;
  return (
    <span className="badge" data-testid="needs-input-badge" title={`${String(count)} need input`}>
      {count}
    </span>
  );
}

/**
 * A space's dot, folded or not: the most urgent state of every session in it (any tab, inbox-hidden ones included).
 * Waiting is the badge when folded, a dot when open.
 */
function rollupDot(node: SpaceNode, open: boolean) {
  if (waitingIn(node) > 0) return open ? <StatusDot state="waiting" className="row-dot" testId="row-waiting" label="Needs input" /> : null;
  if (workingIn(node) > 0) return <StatusDot state="working" className="row-dot" testId="row-working" label="Working" />;
  if (unseenIn(node) > 0) return <StatusDot state="finished" className="row-dot" testId="row-finished" label="Finished" />;
  if (isSleeping(node)) return <StatusDot state="asleep" className="row-dot" testId="row-asleep" label="Asleep" />;
  return null;
}

export interface TreeViewProps {
  readonly tree: Tree;
  readonly route: Route;
}

export function TreeView({ tree: fullTree, route }: TreeViewProps) {
  const [toggled, setToggled] = useState(loadToggled);
  const [query, setQuery] = useState("");
  const { tree, open: matchOpen } = filterTree(fullTree, query);
  const searching = query.trim() !== "";
  // A node is open when its default (groups open, spaces closed) has not been toggled; while
  // searching, a node with a match beneath it is open as well.
  const isOpen = (kind: "group" | "space", id: string) => matchOpen.has(id) || (kind !== "space") !== toggled.has(id);
  const toggle = (id: string) => {
    const next = new Set(toggled);
    if (!next.delete(id)) next.add(id);
    saveToggled(next);
    setToggled(next);
  };

  const pane = (space: SpaceNode, tab: TabNode, p: PaneNode, depth: number) => (
    <Row key={p.id} depth={depth} kind="pane" id={p.id} name={p.name} selected={route.space === space.id && route.pane === p.id}
      onOpen={() => navigate({ space: space.id, tab: tab.id, pane: p.id })} extra={paneStatus(p)} actions={() => paneItems(p)} />
  );
  const tab = (space: SpaceNode, t: TabNode, depth: number) => (
    <div key={t.id}>
      <Row depth={depth} kind="tab" id={t.id} name={t.name} onOpen={() => navigate({ space: space.id, tab: t.id, pane: null })} actions={() => tabItems(space, t, route)} />
      {t.panes.map((p) => pane(space, t, p, depth + 1))}
    </div>
  );
  const space = (s: SpaceNode, depth: number, inherited: string | null): React.ReactNode => {
    const open = isOpen("space", s.id);
    return (
      <div key={s.id}>
        <Row depth={depth} kind="space" id={s.id} name={s.name} open={open} onToggle={() => toggle(s.id)}
          onOpen={() => navigate({ space: s.id, tab: null, pane: null })} selected={route.space === s.id} colour={resolveColour(s.color, inherited)} extra={<>{needsInputBadge(s, open)}{rollupDot(s, open)}</>} actions={() => spaceItems(fullTree, s, route)} />
        {open && s.tabs.map((t) => tab(s, t, depth + 1))}
        {open && s.children.map((c) => space(c, depth + 1, inherited))}
      </div>
    );
  };
  const group = (g: GroupNode, depth: number) => {
    const open = isOpen("group", g.id);
    return (
      <div key={g.id} className="group">
        <Row depth={depth} kind="group" id={g.id} name={g.name} open={open} onToggle={() => toggle(g.id)} colour={resolveColour(g.color, null)} extra={needsInputBadge(g, open)} actions={() => groupItems(fullTree, g, route)} />
        {open && (
          <>
            {g.spaces.map((s) => space(s, depth + 1, g.color))}
            {g.groups.map((c) => group(c, depth + 1))}
          </>
        )}
      </div>
    );
  };

  return (
    <nav className="tree" aria-label="Spaces">
      <ViewSwitch mode="list" wrap />
      <div className="tree-search">
        <input type="search" role="searchbox" aria-label="Search spaces and sessions" placeholder="Search" data-testid="search-box" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="add" aria-label="New space or group" data-testid="add-node" onClick={() => addMenu(fullTree)}>
          +
        </button>
        <SettingsButton />
      </div>
      {searching && tree.spaces.length === 0 && tree.groups.length === 0 && <div className="notice" data-testid="search-empty">Nothing matches “{query.trim()}”.</div>}
      {tree.spaces.map((s) => space(s, 0, null))}
      {tree.groups.map((g) => group(g, 0))}
    </nav>
  );
}
