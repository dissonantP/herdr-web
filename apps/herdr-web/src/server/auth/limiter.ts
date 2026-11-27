// Login slowdown (F30). Every request reaches the backend from Traefik's address, so this is one
// global counter, not per source. After the n-th failure in a row the next attempt is refused,
// before any password check, until 2^(n-1) seconds have passed, capped at MAX_DELAY_MS: slower and
// slower, never a hard lock. A success resets it, and so does a quiet
// spell of FORGET_MS after the last wait ended (old typos don't add up over months).

export const MAX_DELAY_MS = 5 * 60_000;
const BASE_DELAY_MS = 1000;
export const FORGET_MS = 60 * 60_000;

export class LoginLimiter {
  private failures = 0;
  private notBefore = 0;

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Milliseconds until the next attempt may be checked; 0 when it may be now. */
  wait(): number {
    return Math.max(0, this.notBefore - this.now());
  }

  fail(): void {
    if (this.failures > 0 && this.now() > this.notBefore + FORGET_MS) this.failures = 0;
    this.failures += 1;
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(this.failures - 1, 30));
    this.notBefore = this.now() + delay;
  }

  succeed(): void {
    this.failures = 0;
    this.notBefore = 0;
  }
}
