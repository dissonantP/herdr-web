import { spawn } from "node:child_process";
import type { UsageLimit, UsageReply, UsageSnapshot } from "../../shared/usage.ts";

// The Claude plan's limits for the usage bar (task 098): what `claude -p /usage` prints, the same numbers as /usage.
// It spends no model call but takes ~10-20 s and ~420 MB, so it runs on demand only: at most once per TTL, never
// twice at once, and in its own systemd scope (a child of herdr.service would count against its 300 MB MemoryMax).

export type { UsageLimit, UsageReply, UsageSnapshot } from "../../shared/usage.ts";

const LINE = /^(Current [^:]+): (\d+)% used(?: · resets (.+))?$/u;

/** The limit lines of `claude -p /usage`; others (tips, headings) are ignored. */
export function parseUsage(text: string): UsageLimit[] {
  const out: UsageLimit[] = [];
  for (const line of text.split("\n")) {
    const m = LINE.exec(line.trim());
    if (m !== null) out.push({ label: m[1]!.replace(/^Current /u, ""), pct: Number(m[2]), resets: m[3] ?? null });
  }
  return out;
}

export type RunUsage = () => Promise<string>;

/** Runs the command in `cwd` (a private folder: Claude reads project config from its cwd) without HC_TERMINAL_ID (so its hooks don't relabel a pane) and gives its stdout. */
export function runCommand(argv: readonly string[], cwd: string, timeoutMs = 90_000): RunUsage {
  return () =>
    new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.HC_TERMINAL_ID;
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn();
      };
      child.stdout.on("data", (d: Buffer) => {
        if (out.length < 64 * 1024) out += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        err = (err + d.toString("utf8")).slice(-300);
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout.destroy();
        finish(() => reject(new Error("timed out")));
      }, timeoutMs);
      child.on("error", (e) => finish(() => reject(e)));
      child.on("close", (code) => finish(() => (code === 0 ? resolve(out) : reject(new Error(`exit ${String(code)}: ${err.trim()}`)))));
    });
}

export class UsageService {
  #snapshot: UsageSnapshot | null = null;
  #error: string | null = null;
  #running = false;
  #lastTry = -Infinity;

  readonly #run: RunUsage;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(run: RunUsage, ttlMs = 5 * 60_000, now: () => number = Date.now) {
    this.#run = run;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /** What is known now; starts a read when the last try (good or failed) is older than the TTL. */
  get(): UsageReply {
    if (!this.#running && this.#now() - this.#lastTry >= this.#ttlMs) void this.#refresh();
    return { ok: true, snapshot: this.#snapshot, loading: this.#running, error: this.#error };
  }

  async #refresh(): Promise<void> {
    this.#running = true;
    this.#lastTry = this.#now();
    try {
      const limits = parseUsage(await this.#run());
      if (limits.length === 0) throw new Error("no usage lines in the output");
      this.#snapshot = { limits, fetchedAt: this.#now() };
      this.#error = null;
    } catch (err) {
      this.#error = err instanceof Error ? err.message : String(err);
    } finally {
      this.#running = false;
    }
  }
}
