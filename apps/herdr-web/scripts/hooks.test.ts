import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// F22: the Claude hook the app relies on exits 0 in under 100 ms and never blocks Claude, whether
// or not herdr (or even hc) is there. Agent state needs no hook (herdr-core's status and events).

const HOOK = join(import.meta.dirname, "../deploy/hooks/session-label.sh");
let dir = "";
let slowBin = "";
let logFile = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-hook-"));
  slowBin = join(dir, "bin");
  logFile = join(dir, "hc.log");
  spawnSync("mkdir", ["-p", slowBin]);
  // A hc that hangs for 5 s (a stuck core), logging what it was asked.
  writeFileSync(join(slowBin, "hc"), `#!/bin/sh\necho "$@" >> "${logFile}"\nsleep 5\n`);
  chmodSync(join(slowBin, "hc"), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const INPUT = JSON.stringify({ session_id: "abc-123_DEF", cwd: "/home/me/proj", hook_event_name: "SessionStart" });

function run(opts: { path: string; input?: string; terminal?: string | null }): { status: number | null; ms: number } {
  const env: NodeJS.ProcessEnv = { PATH: opts.path, HOME: dir };
  if (opts.terminal !== null) env.HC_TERMINAL_ID = opts.terminal ?? "t9";
  const start = performance.now();
  const result = spawnSync("bash", [HOOK], { env, input: opts.input ?? INPUT, timeout: 4000 });
  return { status: result.status, ms: performance.now() - start };
}

/** The median of five runs: one slow scheduler hiccup is not the hook being slow. */
function median(opts: Parameters<typeof run>[0]): { status: number | null; ms: number } {
  const runs = Array.from({ length: 5 }, () => run(opts)).sort((a, b) => a.ms - b.ms);
  expect(runs.every((r) => r.status === 0)).toBe(true);
  return runs[2] ?? { status: null, ms: Infinity };
}

describe("session-label hook (F22)", () => {
  it("exits 0 in under 100 ms even when hc hangs", () => {
    const { ms } = median({ path: `${slowBin}:/usr/bin:/bin` });
    expect(ms).toBeLessThan(100);
  });

  it("still hands hc the session and folder (detached)", async () => {
    run({ path: `${slowBin}:/usr/bin:/bin` });
    for (let i = 0; i < 50 && !existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(logFile, "utf8")).toContain("label t9 claude.session=abc-123_DEF claude.cwd=/home/me/proj");
  });

  it("ignores a claude -p (non-interactive) ancestor, labels under an interactive one", async () => {
    const fake = (name: string, args: string[]) => {
      const claude = join(dir, name, "claude");
      spawnSync("mkdir", ["-p", join(dir, name)]);
      writeFileSync(claude, `#!/bin/sh\nrm -f "${logFile}"\nbash "${HOOK}" <<'EOF'\n${INPUT}\nEOF\nsleep 0.5\n`);
      chmodSync(claude, 0o755);
      spawnSync(claude, args, { env: { PATH: `${slowBin}:/usr/bin:/bin`, HOME: dir, HC_TERMINAL_ID: "t9" }, timeout: 4000 });
    };
    fake("nested", ["-p", "hi"]);
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(logFile)).toBe(false);
    fake("interactive", ["--model", "x"]);
    for (let i = 0; i < 50 && !existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(logFile, "utf8")).toContain("claude.session=abc-123_DEF");
  });

  it("exits 0 in under 100 ms when hc is not installed (herdr not running)", () => {
    const { ms } = median({ path: "/usr/bin:/bin" });
    expect(ms).toBeLessThan(100);
  });

  it("exits 0 in under 100 ms outside a herdr terminal, and on garbage input", () => {
    expect(median({ path: `${slowBin}:/usr/bin:/bin`, terminal: null }).ms).toBeLessThan(100);
    expect(median({ path: `${slowBin}:/usr/bin:/bin`, input: "not json \u0000 {{{" }).ms).toBeLessThan(100);
    expect(median({ path: `${slowBin}:/usr/bin:/bin`, input: "" }).ms).toBeLessThan(100);
  });

  it("never reaches for the herdr app: no network tools in the script", () => {
    expect(readFileSync(HOOK, "utf8").replace(/^#.*$/gmu, "")).not.toMatch(/\b(curl|wget|nc|ncat|socat)\b|\/dev\/tcp/u);
  });
});
