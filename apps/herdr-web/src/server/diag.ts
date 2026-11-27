import type { IncomingMessage, ServerResponse } from "node:http";

// The diagnostic trail (task 084): the service worker reports each notification tap, so a real
// phone's behaviour shows up in the server's journal
// (`journalctl _SYSTEMD_USER_UNIT=herdr.service --no-pager | grep 'diag '`). Behind the app login and the Origin check like
// every other route. Each report is one log line; only known fields are kept, strings are cut short,
// so nothing else the client sends gets logged.
//   POST /api/diag   {kind: "tap", ...fields below}

const MAX_BODY = 8 * 1024;
const MAX_TEXT = 300;
const MAX_WINDOWS = 10;

const FIELDS = ["kind", "sw", "tapped", "target", "matched", "picked", "acked", "action", "result", "error"] as const;

const clean = (value: unknown): unknown => {
  if (typeof value === "string") return value.slice(0, MAX_TEXT);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
};

/** The report as it is logged: the known fields only, short strings, at most a few windows. */
export function diagEntry(body: Record<string, unknown>): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  for (const key of FIELDS) {
    const v = clean(body[key]);
    if (v !== undefined) entry[key] = v;
  }
  if (Array.isArray(body.windows)) {
    entry.windows = body.windows.slice(0, MAX_WINDOWS).map((w: unknown) => {
      const o = typeof w === "object" && w !== null ? (w as Record<string, unknown>) : {};
      return { url: clean(o.url), focused: clean(o.focused), visibility: clean(o.visibility), controlled: clean(o.controlled) };
    });
  }
  return entry;
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

/** Handles `/api/diag`; `false` when the path is not it. */
export function diagRoute(req: IncomingMessage, res: ServerResponse, pathname: string, log: (line: string) => void = console.log): boolean {
  if (pathname !== "/api/diag") return false;
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return true;
  }
  void readJson(req).then((body) => {
    if (body === null) {
      res.writeHead(400).end();
      return;
    }
    log(`diag ${JSON.stringify(diagEntry(body))}`);
    res.writeHead(204, { "cache-control": "no-store" }).end();
  });
  return true;
}
