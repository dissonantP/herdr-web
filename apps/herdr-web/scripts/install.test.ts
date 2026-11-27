import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// install.sh follows the installer's project-script contract; here it runs with
// HERDR_UNIT_DIR set, so it writes only a temp folder and never calls systemctl.

const script = new URL("../install.sh", import.meta.url).pathname;
const run = (args: string[], env: Record<string, string> = {}) => execFileSync(script, args, { encoding: "utf8", env: { ...process.env, ...env } });
// Async, so the in-process HTTP servers below can answer while the script runs.
const runAsync = async (args: string[], env: Record<string, string>) => {
  try {
    const { stdout } = await promisify(execFile)(script, args, { encoding: "utf8", env: { ...process.env, ...env } });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { status: e.code ?? -1, stdout: e.stdout ?? "" };
  }
};
const listen = (server: Server, host: string) =>
  new Promise<number>((resolve) => server.listen(0, host, () => { resolve((server.address() as AddressInfo).port); }));
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => { resolve(); }));

describe("install.sh", () => {
  it("lists its steps as id, user|root, title", () => {
    const lines = run(["steps"]).trim().split("\n").map((l) => l.split("\t"));
    expect(lines.map((l) => l[0])).toEqual(["build", "dirs", "login", "vapid", "hook", "service", "smoke", "bind"]);
    expect(lines.every((l) => l[1] === "user" && (l[2] ?? "") !== "")).toBe(true);
  });

  it("the repo root's install.sh runs this one", () => {
    const root = new URL("../../../install.sh", import.meta.url).pathname;
    expect(execFileSync(root, ["steps"], { encoding: "utf8" })).toBe(run(["steps"]));
  });

  it("dirs: makes the config and state folders 0700, existing ones included (task 052)", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-install-"));
    const env = { XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state") };
    const status = (args: string[]) => {
      try {
        execFileSync(script, args, { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
        return 0;
      } catch (err) {
        return (err as { status?: number }).status ?? -1;
      }
    };
    try {
      mkdirSync(join(dir, "state", "herdr"), { recursive: true, mode: 0o755 });
      chmodSync(join(dir, "state", "herdr"), 0o755);
      expect(status(["check", "dirs"])).toBe(1);
      expect(status(["apply", "dirs"])).toBe(0);
      expect(statSync(join(dir, "config", "herdr")).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "state", "herdr")).mode & 0o777).toBe(0o700);
      expect(status(["check", "dirs"])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("vapid: creates a 0600 key file once and never overwrites it (F19)", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-install-"));
    const file = join(dir, "vapid.json");
    const env = { HERDR_VAPID_FILE: file };
    const status = (args: string[]) => {
      try {
        execFileSync(script, args, { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
        return 0;
      } catch (err) {
        return (err as { status?: number }).status ?? -1;
      }
    };
    try {
      expect(status(["check", "vapid"])).toBe(1);
      expect(status(["apply", "vapid"])).toBe(0);
      expect(status(["check", "vapid"])).toBe(0);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const first = readFileSync(file, "utf8");
      expect(status(["apply", "vapid"])).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(first);
      chmodSync(file, 0o644);
      expect(status(["check", "vapid"])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000); // four node starts; the 5 s default fails when the machine is busy with other test files

  it("login: refuses without a terminal; its check wants a 0600 argon2id file (F30)", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-install-"));
    const file = join(dir, "credentials.json");
    const env = { HERDR_CREDENTIALS_FILE: file };
    const status = (args: string[]) => {
      try {
        execFileSync(script, args, { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
        return 0;
      } catch (err) {
        return (err as { status?: number }).status ?? -1;
      }
    };
    try {
      expect(status(["apply", "login"])).toBe(1); // stdin is not a terminal: no prompt, no file
      expect(status(["check", "login"])).toBe(1);
      writeFileSync(file, JSON.stringify({ username: "max", hash: "plaintext" }), { mode: 0o600 });
      expect(status(["check", "login"])).toBe(1);
      writeFileSync(file, JSON.stringify({ username: "max", hash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA" }));
      chmodSync(file, 0o644);
      expect(status(["check", "login"])).toBe(1);
      chmodSync(file, 0o600);
      expect(status(["check", "login"])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hook: adds the SessionStart label hook once, keeping other settings; a hand-written equivalent is replaced (F22)", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-install-"));
    const file = join(dir, "claude", "settings.json");
    const env = { HERDR_CLAUDE_SETTINGS: file };
    const status = (args: string[]) => {
      try {
        execFileSync(script, args, { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
        return 0;
      } catch (err) {
        return (err as { status?: number }).status ?? -1;
      }
    };
    const read = () => JSON.parse(readFileSync(file, "utf8")) as { model?: string; hooks: { SessionStart: { hooks: { command: string }[] }[]; Stop?: unknown } };
    try {
      expect(status(["check", "hook"])).toBe(1); // no settings file yet
      expect(status(["apply", "hook"])).toBe(0);
      expect(status(["check", "hook"])).toBe(0);
      expect(read().hooks.SessionStart[0]?.hooks[0]?.command).toMatch(/^bash '\/.*\/deploy\/hooks\/session-label\.sh'$/u);
      expect(statSync(file).mode & 0o777).toBe(0o600);

      // Other settings and hooks stay; a second apply adds nothing.
      writeFileSync(file, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [] }], SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }));
      chmodSync(file, 0o644);
      expect(status(["check", "hook"])).toBe(1);
      expect(status(["apply", "hook"])).toBe(0);
      expect(status(["apply", "hook"])).toBe(0);
      const after = read();
      expect(after.model).toBe("opus");
      expect(after.hooks.Stop).toEqual([{ hooks: [] }]);
      expect(after.hooks.SessionStart.map((g) => g.hooks[0]?.command)).toEqual(["echo hi", expect.stringContaining("session-label.sh")]);
      expect(statSync(file).mode & 0o777).toBe(0o644);

      // A hand-written hook that sets claude.session itself is replaced, not kept beside it.
      writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "hc label \"$HC_TERMINAL_ID\" claude.session=x" }] }, { hooks: [{ type: "command", command: "echo hi" }] }] } }));
      expect(status(["check", "hook"])).toBe(1);
      expect(status(["apply", "hook"])).toBe(0);
      expect(read().hooks.SessionStart.map((g) => g.hooks[0]?.command)).toEqual(["echo hi", expect.stringContaining("session-label.sh")]);
      expect(status(["check", "hook"])).toBe(0);

      // session-label.sh at another path (the layout before apps/herdr-web) is stale: replaced with this one.
      writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "bash '/old/deploy/hooks/session-label.sh'" }] }] } }));
      expect(status(["check", "hook"])).toBe(1);
      expect(status(["apply", "hook"])).toBe(0);
      expect(read().hooks.SessionStart.map((g) => g.hooks[0]?.command)).toEqual([`bash '${new URL("../deploy/hooks/session-label.sh", import.meta.url).pathname}'`]);
      expect(status(["check", "hook"])).toBe(0);

      // Not JSON: left alone; the check cannot tell, and the step fails.
      writeFileSync(file, "{ nope");
      expect(status(["check", "hook"])).toBe(75);
      expect(status(["apply", "hook"])).toBe(1);
      expect(readFileSync(file, "utf8")).toBe("{ nope");

      // A symlinked settings file (dotfiles) is written through; the link stays a link.
      const real = join(dir, "dotfiles-settings.json");
      writeFileSync(real, JSON.stringify({ model: "sonnet" }));
      rmSync(file);
      symlinkSync(real, file);
      expect(status(["apply", "hook"])).toBe(0);
      expect(lstatSync(file).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, "utf8")).toContain("session-label.sh");

      // A dangling symlink: its target is created, and the link stays.
      const missing = join(dir, "not-yet", "settings.json");
      rmSync(file);
      symlinkSync(missing, file);
      expect(status(["apply", "hook"])).toBe(0);
      expect(lstatSync(file).isSymbolicLink()).toBe(true);
      expect(readFileSync(missing, "utf8")).toContain("session-label.sh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("renders the unit for this checkout and passes its own check", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-install-"));
    try {
      const env = { HERDR_UNIT_DIR: dir, HERDR_PORT: "7999" };
      run(["apply", "service"], env);
      const unit = readFileSync(join(dir, "herdr.service"), "utf8");
      expect(unit).not.toMatch(/@DIR@|@ROOT@|@NODE@/u);
      // F28: no node path in the unit; the launcher finds node at every start.
      expect(unit).toMatch(/^ExecStart=\/.*\/deploy\/run\.sh$/mu);
      expect(unit).not.toMatch(/\/versions\/node\//u);
      expect(unit).not.toMatch(/^Environment=HERDR_NODE/mu);
      expect(unit).toContain("Environment=HERDR_PORT=7999");
      // F25, F7: by default only the proxy on this machine is served, on loopback, never 0.0.0.0.
      expect(unit).toContain("Environment=HERDR_ALLOWED_SOURCE=127.0.0.1");
      expect(unit).toContain("Environment=HERDR_HOST=127.0.0.1");
      expect(unit).toContain("MemoryMax=300M");
      run(["check", "service"], env);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pins HERDR_NODE into the unit only when asked", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-install-"));
    try {
      const env = { HERDR_UNIT_DIR: dir, HERDR_NODE: process.execPath };
      run(["apply", "service"], env);
      expect(readFileSync(join(dir, "herdr.service"), "utf8")).toContain(`Environment=HERDR_NODE=${process.execPath}`);
      run(["check", "service"], env);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bind passes only when the backend listens on HERDR_HOST alone", async () => {
    const backend = createServer((_req, res) => { res.end("ok"); });
    const port = await listen(backend, "127.0.0.1");
    const env = { HERDR_HOST: "127.0.0.1", HERDR_PORT: String(port) };
    try {
      const ok = await runAsync(["check", "bind"], env);
      expect(ok.stdout).toContain("backend listens only on");
      expect(ok.status).toBe(0);

      // The backend also on another address: fails.
      const extra = createServer((_req, res) => { res.end("ok"); });
      await new Promise<void>((resolve) => extra.listen(port, "127.0.0.2", () => { resolve(); }));
      try {
        const both = await runAsync(["check", "bind"], env);
        expect(both.stdout).toContain("want only");
        expect(both.status).toBe(1);
      } finally {
        await close(extra);
      }
    } finally {
      await close(backend);
    }
    // Nothing listening: fails.
    expect((await runAsync(["check", "bind"], env)).status).toBe(1);
  });


  it("the launcher finds node through nvm's default alias at every start, not at install time", () => {
    const nvm = mkdtempSync(join(tmpdir(), "herdr-nvm-"));
    try {
      const runner = new URL("../deploy/run.sh", import.meta.url).pathname;
      const print = () => execFileSync(runner, ["--print"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", NVM_DIR: nvm } }).trim();
      const addVersion = (v: string) => {
        mkdirSync(join(nvm, "versions/node", v, "bin"), { recursive: true });
        writeFileSync(join(nvm, "versions/node", v, "bin/node"), "#!/bin/sh\n");
        chmodSync(join(nvm, "versions/node", v, "bin/node"), 0o755);
      };
      mkdirSync(join(nvm, "alias"), { recursive: true });
      writeFileSync(join(nvm, "alias/default"), "26\n");
      addVersion("v26.13.0");
      expect(print()).toBe(join(nvm, "versions/node/v26.13.0/bin/node"));
      // An nvm upgrade: a newer patch appears and the old one is removed; the same unit keeps working.
      addVersion("v26.14.1");
      rmSync(join(nvm, "versions/node/v26.13.0"), { recursive: true });
      expect(print()).toBe(join(nvm, "versions/node/v26.14.1/bin/node"));
      // An alias that points at another alias (lts/*) is followed.
      mkdirSync(join(nvm, "alias/lts"), { recursive: true });
      writeFileSync(join(nvm, "alias/lts/*"), "lts/krypton\n");
      writeFileSync(join(nvm, "alias/lts/krypton"), "v26.14.1\n");
      writeFileSync(join(nvm, "alias/default"), "lts/*\n");
      expect(print()).toBe(join(nvm, "versions/node/v26.14.1/bin/node"));
      // An alias naming no installed version (node, lts/* without a file, junk) means the newest installed.
      for (const alias of ["node", "stable", "lts/*", "99"]) {
        rmSync(join(nvm, "alias/lts/*"), { force: true });
        writeFileSync(join(nvm, "alias/default"), `${alias}\n`);
        expect(print()).toBe(join(nvm, "versions/node/v26.14.1/bin/node"));
      }
      // HERDR_NODE wins.
      expect(execFileSync(runner, ["--print"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", NVM_DIR: nvm, HERDR_NODE: process.execPath } }).trim()).toBe(process.execPath);
      expect(() => execFileSync(runner, ["--print"], { stdio: "ignore", env: { PATH: "/usr/bin:/bin", NVM_DIR: nvm, HERDR_NODE: "/opt/nonexistent-node" } })).toThrow();
    } finally {
      rmSync(nvm, { recursive: true, force: true });
    }
  });

  it("refuses an unknown step with exit 2", () => {
    try {
      run(["check", "nope"]);
      expect.unreachable("should have exited non-zero");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(2);
    }
  });
});
