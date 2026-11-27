import type { Tree } from "../shared/model.ts";
import { addMenu, apply, SettingsButton } from "./admin.tsx";
import { navigate, type Route } from "./router.ts";
import { usePins } from "./pins.ts";
import { dotState, INBOX_ORDER, inboxItems, type InboxItem } from "./tree-utils.ts";
import { ViewSwitch } from "./ViewSwitch.tsx";
import { StatusDot } from "./StatusDot.tsx";
import { useSwipeAway } from "./useSwipeAway.ts";

/** The row goes at once (sync.ts); a refusal brings it back with a toast. */
function dismiss(paneId: string, name: string): Promise<boolean> {
  return apply({ type: "pane.dismiss", id: paneId }, `Couldn't dismiss ${name}`).then((r) => r.ok);
}

/** One Inbox row: tap opens the session, a sideways swipe or the x button dismisses it (until it does something new). */
function InboxRow({ item, selected }: { readonly item: InboxItem; readonly selected: boolean }) {
  const swipe = useSwipeAway(() => dismiss(item.pane.id, item.pane.name), () => navigate({ space: item.spaceId, tab: item.tabId, pane: item.pane.id }));
  return (
    <div className="inbox-row-wrap" style={swipe.style} {...swipe.handlers} data-testid="inbox-row-wrap">
      <button type="button" className={`inbox-row${selected ? " selected" : ""}`} data-testid="inbox-item" data-status={item.pane.status} data-pane={item.pane.id}>
        <StatusDot state={dotState(item.pane)} />
        <span className="inbox-name">{item.pane.name}</span>
        <span className="inbox-space">{item.spaceName}</span>
      </button>
      <button type="button" className="inbox-dismiss" aria-label={`Dismiss ${item.pane.name}`} data-testid="inbox-dismiss" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => {
          e.stopPropagation();
          void dismiss(item.pane.id, item.pane.name);
        }}>
        ×
      </button>
    </div>
  );
}

// The "needs you" inbox (F41), a view beside List and Pinned (shown only when the setting is on):
// every agent session, those waiting on you first, then working, then idle (idle ones only in pinned spaces). Tap one to open it.

export function InboxView({ tree, route }: { readonly tree: Tree; readonly route: Route }) {
  const { pins, loaded } = usePins();
  const items = inboxItems(tree, loaded ? pins : undefined);
  return (
    <nav className="inbox" aria-label="Needs you" data-testid="inbox-view">
      <ViewSwitch mode="inbox" wrap />
      <div className="tree-search">
        <span className="inbox-title">Needs you</span>
        <span className="graph-spacer" />
        <button type="button" className="add" aria-label="New space or group" data-testid="add-node" onClick={() => addMenu(tree)}>
          +
        </button>
        <SettingsButton />
      </div>
      {items.length === 0 && <div className="notice" data-testid="inbox-empty">No agent sessions running.</div>}
      {INBOX_ORDER.map((status) => {
        const group = items.filter((i) => i.pane.status === status);
        if (group.length === 0) return null;
        return (
          <section key={status} data-testid={`inbox-${status}`}>
            <h2 className="inbox-head">
              {status} · {group.length}
            </h2>
            {group.map((i) => (
              <InboxRow key={i.pane.id} item={i} selected={route.pane === i.pane.id} />
            ))}
          </section>
        );
      })}
    </nav>
  );
}
