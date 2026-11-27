import { useEffect, useRef, useState } from "react";
import type { Tree } from "../shared/model.ts";
import { spaceItems } from "./admin.tsx";
import { guardNextClick } from "./longpress.ts";
import { openMenu } from "./overlay.tsx";
import { insertIndex, loadPins, movePin, reorderPins, unpinSpace, usePins } from "./pins.ts";
import { navigate, type Route } from "./router.ts";
import { shownPins } from "./nav-shortcuts.ts";
import { useIndexBadges } from "./shortcuts.ts";
import { findSpace, isSleeping, unseenIn, waitingIn, workingIn } from "./tree-utils.ts";
import { StatusDot } from "./StatusDot.tsx";

// The pin bar (F40): a horizontal strip at the top of every view. Opening a space pins it (App) so
// the bar doubles as recents. Tap a pin to open that space; the open one is highlighted and alone
// shows an unpin button. Drag a pin sideways to reorder (a mouse drags at once; a finger holds
// first, so a quick swipe still scrolls the bar).

const POLL_MS = 15_000;
const HOLD_MS = 350; // a finger must rest this long before a drag starts
const MOVE_PX = 6; // a mouse drag starts after this much movement
const SLOP_PX = 10; // a finger moving this far before the hold is a scroll

interface Drag {
  readonly id: string;
  readonly pointer: number;
  readonly startX: number;
  readonly touch: boolean;
  active: boolean;
  /** Android's contextmenu already opened the menu during the hold. */
  menu: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export function PinBar({ tree, route }: { readonly tree: Tree; readonly route: Route }) {
  const { pins, loaded } = usePins();
  const [drag, setDrag] = useState<{ id: string; dx: number; at: number } | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const badges = useIndexBadges();
  const state = useRef<Drag | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    void loadPins();
    const refresh = () => {
      if (document.visibilityState === "visible") void loadPins();
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    const t = setInterval(refresh, POLL_MS);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      clearInterval(t);
    };
  }, []);

  // While a finger drags a pin the bar must not scroll: stop the touch's default once the hold fired.
  useEffect(() => {
    const el = bar.current;
    if (el === null) return;
    const stop = (e: TouchEvent) => {
      if (state.current?.active === true && e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchmove", stop, { passive: false });
    return () => el.removeEventListener("touchmove", stop);
  }, []);

  const shown = shownPins(tree, pins);
  const chip = (id: string) => bar.current?.querySelector<HTMLElement>(`[data-pin="${CSS.escape(id)}"]`) ?? null;

  const landing = (id: string, x: number): number => {
    const centres = shown.filter((p) => p !== id).map((p) => {
      const r = chip(p)?.getBoundingClientRect();
      return r === undefined ? Infinity : r.left + r.width / 2;
    });
    return insertIndex(centres, x);
  };

  const menuFor = (id: string) => {
    const space = findSpace(tree, id);
    if (space === null) return;
    openMenu(space.name, [...spaceItems(tree, space, route), { section: "Space", label: "Unpin", run: () => unpinSpace(id) }]);
  };

  const finish = (commit: boolean, x: number) => {
    const d = state.current;
    state.current = null;
    if (d === null) return;
    if (d.timer !== null) clearTimeout(d.timer);
    if (d.active) {
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      if (commit && d.touch && Math.abs(x - d.startX) < MOVE_PX) {
        // Held and let go without moving: the long-press menu (the hold already armed the drag).
        // The release clicks a moment later on whatever is under the finger by then, the menu's
        // scrim, which would close the menu at once (task 046): swallow that click. (suppressClick
        // above is for the mouse and drag path; it resets too early for this late click.)
        if (!d.menu) {
          guardNextClick();
          menuFor(d.id);
        }
      } else if (commit) {
        const order = movePin(shown, d.id, landing(d.id, x));
        // Pins of spaces no longer shown keep their place at the end.
        if (order.join() !== shown.join()) reorderPins([...order, ...pins.filter((p) => !shown.includes(p))]);
      }
    }
    setDrag(null);
  };

  const onDown = (e: React.PointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-unpin]") !== null) return;
    const d: Drag = { id, pointer: e.pointerId, startX: e.clientX, touch: e.pointerType === "touch", active: false, menu: false, timer: null };
    state.current = d;
    const target = e.currentTarget;
    if (d.touch) {
      d.timer = setTimeout(() => {
        if (state.current !== d) return;
        d.active = true;
        target.setPointerCapture(d.pointer);
        setDrag({ id, dx: 0, at: shown.indexOf(id) });
      }, HOLD_MS);
    } else target.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = state.current;
    if (d === null || e.pointerId !== d.pointer) return;
    const dx = e.clientX - d.startX;
    if (!d.active) {
      if (d.touch) {
        if (Math.abs(dx) > SLOP_PX && d.timer !== null) {
          clearTimeout(d.timer); // a swipe: let the bar scroll
          state.current = null;
        }
        return;
      }
      if (Math.abs(dx) < MOVE_PX) return;
      d.active = true;
    }
    setDrag({ id: d.id, dx, at: landing(d.id, e.clientX) });
  };

  const others = drag === null ? [] : shown.filter((p) => p !== drag.id);
  return (
    <div className="pinbar" ref={bar} data-testid="pin-bar" role="tablist" aria-label="Pinned spaces">
      {shown.length === 0 && loaded && <span className="pin-empty">Open a space to pin it</span>}
      {shown.map((id, index) => {
        const space = findSpace(tree, id);
        if (space === null) return null;
        const active = route.space === id;
        const waiting = waitingIn(space);
        const working = waiting === 0 && workingIn(space) > 0; // the alert has priority
        const finished = waiting === 0 && !working && unseenIn(space) > 0;
        const dragging = drag?.id === id;
        const before = drag !== null && !dragging && others[drag.at] === id;
        const after = drag !== null && !dragging && drag.at >= others.length && others[others.length - 1] === id;
        return (
          <div
            key={id}
            role="tab"
            aria-selected={active}
            data-testid="pin"
            data-pin={id}
            className={`pin${active ? " active" : ""}${dragging ? " dragging" : ""}${before ? " drop-before" : ""}${after ? " drop-after" : ""}`}
            style={dragging ? { transform: `translateX(${String(drag.dx)}px)` } : undefined}
            // The click is on the chip, not its button: a captured pointer sends it to the chip.
            onClick={() => {
              if (!suppressClick.current) navigate({ space: id, tab: null, pane: null });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (state.current?.id === id) state.current.menu = true; // Android fires this during the hold: the release must not reopen it
              menuFor(id);
            }}
            onPointerDown={(e) => onDown(e, id)}
            onPointerMove={onMove}
            onPointerUp={(e) => finish(true, e.clientX)}
            onPointerCancel={(e) => finish(false, e.clientX)}
          >
            {badges && index < 9 && (
              <kbd className="pin-index" data-testid="pin-index" aria-hidden="true">
                {index + 1}
              </kbd>
            )}
            <button type="button" className="pin-name">
              {space.name}
            </button>
            {waiting > 0 && <span className="badge" title={`${String(waiting)} need input`}>{waiting}</span>}
            {working && <StatusDot state="working" testId="pin-working" label="Working" />}
            {finished && <StatusDot state="finished" testId="pin-finished" label="Finished" />}
            {isSleeping(space) && <StatusDot state="asleep" testId="pin-asleep" label="Asleep" />}
            {active && (
              <button
                type="button"
                className="pin-unpin"
                data-unpin=""
                data-testid="pin-unpin"
                aria-label={`Remove ${space.name} from pins`}
                title="Remove pin (sessions keep running)"
                onClick={(e) => {
                  e.stopPropagation();
                  unpinSpace(id);
                  navigate({ space: null, tab: null, pane: null }, { replace: true });
                }}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                  <path d="M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                </svg>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
