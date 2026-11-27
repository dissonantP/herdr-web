// F27: a request that changes anything (every non-GET endpoint) or opens a WebSocket must come from
// a page on this app's own origin: its Origin header's host must equal the Host header. A missing
// Origin is refused too: browsers send it on these requests, and anything else is not the app.

export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || host === undefined || host === "") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The request's URL, or `null` when it does not parse (e.g. `//[`). */
export function parseRequestUrl(raw: string | undefined): URL | null {
  try {
    return new URL(raw ?? "/", "http://localhost");
  } catch {
    return null;
  }
}
