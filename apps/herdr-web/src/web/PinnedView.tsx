import type { Tree } from "../shared/model.ts";
import { addMenu, SettingsButton } from "./admin.tsx";
import { navigate, type Route } from "./router.ts";
import { shownPins } from "./nav-shortcuts.ts";
import { unpinSpace, usePins } from "./pins.ts";
import { findSpace, unseenIn, waitingIn, workingIn } from "./tree-utils.ts";
import { StatusDot } from "./StatusDot.tsx";
import { useSwipeAway } from "./useSwipeAway.ts";
import { ViewSwitch } from "./ViewSwitch.tsx";

function PinnedRow({ tree, id, selected }: { readonly tree: Tree; readonly id: string; readonly selected: boolean }) {
  const space = findSpace(tree, id);
  const swipe = useSwipeAway(() => unpinSpace(id), () => navigate({ space: id, tab: null, pane: null }));
  if (space === null) return null;
  const waiting = waitingIn(space);
  const working = waiting === 0 && workingIn(space) > 0;
  const finished = waiting === 0 && !working && unseenIn(space) > 0;
  return (
    <div className="inbox-row-wrap" style={swipe.style} {...swipe.handlers} data-testid="pinned-row-wrap">
      <button type="button" className={`inbox-row${selected ? " selected" : ""}`} data-testid="pinned-item" data-space={id}>
        {waiting > 0 && <span className="badge" title={`${String(waiting)} need input`}>{waiting}</span>}
        {working && <StatusDot state="working" label="Working" />}
        {finished && <StatusDot state="finished" label="Finished" />}
        <span className="inbox-name">{space.name}</span>
      </button>
      <button type="button" className="inbox-dismiss" aria-label={`Unpin ${space.name}`} data-testid="pinned-unpin" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => {
          e.stopPropagation();
          unpinSpace(id);
        }}>
        ×
      </button>
    </div>
  );
}

/** The Pinned view: only the pinned spaces (the pin bar's), in its order. Tap opens one; a swipe or the x unpins it. */
export function PinnedView({ tree, route }: { readonly tree: Tree; readonly route: Route }) {
  const { pins, loaded } = usePins();
  const shown = shownPins(tree, pins);
  return (
    <nav className="inbox" aria-label="Pinned" data-testid="pinned-view">
      <ViewSwitch mode="pinned" wrap />
      <div className="tree-search">
        <span className="inbox-title">Pinned</span>
        <span className="graph-spacer" />
        <button type="button" className="add" aria-label="New space or group" data-testid="add-node" onClick={() => addMenu(tree)}>
          +
        </button>
        <SettingsButton />
      </div>
      {shown.length === 0 && loaded && <div className="notice" data-testid="pinned-empty">Nothing pinned.</div>}
      {shown.map((id) => (
        <PinnedRow key={id} tree={tree} id={id} selected={route.space === id} />
      ))}
    </nav>
  );
}
