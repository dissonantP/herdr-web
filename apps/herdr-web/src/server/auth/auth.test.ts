import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeNext } from "./auth.ts";
import { CredentialsFile, readCredentials } from "./credentials.ts";
import { FORGET_MS, LoginLimiter, MAX_DELAY_MS } from "./limiter.ts";
import { hashPassword, parseHash, verifyPassword } from "./password.ts";
import { SESSION_TTL_MS, SessionStore, StreamRegistry } from "./sessions.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-auth-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("password (F30)", () => {
  it("hashes with argon2id and modest parameters, and verifies", async () => {
    const phc = await hashPassword("correct horse");
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    expect(phc).not.toContain("correct horse");
    const parsed = parseHash(phc);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(await verifyPassword("correct horse", parsed)).toBe(true);
    expect(await verifyPassword("correct hors", parsed)).toBe(false);
  });

  it("refuses malformed hashes and parameters that would blow the memory budget", async () => {
    expect(parseHash("plaintext")).toBeNull();
    expect(parseHash("$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo")).toBeNull();
    const big = (await hashPassword("x".repeat(8), { memory: 19_456, passes: 1, parallelism: 1 })).replace("m=19456", "m=1048576");
    expect(parseHash(big)).toBeNull();
  });
});

describe("credentials file (F30)", () => {
  it("needs mode 600, a username and an argon2id hash", async () => {
    const path = join(dir, "credentials.json");
    expect(readCredentials(path)).toMatchObject({ ok: false, error: expect.stringContaining("no credentials file") as unknown });
    writeFileSync(path, JSON.stringify({ username: "max", hash: await hashPassword("pw-pw-pw-pw") }), { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(readCredentials(path)).toMatchObject({ ok: false, error: expect.stringContaining("readable by others") as unknown });
    chmodSync(path, 0o600);
    expect(readCredentials(path)).toMatchObject({ ok: true, credentials: { username: "max" } });
    writeFileSync(path, JSON.stringify({ username: "max", hash: "hunter2" }));
    expect(readCredentials(path).ok).toBe(false);
  });

  it("refuses a file another user owns (task 052)", () => {
    // /etc/hostname is root's; the uid check comes before the mode check.
    if (process.getuid?.() === 0) return;
    expect(readCredentials("/etc/hostname")).toMatchObject({ ok: false, error: expect.stringContaining("is owned by uid 0") as unknown });
  });

  it("picks up a new file without a restart and logs each problem once", async () => {
    const path = join(dir, "credentials.json");
    const lines: string[] = [];
    const file = new CredentialsFile(path, (l) => lines.push(l));
    expect(file.get().ok).toBe(false);
    expect(file.get().ok).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/refusing to serve.*install\.sh apply login/u);
    writeFileSync(path, JSON.stringify({ username: "max", hash: await hashPassword("pw-pw-pw-pw") }), { mode: 0o600 });
    expect(file.get().ok).toBe(true);
  });
});

describe("set-password (install.sh apply login)", () => {
  it("reads the username and password from stdin and stores only the hash, 0600", async () => {
    const path = join(dir, "cfg", "credentials.json");
    const script = new URL("./set-password.ts", import.meta.url).pathname;
    execFileSync(process.execPath, [script, path], { input: "max\nsecret-pass-1\n", stdio: ["pipe", "ignore", "pipe"] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "cfg")).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf8")).not.toContain("secret-pass-1");
    const read = readCredentials(path);
    if (!read.ok) throw new Error(read.error);
    expect(read.credentials.username).toBe("max");
    expect(await verifyPassword("secret-pass-1", read.credentials.hash)).toBe(true);
    expect(() => execFileSync(process.execPath, [script, path], { input: "max\nshort\n", stdio: ["pipe", "ignore", "ignore"] })).toThrow();
  });
});

describe("login limiter (F30)", () => {
  it("slows down exponentially, caps the delay, never locks, resets on success", () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now);
    expect(limiter.wait()).toBe(0);
    const delays: number[] = [];
    for (let i = 0; i < 40; i++) {
      limiter.fail();
      delays.push(limiter.wait());
      now += limiter.wait();
      expect(limiter.wait()).toBe(0); // after waiting, an attempt is always allowed again
    }
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(Math.max(...delays)).toBe(MAX_DELAY_MS);
    limiter.succeed();
    limiter.fail();
    expect(limiter.wait()).toBe(1000);
    limiter.fail();
    expect(limiter.wait()).toBe(2000);
    now += 2000 + FORGET_MS + 1; // a quiet hour after the last wait: old failures are forgotten
    limiter.fail();
    expect(limiter.wait()).toBe(1000);
  });
});

describe("sessions (F31)", () => {
  it("stores only the token's hash, in a 0600 file, and survives a restart", () => {
    const path = join(dir, "state", "sessions.json");
    const store = new SessionStore(path);
    const token = store.create("cred");
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain(token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(new SessionStore(path).check(token, "cred")).not.toBeNull();
    expect(new SessionStore(path).check("x".repeat(43), "cred")).toBeNull();
  });

  it("slides 30 days from the last use, at most once an hour, and expires", () => {
    let now = 1_000_000;
    const path = join(dir, "sessions.json");
    const store = new SessionStore(path, () => now);
    const token = store.create("cred");
    now += 10 * 60_000;
    expect(store.check(token, "cred")).toMatchObject({ refreshed: false });
    now += 2 * 60 * 60_000;
    expect(store.check(token, "cred")).toMatchObject({ refreshed: true });
    now += SESSION_TTL_MS - 1000; // still inside the slid window
    expect(store.check(token, "cred")).not.toBeNull();
    now += SESSION_TTL_MS + 1;
    expect(store.check(token, "cred")).toBeNull();
    expect(new SessionStore(path, () => now).check(token, "cred")).toBeNull();
  });

  it("does not slide when asked not to (an upgrade cannot re-send the cookie)", () => {
    let now = 1_000_000;
    const store = new SessionStore(join(dir, "sessions.json"), () => now);
    const token = store.create("cred");
    now += 2 * 60 * 60_000;
    expect(store.check(token, "cred", false)).toMatchObject({ refreshed: false });
    expect(store.check(token, "cred")).toMatchObject({ refreshed: true });
  });

  it("ends sessions made under another password, and on revoke", () => {
    const store = new SessionStore(join(dir, "sessions.json"));
    const token = store.create("old");
    expect(store.check(token, "new")).toBeNull();
    expect(store.check(token, "old")).toBeNull(); // gone for good
    const t2 = store.create("old");
    const s = store.check(t2, "old");
    if (s === null) throw new Error("no session");
    store.revoke(s.id);
    expect(store.check(t2, "old")).toBeNull();
  });

  it("closes a session's streams on logout, not others'", () => {
    const registry = new StreamRegistry();
    const closed: string[] = [];
    registry.track("a", () => closed.push("a1"));
    const untrack = registry.track("a", () => closed.push("a2"));
    registry.track("b", () => closed.push("b1"));
    untrack();
    registry.closeAll("a");
    expect(closed).toEqual(["a1"]);
    registry.closeAll("a");
    expect(closed).toEqual(["a1"]);
  });
});

describe("safeNext", () => {
  it("allows only paths on this site", () => {
    expect(safeNext("/s/abc?x=1")).toBe("/s/abc?x=1");
    for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", "javascript:alert(1)", "/login?next=/", "", null, "/a b"]) expect(safeNext(bad)).toBe("/");
  });
});
