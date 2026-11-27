// Text zoom (tasks 071, 080): a pinch (or Ctrl+wheel) over the chat or the terminal scales that view's text only, kept per browser under its own key.
export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 2.5;
export const CHAT_ZOOM_KEY = "herdr.chatZoom";
export const TERMINAL_ZOOM_KEY = "herdr.terminalZoom";
const WHEEL_SENSITIVITY = 0.01; // zoom factor per wheel-delta pixel

export function clampZoom(z: number): number {
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 1000) / 1000;
}

export function wheelZoom(zoom: number, deltaY: number): number {
  return clampZoom(zoom * Math.exp(-deltaY * WHEEL_SENSITIVITY));
}

export function loadZoom(key = CHAT_ZOOM_KEY): number {
  try {
    const n = Number(window.localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? clampZoom(n) : 1;
  } catch {
    return 1;
  }
}

export function saveZoom(z: number, key = CHAT_ZOOM_KEY): void {
  try {
    if (z === 1) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(z));
  } catch {
    // storage unavailable: the size just isn't remembered
  }
}

/**
 * Two-finger pinch and Ctrl+wheel on `el` drive `apply` with the wanted zoom (unclamped). Capturing, non-passive
 * listeners block the browser's own page zoom over `el` only. Returns the cleanup.
 */
export function attachZoomGestures(el: HTMLElement, current: () => number, apply: (zoom: number) => void): () => void {
  const dist = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
  let start: { d: number; z: number } | null = null;
  const onTouchStart = (e: TouchEvent) => {
    start = e.touches.length === 2 ? { d: dist(e.touches), z: current() } : null;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    if (start === null) start = { d: dist(e.touches), z: current() };
    else if (start.d > 0) apply(start.z * (dist(e.touches) / start.d));
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) start = null;
  };
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    apply(wheelZoom(current(), e.deltaY));
  };
  el.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
  el.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
  el.addEventListener("touchend", onTouchEnd, { passive: true, capture: true });
  el.addEventListener("touchcancel", onTouchEnd, { passive: true, capture: true });
  el.addEventListener("wheel", onWheel, { passive: false, capture: true });
  return () => {
    el.removeEventListener("touchstart", onTouchStart, { capture: true });
    el.removeEventListener("touchmove", onTouchMove, { capture: true });
    el.removeEventListener("touchend", onTouchEnd, { capture: true });
    el.removeEventListener("touchcancel", onTouchEnd, { capture: true });
    el.removeEventListener("wheel", onWheel, { capture: true });
  };
}
