import type { IncomingMessage, ServerResponse } from "node:http";
import type { PinsStore } from "./store.ts";

// GET  /api/pins   {pins: [space ids in order]}
// POST /api/pins   {pin: id} (appended at the end) | {unpin: id} | {order: [ids]}
// Behind the app login and the Origin check like every other route.

const MAX_BODY = 8 * 1024;

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

/** Handles `/api/pins`; `false` when the path is not it. */
export function pinsRoute(pins: PinsStore, req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (pathname !== "/api/pins") return false;
  if (req.method === "GET" || req.method === "HEAD") {
    json(res, 200, { pins: pins.get() });
    return true;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return true;
  }
  void (async () => {
    const body = await readJson(req);
    if (body === null) return json(res, 400, { ok: false, error: "send a small JSON object" });
    if (typeof body.pin === "string") {
      if (!pins.pin(body.pin)) return json(res, 400, { ok: false, error: "not a usable space id" });
    } else if (typeof body.unpin === "string") pins.unpin(body.unpin);
    else if (Array.isArray(body.order) && body.order.every((p) => typeof p === "string")) {
      if (!pins.reorder(body.order as string[])) return json(res, 400, { ok: false, error: "bad order" });
    } else return json(res, 400, { ok: false, error: "pin, unpin or order" });
    json(res, 200, { ok: true, pins: pins.get() });
  })().catch(() => {
    if (!res.headersSent) json(res, 500, { ok: false, error: "failed" });
  });
  return true;
}
