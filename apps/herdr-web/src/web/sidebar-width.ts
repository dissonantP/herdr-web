// Resizable desktop sidebar (task 63): the width is kept per browser in localStorage.
export const SIDEBAR_DEFAULT = 300;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 600;
const KEY = "herdr.sidebarWidth";

export function clampWidth(px: number, viewport = Infinity): number {
  const max = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, viewport - 320));
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN, px)));
}

export function loadWidth(): number {
  try {
    const n = Number(window.localStorage.getItem(KEY));
    return Number.isFinite(n) && n > 0 ? clampWidth(n, window.innerWidth) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

export function saveWidth(px: number): void {
  try {
    if (px === SIDEBAR_DEFAULT) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, String(px));
  } catch {
    // storage unavailable: the width just isn't remembered
  }
}

const COLLAPSED_KEY = "herdr.sidebarCollapsed";

export function loadCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(COLLAPSED_KEY, "1");
    else window.localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    // storage unavailable: the state just isn't remembered
  }
}
