import type { GroupNode, PaneNode, SpaceNode, Tree, TreeMessage } from "../shared/model.ts";
import type { AgentAdapter } from "@herdr/server/adapters/agent.ts";
import type { BackendAdapter, RawGroup, RawPane, RawSpace, RawTree } from "@herdr/server/adapters/backend.ts";
import { allSpaces } from "../shared/tree-walk.ts";

// The live tree: the backend's hierarchy with each pane's agent recognised, re-read when the
// backend says something changed, and handed to every listener only when it actually differs.

/** What the tree service needs of the backend; `readScreen` lets it see menus the program did not report. */
export type TreeSource = Pick<BackendAdapter, "readTree" | "watch" | "readScreen">;

/** Changes that land together (a burst of core events) are read once. */
const SETTLE_MS = 100;

/** The longest a woken pane keeps showing as a chat while Claude comes up. */
const WAKING_MS = 90_000;

/** How often agent panes' screens are checked for a menu waiting on an answer (F4's "needs input"). */
const SCAN_MS = 4000;

/** `waiting`: panes whose screen shows a menu although their program did not report itself blocked (a dismissal does not hide those: they need an answer). */
export function decorate(raw: RawTree, agents: readonly AgentAdapter[], waiting: ReadonlySet<string> = new Set(), waking: ReadonlySet<string> = new Set()): Tree {
  const pane = (p: RawPane): PaneNode => {
    const program = p.program;
    // Asleep: whatever status the killed Claude last reported is stale. Its conversation is still readable from the saved session (task 137).
    if (p.asleep) return { id: p.id, kind: p.kind, name: p.name, agent: null, status: null, chat: agents.find((a) => a.name === "claude")?.chat ?? false, asleep: true };
    // Being woken (task 137): labels are cleared but Claude is not up yet; it stays a chat so the composer and history don't vanish.
    const chatWhileWaking = waking.has(p.id) && p.kind === "terminal";
    const found = program === null ? undefined : agents.map((adapter) => ({ adapter, reading: adapter.recognise(program) })).find((x) => x.reading !== null);
    const reading = found?.reading ?? null;
    const status = reading !== null && waiting.has(p.id) ? "waiting" : (reading?.status ?? null);
    return { id: p.id, kind: p.kind, name: p.name, agent: reading?.agent ?? null, status, chat: found?.adapter.chat ?? (chatWhileWaking && (agents.find((a) => a.name === "claude")?.chat ?? false)), asleep: false, ...(chatWhileWaking && found === undefined ? { waking: true } : {}), ...(p.inboxHidden ? { inboxHidden: true } : {}), ...(status === "idle" && program?.unseen === true ? { unseen: true } : {}), ...(program?.dismissed === true && !waiting.has(p.id) ? { dismissed: true } : {}) };
  };
  const space = (s: RawSpace): SpaceNode => ({ id: s.id, name: s.name, quiet: s.quiet, color: s.color, tabs: s.tabs.map((t) => ({ id: t.id, name: t.name, panes: t.panes.map(pane) })), children: s.children.map(space) });
  const group = (g: RawGroup): GroupNode => ({ id: g.id, name: g.name, color: g.color, spaces: g.spaces.map(space), groups: g.groups.map(group) });
  return { spaces: raw.spaces.map(space), groups: raw.groups.map(group) };
}

export class TreeService {
  private readonly backend: TreeSource;
  private readonly agents: readonly AgentAdapter[];
  private readonly listeners = new Set<(message: TreeMessage) => void>();
  private current: TreeMessage | null = null;
  private currentText = "";
  private stopWatch: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reading: Promise<void> | null = null;
  private again = false;
  private waiting = new Set<string>();
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Panes being woken, by when the wake started; each counts until Claude is up or WAKING_MS passes. */
  private readonly wakingSince = new Map<string, number>();

  constructor(backend: TreeSource, agents: readonly AgentAdapter[]) {
    this.backend = backend;
    this.agents = agents;
  }

  start(): void {
    this.stopWatch = this.backend.watch(() => this.schedule());
    this.schedule();
    this.scanTimer = setTimeout(() => void this.scanLoop(), SCAN_MS);
  }

  stop(): void {
    this.stopped = true;
    this.stopWatch?.();
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.scanTimer !== null) clearTimeout(this.scanTimer);
  }

  private async scanLoop(): Promise<void> {
    await this.scan().catch(() => undefined);
    // Some changes make no core event: a Claude ended by SIGKILL (sleep) or started by typing (wake) changes the
    // terminal's foreground program only. Reading again is cheap and notifies only when something differs.
    await this.refresh();
    if (!this.stopped) this.scanTimer = setTimeout(() => void this.scanLoop(), SCAN_MS);
  }

  /**
   * Read the screen of every agent pane its program does not already report as waiting, and ask its
   * agent adapter whether a menu is up; refresh the tree when that set changes. One read at a time.
   */
  async scan(): Promise<void> {
    if (this.current?.ok !== true) return;
    const panes: { id: string; agent: AgentAdapter }[] = [];
    for (const s of allSpaces(this.current.tree)) for (const t of s.tabs) for (const p of t.panes) {
      const agent = p.kind === "terminal" && p.agent !== null ? this.agents.find((a) => a.name === p.agent) : undefined;
      if (agent !== undefined && (p.status !== "waiting" || this.waiting.has(p.id))) panes.push({ id: p.id, agent });
    }
    const next = new Set<string>();
    for (const { id, agent } of panes) {
      const screen = await this.backend.readScreen(id).catch(() => "");
      if (screen !== "" && agent.needsInput(screen)) next.add(id);
    }
    const changed = next.size !== this.waiting.size || [...next].some((id) => !this.waiting.has(id));
    this.waiting = next;
    if (changed) await this.refresh();
  }

  /** A pane's wake has started (task 137): it keeps showing as a chat until Claude is back. */
  markWaking(id: string): void {
    this.wakingSince.set(id, Date.now());
  }

  unmarkWaking(id: string): void {
    this.wakingSince.delete(id);
  }

  private wakingNow(): Set<string> {
    const now = Date.now();
    for (const [id, since] of this.wakingSince) if (now - since > WAKING_MS) this.wakingSince.delete(id);
    return new Set(this.wakingSince.keys());
  }

  /** The latest tree, read now if none was read yet. */
  /** Panes whose screen shows a menu waiting on an answer although their program did not report itself blocked. */
  waitingPanes(): ReadonlySet<string> {
    return this.waiting;
  }

  async get(): Promise<TreeMessage> {
    if (this.current === null) await this.refresh();
    return this.current ?? { ok: false, error: "not read yet" };
  }

  subscribe(listener: (message: TreeMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, SETTLE_MS);
  }

  /**
   * Read the tree now (also after a change made here), handing it to listeners if it differs. One
   * read at a time; a call during a read triggers one more, and resolves after it.
   */
  refresh(): Promise<void> {
    if (this.reading !== null) {
      this.again = true;
      return this.reading;
    }
    this.reading = (async () => {
      do {
        this.again = false;
        let message: TreeMessage;
        try {
          message = { ok: true, tree: decorate(await this.backend.readTree(), this.agents, this.waiting, this.wakingNow()) };
        } catch (err) {
          message = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        const text = JSON.stringify(message);
        if (text !== this.currentText) {
          this.current = message;
          this.currentText = text;
          for (const listener of this.listeners) listener(message);
        }
      } while (this.again);
    })().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }
}
