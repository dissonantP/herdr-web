import type { IncomingMessage, ServerResponse } from "node:http";
import type { CredentialsFile } from "./credentials.ts";
import { LoginLimiter } from "./limiter.ts";
import { loginPage } from "./login-page.ts";
import { verifyPassword } from "./password.ts";
import { SESSION_TTL_MS, SessionStore, StreamRegistry, type Session } from "./sessions.ts";

// The app login on top of Authelia (F30-F31), as the HTTP layer uses it:
//   GET  /login        the login page
//   POST /login        username + password (form); a session cookie and a redirect on success
//   POST /api/logout   ends this session and closes its open streams
// `session(req, res)` gates every other route, stream and upgrade (http.ts, terminal-socket.ts).

export const COOKIE = "__Host-herdr_session";
const MAX_FORM_BYTES = 4096;
const MAX_FIELD = 1024;
const GENERIC_ERROR = "Wrong username or password.";

export interface AuthOptions {
  readonly credentials: CredentialsFile;
  readonly sessions: SessionStore;
}

function cookieHeader(token: string, maxAgeS: number): string {
  return `${COOKIE}=${token}; Path=/; Max-Age=${String(maxAgeS)}; HttpOnly; Secure; SameSite=Lax`;
}

function tokenOf(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) {
      const value = part.slice(eq + 1).trim();
      return /^[A-Za-z0-9_-]{20,100}$/u.test(value) ? value : null;
    }
  }
  return null;
}

/** Where to go after logging in: a path on this site only (never `//host` or a scheme). */
export function safeNext(next: string | null | undefined): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.startsWith("/login")) return "/";
  return /^[\x21-\x7e]{1,512}$/u.test(next) ? next : "/";
}

function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) {
        req.pause(); // answered at once (413, connection: close); the rest is never read
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

function html(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    ...headers,
  });
  res.end(body);
}

export class Auth {
  readonly streams = new StreamRegistry();
  private readonly limiter = new LoginLimiter();
  private verifying = false;
  private readonly opts: AuthOptions;

  constructor(opts: AuthOptions) {
    this.opts = opts;
  }

  /** Whether a usable credentials file exists; without one the server refuses everything. */
  configured(): boolean {
    return this.opts.credentials.get().ok;
  }

  /**
   * The request's live session, or `null`. With `res` (a plain HTTP answer) the expiry slides and
   * the cookie goes out again when it moved; without (an upgrade) it does not slide.
   */
  session(req: IncomingMessage, res?: ServerResponse): Session | null {
    const creds = this.opts.credentials.get();
    const token = tokenOf(req);
    if (!creds.ok || token === null) return null;
    const session = this.opts.sessions.check(token, creds.credentials.fingerprint, res !== undefined && !res.headersSent);
    if (session?.refreshed === true && res !== undefined) res.setHeader("set-cookie", cookieHeader(token, SESSION_TTL_MS / 1000));
    return session;
  }

  showLogin(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (this.session(req) !== null) {
      res.writeHead(303, { location: safeNext(url.searchParams.get("next")), "cache-control": "no-store" }).end();
      return;
    }
    html(res, 200, loginPage({ next: safeNext(url.searchParams.get("next")) }));
  }

  async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readForm(req);
    if (form === null) {
      res.on("finish", () => req.destroy());
      return html(res, 413, loginPage({ next: "/", error: "Too large." }), { connection: "close" });
    }
    const next = safeNext(form.get("next"));
    const username = (form.get("username") ?? "").slice(0, MAX_FIELD);
    const password = form.get("password") ?? "";
    const page = (status: number, error: string, headers: Record<string, string> = {}) => html(res, status, loginPage({ next, error, username }), headers);

    // The slowdown is applied before any password check, and only one check runs at a time.
    const wait = this.limiter.wait();
    if (wait > 0 || this.verifying) {
      const s = Math.max(1, Math.ceil(wait / 1000));
      return page(429, `Too many attempts. Try again in ${String(s)} s.`, { "retry-after": String(s) });
    }
    const creds = this.opts.credentials.get();
    if (!creds.ok) return page(503, "Login is not set up.");
    this.verifying = true;
    let ok: boolean;
    try {
      // Always run the hash (even for a wrong username) so the two failures take the same time.
      const passwordOk = password.length <= MAX_FIELD && (await verifyPassword(password, creds.credentials.hash));
      ok = passwordOk && username === creds.credentials.username;
    } finally {
      this.verifying = false;
    }
    if (!ok) {
      this.limiter.fail();
      return page(401, GENERIC_ERROR);
    }
    this.limiter.succeed();
    const token = this.opts.sessions.create(creds.credentials.fingerprint);
    res.writeHead(303, { location: next, "set-cookie": cookieHeader(token, SESSION_TTL_MS / 1000), "cache-control": "no-store" }).end();
  }

  /**
   * POST /api/logout: end the session, close its streams, clear the cookie. (A new password ends
   * sessions at their next request; streams already open then end at their lifetime cap, F26.)
   */
  logout(session: Session, res: ServerResponse): void {
    this.opts.sessions.revoke(session.id);
    this.streams.closeAll(session.id);
    res.writeHead(204, { "set-cookie": cookieHeader("", 0), "cache-control": "no-store", "clear-site-data": '"cache"' }).end();
  }
}
