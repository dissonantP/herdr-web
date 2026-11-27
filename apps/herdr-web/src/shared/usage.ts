// The usage bar's API answer (task 098); server/usage/usage.ts makes it.

export interface UsageLimit {
  readonly label: string;
  readonly pct: number;
  /** "Nov 24, 1am (America/Los_Angeles)", as Claude prints it; null when it prints none. */
  readonly resets: string | null;
}

export interface UsageSnapshot {
  readonly limits: readonly UsageLimit[];
  /** ms since the epoch */
  readonly fetchedAt: number;
}

export interface UsageReply {
  readonly ok: true;
  readonly snapshot: UsageSnapshot | null;
  /** A read is running now: ask again shortly. */
  readonly loading: boolean;
  /** The last read failed (the snapshot, if any, is older than that). */
  readonly error: string | null;
}
