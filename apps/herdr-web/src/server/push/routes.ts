import type { IncomingMessage, ServerResponse } from "node:http";
import type { PushService } from "./service.ts";
import type { PushStore } from "./store.ts";
import { endpointAllowed } from "./webpush.ts";

// The push endpoints (behind the app login and the Origin check like every other route):
//   GET  /api/push                 {enabled, publicKey, paused, muted: [space ids], subscriptions}
//   POST /api/push/subscribe       {endpoint, keys: {p256dh, auth}}   this browser's subscription
//   POST /api/push/unsubscribe     {endpoint}
//   POST /api/push/settings        {paused: boolean} | {mute: space id, muted: boolean}
//   POST /api/push/test            a test push to every subscription
//   POST /api/presence             {id, panes: [pane ids]}  what this page shows (204)

export interface PushRouteDeps {
  readonly push: PushService;
  readonly store: PushStore;
  readonly allowInsecure: boolean;
}

const MAX_BODY = 8 * 1024;
const ID = /^[\w.-]{1,80}$/u;
const KEY = /^[\w-]{20,200}$/u;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    if (!/^application\/json\b/u.test(req.headers["content-type"] ?? "")) {
      req.resume();
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY) return resolve(null);
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/** Handles a request for `/api/push*` or `/api/presence`; `false` when the path is not one of them. */
export function pushRoute(deps: PushRouteDeps, req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  const { push, store } = deps;
  const get = req.method === "GET" || req.method === "HEAD";
  if (pathname === "/api/push" && get) {
    json(res, 200, { enabled: push.enabled, publicKey: push.publicKey, paused: store.paused(), muted: [...store.muted()], subscriptions: store.subscriptions().length });
    return true;
  }
  const post = (handler: (body: Record<string, unknown>) => void | Promise<void>) => {
    void (async () => {
      const body = await readJson(req);
      if (body === null) return json(res, 400, { ok: false, error: "send a small JSON object" });
      await handler(body);
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { ok: false, error: "failed" });
    });
  };
  if (req.method !== "POST") {
    if (pathname === "/api/presence" || pathname.startsWith("/api/push/")) {
      res.writeHead(405).end();
      return true;
    }
    return false;
  }
  switch (pathname) {
    case "/api/presence":
      post((b) => {
        const panes = Array.isArray(b.panes) ? b.panes.filter((p): p is string => typeof p === "string" && p.length <= 200).slice(0, 8) : null;
        if (typeof b.id !== "string" || !ID.test(b.id) || panes === null) return json(res, 400, { ok: false, error: "id and panes" });
        push.presence.report(b.id, panes);
        res.writeHead(204, { "cache-control": "no-store" }).end();
      });
      return true;
    case "/api/push/subscribe":
      post((b) => {
        if (!push.enabled) return json(res, 503, { ok: false, error: "Push is not set up on the server (no VAPID key file)." });
        const keys = typeof b.keys === "object" && b.keys !== null ? (b.keys as Record<string, unknown>) : {};
        const { endpoint } = b;
        if (typeof endpoint !== "string" || typeof keys.p256dh !== "string" || typeof keys.auth !== "string" || !KEY.test(keys.p256dh) || !KEY.test(keys.auth)) return json(res, 400, { ok: false, error: "endpoint and keys" });
        if (!endpointAllowed(endpoint, deps.allowInsecure)) return json(res, 400, { ok: false, error: "That push endpoint is not allowed." });
        if (!store.addSubscription({ endpoint, p256dh: keys.p256dh, auth: keys.auth })) return json(res, 409, { ok: false, error: "Too many subscribed browsers." });
        json(res, 200, { ok: true });
      });
      return true;
    case "/api/push/unsubscribe":
      post((b) => {
        if (typeof b.endpoint !== "string") return json(res, 400, { ok: false, error: "endpoint" });
        store.removeSubscription(b.endpoint);
        json(res, 200, { ok: true });
      });
      return true;
    case "/api/push/settings":
      post((b) => {
        if (typeof b.paused === "boolean") store.setPaused(b.paused);
        else if (typeof b.mute === "string" && b.mute.length > 0 && b.mute.length <= 200 && typeof b.muted === "boolean") store.setMuted(b.mute, b.muted);
        else return json(res, 400, { ok: false, error: "paused, or mute and muted" });
        json(res, 200, { ok: true, paused: store.paused(), muted: [...store.muted()] });
      });
      return true;
    case "/api/push/test":
      post(async () => {
        if (!push.enabled) return json(res, 503, { ok: false, error: "Push is not set up on the server (no VAPID key file)." });
        json(res, 200, { ok: true, sent: await push.sendTest() });
      });
      return true;
    default:
      return pathname.startsWith("/api/push/");
  }
}
