import { useRef } from "react";
import type React from "react";

// Long-press to open a menu with a finger. iOS Safari never fires `contextmenu` for a touch (Android
// Chrome does), so this fires `open` itself after a rest of LONG_PRESS_MS. A scroll or drag cancels it
// (movement beyond SLOP_PX, or the browser's pointercancel), and the click that ends the press is
// swallowed so the row isn't also opened. A mouse or pen is left to the browser's right-click.

export const LONG_PRESS_MS = 500;
export const SLOP_PX = 10;
const CLICK_GUARD_MS = 400;

export interface LongPressHandlers {
  readonly onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: () => void;
  readonly onPointerCancel: () => void;
  readonly onContextMenu: (e: React.MouseEvent<HTMLElement>) => void;
}

interface Press {
  readonly pointer: number;
  readonly x: number;
  readonly y: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** The menu opened while the finger was still down. */
  fired: boolean;
}

/** Swallow the one click that follows a long-press, before React or the scrim sees it. */
export function guardNextClick(): void {
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    cleanup();
  };
  const cleanup = () => {
    window.removeEventListener("click", swallow, true);
    clearTimeout(timer);
  };
  const timer = setTimeout(cleanup, CLICK_GUARD_MS);
  window.addEventListener("click", swallow, true);
}

/**
 * Handlers for an element whose menu opens on a touch long-press and on right-click / Android's
 * contextmenu. Spread them onto the element. `open` always runs the latest closure.
 */
export function useLongPress(open: () => void): LongPressHandlers {
  const press = useRef<Press | null>(null);
  const latest = useRef(open);
  latest.current = open;
  /** The finger is up (or the browser took the touch). After a fired press, swallow the click it ends with. */
  const release = () => {
    const p = press.current;
    press.current = null;
    if (p === null) return;
    if (p.timer !== null) clearTimeout(p.timer);
    if (p.fired) guardNextClick();
  };
  return {
    onPointerDown: (e) => {
      release();
      if (e.pointerType !== "touch" || !e.isPrimary) return;
      const p: Press = { pointer: e.pointerId, x: e.clientX, y: e.clientY, timer: null, fired: false };
      p.timer = setTimeout(() => {
        if (press.current !== p) return;
        p.fired = true;
        latest.current();
      }, LONG_PRESS_MS);
      press.current = p;
    },
    onPointerMove: (e) => {
      const p = press.current;
      if (p === null || p.fired || e.pointerId !== p.pointer) return;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP_PX) release();
    },
    onPointerUp: release,
    onPointerCancel: release,
    onContextMenu: (e) => {
      e.preventDefault();
      const p = press.current;
      if (p?.fired === true) return; // our timer already opened it
      if (p !== null) {
        // Android's contextmenu came first: it owns this press, so the timer must not open it again.
        if (p.timer !== null) clearTimeout(p.timer);
        p.fired = true;
        p.timer = null;
      }
      latest.current();
    },
  };
}
