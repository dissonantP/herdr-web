import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseHash, type ParsedHash } from "./password.ts";

// The one login (F30): `{"username": "...", "hash": "$argon2id$..."}` in a 0600 file outside the
// repo, written by `install.sh apply login` (set-password.ts). The file is re-read when it changes,
// so a new password applies without a restart (and ends every session: see `fingerprint`).

export interface Credentials {
  readonly username: string;
  readonly hash: ParsedHash;
  /** Changes with the password; sessions made under another one are void. */
  readonly fingerprint: string;
}

export type CredentialsResult = { readonly ok: true; readonly credentials: Credentials } | { readonly ok: false; readonly error: string };

export function credentialsPath(env: NodeJS.ProcessEnv, home = homedir()): string {
  return env.HERDR_CREDENTIALS_FILE ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "herdr", "credentials.json");
}

export function readCredentials(path: string): CredentialsResult {
  let mode: number;
  let uid: number;
  try {
    ({ mode, uid } = statSync(path));
  } catch {
    return { ok: false, error: `no credentials file at ${path}` };
  }
  const me = process.getuid?.();
  if (me !== undefined && uid !== me) return { ok: false, error: `${path} is owned by uid ${String(uid)}, not this user (${String(me)})` };
  if ((mode & 0o077) !== 0) return { ok: false, error: `${path} is readable by others (mode ${(mode & 0o777).toString(8)}; want 600)` };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, error: `${path} is not valid JSON` };
  }
  const { username, hash } = (value ?? {}) as { username?: unknown; hash?: unknown };
  if (typeof username !== "string" || username === "" || typeof hash !== "string") return { ok: false, error: `${path} lacks a username or hash` };
  const parsed = parseHash(hash);
  if (parsed === null) return { ok: false, error: `${path} does not hold an argon2id hash with allowed parameters` };
  const fingerprint = createHash("sha256").update(hash).digest("base64url").slice(0, 16);
  return { ok: true, credentials: { username, hash: parsed, fingerprint } };
}

/** The credentials file, re-read when its mtime or size changes. Errors are logged once each. */
export class CredentialsFile {
  private key = "";
  private result: CredentialsResult = { ok: false, error: "not read yet" };
  private lastLogged = "";

  readonly path: string;
  private readonly log: (line: string) => void;

  constructor(path: string, log: (line: string) => void = (line) => console.error(line)) {
    this.path = path;
    this.log = log;
  }

  get(): CredentialsResult {
    let key: string;
    try {
      const s = statSync(this.path);
      key = `${String(s.mtimeMs)}:${String(s.size)}:${String(s.mode)}:${String(s.uid)}`;
    } catch {
      key = "missing";
    }
    if (key !== this.key) {
      this.key = key;
      this.result = readCredentials(this.path);
      const line = this.result.ok ? "" : `herdr: refusing to serve: ${this.result.error}. Create it with ./install.sh apply login`;
      if (line !== this.lastLogged && line !== "") this.log(line);
      this.lastLogged = line;
    }
    return this.result;
  }
}
