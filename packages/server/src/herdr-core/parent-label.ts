// Runs `applyParentLabels` (adapter.ts; F49), or `applyGroupLabels`, soon after a core event and every few seconds, never
// two at once. Only reads labels and moves spaces in `herdr-tree`; errors are logged and retried.

export interface ParentLabelOptions {
  readonly apply: () => Promise<void>;
  readonly intervalMs?: number;
  /** Named in the log line when `apply` fails (default `herdr.parent`). */
  readonly label?: string;
}

export class ParentLabelWatcher {
  private readonly opts: ParentLabelOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poked: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(opts: ParentLabelOptions) {
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.poked !== null) clearTimeout(this.poked);
  }

  /** Check soon (a core event); a burst of events makes one check. */
  poke(): void {
    if (this.poked !== null || this.stopped) return;
    this.poked = setTimeout(() => {
      this.poked = null;
      void this.check();
    }, 500);
    this.poked.unref();
  }

  private async loop(): Promise<void> {
    await this.check();
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.loop(), this.opts.intervalMs ?? 5000);
      this.timer.unref();
    }
  }

  check(): Promise<void> {
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.opts.apply().catch((err: unknown) => console.error(`${this.opts.label ?? "herdr.parent"}: ${err instanceof Error ? err.message : String(err)}`));
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }
}
