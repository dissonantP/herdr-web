import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { generateVapidKeys, keysMatch, type VapidKeys } from "./webpush.ts";

// The VAPID key pair, in a 0600 file outside git: `{"publicKey": "<base64url>", "privateKey": "<PKCS8 PEM>"}`.
// `install.sh apply vapid` creates it once; it is never overwritten (a new pair would void every
// subscription). Without a valid file push fails closed: nothing is sent and the subscribe
// endpoints answer 503.

export function vapidPath(env: NodeJS.ProcessEnv, home = homedir()): string {
  return env.HERDR_VAPID_FILE ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "herdr", "vapid.json");
}

export type VapidResult = { readonly ok: true; readonly keys: VapidKeys } | { readonly ok: false; readonly error: string };

export function readVapid(path: string): VapidResult {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return { ok: false, error: `no VAPID key file at ${path} (run ./install.sh apply vapid)` };
  }
  if ((mode & 0o077) !== 0) return { ok: false, error: `${path} is readable by others (mode ${(mode & 0o777).toString(8)}; want 600)` };
  try {
    const value = (JSON.parse(readFileSync(path, "utf8")) ?? {}) as { publicKey?: unknown; privateKey?: unknown };
    if (typeof value.publicKey !== "string" || typeof value.privateKey !== "string") return { ok: false, error: `${path} lacks publicKey or privateKey` };
    const privateKey = createPrivateKey(value.privateKey);
    if (!keysMatch(value.publicKey, privateKey)) return { ok: false, error: `${path}: the public key does not match the private key` };
    return { ok: true, keys: { publicKey: value.publicKey, privateKey } };
  } catch {
    return { ok: false, error: `${path} is not a valid VAPID key file` };
  }
}

/** Create the file when it is missing (0600, atomically); an existing file is left alone. `true` when it wrote one. */
export function ensureVapid(path: string): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { publicKey, privatePem } = generateVapidKeys();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ publicKey, privateKey: privatePem }), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return true;
}
