import { useEffect, useState } from "react";
import { ACTIONS, FIXED, display, fromEvent, isDefault, removeBinding, resetBindings, setBinding, setRecording, useBindings, type Action } from "./shortcuts.ts";

// The keyboard shortcuts section of Settings (task 074): each action's shortcuts, which can be changed,
// removed or added; a key press is recorded while a shortcut is being set. Kept per browser.

interface Recording {
  readonly action: Action;
  readonly replacing?: string;
}

export function ShortcutsSettings() {
  const bindings = useBindings();
  const [rec, setRec] = useState<Recording | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (rec === null) return;
    setRecording(true);
    // Capture phase on the window, ahead of the app's own shortcut handlers.
    const onKey = (e: KeyboardEvent) => {
      // Plain Tab moves focus on (and stops recording), so the keyboard is never trapped.
      if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) return setRec(null);
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return setRec(null);
      const b = fromEvent(e);
      if (b === null) return;
      const why = setBinding(rec.action, b, rec.replacing);
      setMessage(why);
      if (why === null) setRec(null);
    };
    // A click anywhere else cancels; a click on a shortcut button starts recording that one instead.
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || e.target.closest(".shortcut-key, .shortcut-add") === null) setRec(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("pointerdown", onDown);
    return () => {
      setRecording(false);
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("pointerdown", onDown);
    };
  }, [rec]);

  const start = (r: Recording) => {
    setMessage(null);
    setRec(r);
  };
  const isRec = (action: Action, replacing?: string) => rec !== null && rec.action === action && rec.replacing === replacing;

  return (
    <div className="settings-group" data-testid="shortcuts">
      <h2>Keyboard shortcuts</h2>
      {ACTIONS.map((a) => (
        <div className="shortcut shortcut-edit" key={a.id} data-testid={`shortcut-${a.id}`}>
          <span className="shortcut-label">{a.label}</span>
          <div className="shortcut-keys">
            {bindings[a.id].map((b) => (
              <span className="shortcut-chip" key={b}>
                <button type="button" className="shortcut-key" data-testid="shortcut-key" aria-label={`Change ${display(b)}`} aria-pressed={isRec(a.id, b)} onClick={() => start({ action: a.id, replacing: b })}>
                  {isRec(a.id, b) ? "Press a key…" : <kbd>{display(b)}</kbd>}
                </button>
                <button type="button" className="shortcut-remove" data-testid="shortcut-remove" aria-label={`Remove ${display(b)}`} onClick={() => removeBinding(a.id, b)}>
                  ×
                </button>
              </span>
            ))}
            <button type="button" className="shortcut-add" data-testid="shortcut-add" aria-pressed={isRec(a.id)} onClick={() => start({ action: a.id })}>
              {isRec(a.id) ? "Press a key…" : "Add"}
            </button>
          </div>
        </div>
      ))}
      {message !== null && (
        <div className="setting-error" role="alert" data-testid="shortcut-error">
          {message}
        </div>
      )}
      <div className="setting-hint">{rec === null ? "Click a shortcut to change it, × to remove it. Saved in this browser only." : "Press the new keys, or Escape to cancel."}</div>
      <div className="setting">
        <span>Reset all shortcuts to defaults</span>
        <button
          type="button"
          data-testid="shortcuts-reset"
          disabled={isDefault(bindings)}
          onClick={() => {
            setRec(null);
            setMessage(null);
            resetBindings();
          }}
        >
          Reset
        </button>
      </div>
      <h3 className="shortcut-fixed-title">Fixed keys</h3>
      {FIXED.map((f) => (
        <div className="shortcut" key={f.keys}>
          <span className="shortcut-label">{f.label}</span>
          <div className="shortcut-keys">
            <kbd>{f.keys}</kbd>
          </div>
        </div>
      ))}
    </div>
  );
}
