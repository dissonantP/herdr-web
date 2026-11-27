import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for a browser and its push service (SPEC § How QA drives it): it holds a browser's
// push keys, listens where the subscription's endpoint points, and records every push herdr
// POSTs there: when it arrived, the VAPID header, and the payload decrypted the way a browser
// would (RFC 8291). Real delivery to a phone is left to a person (the task doc's Unverified section).

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** A browser's push keys and the decryption of what was encrypted for them. */
export function makeBrowser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const keys = { p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) };
  const decrypt = (body: Buffer): { readonly text: string; readonly lastByte: number } => {
    const salt = body.subarray(0, 16);
    const idLen = body[20] ?? 0;
    const asPublic = body.subarray(21, 21 + idLen);
    const sealed = body.subarray(21 + idLen);
    const secret = ecdh.computeSecret(asPublic);
    const ikm = Buffer.from(hkdfSync("sha256", secret, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]), 32));
    const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    return { text: plain.subarray(0, plain.length - 1).toString("utf8"), lastByte: plain[plain.length - 1] ?? 0 };
  };
  return { keys, decrypt };
}

export interface Received {
  /** When the POST arrived (ms since epoch). */
  readonly at: number;
  readonly authorization: string;
  readonly headers: IncomingMessage["headers"];
  readonly payload: { kind: string; title: string; body: string; url: string; tag: string };
}

export class PushDevice {
  readonly received: Received[] = [];
  private readonly browser = makeBrowser();
  private readonly server: Server;
  /** What a real browser's `PushSubscription.toJSON()` gives. */
  readonly subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  /** The status the stub answers with (410: the subscription is gone). */
  status = 201;

  private constructor(server: Server, port: number) {
    this.server = server;
    this.subscription = { endpoint: `http://127.0.0.1:${String(port)}/push/${randomBytes(6).toString("hex")}`, keys: this.browser.keys };
  }

  static async start(): Promise<PushDevice> {
    let device: PushDevice | null = null;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (device !== null && req.method === "POST") {
          const { text, lastByte } = device.browser.decrypt(Buffer.concat(chunks));
          if (lastByte !== 2) throw new Error("bad record delimiter");
          device.received.push({ at: Date.now(), authorization: String(req.headers.authorization ?? ""), headers: req.headers, payload: JSON.parse(text) as Received["payload"] });
        }
        res.writeHead(device?.status ?? 201).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    device = new PushDevice(server, (server.address() as AddressInfo).port);
    return device;
  }

  /** Wait until `count` pushes arrived, or `ms` passed; what arrived. */
  async waitFor(count: number, ms: number): Promise<readonly Received[]> {
    const deadline = Date.now() + ms;
    while (this.received.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    return this.received;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
