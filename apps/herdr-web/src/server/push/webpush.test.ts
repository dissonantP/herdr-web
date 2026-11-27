import { createECDH, createPrivateKey, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeBrowser } from "../../../tests/support/push-stub.ts";
import { encryptPayload, endpointAllowed, generateVapidKeys, keysMatch, MAX_PAYLOAD_BYTES, vapidAuthorization } from "./webpush.ts";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");

describe("web push encryption (RFC 8291)", () => {
  it("round-trips through an independent decryption", () => {
    const b = makeBrowser();
    const body = encryptPayload(b.keys, Buffer.from(JSON.stringify({ title: "alpha", body: "worker needs your input ✓" })));
    expect(b.decrypt(body).text).toBe('{"title":"alpha","body":"worker needs your input ✓"}');
    expect(body.readUInt32BE(16)).toBe(4096);
  });

  it("matches the RFC 8291 appendix A test vector", () => {
    const ua = Buffer.from("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "base64url");
    expect(ua.length).toBe(65);
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"));
    const salt = Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url");
    const body = encryptPayload({ p256dh: b64(ua), auth: "BTBZMqHH6r4Tts7J_aSIgg" }, Buffer.from("When I grow up, I want to be a watermelon"), { ecdh, salt });
    expect(body.toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("refuses bad keys and oversized payloads", () => {
    const b = makeBrowser();
    expect(() => encryptPayload({ p256dh: "AAAA", auth: b.keys.auth }, Buffer.from("x"))).toThrow();
    expect(() => encryptPayload(b.keys, Buffer.alloc(MAX_PAYLOAD_BYTES + 1))).toThrow();
  });
});

describe("VAPID (RFC 8292)", () => {
  it("signs a JWT the public key verifies, for the endpoint's origin", () => {
    const { publicKey, privatePem } = generateVapidKeys();
    const privateKey = createPrivateKey(privatePem);
    expect(keysMatch(publicKey, privateKey)).toBe(true);
    expect(keysMatch(generateVapidKeys().publicKey, privateKey)).toBe(false);
    const header = vapidAuthorization({ publicKey, privateKey }, "https://fcm.googleapis.com/fcm/send/abc", "mailto:a@b.invalid", 1_700_000_000_000);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/u.exec(header);
    expect(m).not.toBeNull();
    const [, h, p, sig, k] = m ?? [];
    expect(k).toBe(publicKey);
    expect(JSON.parse(Buffer.from(h ?? "", "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(Buffer.from(p ?? "", "base64url").toString())).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_700_000_000 + 12 * 3600, sub: "mailto:a@b.invalid" });
    const raw = Buffer.from(publicKey, "base64url");
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h ?? ""}.${p ?? ""}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig ?? "", "base64url"))).toBe(true);
  });
});

describe("endpointAllowed", () => {
  it("takes https push services on public names only", () => {
    expect(endpointAllowed("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(endpointAllowed("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(endpointAllowed("https://web.push.apple.com/x")).toBe(true);
    expect(endpointAllowed("https://wns2-par02p.notify.windows.com/x")).toBe(true);
    for (const bad of ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://[::1]/x", "https://localhost/x", "https://nas.local/x", "https://pi.internal/x", "https://u:p@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "ftp://x.example.com", "nonsense", "https://intranet/x", "https://localhost./x", "https://router.lan./x", "https://nas.ts.net/x", "https://evil.example.com/x", "https://fcm.googleapis.com.evil.example/x", "https://push.apple.com.evil.example/x"]) {
      expect(endpointAllowed(bad), bad).toBe(false);
    }
  });

  it("allows http on loopback only when told to (tests)", () => {
    expect(endpointAllowed("http://127.0.0.1:9999/push")).toBe(false);
    expect(endpointAllowed("http://127.0.0.1:9999/push", true)).toBe(true);
    expect(endpointAllowed("http://10.0.0.5:9999/push", true)).toBe(false);
  });
});
