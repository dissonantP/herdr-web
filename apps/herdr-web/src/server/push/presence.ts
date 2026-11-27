// Which panes a person has open in the app right now, so a session they are looking at never
// pushes (F19). Each open, visible page reports its pane about every 10 s with its own id; a report
// older than the TTL is forgotten, so a closed tab, a locked phone or a dead network stops
// counting within seconds.

/** How long a report counts. The page reports every 10 s. */
export const PRESENCE_TTL_MS = 25_000;

const MAX_CLIENTS = 50;

export class Presence {
  private readonly clients = new Map<string, { readonly panes: ReadonlySet<string>; readonly at: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A page's report: the panes it shows now (none when hidden or on the tree). */
  report(clientId: string, panes: readonly string[]): void {
    this.sweep();
    if (!this.clients.has(clientId) && this.clients.size >= MAX_CLIENTS) return;
    this.clients.set(clientId, { panes: new Set(panes), at: this.now() });
  }

  isOpen(paneId: string): boolean {
    this.sweep();
    for (const client of this.clients.values()) if (client.panes.has(paneId)) return true;
    return false;
  }

  private sweep(): void {
    const cutoff = this.now() - PRESENCE_TTL_MS;
    for (const [id, client] of this.clients) if (client.at < cutoff) this.clients.delete(id);
  }
}
