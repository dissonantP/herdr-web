import { useEffect, useRef } from "react";
import { encodeMobileTerminalChord, MOBILE_TERMINAL_SPECIAL_KEYS, type MobileTerminalChordKey } from "./terminal/mobileTerminalControls.ts";

// The special-keys bar under a terminal: Esc, Tab, a sticky Ctrl and the arrows. Keys are sent as
// the VT bytes a terminal sends for them (the encodings are borrowed from kcosr/herdr-web's mobile
// controls). herdr-core's `terminal.keys` is not used: it makes the first key after typed text wait
// about 3 s (HC_API.md), while raw bytes through the attach do not.

// One table: the bar's keys in order (`ctrl` is the sticky modifier, `paste` pastes the clipboard), with the label shown.
const LAYOUT: readonly { readonly id: string; readonly label: string }[] = [
  { id: "escape", label: "Esc" },
  { id: "tab", label: "Tab" },
  { id: "ctrl", label: "Ctrl" },
  { id: "arrow-left", label: "←" },
  { id: "arrow-up", label: "↑" },
  { id: "arrow-down", label: "↓" },
  { id: "arrow-right", label: "→" },
  { id: "paste", label: "Paste" },
];

const byId = new Map<string, MobileTerminalChordKey>(MOBILE_TERMINAL_SPECIAL_KEYS.map((k) => [k.id, k]));

export interface KeysBarProps {
  readonly ctrl: boolean;
  readonly onCtrl: (armed: boolean) => void;
  readonly onSend: (text: string) => void;
  /** Paste the clipboard into the terminal (phones have no Ctrl+V). */
  readonly onPaste: () => void;
}

// Holding an arrow repeats it like a physical key: after a short delay, then at a steady rate.
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 60;

export function KeysBar({ ctrl, onCtrl, onSend, onPaste }: KeysBarProps) {
  // The bar must not take focus from the terminal, or the soft keyboard would close on each tap.
  const keepFocus = { onPointerDown: (e: React.PointerEvent) => e.preventDefault(), onMouseDown: (e: React.MouseEvent) => e.preventDefault() };
  const press = (id: string) => {
    if (id === "ctrl") {
      onCtrl(!ctrl);
      return;
    }
    if (id === "paste") {
      onPaste();
      return;
    }
    const key = byId.get(id);
    if (key !== undefined) onSend(encodeMobileTerminalChord(key, ctrl ? ["ctrl"] : []));
    if (ctrl) onCtrl(false);
  };
  const timers = useRef<{ delay?: number; interval?: number }>({});
  const stopRepeat = () => {
    window.clearTimeout(timers.current.delay);
    window.clearInterval(timers.current.interval);
    timers.current = {};
  };
  useEffect(() => stopRepeat, []);
  const startRepeat = (id: string) => {
    stopRepeat();
    press(id);
    timers.current.delay = window.setTimeout(() => {
      timers.current.interval = window.setInterval(() => press(id), REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
  };
  return (
    <div className="keys-bar" role="toolbar" aria-label="Terminal keys" data-testid="keys-bar">
      {LAYOUT.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          className="key"
          data-key={id}
          aria-pressed={id === "ctrl" ? ctrl : undefined}
          {...keepFocus}
          {...(id.startsWith("arrow-")
            ? {
                // Pointer down sends and starts the repeat; the click that follows a pointer press is
                // ignored (detail 0 is a keyboard activation, which sends once).
                onPointerDown: (e: React.PointerEvent) => {
                  e.preventDefault();
                  startRepeat(id);
                },
                onPointerUp: stopRepeat,
                onPointerCancel: stopRepeat,
                onPointerLeave: stopRepeat,
                onClick: (e: React.MouseEvent) => {
                  if (e.detail === 0) press(id);
                },
                onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
              }
            : { onClick: () => press(id) })}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
