import { useEffect, useRef, useState } from "react";
import { uploadFile } from "./chat-input.ts";
import { attachZoomGestures, clampZoom, loadZoom, saveZoom, TERMINAL_ZOOM_KEY } from "./chat-zoom.ts";
import { KeysBar } from "./KeysBar.tsx";
import { checkSession } from "./session.ts";
import { encodeMobileTerminalChord, mobileTerminalPrintableKey } from "./terminal/mobileTerminalControls.ts";
import { GhosttyRenderer } from "./terminal/terminalRenderer.ts";
import { connectTerminal, type ConnectionState, type TerminalConnection } from "./terminal/terminalConnection.ts";
import { DEFAULT_TERMINAL_FONT_SIZE_PX } from "./terminal/terminalPrefs.ts";
import { readTerminalTheme } from "./terminal/terminalTheme.ts";

// A live terminal for one pane: the borrowed ghostty-web renderer drawing the bytes the backend
// streams from herdr-core's `terminal.attach`, typing and the keys bar going back the same way.
// Remounted per pane (`key={pane.id}` in the caller), so one view is one attach.

const LABELS: Record<ConnectionState, string> = { connecting: "Connecting…", live: "Live", reconnecting: "Reconnecting…", ended: "Session ended" };

export interface TerminalViewProps {
  readonly paneId: string;
}

export function TerminalView({ paneId }: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const connection = useRef<TerminalConnection | null>(null);
  const ctrlRef = useRef(false);
  const [ctrl, setCtrl] = useState(false);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [screen, setScreen] = useState("");
  const [zoom, setZoom] = useState(() => loadZoom(TERMINAL_ZOOM_KEY));
  const zoomRef = useRef(zoom);

  const rendererRef = useRef<GhosttyRenderer | null>(null);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef(0);
  const flash = (text: string) => {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 1500);
  };

  // The Paste key: read the clipboard (needs the browser's permission; https only) and paste it like Ctrl+V.
  // If the browser refuses (or the user denies the permission), ask for the text instead so paste still works.
  const paste = async () => {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = window.prompt("Paste text to send to the terminal") ?? "";
    }
    if (text !== "") rendererRef.current?.paste(text);
    rendererRef.current?.focusTextInput();
  };

  const arm = (armed: boolean) => {
    ctrlRef.current = armed;
    setCtrl(armed);
  };

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const renderer = new GhosttyRenderer(DEFAULT_TERMINAL_FONT_SIZE_PX * zoomRef.current, undefined, readTerminalTheme(element));
    rendererRef.current = renderer;
    let disposed = false;
    let stopInput = () => {};
    let observer: ResizeObserver | null = null;

    const sendSize = () => {
      const size = renderer.fit();
      connection.current?.sendResize(size.cols, size.rows);
    };

    // Pinch or Ctrl+wheel over the terminal changes only its font size (task 080); the refit tells the core the new size.
    const applyZoom = (z: number) => {
      const next = clampZoom(z);
      if (next === zoomRef.current) return;
      zoomRef.current = next;
      setZoom(next);
      saveZoom(next, TERMINAL_ZOOM_KEY);
      renderer.setFontSize(DEFAULT_TERMINAL_FONT_SIZE_PX * next);
      sendSize();
    };
    const stopZoom = attachZoomGestures(element, () => zoomRef.current, applyZoom);

    void renderer.mount(element).then(() => {
      if (disposed) return;
      renderer.setAccessibleScreenListener(setScreen);
      renderer.setTapFocusHandler(() => "terminal");
      renderer.setMobileTouchSelection("copy", (event) => {
        if (event.type === "selection") void navigator.clipboard?.writeText(event.text).then(() => flash("Copied"), () => undefined);
        else window.open(event.url, "_blank", "noopener");
      }, 1500);
      // Only a Claude pane takes the upload (the server answers 404 for a plain shell, which shows as the notice).
      // An image on the clipboard: upload it as chat attachments are, then type its path into the terminal (Claude reads the file).
      renderer.setImagePasteHandler((files) => {
        void (async () => {
          for (const file of files) {
            const result = await uploadFile(paneId, file);
            if (result.ok && result.path !== undefined) renderer.paste(`${result.path} `);
            else flash(result.ok ? "No path returned" : result.error);
          }
        })();
      });
      stopInput = renderer.onInput((data) => {
        // Sticky Ctrl from the keys bar turns the next typed character into its control character.
        if (ctrlRef.current && Array.from(data).length === 1) {
          arm(false);
          connection.current?.sendInput(encodeMobileTerminalChord(mobileTerminalPrintableKey(data), ["ctrl"]));
          return;
        }
        connection.current?.sendInput(data);
      });
      connection.current = connectTerminal(paneId, {
        onOutput: (bytes) => renderer.write(bytes),
        // Every attach starts with a full paint of the screen: reset first so a reconnect doesn't double it.
        onFreshStart: () => renderer.write("\x1bc"),
        onState: setState,
        onOpen: sendSize,
        onDrop: () => void checkSession(),
      });
      observer = new ResizeObserver(sendSize);
      observer.observe(element);
      if (window.matchMedia("(pointer: fine)").matches) renderer.focus();
    });

    return () => {
      disposed = true;
      stopZoom();
      observer?.disconnect();
      stopInput();
      connection.current?.close();
      connection.current = null;
      rendererRef.current = null;
      window.clearTimeout(noticeTimer.current);
      renderer.dispose();
    };
  }, [paneId]);

  return (
    <div className="terminal-view" data-testid="terminal-view" data-state={state} data-zoom={zoom}>
      <div className="terminal-state" data-testid="terminal-state" data-state={state}>
        {LABELS[state]}
      </div>
      {notice !== "" && (
        <div className="terminal-notice" role="status" data-testid="terminal-notice">
          {notice}
        </div>
      )}
      <div ref={host} className="terminal-host" data-testid="terminal" />
      {/* The screen as text: what a screen reader reads, and what tests assert on. */}
      <pre className="sr-only" data-testid="terminal-text" aria-live="off">
        {screen}
      </pre>
      <KeysBar ctrl={ctrl} onCtrl={arm} onPaste={() => void paste()} onSend={(text) => connection.current?.sendInput(text)} />
    </div>
  );
}
