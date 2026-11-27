import type { IncomingMessage, ServerResponse } from "node:http";
import type { PushStore } from "../push/store.ts";
import { parseIdle, type SettingsStore } from "./store.ts";

// The settings endpoints (behind the app login and the Origin check like every other route):
//   GET  /api/settings   {autosleep: {enabled, idle, every, neverSleep: [space names]}, inbox, pushPaused}
//   POST /api/settings   {autosleep: {enabled?, idle?, every?}} | {inbox} | {neverSleep: {space, never}}
// The push pause is changed through POST /api/push/settings; it is only read here so the page has it all.

export interface SettingsRouteDeps {
  readonly settings: SettingsStore;
  readonly push: Pick<PushStore, "paused">;
}

const MAX_BODY = 4 * 1024;

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

const view = (deps: SettingsRouteDeps) => ({ ...deps.settings.get(), pushPaused: deps.push.paused() });

/** Handles `/api/settings`; `false` when the path is not it. */
export function settingsRoute(deps: SettingsRouteDeps, req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (pathname !== "/api/settings") return false;
  if (req.method === "GET" || req.method === "HEAD") {
    json(res, 200, view(deps));
    return true;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return true;
  }
  void (async () => {
    const body = await readJson(req);
    if (body === null) return json(res, 400, { ok: false, error: "send a small JSON object" });
    const { settings } = deps;
    const auto = body.autosleep;
    if (typeof auto === "object" && auto !== null && !Array.isArray(auto)) {
      const a = auto as Record<string, unknown>;
      if (a.enabled !== undefined && typeof a.enabled !== "boolean") return json(res, 400, { ok: false, error: "enabled must be true or false" });
      if (a.idle !== undefined && parseIdle(a.idle) === null) return json(res, 400, { ok: false, error: "idle must be like 90m, 3h or 1d" });
      if (a.every !== undefined && parseIdle(a.every) === null) return json(res, 400, { ok: false, error: "every must be like 90m, 3h or 1d" });
      if (a.idle !== undefined) settings.setIdle(a.idle);
      if (a.every !== undefined) settings.setEvery(a.every);
      if (typeof a.enabled === "boolean") settings.setAutosleepEnabled(a.enabled);
    } else if (typeof body.inbox === "boolean") settings.setInbox(body.inbox);
    else if (typeof body.neverSleep === "object" && body.neverSleep !== null) {
      const n = body.neverSleep as Record<string, unknown>;
      if (typeof n.space !== "string" || typeof n.never !== "boolean" || !settings.setNeverSleep(n.space, n.never)) return json(res, 400, { ok: false, error: "space and never" });
    } else return json(res, 400, { ok: false, error: "autosleep, inbox or neverSleep" });
    json(res, 200, { ok: true, ...view(deps) });
  })().catch(() => {
    if (!res.headersSent) json(res, 500, { ok: false, error: "failed" });
  });
  return true;
}
