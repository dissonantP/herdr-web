import { readFileSync, unwatchFile, watchFile } from "node:fs";
import type { PaneFacts } from "../adapters/chat.ts";
import { AdminError, type AttachOptions, type BackendAdapter, type PushFacts, type RawGroup, type RawSpace, type RawTree, type TerminalStream } from "../adapters/backend.ts";
import { HcError, type HcRpc, type WireLayout, type WireTerminal } from "./client.ts";
import { changeLayout, HerdrCoreAdmin } from "./admin.ts";
import { allTerminals, dropTerminals } from "./layout-edit.ts";
import { readGroups } from "./groups.ts";
import { applyGroupLabel, updateGroups } from "./groups-write.ts";
import { readQuietSpaces, recordQuiet } from "./quiet.ts";
import { buildTree, DISMISSED_LABEL, dismissKey, isAsleep, SEEN_LABEL } from "./tree.ts";
import { autoSleepCandidates, CLAUDE_CWD, CLAUDE_SESSION, runsClaude, runsShell, SESSION_ID, SLEEP_CWD, SLEEP_SESSION, sleepSignal, wakeLine } from "./sleep.ts";
import { changeTreeDoc, EMPTY_TREE_DOC, goneIn, readTreeDoc, reconcile, type ReconcileFacts, type TreeDoc } from "./tree-doc.ts";

const NOTIFY_LABEL = "herdr.notify";
const QUIET_LABEL = "herdr.quiet";
const SPACE_LABEL = "herdr.space";
const PARENT_LABEL = "herdr.parent";
const GROUP_LABEL = "group";

/**
 * Where a new space belongs (SPEC, "Auto-nesting"): its first terminal's parent terminal's
 * `herdr.space` label (else the space whose layout shows that terminal). `null`: no known parent;
 * `undefined`: no live terminal yet to ask.
 */
export function nestingFacts(layout: WireLayout, terminals: readonly WireTerminal[], pending: ReadonlySet<string>): ReconcileFacts {
  const live = new Map(terminals.filter((t) => t.state === "live").map((t) => [t.address, t]));
  const shownIn = new Map<string, string>();
  for (const space of layout.spaces) for (const tab of space.tabs) for (const block of tab.blocks) if (block.terminal !== "") shownIn.set(block.terminal, space.id);
  return {
    spaces: new Set(layout.spaces.map((s) => s.id)),
    pending,
    parentOfNew(spaceId) {
      const space = layout.spaces.find((s) => s.id === spaceId);
      const first = space?.tabs.flatMap((t) => t.blocks).map((b) => live.get(b.terminal)).find((t) => t !== undefined);
      if (first === undefined) return undefined;
      if (first.parent === "") return null;
      const parent = live.get(first.parent);
      if (parent === undefined) return null;
      return parent.labels[SPACE_LABEL] || shownIn.get(parent.address) || null;
    },
  };
}

// The herdr-core implementation of the backend adapter: reading the tree here, changing it in
// admin.ts (the layout doc with a version check, the groups file as Desktop writes it).

/** How often the groups file is checked. Desktop polls it about every 3 s; this is quicker. */
const GROUPS_POLL_MS = 500;
/** How long to wait before dialling the core again after its event stream went down. */
const RESUBSCRIBE_MS = 2000;

export interface HerdrCoreOptions {
  readonly rpc: Pick<HcRpc, "listTerminals" | "getTerminal" | "readLayout" | "subscribe" | "attach" | "getDoc" | "setDoc" | "runShell" | "killTerminal" | "keepTerminal" | "labelTerminal" | "readTerminal" | "pressKeys" | "typeRaw" | "sendText" | "interrupt" | "putFile">;
  readonly groupsFile: string;
  readonly home: string;
  /** How to find and resume a running agent's session, for sleep and wake (the agent adapter's). Without it, sleep and wake refuse. */
  readonly sessions?: SleepSessions;
}

/** What sleep and wake need from the agent: the session a process has open, and the command that resumes one. */
export interface SleepSessions {
  runningSession(pid: number): Promise<{ readonly id: string; readonly cwd: string } | null>;
  resumeCommand(session: string): readonly string[];
}

/**
 * When a process on this machine started (ms since the epoch), from /proc: its start in clock ticks
 * after boot (`/proc/<pid>/stat` field 22; USER_HZ is 100 on Linux) plus the boot time
 * (`/proc/stat` btime). 0 when it can't be read, so only the status time counts.
 */
export function processStartMs(pid: number | undefined): number {
  if (pid === undefined) return 0;
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    const btime = Number(/^btime (\d+)$/mu.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
    return Number.isFinite(ticks) && Number.isFinite(btime) ? btime * 1000 + ticks * 10 : 0;
  } catch {
    return 0;
  }
}

/** Whether the process is still there (a signal-0 probe). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait up to `ms` for the process to end; whether it did. */
async function waitFor(done: () => boolean | Promise<boolean>, deadline: number): Promise<boolean> {
  while (!(await done())) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

/** A space named by id, else by name (exact, then ignoring case); `-` is the top level (`null`). */
function resolveSpace(spaces: readonly { id: string; name: string }[], want: string): string | null {
  if (want === "-") return null;
  const byId = spaces.find((s) => s.id === want);
  if (byId !== undefined) return byId.id;
  for (const same of [(n: string) => n === want, (n: string) => n.toLowerCase() === want.toLowerCase()]) {
    const found = spaces.filter((s) => same(s.name));
    if (found.length === 1) return found[0]?.id ?? null;
    if (found.length > 1) throw new AdminError(`More than one space is called "${want}"; use its id.`);
  }
  throw new AdminError(`No space "${want}".`);
}

export class HerdrCoreBackend extends HerdrCoreAdmin implements BackendAdapter {
  private readonly opts: HerdrCoreOptions;
  /** Auto-sleep's last failure per pane, so a repeating one is logged once. */
  private readonly sleepFailures = new Map<string, string>();

  constructor(opts: HerdrCoreOptions) {
    super(opts);
    this.opts = opts;
  }

  async readTree(): Promise<RawTree> {
    // Pending spaces as they are before the layout read: one that stops pending later was already in that layout.
    const pending = new Set(this.pendingSpaces);
    const [terminals, layout, groups] = await Promise.all([this.opts.rpc.listTerminals(), this.opts.rpc.readLayout(), readGroups(this.opts.groupsFile)]);
    return buildTree(terminals, layout, groups, this.opts.home, await this.nesting(layout, terminals, pending));
  }

  /**
   * `herdr-tree` with its integrity rules applied (tree-doc.ts `reconcile`), written back when they
   * changed it. Without herdr-app's doc nothing can be checked, so it is only read. A failed write
   * (the core busy, a conflict storm) still draws the tree from the doc as it is.
   */
  private async nesting(layout: WireLayout | null, terminals: readonly WireTerminal[], pending: ReadonlySet<string>): Promise<TreeDoc> {
    // Display only: an unreadable doc draws the tree flat rather than not at all.
    const fallback = () => readTreeDoc(this.opts.rpc).catch(() => EMPTY_TREE_DOC);
    if (layout === null) return fallback();
    return changeTreeDoc(this.opts.rpc, async (doc) => {
      let facts = nestingFacts(layout, terminals, pending);
      if (goneIn(doc, facts).length > 0) {
        // Before dropping anything, look at herdr-app again, AFTER this read of the tree doc: a space
        // made here meanwhile (entry first, then layout) is then either in it or still pending.
        const pendingNow = new Set(this.pendingSpaces);
        const fresh = await this.opts.rpc.readLayout();
        if (fresh === null) return false;
        facts = nestingFacts(fresh, terminals, new Set([...pendingNow, ...this.pendingSpaces]));
      }
      return reconcile(doc, facts);
    }).catch(fallback);
  }

  /**
   * Apply `herdr.parent` labels (F49): an agent moves its own space with
   * `hc label "$HC_TERMINAL_ID" herdr.parent="<space name or id>"` (`-`: top level). The label comes
   * off whether the move worked or was refused (a cycle, no such space, an ambiguous name), so a
   * refusal is not retried forever. A terminal whose space is not known yet keeps its label for the next run.
   */
  async applyParentLabels(): Promise<void> {
    const asked = (await this.opts.rpc.listTerminals()).filter((t) => t.state === "live" && (t.labels[PARENT_LABEL] ?? "").trim() !== "");
    if (asked.length === 0) return;
    const [tree, layout] = await Promise.all([this.readTree(), this.opts.rpc.readLayout()]);
    const spaces: { id: string; name: string }[] = [];
    const walk = (list: readonly RawSpace[]) => {
      for (const sp of list) {
        spaces.push({ id: sp.id, name: sp.name });
        walk(sp.children);
      }
    };
    const walkGroups = (groups: readonly RawGroup[]) => {
      for (const g of groups) {
        walk(g.spaces);
        walkGroups(g.groups);
      }
    };
    walk(tree.spaces);
    walkGroups(tree.groups);
    const shownIn = new Map<string, string>();
    for (const sp of layout?.spaces ?? []) for (const tab of sp.tabs) for (const b of tab.blocks) if (b.terminal !== "") shownIn.set(b.terminal, sp.id);
    for (const t of asked) {
      const own = t.labels[SPACE_LABEL] || shownIn.get(t.address);
      if (own === undefined || !spaces.some((x) => x.id === own)) continue;
      const want = (t.labels[PARENT_LABEL] ?? "").trim();
      try {
        const parent = resolveSpace(spaces, want);
        await this.reparentSpace(own, parent);
      } catch (err) {
        console.error(`herdr.parent on ${t.address}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.opts.rpc.labelTerminal(t.address, { [PARENT_LABEL]: "" }).catch((err: unknown) => console.error(`herdr.parent on ${t.address}: label not cleared: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /**
   * Task 087: drop tabs and spaces left holding only terminals that no longer exist in herdr-core
   * (removed with `hc rm`), the way space.js's detach drops empty ones. A finished or sleeping
   * terminal still exists (terminal.get finds it), so its tab stays. Only the core's own "not found"
   * counts as removed; any other failure leaves the layout alone.
   */
  async dropRemovedTerminals(): Promise<void> {
    const [doc, live] = await Promise.all([this.opts.rpc.getDoc("herdr-app"), this.opts.rpc.listTerminals()]);
    if (doc.value === null) return;
    const liveSet = new Set(live.map((t) => t.address));
    const gone = new Set<string>();
    for (const address of new Set(allTerminals(doc.value))) {
      if (address === "" || address.includes("/") || liveSet.has(address)) continue;
      try {
        await this.opts.rpc.getTerminal(address);
      } catch (err) {
        if (err instanceof HcError && err.kind === "not_found") gone.add(address);
        else return;
      }
    }
    if (gone.size === 0) return;
    // Re-check inside the write: Desktop may have changed the doc meanwhile; the set is what was proven gone.
    await changeLayout(this.opts.rpc, (value) => dropTerminals(value, gone));
  }

  /**
   * Apply `group=` labels the way Desktop's spaces-grouped mod does, so a new space is filed in its
   * group when Desktop isn't running: `hc label "$HC_TERMINAL_ID" group="<name>"` (`-`: no group).
   * The label comes off once the file holds it. Doing it twice (Desktop too) changes nothing. A
   * terminal whose space isn't in the layout yet keeps its label for the next run.
   */
  async applyGroupLabels(): Promise<void> {
    const asked = (await this.opts.rpc.listTerminals()).filter((t) => t.state === "live" && (t.labels[GROUP_LABEL] ?? "").trim() !== "" && !t.address.includes("/"));
    if (asked.length === 0) return;
    const layout = await this.opts.rpc.readLayout();
    const shownIn = new Map<string, { id: string; name: string }>();
    for (const sp of layout?.spaces ?? []) for (const tab of sp.tabs) for (const b of tab.blocks) if (b.terminal !== "") shownIn.set(b.terminal, sp);
    for (const t of asked) {
      const own = layout?.spaces.find((s) => s.id === t.labels[SPACE_LABEL]) ?? shownIn.get(t.address);
      if (own === undefined) continue;
      const want = (t.labels[GROUP_LABEL] ?? "").trim();
      try {
        await updateGroups(this.opts.groupsFile, (body) => applyGroupLabel(body, own.id, own.name, want));
      } catch (err) {
        console.error(`group= on ${t.address}: ${err instanceof Error ? err.message : String(err)}`);
        continue; // the file couldn't be edited: keep the label and try again
      }
      await this.opts.rpc.labelTerminal(t.address, { [GROUP_LABEL]: "" }).catch((err: unknown) => console.error(`group= on ${t.address}: label not cleared: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  async sleepPane(id: string): Promise<void> {
    const t = await this.sleepTarget(id);
    if (t.state !== "live") throw new AdminError("That pane is gone.");
    if (isAsleep(t)) throw new AdminError("That session is already asleep.");
    if (!runsClaude(t)) throw new AdminError("Only a running Claude session can be put to sleep.");
    if (t.status?.state === "working") throw new AdminError("It is working right now; sleep it when it's idle.");
    if (t.status?.state === "blocked") throw new AdminError("It is waiting for an answer; answer it first.");
    await this.putToSleep(t);
  }

  async markSeen(id: string): Promise<void> {
    if (!/^t[0-9a-z]+$/u.test(id)) throw new AdminError("Only terminals on this machine have a seen mark.");
    const t = await this.opts.rpc.getTerminal(id).catch(() => {
      throw new AdminError("That pane is gone.");
    });
    const turn = t.turn ?? 0;
    // Only a finished turn is marked: a new turn may have started since the viewer's screen last updated.
    if (t.state !== "live" || t.status?.state !== "done" || turn <= (Number(t.labels[SEEN_LABEL]) || 0)) return;
    await this.opts.rpc.labelTerminal(id, { [SEEN_LABEL]: String(turn) });
  }

  async dismissPane(id: string): Promise<void> {
    if (!/^t[0-9a-z]+$/u.test(id)) throw new AdminError("Only terminals on this machine can be dismissed.");
    const t = await this.opts.rpc.getTerminal(id).catch(() => {
      throw new AdminError("That pane is gone.");
    });
    if (t.state !== "live") return;
    const turn = t.turn ?? 0;
    // Dismissing reads it, as opening it would: a finished turn is marked seen too.
    const seen: Record<string, string> = t.status?.state === "done" && turn > (Number(t.labels[SEEN_LABEL]) || 0) ? { [SEEN_LABEL]: String(turn) } : {};
    await this.opts.rpc.labelTerminal(id, { ...seen, [DISMISSED_LABEL]: dismissKey(t) });
  }

  async wakePane(id: string): Promise<void> {
    const t = await this.sleepTarget(id);
    if (t.state !== "live") throw new AdminError("That pane is gone.");
    if (!isAsleep(t)) throw new AdminError("That session isn't asleep.");
    const session = (t.labels[SLEEP_SESSION] ?? "") || (t.labels[CLAUDE_SESSION] ?? "");
    if (!SESSION_ID.test(session)) throw new AdminError("Its saved session id is not a session id; it was left alone.");
    if (!runsShell(t)) throw new AdminError(`${t.foreground?.name ?? "Nothing"} is running in it, not a shell; it was left alone.`);
    const sessions = this.opts.sessions;
    if (sessions === undefined) throw new AdminError("Sleep and wake are not set up on this server.");
    const cwd = (t.labels[SLEEP_CWD] ?? "") || (t.labels[CLAUDE_CWD] ?? "") || this.opts.home;
    const saved = { [SLEEP_SESSION]: t.labels[SLEEP_SESSION] ?? "", [SLEEP_CWD]: t.labels[SLEEP_CWD] ?? "", [CLAUDE_SESSION]: t.labels[CLAUDE_SESSION] ?? "", [CLAUDE_CWD]: t.labels[CLAUDE_CWD] ?? "" };
    this.wakeLabels.set(id, saved);
    // Labels off first (claude.* too: Claude's hook sets them again), so the pane stops showing asleep as soon as the line is typed (the send waits for the program to start).
    await this.opts.rpc.labelTerminal(id, { [SLEEP_SESSION]: "", [SLEEP_CWD]: "", [CLAUDE_SESSION]: "", [CLAUDE_CWD]: "" });
    try {
      // Ctrl+C first: text sent to the sleeping pane (hc send) is left on its prompt and would break the resume line.
      await this.opts.rpc.pressKeys(id, ["ctrl+c"]);
      await this.opts.rpc.sendText(id, wakeLine(cwd, sessions.resumeCommand(session)), false);
    } catch (err) {
      await this.opts.rpc.labelTerminal(id, saved).catch(() => undefined);
      throw err;
    }
  }

  /** The labels each woken pane had, to give back when its Claude never came up (task 139). */
  private readonly wakeLabels = new Map<string, Record<string, string>>();

  async restoreSleep(id: string): Promise<void> {
    const labels = this.wakeLabels.get(id);
    this.wakeLabels.delete(id);
    if (labels === undefined) return;
    const t = await this.opts.rpc.getTerminal(id);
    // Only while no Claude runs there (a late start keeps the pane awake).
    if (t.state === "live" && runsShell(t) && !isAsleep(t)) await this.opts.rpc.labelTerminal(id, labels);
  }

  /**
   * Auto-sleep (task 067): put to sleep every Claude session idle longer than `idleMs` outside the
   * never-sleep spaces (sleep.ts `autoSleepCandidates`). Each is checked again just before; one that
   * fails is logged and skipped. The addresses it put to sleep.
   */
  async sleepIdle(idleMs: number, neverSleep: readonly string[], skip: readonly string[] = []): Promise<string[]> {
    const [terminals, layout] = await Promise.all([this.opts.rpc.listTerminals(), this.opts.rpc.readLayout()]);
    const rules = () => ({ idleMs, neverSleep, now: Date.now(), skip: new Set(skip), awakeSince: (t: WireTerminal) => processStartMs(t.foreground?.pid) });
    const slept: string[] = [];
    for (const address of autoSleepCandidates(terminals, layout, rules())) {
      try {
        const fresh = await this.opts.rpc.getTerminal(address);
        if (autoSleepCandidates([fresh], layout, rules()).length === 0) continue;
        await this.putToSleep(fresh);
        slept.push(address);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        // A pane that keeps failing (say, no session file) is logged once per reason, not every round.
        if (this.sleepFailures.get(address) !== why) console.error(`auto-sleep ${address}: ${why}`);
        this.sleepFailures.set(address, why);
      }
    }
    return slept;
  }

  /** End the Claude running in `t` so its pane keeps a shell, recording its session first (sessions.py's `go_to_sleep`). */
  private async putToSleep(t: WireTerminal): Promise<void> {
    const pid = t.foreground?.pid;
    if (pid === undefined) throw new AdminError("Its Claude process can't be found.");
    const found = await this.opts.sessions?.runningSession(pid);
    if (found === undefined) throw new AdminError("Sleep and wake are not set up on this server.");
    if (found === null) throw new AdminError("Its Claude session can't be found, so it can't be resumed; left awake.");
    await this.opts.rpc.keepTerminal(t.address);
    await this.opts.rpc.labelTerminal(t.address, { [SLEEP_SESSION]: found.id, [SLEEP_CWD]: found.cwd || t.foreground?.cwd || t.cwd });
    try {
      process.kill(pid, sleepSignal(t));
    } catch (err) {
      if ((err as { code?: unknown }).code !== "ESRCH") throw err;
    }
    const deadline = Date.now() + 5000;
    if (!(await waitFor(() => !alive(pid), deadline))) {
      // Still running: take the labels off again, or the pane would later show asleep under a stale session.
      await this.opts.rpc.labelTerminal(t.address, { [SLEEP_SESSION]: "", [SLEEP_CWD]: "" }).catch(() => undefined);
      throw new AdminError("Claude did not end; it may still be running.");
    }
    // Asleep once the core sees the shell back in front, so the tree read right after the answer shows it (task 142).
    await waitFor(() => this.opts.rpc.getTerminal(t.address).then(isAsleep, () => true), deadline);
  }

  private async sleepTarget(id: string): Promise<WireTerminal> {
    if (!/^t[0-9a-z]+$/u.test(id)) throw new AdminError("Only terminals on this machine can sleep.");
    try {
      return await this.opts.rpc.getTerminal(id);
    } catch {
      throw new AdminError("That pane is gone.");
    }
  }

  async readPushFacts(): Promise<PushFacts> {
    const [terminals, quietSpaces] = await Promise.all([this.opts.rpc.listTerminals(), readQuietSpaces(this.opts.rpc)]);
    const live = terminals.filter((t) => t.state === "live" && t.address !== "" && !t.address.includes("/"));
    return {
      notes: live.flatMap((t) => ((t.labels[NOTIFY_LABEL] ?? "").trim() === "" ? [] : [{ paneId: t.address, text: t.labels[NOTIFY_LABEL] ?? "" }])),
      quietPanes: live.filter((t) => t.labels[QUIET_LABEL] === "1").map((t) => t.address),
      quietSpaces,
    };
  }

  clearNote(paneId: string): Promise<void> {
    return this.opts.rpc.labelTerminal(paneId, { [NOTIFY_LABEL]: "" });
  }

  markQuiet(spaceId: string): Promise<void> {
    return recordQuiet(this.opts.rpc, spaceId);
  }

  clearQuietLabel(paneId: string): Promise<void> {
    return this.opts.rpc.labelTerminal(paneId, { [QUIET_LABEL]: "" });
  }

  attachTerminal(paneId: string, opts: AttachOptions): TerminalStream {
    return this.opts.rpc.attach(paneId, opts);
  }

  async paneFacts(paneId: string): Promise<PaneFacts | null> {
    try {
      const t = await this.opts.rpc.getTerminal(paneId);
      return t.state === "live" ? { labels: t.labels, cwd: t.cwd } : null;
    } catch {
      return null;
    }
  }

  async readScreen(paneId: string): Promise<string> {
    return (await this.opts.rpc.readTerminal(paneId, 0)).text;
  }

  pressKeys(paneId: string, keys: readonly string[]): Promise<void> {
    return this.opts.rpc.pressKeys(paneId, keys);
  }

  typeText(paneId: string, text: string): Promise<void> {
    return this.opts.rpc.typeRaw(paneId, text);
  }

  sendText(paneId: string, text: string, force: boolean): Promise<void> {
    return this.opts.rpc.sendText(paneId, text, force);
  }

  interrupt(paneId: string): Promise<string> {
    return this.opts.rpc.interrupt(paneId);
  }

  putFile(paneId: string, name: string, bytes: Uint8Array): Promise<string> {
    return this.opts.rpc.putFile(paneId, name, bytes);
  }

  watch(onChange: () => void): () => void {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stream: { close(): void } | null = null;
    const subscribe = () => {
      stream = this.opts.rpc.subscribe({
        // Up again after being down: whatever happened meanwhile is unknown, so read everything.
        onUp: onChange,
        // Every event type can change the tree (a new terminal, a finished one, a status, a name,
        // a doc); heartbeats never reach here.
        onEvent: onChange,
        onDown: () => {
          onChange();
          if (!stopped) retry = setTimeout(subscribe, RESUBSCRIBE_MS);
        },
      });
    };
    subscribe();
    // Desktop replaces the file (tmp + mv); watchFile stats the path, so it sees the new inode.
    const onFile = () => onChange();
    watchFile(this.opts.groupsFile, { interval: GROUPS_POLL_MS }, onFile);
    return () => {
      stopped = true;
      if (retry !== null) clearTimeout(retry);
      stream?.close();
      unwatchFile(this.opts.groupsFile, onFile);
    };
  }
}
