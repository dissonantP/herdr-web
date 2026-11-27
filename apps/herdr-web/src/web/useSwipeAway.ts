import { useRef, useState, type CSSProperties, type PointerEvent } from "react";

/** Dragged sideways at least this far (pixels), it is dismissed; less snaps back. */
export const SWIPE_PX = 60;
/** A press that moved less than this (pixels) is a tap. */
export const TAP_PX = 8;

// Swipe-to-dismiss shared by the reply banner and the Inbox rows (tasks 101, 104, 109): drag sideways past SWIPE_PX to dismiss,
// less snaps back; a press that moved under TAP_PX is a tap.

export interface SwipeAway {
  readonly style: CSSProperties;
  readonly handlers: {
    readonly onPointerDown: (e: PointerEvent<HTMLElement>) => void;
    readonly onPointerMove: (e: PointerEvent<HTMLElement>) => void;
    readonly onPointerUp: (e: PointerEvent<HTMLElement>) => void;
    readonly onPointerCancel: () => void;
    readonly onClick: () => void;
  };
}

/** `onDismiss` may return a promise resolving to false when the dismissal failed: the element then snaps back. */
export function useSwipeAway(onDismiss: () => void | Promise<boolean>, onTap: () => void): SwipeAway {
  const start = useRef<{ x: number; id: number } | null>(null);
  const dragged = useRef(false);
  const [dx, setDx] = useState(0);
  return {
    style: { transform: `translateX(${String(dx)}px)`, opacity: 1 - Math.min(Math.abs(dx) / (SWIPE_PX * 3), 0.7) },
    handlers: {
      onPointerDown: (e) => {
        start.current = { x: e.clientX, id: e.pointerId };
        dragged.current = false;
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerMove: (e) => {
        if (start.current?.id === e.pointerId) setDx(e.clientX - start.current.x);
      },
      onPointerUp: (e) => {
        if (start.current?.id !== e.pointerId) return;
        const moved = e.clientX - start.current.x;
        start.current = null;
        dragged.current = Math.abs(moved) >= TAP_PX;
        if (Math.abs(moved) >= SWIPE_PX) {
          void Promise.resolve(onDismiss()).then((ok) => {
            if (ok === false) setDx(0);
          });
        } else setDx(0);
      },
      // Tap on the click, not on pointerup: acting on pointerup can unmount the element before the browser's click for
      // the same touch lands, and that click hit whatever appeared there (real phone, task 104).
      onClick: () => {
        if (!dragged.current) onTap();
        dragged.current = false;
      },
      onPointerCancel: () => {
        start.current = null;
        setDx(0);
      },
    },
  };
}
