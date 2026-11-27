import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { BackendAdapter } from "./adapters/backend.ts";
import { parseRequestUrl, sameOrigin } from "./request.ts";

// The live terminal over a WebSocket: `GET /api/terminal/<pane id>` upgrades to a stream.
//
//   server -> browser   binary messages: the terminal's raw VT output
//   browser -> server   binary messages: raw input bytes, typed as they are
//                       text messages: JSON control, `{"type":"resize","cols":80,"rows":24}`
//
// The app decides who may attach and to what (TerminalSocketGate); this module always refuses a
// page from another origin (F27). The server holds one backend attach per open socket and nothing
// else: the terminal itself lives in the backend. Browser side: @herdr/web/terminal/terminalConnection.ts.

const PATH = /^\/api\/terminal\/([^/]+)$/u;
/** A browser that stops reading must not make the backend hold unbounded output. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/** One input message (a paste) at most. */
const MAX_INPUT_BYTES = 1024 * 1024;

export interface ResizeMessage {
  readonly cols: number;
  readonly rows: number;
}

/** A well-formed resize control message, or `null`. */
export function parseResize(text: string): ResizeMessage | null {
  try {
    const value = JSON.parse(text) as { type?: unknown; cols?: unknown; rows?: unknown };
    const { cols, rows } = value;
    if (value.type !== "resize" || typeof cols !== "number" || typeof rows !== "number") return null;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return null;
    return { cols, rows };
  } catch {
    return null;
  }
}

function reject(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}

/** WebSocket close codes the browser tells apart: the terminal ended, or the stream failed. */
export const CLOSE_TERMINAL_ENDED = 4000;
const CLOSE_STREAM_FAILED = 1011;
const CLOSE_TOO_SLOW = 1013;
/** The capped stream lifetime ran out (F26): the browser reconnects at once, through Authelia. */
export const CLOSE_LIFETIME = 4001;
/** The session was logged out (F31): the browser checks its session and goes to the login page. */
export const CLOSE_LOGGED_OUT = 4002;
const CLOSE_GRACE_MS = 5000;

/** How often an idle socket is pinged; one that misses a pong is dead (a phone that went away). */
const PING_MS = 20_000;
/** Open sockets allowed in all, and on one pane (each holds a herdr-core attach and buffers). */
const MAX_SOCKETS = 16;
const MAX_SOCKETS_PER_PANE = 4;

function bridge(ws: WebSocket, paneId: string, backend: BackendAdapter, maxMs: number, track: (close: () => void) => () => void): void {
  let alive = true;
  const stream = backend.attachTerminal(paneId, {
    onData: (bytes) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) ws.close(CLOSE_TOO_SLOW, "client too slow");
      else ws.send(bytes, { binary: true });
    },
    onClose: (reason, ended) => {
      if (ws.readyState === ws.OPEN) ws.close(ended ? CLOSE_TERMINAL_ENDED : CLOSE_STREAM_FAILED, reason.slice(0, 100));
    },
  });
  const ping = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, PING_MS);
  ws.on("pong", () => {
    alive = true;
  });
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    alive = true;
    if (isBinary) {
      stream.write(data);
      return;
    }
    const resize = parseResize(data.toString("utf8"));
    if (resize !== null) stream.resize(resize.cols, resize.rows);
  });
  const lifetime = setTimeout(() => {
    ws.close(CLOSE_LIFETIME, "stream lifetime");
    setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref(); // a client that ignores the close frame
  }, maxMs);
  const untrack = track(() => {
    ws.close(CLOSE_LOGGED_OUT, "logged out");
    setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
  });
  const done = () => {
    untrack();
    clearTimeout(lifetime);
    clearInterval(ping);
    stream.close();
  };
  ws.on("close", done);
  ws.on("error", done);
}

/** The pane id in a terminal socket path, or `null` when the path is not one (or is malformed). */
export function paneIdOf(pathname: string): string | null {
  const match = PATH.exec(pathname);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
}

export interface TerminalSockets {
  /** End every open terminal socket (upgraded sockets are not the HTTP server's to close). */
  closeAll(): void;
}

/** The app's say over terminal sockets. */
export interface TerminalSocketGate {
  /** False refuses every upgrade with 503 (e.g. no login is set up yet). */
  ready(): boolean;
  /** The caller's login, or `null` (401). Asked again right before the upgrade; `track` ties the socket to that login, so logging out closes it. */
  session(req: IncomingMessage): { track(close: () => void): () => void } | null;
  /** Whether `paneId` is a terminal that may be attached (e.g. one in the app's current tree); false is 404. */
  canAttach(paneId: string): Promise<boolean>;
}

/** Serve terminal sockets on `server`'s upgrade requests. */
export function attachTerminalSockets(server: Server, backend: BackendAdapter, streamMaxMs: number, gate: TerminalSocketGate): TerminalSockets {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES });
  const perPane = new Map<string, number>();
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const url = parseRequestUrl(req.url);
    if (url === null) return reject(socket, "400 Bad Request");
    if (!PATH.test(url.pathname)) return reject(socket, "404 Not Found");
    if (!gate.ready()) return reject(socket, "503 Service Unavailable");
    if (!sameOrigin(req.headers.origin, req.headers.host)) return reject(socket, "403 Forbidden");
    if (gate.session(req) === null) return reject(socket, "401 Unauthorized");
    const id = paneIdOf(url.pathname);
    if (id === null) return reject(socket, "400 Bad Request");
    gate
      .canAttach(id)
      .then((ok) => {
        if (!ok) return reject(socket, "404 Not Found");
        if (sockets.clients.size >= MAX_SOCKETS || (perPane.get(id) ?? 0) >= MAX_SOCKETS_PER_PANE) return reject(socket, "503 Service Unavailable");
        const session = gate.session(req);
        if (session === null) return reject(socket, "401 Unauthorized"); // logged out meanwhile
        perPane.set(id, (perPane.get(id) ?? 0) + 1);
        sockets.handleUpgrade(req, socket, head, (ws) => {
          ws.on("close", () => perPane.set(id, (perPane.get(id) ?? 1) - 1));
          bridge(ws, id, backend, streamMaxMs, (close) => session.track(close));
        });
      })
      .catch(() => reject(socket, "503 Service Unavailable"));
  });
  return {
    closeAll() {
      for (const client of sockets.clients) client.terminate();
    },
  };
}
