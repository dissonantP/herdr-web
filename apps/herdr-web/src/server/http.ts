import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import type { InputResult, MenuAnswer } from "../shared/chat.ts";
import type { Created } from "@herdr/server/adapters/backend.ts";
import type { ActionResult, AdminAction, PaneNode, Tree } from "../shared/model.ts";
import { allSpaces } from "../shared/tree-walk.ts";
import { parseAction, runAction } from "./actions.ts";
import type { AgentAdapter } from "@herdr/server/adapters/agent.ts";
import { AdminError, type BackendAdapter } from "@herdr/server/adapters/backend.ts";
import type { Auth } from "./auth/auth.ts";
import { diagRoute } from "./diag.ts";
import { openChat } from "@herdr/server/chat-service.ts";
import { createSendOnce } from "./send-once.ts";
import { answerMenu, MAX_UPLOAD_BYTES, sendMessage, upload, wakeOnce, watchMenu, type Waker } from "./input-service.ts";
import { endedBy } from "./push/ends.ts";
import { pushRoute, type PushRouteDeps } from "./push/routes.ts";
import { pinsRoute } from "./pins/routes.ts";
import { usageRoute } from "./usage/routes.ts";
import type { UsageService } from "./usage/usage.ts";
import type { PinsStore } from "./pins/store.ts";
import { settingsRoute, type SettingsRouteDeps } from "./settings/routes.ts";
import { findPane } from "./tree-find.ts";
import { fetchSiteAllowed, setSecurityHeaders } from "./headers.ts";
import { parseRequestUrl, sameOrigin } from "@herdr/server/request.ts";
import { DEFAULT_ALLOWED_SOURCE, guardSource } from "./source-guard.ts";
import { attachTerminalSockets } from "@herdr/server/terminal-socket.ts";
import { serveUploadedImage } from "./upload-file.ts";
import type { TreeService } from "./tree-service.ts";

// The HTTP API the UI talks to, plus the built UI. It knows the tree service and nothing about
// which backend or agent sits behind it.
//
//   GET /api/tree    the tree now (TreeMessage)
//   GET /api/events  Server-Sent Events: the tree now, then again whenever it changes
//   GET /api/chat/<pane id>  Server-Sent Events: a pane's conversation (ChatEvent), from the agent
//                      adapter's transcript, and the menu on its screen; 404 for a pane that can't chat
//   GET /api/chat/<pane id>/commands  the agent's slash commands (SlashCommand[])
//   POST /api/chat/<pane id>/send {text} | /stop | /answer (MenuAnswer)   the chat's input (InputResult)
//   POST /api/chat/<pane id>/upload?name=<file>  the raw bytes of an attachment (<= 8 MB); answers its path
//   GET  /api/upload-image?path=<path>  an uploaded image back, for the chat's previews (upload-file.ts)
//   GET/POST /api/push..., POST /api/presence  web push: subscribe, mute, pause, what is open (push/routes.ts)
//   GET/POST /api/settings  the settings page: auto-sleep, inbox view (settings/routes.ts)
//   GET/POST /api/pins      the pin bar's list of space ids (pins/routes.ts)
//   GET  /api/usage         the Claude plan's 5-hour and weekly limits, cached (usage/routes.ts)
//   GET  /api/conversations  past Claude conversations to resume (claude/conversations.ts)
//   POST /api/actions  one change to the hierarchy (AdminAction), answered with ActionResult once
//                      the tree shows it
// Every request other than GET/HEAD must carry an Origin equal to its Host (F27), as must
// WebSocket upgrades (terminal-socket.ts). GETs of /api/* must not come from another site or a
// same-site sibling (Sec-Fetch-Site, headers.ts). Every response carries the CSP and framing headers.
//   WS  /api/terminal/<pane id>  a live terminal (terminal-socket.ts)
//   GET /api/session  204 with a live session, 401 without (the UI's check before going to login)
//   GET/POST /login, POST /api/logout  the app login (auth/auth.ts)
//   POST /api/diag  one diagnostic report, logged to the journal (diag.ts)
// Everything but the login page and the few files it uses (PUBLIC) needs a login session (F31):
// without one, /api answers 401 and pages redirect to /login. Without a credentials file the server
// refuses every request (503), so a missing login setup fails closed.

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** The largest action body read. */
const MAX_BODY_BYTES = 16 * 1024;

/** SSE comment lines keep proxies from closing an idle stream. */
const KEEPALIVE_MS = 25_000;

export interface HttpOptions {
  readonly tree: TreeService;
  readonly backend: BackendAdapter;
  /** The built UI (`dist/web`), or `null` to serve only the API (dev: Vite serves the UI). */
  readonly webRoot: string | null;
  /** The one source address served (private Traefik); default `DEFAULT_ALLOWED_SOURCE`. */
  readonly allowedSource?: string;
  /** Longest an SSE or terminal stream stays open before the server closes it (F26); default `DEFAULT_STREAM_MAX_MS`. */
  readonly streamMaxMs?: number;
  readonly auth: Auth;
  /** The agent adapters; a pane's chat comes from the one that recognised it. */
  readonly agents: readonly AgentAdapter[];
  /** Web push (F19-F21): its service, store and whether tests may use http endpoints. */
  readonly push: PushRouteDeps;
  /** The settings page's store (F51). */
  readonly settings: SettingsRouteDeps;
  /** The pin bar's list (F40). */
  readonly pins: PinsStore;
  /** The usage bar's plan limits. */
  readonly usage: UsageService;
  /** Where the core keeps uploaded files (served back as image previews). */
  readonly uploadsRoot: string;
}

/** Open chat streams allowed in all (each follows a transcript file). */
const MAX_CHAT_STREAMS = 12;
const CHAT_PATH = /^\/api\/chat\/([^/]+)(?:\/(commands|send|stop|answer|upload))?$/u;

/** Served without a session: what the login page itself uses, and the PWA's own files. */
function isPublic(pathname: string): boolean {
  return pathname === "/manifest.webmanifest" || pathname === "/sw.js" || /^\/icons\/[\w.-]+\.png$/u.test(pathname);
}

/**
 * Streams are closed after this long, so a stream cannot outlive an Authelia logout indefinitely:
 * the browser reconnects through Traefik, where Authelia checks the session again. Authelia
 * sessions here last a month ("remember me"), so a short cap costs little; reconnecting is quick.
 */
export const DEFAULT_STREAM_MAX_MS = 15 * 60_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function serveStatic(root: string, urlPath: string, res: ServerResponse): Promise<void> {
  const relative = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/u, "");
  let file = join(root, relative);
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(400).end();
    return;
  }
  let info = await stat(file).catch(() => null);
  // Client-side routes (`/s/...`) get the app shell.
  if (info === null || !info.isFile()) {
    file = join(root, "index.html");
    info = await stat(file).catch(() => null);
    if (info === null) {
      res.writeHead(404).end("UI not built: run npm run build");
      return;
    }
  }
  const hashed = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(file).pipe(res);
}

/** The built UI's entry script path (Vite hashes it per build), read fresh so a redeploy shows; `null` when there is no build. */
export async function currentBuild(webRoot: string | null): Promise<string | null> {
  if (webRoot === null) return null;
  const html = await readFile(join(webRoot, "index.html"), "utf8").catch(() => null);
  return html?.match(/<script[^>]*type="module"[^>]*src="([^"]*\/assets\/[^"]+)"/u)?.[1] ?? null;
}

function events(tree: TreeService, webRoot: string | null, req: IncomingMessage, res: ServerResponse, maxMs: number, track: (close: () => void) => () => void): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write("retry: 1000\n\n"); // reconnect quickly after the capped lifetime ends the stream
  const send = (message: unknown) => res.write(`data: ${JSON.stringify(message)}\n\n`);
  // Say which UI build is deployed, so an open page running an older one reloads (src/web/build.ts).
  void currentBuild(webRoot).then((build) => {
    if (build !== null && !res.writableEnded) res.write(`event: build\ndata: ${build}\n\n`);
  });
  const unsubscribe = tree.subscribe(send);
  void tree.get().then(send);
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
  res.on("error", () => undefined); // a write racing the client's disconnect
  // Capped lifetime: end the stream; EventSource reconnects by itself (through Authelia).
  const lifetime = setTimeout(() => res.end(), maxMs);
  const untrack = track(() => res.end()); // logout ends it (F31)
  req.on("close", () => {
    untrack();
    unsubscribe();
    clearInterval(keepalive);
    clearTimeout(lifetime);
  });
}

/** The pane and its agent when the pane can chat, else null. A sleeping or waking pane has no agent running, but its Claude session is a conversation (task 137). */
async function chatTarget(opts: HttpOptions, paneId: string): Promise<{ readonly paneId: string; readonly agent: AgentAdapter; readonly asleep: boolean } | null> {
  const message = await opts.tree.get();
  const pane = message.ok ? findPane(message.tree, paneId) : null;
  const agent = pane === null ? undefined : opts.agents.find((a) => a.name === (pane.agent ?? "claude"));
  if (pane === null || pane.kind !== "terminal" || !pane.chat || agent === undefined) return null;
  return { paneId: pane.id, agent, asleep: pane.asleep };
}

/** A pane's chat stream (conversation and menu), or a 404 when the pane can't chat. */
async function chat(opts: HttpOptions, paneId: string, req: IncomingMessage, res: ServerResponse, maxMs: number, track: (close: () => void) => () => void, open: { count: number }): Promise<void> {
  const target = await chatTarget(opts, paneId);
  if (req.destroyed) return; // the client left while the tree was read: nothing to start, nothing to clean up
  if (target === null) return sendJson(res, 404, { ok: false, error: "no chat for this pane" });
  const { agent, paneId: id } = target;
  if (open.count >= MAX_CHAT_STREAMS) return sendJson(res, 503, { ok: false, error: "too many chat streams" });
  open.count++;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write("retry: 1000\n\n");
  res.on("error", () => undefined);
  const write = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const subscription = openChat(opts.backend, agent, id, write);
  const menus = watchMenu(opts.backend, agent, id, (menu) => write({ type: "menu", menu }));
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
  const lifetime = setTimeout(() => res.end(), maxMs);
  const untrack = track(() => res.end());
  req.on("close", () => {
    open.count--;
    untrack();
    subscription.close();
    menus.close();
    clearInterval(keepalive);
    clearTimeout(lifetime);
  });
}

function readBytes(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        resolve(null); // the rest is read and dropped, so the 413 reaches the client
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  return (await readBytes(req, MAX_BODY_BYTES))?.toString("utf8") ?? null;
}

/** A JSON body as an object, or the reply already sent. */
async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  if (!/^application\/json\b/u.test(req.headers["content-type"] ?? "")) {
    sendJson(res, 415, { ok: false, error: "send JSON" });
    return null;
  }
  const text = await readBody(req);
  if (text === null) {
    res.setHeader("connection", "close");
    sendJson(res, 413, { ok: false, error: "too large" });
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // answered below
  }
  sendJson(res, 400, { ok: false, error: "not JSON" });
  return null;
}

/** A `MenuAnswer` from a request body, or why not. */
export function parseAnswer(body: Record<string, unknown>): MenuAnswer | { readonly invalid: string } {
  const { id, action } = body;
  if (typeof id !== "string" || id === "") return { invalid: "id" };
  if (action === "submit") return { id, action };
  if (action === "other") return typeof body.text === "string" ? { id, action, text: body.text } : { invalid: "text" };
  if (action === "pick" || action === "toggle") return Number.isSafeInteger(body.n) && (body.n as number) > 0 ? { id, action, n: body.n as number } : { invalid: "n" };
  return { invalid: "action" };
}

const sends = createSendOnce();

/** Uploads read at once (each holds up to 8 MB, then its base64 on the way to the core). */
const MAX_UPLOADS = 2;
const uploads = { count: 0 };

/** The pane in a fresh tree read; an unreadable tree or a missing pane is an error, never "awake". */
async function freshPane(opts: HttpOptions, paneId: string): Promise<PaneNode> {
  await opts.tree.refresh();
  const message = await opts.tree.get();
  const pane = message.ok ? findPane(message.tree, paneId) : null;
  if (pane === null) throw new AdminError("Can't tell whether that session is asleep right now; try again.");
  return pane;
}

/** Wake a sleeping pane for its message (or for Resume): marked waking so it stays a chat, whether it sleeps now, wake it, and whether Claude is back up. */
function wakeFor(opts: HttpOptions, agent: AgentAdapter, paneId: string): Waker {
  return {
    asleep: async () => (await freshPane(opts, paneId)).asleep,
    wake: async () => {
      opts.tree.markWaking(paneId);
      try {
        await opts.backend.wakePane(paneId);
        await opts.tree.refresh().catch(() => undefined); // every viewer sees "waking" now
      } catch (err) {
        opts.tree.unmarkWaking(paneId);
        throw err;
      }
    },
    up: async () => (await freshPane(opts, paneId).catch(() => null))?.agent === agent.name,
    failed: async () => {
      opts.tree.unmarkWaking(paneId);
      await opts.backend.restoreSleep(paneId);
      await opts.tree.refresh();
    },
  };
}

async function runWake(opts: HttpOptions, id: string): Promise<Created> {
  opts.tree.markWaking(id);
  try {
    return await runAction(opts.backend, claudeAgent(opts), { type: "pane.wake", id });
  } catch (err) {
    opts.tree.unmarkWaking(id);
    throw err;
  }
}

/** One of the chat's input requests for a pane that can chat. */
async function chatInput(opts: HttpOptions, paneId: string, what: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reply = (status: number, body: InputResult) => sendJson(res, status, body);
  const target = await chatTarget(opts, paneId);
  if (target === null) {
    req.resume();
    return reply(404, { ok: false, error: "no chat for this pane" });
  }
  const { agent } = target;
  try {
    // An upload is fine while asleep (the file waits beside the terminal; its path goes with the message that wakes it).
    if (target.asleep && what !== "send" && what !== "upload") {
      req.resume();
      return reply(409, { ok: false, error: "It is asleep; send a message to wake it." });
    }
    if (what === "upload") {
      if (uploads.count >= MAX_UPLOADS) {
        res.setHeader("connection", "close");
        req.resume();
        return reply(503, { ok: false, error: "Another upload is still going; try again in a moment." });
      }
      uploads.count++;
      try {
        const bytes = await readBytes(req, MAX_UPLOAD_BYTES);
        if (bytes === null) {
          res.setHeader("connection", "close");
          return reply(413, { ok: false, error: "Files up to 8 MB only." });
        }
        return reply(200, { ok: true, path: await upload(opts.backend, target.paneId, url.searchParams.get("name") ?? "", bytes) });
      } finally {
        uploads.count--;
      }
    }
    if (what === "stop") {
      req.resume();
      return reply(200, { ok: true, outcome: await opts.backend.interrupt(target.paneId) });
    }
    const body = await readJson(req, res);
    if (body === null) return;
    if (what === "send") {
      if (typeof body.text !== "string") return reply(400, { ok: false, error: "text" });
      const text = body.text;
      const deliver = () => sendMessage(opts.backend, agent, target.paneId, text, wakeFor(opts, agent, target.paneId));
      // A retry of the same message (a dropped connection during a long wake) joins the first attempt instead of sending again.
      await (typeof body.id === "string" && body.id !== "" ? sends.once(`${target.paneId}/${body.id}`, deliver) : deliver());
      return reply(200, { ok: true });
    }
    const answer = parseAnswer(body);
    if ("invalid" in answer) return reply(400, { ok: false, error: answer.invalid });
    reply(200, { ok: true, menu: await answerMenu(opts.backend, agent, target.paneId, answer) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply(err instanceof AdminError ? 409 : 502, { ok: false, error: message });
  }
}

/** Per-space settings follow a rename and drop with a delete (they are kept by space name). */
function settingsFollow(settings: SettingsRouteDeps["settings"], act: AdminAction, tree: Tree): void {
  if (act.type !== "space.rename" && act.type !== "space.delete") return;
  const space = allSpaces(tree).find((s) => s.id === act.id);
  if (space === undefined) return;
  settings.spaceRenamed(space.name, act.type === "space.rename" ? act.name : ""); // a delete drops it
}

/** The agent a new Claude tab starts (the only one that can start sessions today). */
function claudeAgent(opts: HttpOptions): AgentAdapter {
  const agent = opts.agents.find((a) => a.name === "claude");
  if (agent === undefined) throw new AdminError("Claude is not set up on this server.");
  return agent;
}

async function action(opts: HttpOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reply = (status: number, body: ActionResult) => sendJson(res, status, body);
  const parsed = await readJson(req, res);
  if (parsed === null) return;
  const act = parseAction(parsed);
  if ("invalid" in act) return reply(400, { ok: false, error: act.invalid });
  if (act.type === "pane.sleep" && opts.tree.waitingPanes().has(act.id)) return reply(400, { ok: false, error: "It is waiting for an answer; answer it first." });
  const before = await opts.tree.get();
  if (before.ok) opts.push.push.expectEnding(endedBy(act, before.tree)); // what this ends is not a session dying
  try {
    // Resume goes in line with the pane's messages, so it and a send never both wake it.
    const created = act.type === "pane.wake" ? await wakeOnce(act.id, async () => ((await wakeFor(opts, claudeAgent(opts), act.id).asleep()) ? runWake(opts, act.id) : {})) : await runAction(opts.backend, claudeAgent(opts), act);
    if (before.ok) settingsFollow(opts.settings.settings, act, before.tree);
    await opts.tree.refresh(); // the change is in the tree (and on its way to every stream) before the answer
    reply(200, { ok: true, created });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply(err instanceof AdminError ? 409 : 502, { ok: false, error: message });
  }
}

/** A pane id from the URL, or `""` (no pane has it) when it does not decode. */
function decodePane(part: string | undefined): string {
  try {
    return decodeURIComponent(part ?? "");
  } catch {
    return "";
  }
}

async function commands(opts: HttpOptions, paneId: string, res: ServerResponse): Promise<void> {
  const target = await chatTarget(opts, paneId);
  if (target === null) return sendJson(res, 404, { ok: false, error: "no chat for this pane" });
  const facts = await opts.backend.paneFacts(target.paneId);
  sendJson(res, 200, facts === null ? [] : await target.agent.commands(facts));
}

/** The HTTP server, plus `closeTerminals` to end the upgraded terminal sockets it no longer tracks. */
export type HerdrServer = Server & { closeTerminals(): void };

export function createHttpServer(opts: HttpOptions): HerdrServer {
  const streamMaxMs = opts.streamMaxMs ?? DEFAULT_STREAM_MAX_MS;
  const auth = opts.auth;
  const chats = { count: 0 };
  const server = createServer((req, res) => {
    setSecurityHeaders(res);
    const url = parseRequestUrl(req.url);
    if (url === null) {
      sendJson(res, 400, { ok: false, error: "bad request path" });
      return;
    }
    if (!auth.configured()) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("herdr login is not set up (see the server log).\n");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (!sameOrigin(req.headers.origin, req.headers.host)) {
        sendJson(res, 403, { ok: false, error: "cross-origin request refused" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/login") {
        auth.login(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
        return;
      }
    }
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/api/") && !fetchSiteAllowed(req)) {
      sendJson(res, 403, { ok: false, error: "cross-site request refused" });
      return;
    }
    if (url.pathname === "/login") {
      if (req.method === "GET" || req.method === "HEAD") auth.showLogin(req, res, url);
      else res.writeHead(405).end();
      return;
    }
    if (isPublic(url.pathname) && (req.method === "GET" || req.method === "HEAD") && opts.webRoot !== null) {
      serveStatic(opts.webRoot, url.pathname, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      return;
    }
    const session = auth.session(req, res);
    if (session === null) {
      if (url.pathname.startsWith("/api/") || (req.method !== "GET" && req.method !== "HEAD")) sendJson(res, 401, { ok: false, error: "log in" });
      else res.writeHead(302, { location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`, "cache-control": "no-store" }).end();
      return;
    }
    if ((url.pathname === "/api/presence" || url.pathname === "/api/push" || url.pathname.startsWith("/api/push/")) && pushRoute(opts.push, req, res, url.pathname)) return;
    if (settingsRoute(opts.settings, req, res, url.pathname)) return;
    if (diagRoute(req, res, url.pathname)) return;
    if (pinsRoute(opts.pins, req, res, url.pathname)) return;
    if (usageRoute(opts.usage, req, res, url.pathname)) return;
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.method === "POST" && url.pathname === "/api/actions") {
        action(opts, req, res).catch(() => {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: "failed" });
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/logout") {
        auth.logout(session, res);
        return;
      }
      const input = req.method === "POST" ? CHAT_PATH.exec(url.pathname) : null;
      if (input !== null && input[2] !== undefined && input[2] !== "commands") {
        const what = input[2];
        chatInput(opts, decodePane(input[1]), what, url, req, res).catch(() => {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: "failed" });
        });
        return;
      }
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === "/api/conversations") {
      Promise.all(opts.agents.map((a) => a.conversations()))
        .then((lists) => sendJson(res, 200, lists.flat().sort((a, b) => b.updated - a.updated)))
        .catch(() => sendJson(res, 500, { ok: false, error: "failed" }));
      return;
    }
    if (url.pathname === "/api/upload-image" && req.method === "GET") {
      void serveUploadedImage(opts.uploadsRoot, url.searchParams.get("path"), res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: "failed" });
      });
      return;
    }
    if (url.pathname === "/api/session") {
      res.writeHead(204, { "cache-control": "no-store" }).end();
      return;
    }
    if (url.pathname === "/api/tree") {
      void opts.tree.get().then((message) => sendJson(res, message.ok ? 200 : 503, message));
      return;
    }
    if (url.pathname === "/api/events") {
      events(opts.tree, opts.webRoot, req, res, streamMaxMs, (close) => auth.streams.track(session.id, close));
      return;
    }
    const chatMatch = CHAT_PATH.exec(url.pathname);
    if (chatMatch !== null && chatMatch[2] === "commands") {
      commands(opts, decodePane(chatMatch[1]), res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: "failed" });
      });
      return;
    }
    if (chatMatch !== null && chatMatch[2] === undefined) {
      chat(opts, decodePane(chatMatch[1]), req, res, streamMaxMs, (close) => auth.streams.track(session.id, close), chats).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: "failed" });
      });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { ok: false, error: "no such endpoint" });
      return;
    }
    if (opts.webRoot === null) {
      res.writeHead(404).end();
      return;
    }
    serveStatic(opts.webRoot, url.pathname, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  guardSource(server, opts.allowedSource ?? DEFAULT_ALLOWED_SOURCE);
  const terminals = attachTerminalSockets(server, opts.backend, streamMaxMs, {
    ready: () => auth.configured(),
    session: (req) => {
      const session = auth.session(req);
      return session === null ? null : { track: (close) => auth.streams.track(session.id, close) };
    },
    canAttach: async (id) => {
      const message = await opts.tree.get();
      return message.ok && findPane(message.tree, id)?.kind === "terminal";
    },
  });
  return Object.assign(server, { closeTerminals: terminals.closeAll });
}
