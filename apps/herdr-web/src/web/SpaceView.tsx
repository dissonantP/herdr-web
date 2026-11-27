import { useEffect, useState } from "react";
import type { PaneNode, SpaceNode, TabNode, Tree } from "../shared/model.ts";
import { apply, newTabMenu, paneItems, resumePane, spaceItems, tabItems } from "./admin.tsx";
import { ChatInput } from "./ChatInput.tsx";
import { ChatView } from "@herdr/web/ChatView.tsx";
import { useLongPress } from "./longpress.ts";
import { openMenu } from "./overlay.tsx";
import { setPaneView, usePaneView } from "./pane-view.ts";
import { usePresence } from "./push.ts";
import { goHome, navigate, type Route } from "./router.ts";
import { unseenIn, waitingIn, workingIn } from "./tree-utils.ts";
import { TerminalView } from "@herdr/web/TerminalView.tsx";
import { StatusDot } from "./StatusDot.tsx";

// One space: its tabs as a tab strip (child spaces never appear here), a pane switcher when the
// tab is split, and one pane at a time. Switching tab or pane replaces the history entry, so back
// always returns to the tree. The ⋯ in the bar holds the space's, tab's and pane's actions; + in the
// tab strip makes a terminal tab; long-press (or right-click) a tab for its own actions.

export interface SpaceViewProps {
  readonly tree: Tree;
  readonly space: SpaceNode;
  readonly route: Route;
  /** Phone: a back button returns to the tree. */
  readonly showBack: boolean;
}

/** A pane whose agent can chat opens as chat, with a switch to its raw terminal; every other terminal opens live. */
function PaneBody({ pane }: { readonly pane: PaneNode }) {
  const view = usePaneView();
  const [waking, setWaking] = useState(false);
  const live = pane.kind === "terminal";
  const working = pane.status === "working";
  if (live && pane.chat) {
    // Asleep (F50, task 137): its saved conversation shows and sending wakes it; the banner's Resume wakes it without a message.
    const banner = pane.waking === true ? (
      <div className="asleep-card waking-card" data-testid="waking-card" data-id={pane.id} role="status">
        <i className="waking-dot" aria-hidden="true" />
        <span>Waking {pane.name}…</span>
      </div>
    ) : (
      pane.asleep && (
      <div className="asleep-card" data-testid="asleep-card" data-id={pane.id}>
        <span>{pane.name} is asleep. Sending a message wakes it.</span>
        <button
          type="button"
          className="btn"
          data-testid="resume"
          disabled={waking}
          onClick={() => {
            setWaking(true);
            void resumePane(pane).finally(() => setTimeout(() => setWaking(false), 8000));
          }}
        >
          {waking ? "Waking…" : "Resume"}
        </button>
      </div>
      )
    );
    return (
      <div className="pane-body pane-terminal pane-chat" data-testid="pane-view" data-id={pane.id} data-view={view}>
        <div className="view-switch" role="tablist" aria-label="View">
          {(["chat", "terminal"] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className="view-pick" data-testid={`view-${v}`} onClick={() => setPaneView(v)}>
              {v === "chat" ? "Chat" : "Terminal"}
            </button>
          ))}
        </div>
        {banner}
        {/* Only the chosen view is mounted: one stream or one terminal attach, never both. */}
        {view === "chat" ? <ChatView key={pane.id} paneId={pane.id} working={working} footer={(menu, setMenu, messages) => <ChatInput paneId={pane.id} menu={menu} onMenu={setMenu} working={working} waking={pane.asleep || pane.waking === true} messages={messages} />} /> : <TerminalView key={pane.id} paneId={pane.id} />}
      </div>
    );
  }
  return (
    <div className={`pane-body${live ? " pane-terminal" : ""}`} data-testid="pane-view" data-id={pane.id}>
      <div className="pane-title" hidden={live}>
        {pane.name}
      </div>
      {live ? (
        <TerminalView key={pane.id} paneId={pane.id} />
      ) : (
        <div className="pane-meta">Desktop mod pane</div>
      )}
    </div>
  );
}

function TabButton({ tab, selected, onOpen, menu }: { readonly tab: TabNode; readonly selected: boolean; readonly onOpen: () => void; readonly menu: () => void }) {
  const press = useLongPress(menu);
  const asleep = tab.panes.some((p) => p.asleep);
  const waiting = waitingIn(tab);
  const working = waiting === 0 && workingIn(tab) > 0; // the alert has priority
  const finished = waiting === 0 && !working && unseenIn(tab) > 0;
  return (
    <button type="button" role="tab" aria-selected={selected} className="tab" data-asleep={asleep ? "true" : undefined} data-id={tab.id} onClick={onOpen} {...press}>
      {tab.name}
      {waiting > 0 && <span className="badge tab-badge" data-testid="tab-badge" aria-hidden="true" title={`${String(waiting)} need input`}>{waiting}</span>}
      {working && <StatusDot state="working" className="tab-working" testId="tab-working" />}
      {finished && <StatusDot state="finished" className="tab-working" testId="tab-finished" />}
      {asleep && (
        <span className="tab-zz" aria-hidden="true">
          {" ᶻᶻ"}
        </span>
      )}
    </button>
  );
}

function PanePick({ pane, selected, onOpen }: { readonly pane: PaneNode; readonly selected: boolean; readonly onOpen: () => void }) {
  const press = useLongPress(() => openMenu(`Pane ${pane.name}`, paneItems(pane)));
  return (
    <button type="button" role="tab" aria-selected={selected} className="pane-pick" data-id={pane.id} onClick={onOpen} {...press}>
      {pane.name}
    </button>
  );
}

export function SpaceView({ tree, space, route, showBack }: SpaceViewProps) {
  const tab = space.tabs.find((t) => t.id === route.tab) ?? space.tabs[0];
  const pane = tab?.panes.find((p) => p.id === route.pane) ?? tab?.panes[0];
  usePresence(pane?.id ?? null);
  // Viewing a finished pane marks its turn seen (herdr.seen), so the finished dots clear here and in Desktop.
  // It re-marks on every tree update while the pane is still unseen: a turn can finish again (or a mark can
  // land before the tree catches up) with the pane open, and the id alone doesn't change then.
  const unseenPane = pane?.unseen === true ? pane.id : null;
  useEffect(() => {
    if (unseenPane === null) return;
    const mark = () => {
      if (document.visibilityState !== "visible") return;
      void apply({ type: "pane.seen", id: unseenPane }, "Couldn't mark it seen", { quiet: true });
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [unseenPane, tree]);
  const go = (tabId: string, paneId: string | null) => navigate({ space: space.id, tab: tabId, pane: paneId }, { replace: true });

  return (
    <section className="space-view" data-testid="space-view" data-id={space.id}>
      <header className="bar">
        {showBack && (
          <button type="button" className="back" aria-label="Back to spaces" onClick={goHome}>
            ‹
          </button>
        )}
        <h1 className="bar-title">{space.name}</h1>
        <button
          type="button"
          className="bar-more"
          aria-label="Space actions"
          data-testid="space-actions"
          onClick={() => openMenu(space.name, [...spaceItems(tree, space, route), ...(tab === undefined ? [] : tabItems(space, tab, route)), ...(pane === undefined ? [] : paneItems(pane))])}
        >
          ⋯
        </button>
      </header>
      <div className="tabs" role="tablist" aria-label="Tabs">
        {space.tabs.map((t) => (
          <TabButton key={t.id} tab={t} selected={t.id === tab?.id} onOpen={() => go(t.id, null)} menu={() => openMenu(`Tab ${t.name}`, tabItems(space, t, route))} />
        ))}
        <button type="button" className="tab tab-add" aria-label="New tab" data-testid="tab-add" onClick={() => newTabMenu(space)}>
          +
        </button>
      </div>
      {tab !== undefined && tab.panes.length > 1 && (
        <div className="pane-switcher" role="tablist" aria-label="Panes">
          {tab.panes.map((p) => (
            <PanePick key={p.id} pane={p} selected={p.id === pane?.id} onOpen={() => go(tab.id, p.id)} />
          ))}
        </div>
      )}
      <div className="pane-area">{pane === undefined ? <div className="empty">Nothing running in this tab.</div> : <PaneBody key={pane.id} pane={pane} />}</div>
    </section>
  );
}
