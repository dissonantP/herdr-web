import { createECDH, createPrivateKey, createPublicKey, createCipheriv, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto";

// Standard Web Push, with nothing but node:crypto and fetch: RFC 8291 payload encryption
// (aes128gcm, RFC 8188) and RFC 8292 VAPID. One message is one record, so a payload up to
// MAX_PAYLOAD_BYTES goes out in a single POST.

/** Plaintext limit: the push services accept 4096-byte bodies; header (86) and tag (16) and the delimiter byte come out of it. */
export const MAX_PAYLOAD_BYTES = 3800;

const RECORD_SIZE = 4096;

export interface PushSubscription {
  readonly endpoint: string;
  /** The browser's P-256 public key, base64url (65 bytes uncompressed). */
  readonly p256dh: string;
  /** The browser's 16-byte auth secret, base64url. */
  readonly auth: string;
}

export interface VapidKeys {
  /** The 65-byte uncompressed public key, base64url: what the browser subscribes with. */
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const unb64 = (text: string): Buffer => Buffer.from(text, "base64url");

/** RFC 8291 section 3.4: the body of the POST. `asKeys` and `salt` are only given by tests. */
export function encryptPayload(sub: Pick<PushSubscription, "p256dh" | "auth">, plaintext: Uint8Array, asKeys?: { readonly ecdh: ReturnType<typeof createECDH>; readonly salt: Buffer }): Buffer {
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new Error("push payload too large");
  const ua = unb64(sub.p256dh);
  const auth = unb64(sub.auth);
  if (ua.length !== 65 || ua[0] !== 4 || auth.length !== 16) throw new Error("bad subscription keys");
  const ecdh = asKeys?.ecdh ?? createECDH("prime256v1");
  if (asKeys === undefined) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = asKeys?.salt ?? randomBytes(16);
  const secret = ecdh.computeSecret(ua);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ua, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

/** RFC 8292: `Authorization: vapid t=<jwt>, k=<public key>` for a push service at `endpoint`. */
export function vapidAuthorization(keys: VapidKeys, endpoint: string, subject: string, nowMs = Date.now()): string {
  const audience = new URL(endpoint).origin;
  const part = (value: unknown) => b64(Buffer.from(JSON.stringify(value)));
  const input = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: audience, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })}`;
  const signature = sign("sha256", Buffer.from(input), { key: keys.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${input}.${b64(signature)}, k=${keys.publicKey}`;
}

/** A new P-256 key pair in the shape VAPID wants: the public key as 65 raw bytes, base64url. */
export function generateVapidKeys(): { readonly publicKey: string; readonly privatePem: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const jwk = { kty: "EC", crv: "P-256", x: b64(ecdh.getPublicKey().subarray(1, 33)), y: b64(ecdh.getPublicKey().subarray(33)), d: b64(ecdh.getPrivateKey()) };
  const privatePem = createPrivateKey({ key: jwk, format: "jwk" }).export({ type: "pkcs8", format: "pem" }) as string;
  return { publicKey: b64(ecdh.getPublicKey()), privatePem };
}

/** Whether `privateKey` and `publicKey` are one pair. */
export function keysMatch(publicKey: string, privateKey: KeyObject): boolean {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), unb64(jwk.x ?? ""), unb64(jwk.y ?? "")]);
  return b64(raw) === publicKey;
}

/** The browsers' push services; a subscription pointing anywhere else is refused. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/u, /(^|\.)push\.services\.mozilla\.com$/u, /(^|\.)push\.apple\.com$/u, /(^|\.)notify\.windows\.com$/u];

/**
 * Whether herdr may POST to this endpoint. The address comes from a browser, so it is held to a
 * short list of real push services over https (no address literals, no trailing-dot names, no other
 * port): the server would otherwise be a request relay into the LAN or tailnet, and a hostname
 * check alone can't stop a public name that resolves to a private address. `allowInsecure` (tests
 * only) permits http on loopback.
 */
export function endpointAllowed(endpoint: string, allowInsecure = false): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "" || endpoint.length > 2048) return false;
  const host = url.hostname;
  if (allowInsecure && url.protocol === "http:" && (host === "127.0.0.1" || host === "localhost")) return true;
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) return false;
  return PUSH_HOSTS.some((re) => re.test(host));
}

export type SendResult = "sent" | "gone" | "failed";

export interface SendOptions {
  readonly keys: VapidKeys;
  readonly subject: string;
  /** Seconds the push service keeps the message for an offline device. */
  readonly ttl?: number;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** One push to one subscription. `gone`: the service says the subscription no longer exists (404/410). */
export async function sendPush(sub: PushSubscription, payload: unknown, opts: SendOptions): Promise<SendResult> {
  const body = encryptPayload(sub, Buffer.from(JSON.stringify(payload)));
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(sub.endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      headers: {
        authorization: vapidAuthorization(opts.keys, sub.endpoint, opts.subject),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(opts.ttl ?? 600),
        urgency: "high",
      },
      body: new Uint8Array(body),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) return "sent";
    return res.status === 404 || res.status === 410 ? "gone" : "failed";
  } catch {
    return "failed";
  }
}
