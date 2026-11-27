import type { IncomingMessage, ServerResponse } from "node:http";

// Headers every response carries (task 052). The login page sets its own, stricter CSP.
//   script-src 'wasm-unsafe-eval': ghostty-web compiles its terminal WASM.
//   connect-src data:: ghostty-web fetches that WASM from a data: URL. 'self' covers the API,
//     the SSE streams and the same-origin terminal WebSocket.
//   style-src 'unsafe-inline': React and ghostty-web set inline styles.
//   img-src 'self' data: blob:: chat markdown never loads remote images; blob: is the composer's own thumbnail of a file just picked.
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("content-security-policy", APP_CSP);
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("x-content-type-options", "nosniff");
}

/**
 * Whether a request's Sec-Fetch-Site allows it to read `/api/*`: the app's own pages
 * (`same-origin`) or the user typing the URL (`none`). A same-site sibling page (another
 * app on a sibling subdomain) or a cross-site one is refused, so it cannot open and hold the
 * chat streams. A missing header (not a browser, or an old one) is allowed: the login session still guards it.
 */
export function fetchSiteAllowed(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

