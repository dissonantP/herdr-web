import type { BackendAdapter } from "@herdr/server/adapters/backend.ts";
import { DEFAULT_EVERY, idleMs, type Settings } from "../settings/store.ts";

const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_MS = idleMs(DEFAULT_EVERY) ?? 1_800_000;

// Auto-sleep (task 067), inside the backend: on a timer, put Claude sessions idle for longer than the
// settings page's idle time to sleep, outside its never-sleep spaces, while it is turned on. Each round
// reads the settings afresh, so a change applies from the next round.

export interface AutoSleepOptions {
  readonly backend: Pick<BackendAdapter, "sleepIdle">;
  readonly settings: { get(): Settings };
  /** Fixed round interval, overriding the setting (tests). */
  readonly everyMs?: number;
  /** The terminal herdr itself runs in, if any (never slept). */
  readonly self?: string;
  /** Panes the app sees waiting on a menu (from their screens), never slept. */
  readonly waiting?: () => ReadonlySet<string>;
}

export class AutoSleep {
  private readonly opts: AutoSleepOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: AutoSleepOptions) {
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One round: what it put to sleep (nothing when auto-sleep is off). */
  async round(): Promise<string[]> {
    const { autosleep } = this.opts.settings.get();
    const idle = idleMs(autosleep.idle);
    if (!autosleep.enabled || idle === null) return [];
    const skip = [...(this.opts.waiting?.() ?? []), ...(this.opts.self === undefined ? [] : [this.opts.self])];
    const slept = await this.opts.backend.sleepIdle(idle, autosleep.neverSleep, skip);
    if (slept.length > 0) console.log(`auto-sleep: put ${slept.join(", ")} to sleep`);
    return slept;
  }

  /** The settings page's interval, read afresh each time one round is scheduled. */
  private everyMs(): number {
    // setTimeout fires at once for delays over 2^31-1 ms (about 24.8 days), so a huge value is capped.
    return Math.min(idleMs(this.opts.settings.get().autosleep.every) ?? DEFAULT_MS, MAX_TIMER_MS);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.round()
        .catch((err: unknown) => console.error(`auto-sleep: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => this.schedule());
    }, this.opts.everyMs ?? this.everyMs());
  }
}
