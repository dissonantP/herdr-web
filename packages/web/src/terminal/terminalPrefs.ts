// Borrowed from kcosr/herdr-web (MIT, Copyright (c) 2026 Kevin; full notice in
// third_party/herdr-web-LICENSE), file web/src/terminalPrefs.ts at commit
// 92717f433b00881724b7f8bff328fb07d9fceab6. Changes for herdr are marked "herdr:".

export const DEFAULT_TERMINAL_FONT_SIZE_PX = 13;
export const MIN_TERMINAL_FONT_SIZE_PX = 10;
export const MAX_TERMINAL_FONT_SIZE_PX = 24;
export const DEFAULT_DESKTOP_COMMAND_COMPOSER = false;
export const DEFAULT_DESKTOP_COMMAND_ENTER_NEWLINE = true;

export function defaultTerminalCursorBlink(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
) {
  return !platform.toLowerCase().startsWith("win");
}

export function parseTerminalFontSizePx(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_FONT_SIZE_PX;
  }
  return Math.min(
    MAX_TERMINAL_FONT_SIZE_PX,
    Math.max(MIN_TERMINAL_FONT_SIZE_PX, Math.round(value)),
  );
}

export function parseDesktopCommandComposer(
  value: unknown,
  fallback = DEFAULT_DESKTOP_COMMAND_COMPOSER,
) {
  return typeof value === "boolean" ? value : fallback;
}

export function parseDesktopCommandEnterNewline(
  value: unknown,
  fallback = DEFAULT_DESKTOP_COMMAND_ENTER_NEWLINE,
) {
  return typeof value === "boolean" ? value : fallback;
}

export function parseTerminalCursorBlink(
  value: unknown,
  fallback = defaultTerminalCursorBlink(),
) {
  return typeof value === "boolean" ? value : fallback;
}
