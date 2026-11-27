import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Login sessions (F31). The browser holds a random token; this side keeps only its SHA-256 (the
// session id), in a 0600 file so sessions survive restarts. Expiry slides: 30 days from the last
// use, refreshed at most once an hour so a busy page does not rewrite the file on every request.
// A session is bound to the password it was made under (the credentials fingerprint): a new
// password ends every session.

export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const SLIDE_EVERY_MS = 60 * 60_000;
const MAX_SESSIONS = 50;

interface Stored {
  readonly id: string; // sha256(token), base64url
  readonly cred: string;
  readonly created: number;
  expires: number;
}

export interface Session {
  readonly id: string;
  /** The expiry moved: the cookie should be sent again with a fresh Max-Age. */
  readonly refreshed: boolean;
}

export function sessionsPath(env: NodeJS.ProcessEnv, home = homedir()): string {
  return env.HERDR_SESSIONS_FILE ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "herdr", "sessions.json");
}

const idOf = (token: string) => createHash("sha256").update(token).digest("base64url");

export class SessionStore {
  private readonly sessions = new Map<string, Stored>();

  readonly path: string;
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
    this.load();
  }

  private load(): void {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return; // none yet (or unreadable: start empty; everyone logs in again)
    }
    const list = (value as { sessions?: unknown } | null)?.sessions;
    if (!Array.isArray(list)) return;
    const now = this.now();
    for (const s of list as Partial<Stored>[]) {
      if (typeof s.id === "string" && typeof s.cred === "string" && typeof s.created === "number" && typeof s.expires === "number" && s.expires > now) {
        this.sessions.set(s.id, { id: s.id, cred: s.cred, created: s.created, expires: s.expires });
      }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions: [...this.sessions.values()] }), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, s] of this.sessions) if (s.expires <= now) this.sessions.delete(id);
    const oldest = [...this.sessions.values()].sort((a, b) => a.expires - b.expires);
    while (oldest.length > MAX_SESSIONS - 1) this.sessions.delete(oldest.shift()?.id ?? "");
  }

  /** A new session under the credentials `cred`; returns the token for the cookie. */
  create(cred: string): string {
    this.prune();
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    this.sessions.set(idOf(token), { id: idOf(token), cred, created: now, expires: now + SESSION_TTL_MS });
    this.save();
    return token;
  }

  /**
   * The live session for `token` under credentials `cred`, or `null`. `slide`: move its expiry
   * (only where the caller can send the cookie again with it, or the two drift apart).
   */
  check(token: string, cred: string, slide = true): Session | null {
    const id = idOf(token);
    const s = this.sessions.get(id);
    if (s === undefined) return null;
    const now = this.now();
    if (s.expires <= now || s.cred !== cred) {
      this.sessions.delete(id);
      this.save();
      return null;
    }
    if (!slide || now + SESSION_TTL_MS - s.expires < SLIDE_EVERY_MS) return { id, refreshed: false };
    s.expires = now + SESSION_TTL_MS;
    this.save();
    return { id, refreshed: true };
  }

  revoke(id: string): void {
    if (this.sessions.delete(id)) this.save();
  }
}

/** Open streams (SSE, WebSockets) per session, so logout can close them (F31). */
export class StreamRegistry {
  private readonly streams = new Map<string, Set<() => void>>();

  /** Register `close` for session `id`; returns the function to call when the stream ends. */
  track(id: string, close: () => void): () => void {
    let set = this.streams.get(id);
    if (set === undefined) this.streams.set(id, (set = new Set()));
    set.add(close);
    return () => {
      set.delete(close);
      if (set.size === 0 && this.streams.get(id) === set) this.streams.delete(id);
    };
  }

  closeAll(id: string): void {
    const set = this.streams.get(id);
    this.streams.delete(id);
    for (const close of set ?? []) close();
  }
}
