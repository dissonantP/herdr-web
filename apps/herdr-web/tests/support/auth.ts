import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashPassword } from "../../src/server/auth/password.ts";

// The QA login: a known username and password in the isolated stack's own credentials file, and
// the session the global setup logs in with (its token in HERDR_QA_TOKEN, its cookie in the
// Playwright storage state every page starts from).

export const QA_USER = "qa";
export const QA_PASSWORD = "qa-password-123";
export const COOKIE = "__Host-herdr_session";

export async function writeCredentials(path: string, username = QA_USER, password = QA_PASSWORD): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ username, hash: await hashPassword(password) }), { mode: 0o600 });
}

/** POST /login as a same-origin form would; the raw response (redirects not followed). */
export function postLogin(base: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The session token a Set-Cookie header carries, or `null`. */
export function tokenFrom(res: Response): string | null {
  const m = new RegExp(`${COOKIE}=([^;]+)`, "u").exec(res.headers.get("set-cookie") ?? "");
  return m?.[1] ?? null;
}

export async function login(base: string, username = QA_USER, password = QA_PASSWORD): Promise<string> {
  const res = await postLogin(base, { username, password, next: "/" });
  const token = tokenFrom(res);
  if (res.status !== 303 || token === null) throw new Error(`QA login failed: ${String(res.status)}`);
  return token;
}

/** Headers for a request on the global setup's session. */
export function authed(extra: Record<string, string> = {}, token = process.env.HERDR_QA_TOKEN ?? ""): Record<string, string> {
  return { cookie: `${COOKIE}=${token}`, ...extra };
}

/** Where the global setup leaves the Playwright storage state (playwright.config.ts reads it). */
export function storageStatePath(session = process.env.HERDR_QA_SESSION ?? "herdr-qa"): string {
  return join(tmpdir(), `${session}-storage.json`);
}

export function writeStorageState(path: string, token: string): void {
  const cookie = { name: COOKIE, value: token, domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: true, sameSite: "Lax" };
  writeFileSync(path, JSON.stringify({ cookies: [cookie], origins: [] }), { mode: 0o600 });
}
