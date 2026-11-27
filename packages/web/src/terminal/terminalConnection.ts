import { terminalReconnectPolicy } from "./terminalReconnectPolicy.ts";

// One terminal's WebSocket (server: @herdr/server/terminal-socket.ts): binary messages are the
// terminal's raw VT output going down and raw input bytes going up; a text message is JSON control
// (`{"type":"resize","cols":..,"rows":..}`). Reconnects with the borrowed backoff policy.

export type ConnectionState = "connecting" | "live" | "reconnecting" | "ended";

export interface TerminalConnectionHandlers {
  /** Output bytes. */
  onOutput(bytes: Uint8Array): void;
  /** The screen is about to be painted again from scratch (every (re)connect starts with a paint). */
  onFreshStart(): void;
  onState(state: ConnectionState): void;
  /** The connection is up: send the viewer's size now. */
  onOpen(): void;
  /** The socket dropped (not the terminal ending, not the lifetime cap): maybe the session is gone. */
  onDrop?(): void;
}

export interface TerminalConnection {
  sendInput(text: string): void;
  sendResize(cols: number, rows: number): void;
  close(): void;
}

/** The server's close code for "the terminal itself ended" (@herdr/server/terminal-socket.ts); any other close is a drop. */
const TERMINAL_ENDED = 4000;
/** The server's close code for "capped stream lifetime reached" (F26): reconnect at once, silently. */
const LIFETIME_REACHED = 4001;
/** Attempts in a row that never got a connection (a pane that is gone) before giving up. */
const MAX_FAILED_ATTEMPTS = 8;

export function socketUrl(paneId: string, location: Pick<Location, "protocol" | "host"> = window.location): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminal/${encodeURIComponent(paneId)}`;
}

export function connectTerminal(paneId: string, handlers: TerminalConnectionHandlers): TerminalConnection {
  const encoder = new TextEncoder();
  let socket: WebSocket | null = null;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let silentReopen = false;

  const open = () => {
    if (!silentReopen) handlers.onState(attempt === 0 ? "connecting" : "reconnecting");
    silentReopen = false;
    const ws = new WebSocket(socketUrl(paneId));
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      handlers.onFreshStart();
      handlers.onState("live");
      handlers.onOpen();
    };
    ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data !== "string") handlers.onOutput(new Uint8Array(event.data));
    };
    ws.onclose = (event) => {
      if (closed || socket !== ws) return;
      socket = null;
      if (event.code === TERMINAL_ENDED || attempt >= MAX_FAILED_ATTEMPTS) {
        handlers.onState("ended");
        return;
      }
      if (event.code === LIFETIME_REACHED) {
        silentReopen = true;
        retry = setTimeout(open, 0);
        return;
      }
      handlers.onDrop?.();
      const policy = terminalReconnectPolicy({ attempt, mode: "normal", immediate: false, foregroundFastAttemptsRemaining: 0 });
      attempt = policy.nextAttempt;
      handlers.onState("reconnecting");
      retry = setTimeout(open, policy.delayMs);
    };
  };
  open();

  return {
    sendInput(text) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(text));
    },
    sendResize(cols, rows) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols, rows }));
    },
    close() {
      closed = true;
      if (retry !== null) clearTimeout(retry);
      socket?.close();
      socket = null;
    },
  };
}
