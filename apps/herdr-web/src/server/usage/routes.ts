import type { IncomingMessage, ServerResponse } from "node:http";
import type { UsageService } from "./usage.ts";

// GET /api/usage  UsageReply: the plan's limits (5-hour, weekly) as `claude -p /usage` prints them, cached
// (usage.ts). Read-only; behind the app login and the Origin check like every other route.

/** Handles `/api/usage`; `false` when the path is not it. */
export function usageRoute(usage: UsageService, req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (pathname !== "/api/usage") return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return true;
  }
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(usage.get()));
  return true;
}
