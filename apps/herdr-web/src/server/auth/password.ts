import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

// Password hashing for the app login (F30): argon2id from Node's own crypto (no native module, so
// it builds anywhere Node runs, arm64 included), stored as a PHC string:
//   $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>   (base64 without padding)
// Parameters are modest (OWASP's 19 MiB, 2 passes, 1 lane: about 0.1 s on a small ARM board) and only one
// verify runs at a time (auth.ts), so a burst of logins cannot eat the 300 MB budget.

export interface Argon2Params {
  readonly memory: number; // KiB
  readonly passes: number;
  readonly parallelism: number;
}

export const DEFAULT_PARAMS: Argon2Params = { memory: 19_456, passes: 2, parallelism: 1 };
/** Hashes with parameters above these are refused: verifying them could exhaust the memory budget. */
const MAX_PARAMS: Argon2Params = { memory: 65_536, passes: 10, parallelism: 4 };
const SALT_BYTES = 16;
const TAG_BYTES = 32;

const b64 = (bytes: Buffer) => bytes.toString("base64").replace(/=+$/u, "");

function derive(password: string, salt: Buffer, params: Argon2Params, tagLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2("argon2id", { message: password, nonce: salt, parallelism: params.parallelism, tagLength, memory: params.memory, passes: params.passes }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string, params: Argon2Params = DEFAULT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt, params, TAG_BYTES);
  return `$argon2id$v=19$m=${String(params.memory)},t=${String(params.passes)},p=${String(params.parallelism)}$${b64(salt)}$${b64(tag)}`;
}

export interface ParsedHash {
  readonly params: Argon2Params;
  readonly salt: Buffer;
  readonly tag: Buffer;
}

const PHC = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,2})\$([A-Za-z0-9+/]{11,})\$([A-Za-z0-9+/]{22,})$/u;

/** A well-formed argon2id PHC string within the allowed parameters, or `null`. */
export function parseHash(phc: string): ParsedHash | null {
  const m = PHC.exec(phc);
  if (m === null) return null;
  const params = { memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]) };
  if (params.parallelism < 1 || params.passes < 1 || params.memory < 8 * params.parallelism) return null;
  if (params.memory > MAX_PARAMS.memory || params.passes > MAX_PARAMS.passes || params.parallelism > MAX_PARAMS.parallelism) return null;
  const salt = Buffer.from(m[4] ?? "", "base64");
  const tag = Buffer.from(m[5] ?? "", "base64");
  if (salt.length < 8 || tag.length < 16) return null;
  return { params, salt, tag };
}

export async function verifyPassword(password: string, hash: ParsedHash): Promise<boolean> {
  const tag = await derive(password, hash.salt, hash.params, hash.tag.length);
  return timingSafeEqual(tag, hash.tag);
}
