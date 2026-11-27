import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTree } from "./api.ts";
import { Overlay } from "./overlay.tsx";
import { refreshPushInfo } from "./push.ts";
import { Launcher, LauncherButton } from "./Launcher.tsx";
import { recordRecent } from "./launcher.ts";
import { InboxButton } from "./InboxButton.tsx";
import { InboxView } from "./InboxView.tsx";
import { PinnedView } from "./PinnedView.tsx";
import { PinBar } from "./PinBar.tsx";
import { ReplyNotify } from "./ReplyNotify.tsx";
import { UsageBar } from "./UsageBar.tsx";
import { SyncStatus, SyncToast } from "./SyncStatus.tsx";
import { pinSpace, unpinSpace, usePins } from "./pins.ts";
import { setGraphPrefs, useGraphPrefs, VIEWS_ENABLED } from "./graph-view.ts";
import { loadSettings, useInboxEnabled } from "./settings.ts";
import { goHome, navigate, parseRoute, useRoute } from "./router.ts";
import { shortcutTarget, type NavKey } from "./nav-shortcuts.ts";
import { SettingsPage } from "./SettingsPage.tsx";
import { SpaceView } from "./SpaceView.tsx";
import { findSpace } from "./tree-utils.ts";
import { TreeView } from "./TreeView.tsx";
import { SIDEBAR_DEFAULT, clampWidth, loadCollapsed, loadWidth, saveCollapsed, saveWidth } from "./sidebar-width.ts";
import { hint, pinNumber, pressed, useBindings } from "./shortcuts.ts";

const GraphView = lazy(() => import("./GraphView.tsx").then((m) => ({ default: m.GraphView })));

// Phone: the tree is home; a space opens full screen. Desktop: the tree in a sidebar and the
// selected space beside it.

const INBOX_PATH = "/inbox";
const WIDE = "(min-width: 900px)";

function useWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(WIDE);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(WIDE).matches,
  );
}

export function App() {
  const state = useTree();
  const route = useRoute();
  const wide = useWide();
  const [sidebarW, setSidebarW] = useState(loadWidth);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  useEffect(() => saveCollapsed(collapsed), [collapsed]);
  const toggleSidebar = useCallback(() => setCollapsed((c) => !c), []);
  const changeWidth = (px: number, save = true) => {
    const w = clampWidth(px, window.innerWidth);
    setSidebarW(w);
    if (save) saveWidth(w);
    return w;
  };
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    let last = sidebarW;
    const move = (ev: PointerEvent) => {
      last = changeWidth(ev.clientX, false);
    };
    const stop = () => {
      saveWidth(last);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
      target.removeEventListener("pointercancel", stop);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
    target.addEventListener("pointercancel", stop);
  };
  const inboxOn = useInboxEnabled();
  // A tapped notification bundle (public/sw.js) lands on /inbox: show the Inbox when that view is on,
  // else just the spaces list. Waits until the setting is known.
  const [wantInbox, setWantInbox] = useState(window.location.pathname === INBOX_PATH);
  useEffect(() => {
    if (!wantInbox || inboxOn === null) return;
    setWantInbox(false);
    if (inboxOn) setGraphPrefs({ mode: "inbox" });
    navigate({ space: null, tab: null, pane: null }, { replace: true });
  }, [wantInbox, inboxOn]);
  // A stored "inbox" or "pinned" shows the list unless the setting is known to be on.
  const picked = useGraphPrefs().mode;
  const mode = ((picked === "inbox" || picked === "pinned") && inboxOn !== true) || (picked === "graph" && !VIEWS_ENABLED) ? "list" : picked;
  const graph = mode === "graph";
  // The sidebar shortcut (Ctrl/Cmd+B by default, set in Settings) toggles the sidebar. Without Cmd it stays
  // with text fields and terminals (readline, tmux).
  const hasSidebar = wide && mode !== "graph";
  useEffect(() => {
    if (!hasSidebar) return;
    const onKey = (e: KeyboardEvent) => {
      if (!pressed("sidebar", e)) return;
      const el = e.target instanceof Element ? e.target : null;
      if (!e.metaKey && el?.closest("input, textarea, select, [contenteditable], .pane-terminal") != null) return;
      e.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar, hasSidebar]);
  const sidebarKeys = hint(useBindings().sidebar);
  const { loaded: pinsLoaded, pins: pinIds } = usePins();
  const tabsTree = state.tree;
  // Tab and pin shortcuts (task 097): they work from a terminal or the composer too, so they run in the
  // capture phase and stop the key before the terminal sees it. Both wrap at the ends.
  const treeRef = useRef(tabsTree);
  treeRef.current = tabsTree;
  const navRef = useRef({ route, pinIds });
  navRef.current = { route, pinIds };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = treeRef.current;
      if (t === null) return;
      const n = pinNumber(e);
      const key: NavKey | null = pressed("tabNext", e)
        ? { kind: "tab", dir: 1 }
        : pressed("tabPrev", e)
          ? { kind: "tab", dir: -1 }
          : pressed("pinNext", e)
            ? { kind: "pin", dir: 1 }
            : pressed("pinPrev", e)
              ? { kind: "pin", dir: -1 }
              : n !== null
                ? { kind: "pinAt", n }
                : null;
      if (key === null) return;
      e.preventDefault();
      e.stopPropagation();
      const to = shortcutTarget(t, navRef.current.route, navRef.current.pinIds, key);
      if (to !== null) navigate(to, { replace: true });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const pinned = useRef<string | null>(null);
  const treeSpaces = state.tree;
  const openSpace = route.space !== null && treeSpaces !== null && findSpace(treeSpaces, route.space) !== null ? route.space : null;
  // Opening a space pins it at the end (once per opening), so the pin bar doubles as recents.
  useEffect(() => {
    if (openSpace === null) {
      pinned.current = null;
      return;
    }
    if (!pinsLoaded || pinned.current === openSpace) return;
    pinned.current = openSpace;
    pinSpace(openSpace);
  }, [openSpace, pinsLoaded]);
  // The launcher lists recently opened spaces first.
  useEffect(() => {
    if (openSpace !== null) recordRecent(openSpace);
  }, [openSpace]);
  // Pins of spaces that were deleted go too, so they don't fill the bar's list.
  useEffect(() => {
    if (!pinsLoaded || treeSpaces === null) return;
    for (const id of pinIds) if (findSpace(treeSpaces, id) === null) unpinSpace(id);
  }, [pinIds, pinsLoaded, treeSpaces]);
  useEffect(() => {
    void loadSettings();
    void refreshPushInfo();
    // A tapped notification asks an open window to show its session (public/sw.js), without a reload.
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (data?.type === "open" && typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//")) {
        if (data.url === INBOX_PATH) setWantInbox(true);
        else navigate(parseRoute(data.url));
        (event.source as ServiceWorker | null)?.postMessage({ type: "opened" });
      }
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, []);

  if (state.tree === null) return state.error === null ? <div className="notice">Loading…</div> : <div className="notice" role="alert">Can't reach herdr-core: {state.error}</div>;

  const tree = state.tree;
  const space = route.space === null ? null : findSpace(tree, route.space);
  const main =
    route.settings === true ? <SettingsPage showBack={!wide || graph} /> : route.space === null ? null : space === null ? (
      <div className="notice">
        That space is gone.{" "}
        <button type="button" className="link" onClick={goHome}>
          Back to spaces
        </button>
      </div>
    ) : (
      <SpaceView tree={tree} space={space} route={route} showBack={!wide || graph} />
    );

  const inbox = mode === "inbox";
  const side = inbox ? <InboxView tree={tree} route={route} /> : mode === "pinned" ? <PinnedView tree={tree} route={route} /> : <TreeView tree={tree} route={route} />;
  const pins = <PinBar tree={tree} route={route} />;
  const shell = (body: React.ReactNode) => (
    <div className={`shell${wide ? " shell-wide" : ""}`}>
      <div className="topbar">
        {wide && !graph && (
          <button
            type="button"
            className="sidebar-toggle"
            data-testid="sidebar-toggle"
            aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
            aria-pressed={!collapsed}
            title={`${collapsed ? "Show" : "Hide"} sidebar${sidebarKeys === "" ? "" : ` (${sidebarKeys})`}`}
            onClick={toggleSidebar}
          >
            ☰
          </button>
        )}
        <LauncherButton />
        {!wide && <InboxButton tree={tree} />}
        {pins}
        <SyncStatus />
        <a
          className="gh-link"
          data-testid="gh-link"
          href="https://github.com/dissonantP/herdr-web"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="herdr-web on GitHub"
          title="herdr-web on GitHub"
        >
          <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
          </svg>
        </a>
      </div>
      <div className="shell-body">{body}</div>
      <ReplyNotify tree={tree} route={route} />
      <SyncToast />
      <UsageBar />
      <Launcher tree={tree} />
    </div>
  );

  if (graph) {
    // The node graph replaces the list. Desktop: a panel beside it opens the tapped space; phone: the
    // space is full screen and back returns to the graph.
    const view = (
      <Suspense fallback={<div className="notice">Loading…</div>}>
        <GraphView tree={tree} route={route} />
      </Suspense>
    );
    if (wide) {
      return shell(
        <div className={`layout-graph${main === null ? "" : " with-panel"}`}>
          <div className="graph-pane">{view}</div>
          {main !== null && (
            <aside className="graph-panel" data-testid="graph-panel">
              {main}
            </aside>
          )}
          <Overlay />
        </div>,
      );
    }
    return shell(
      <div className="layout-phone">
        {main ?? view}
        <Overlay />
      </div>,
    );
  }
  if (wide) {
    return shell(
      <div className="layout-wide" style={{ gridTemplateColumns: collapsed ? "1fr" : `${sidebarW}px 1fr` }}>
        {!collapsed && <aside className="sidebar">{side}</aside>}
        {!collapsed && <div
          className="sidebar-handle"
          data-testid="sidebar-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          style={{ left: sidebarW - 3 }}
          onPointerDown={startDrag}
          onDoubleClick={() => changeWidth(SIDEBAR_DEFAULT)}
        />}
        <main className="main">{main ?? <div className="notice">Pick a space or pane.</div>}</main>
        <Overlay />
      </div>,
    );
  }
  return shell(
    <div className="layout-phone">
      {main ?? side}
      <Overlay />
    </div>,
  );
}
