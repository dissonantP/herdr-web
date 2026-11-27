import type { ChatMenu, MenuAnswer } from "../shared/chat.ts";
import type { AgentAdapter } from "@herdr/server/adapters/agent.ts";
import type { BackendInput } from "@herdr/server/adapters/backend.ts";
import { AdminError } from "@herdr/server/adapters/backend.ts";
import type { InputStep } from "@herdr/server/adapters/chat.ts";

// The chat's input side (F17, F18), beside chat-service.ts and for the same pane and agent: a
// message, an attachment, and the menu on the agent's screen (watched, and answered). Knows nothing
// about Claude: the agent adapter reads its screen and names the keystrokes; this only does them
// through the backend, one request per pane at a time. Every refusal is an AdminError (shown to the
// person as is).

/** How often the screen is read for a menu while a chat is open. */
const MENU_POLL_MS = 1000;
/** How often an `until` step, or the wait after an answer, re-reads the screen. */
const POLL_MS = 100;
/** Most clear presses before giving up (one per row of a multi-line draft). */
const CLEAR_TRIES = 12;
/** How long a press may take to show on screen before the box counts as unchangeable (a ghost suggestion). */
const CLEAR_SETTLE_MS = 800;
/** How long an answer waits for the screen to show its effect before it returns anyway. */
const SETTLE_MS = 1500;
/** The longest message or typed answer taken. */
export const MAX_TEXT = 8000;
/** terminal.put's own cap. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Requests for one pane run one after another, so two devices (or a retry) never interleave keys. */
/** Wake a sleeping pane (once, in line with its other input). */
export const wakeOnce = <T>(paneId: string, work: () => Promise<T>): Promise<T> => serial(paneId, work);

const queues = new Map<string, Promise<unknown>>();
function serial<T>(paneId: string, work: () => Promise<T>): Promise<T> {
  const before = queues.get(paneId) ?? Promise.resolve();
  const run = before.then(work, work);
  const settled = run.catch(() => undefined);
  queues.set(paneId, settled);
  void settled.then(() => {
    if (queues.get(paneId) === settled) queues.delete(paneId);
  });
  return run;
}

/** Waking a sleeping session for a message (task 137). */
export interface Waker {
  /** Whether it sleeps now; throws when that can't be told (never guess awake: the text would run in a shell). */
  asleep(): Promise<boolean>;
  wake(): Promise<void>;
  /** Claude runs in the pane. */
  up(): Promise<boolean>;
  /** The wake failed (timeout): undo what the wake changed, so the pane shows asleep again. */
  failed?(): Promise<void>;
}

/** How long a woken Claude has to come up, and to draw its prompt. */
const WAKE_TIMEOUT_MS = 60_000;
const PROMPT_TIMEOUT_MS = 15_000;
/**
 * A resumed Claude draws its prompt box before it finishes starting (hooks, history); text typed in that
 * window is dropped (the intermittent lost message, task 139). `hc-wake` waits the same few seconds.
 */
const SETTLE_AFTER_PROMPT_MS = 5000;
/** How long to see the message leave the box after a send that woke the session. */
const DELIVER_MS = 4000;

/** Wake the pane if it sleeps, and wait until Claude is up with its prompt shown (also when a wake is already under way). */
async function wakeFirst(backend: BackendInput, agent: AgentAdapter, paneId: string, waker: Waker): Promise<boolean> {
  if (await waker.asleep()) await waker.wake();
  let waited = false;
  const deadline = Date.now() + WAKE_TIMEOUT_MS;
  while (!(await waker.up())) {
    waited = true;
    if (Date.now() > deadline) {
      await waker.failed?.().catch(() => undefined);
      throw new AdminError("It didn't wake up in time; your message was not sent.");
    }
    await sleep(500);
  }
  if (!waited) return false;
  const grace = Date.now() + PROMPT_TIMEOUT_MS;
  while (agent.draft(await backend.readScreen(paneId)) === null) {
    if (Date.now() > grace) throw new AdminError("Claude is up but didn't show its prompt; your message was not sent.");
    await sleep(POLL_MS);
  }
  await sleep(SETTLE_AFTER_PROMPT_MS);
  return true;
}

/**
 * A message typed into the agent and sent (Enter). A sleeping session (`waker`) is woken first. Refused while a menu waits (answer it first).
 * Text already in the prompt box (a desk draft, or the grey suggestion Claude pre-fills after a turn,
 * which a plain read cannot tell apart) is cleared first so the message is not added to it.
 */
export function sendMessage(backend: BackendInput, agent: AgentAdapter, paneId: string, text: string, waker?: Waker): Promise<void> {
  if (text.trim() === "") return Promise.reject(new AdminError("Type a message first."));
  if (text.length > MAX_TEXT) return Promise.reject(new AdminError("That message is too long."));
  return serial(paneId, async () => {
    const woke = waker !== undefined && (await wakeFirst(backend, agent, paneId, waker));
    const screen = await backend.readScreen(paneId);
    if (agent.readMenu(screen) !== null) throw new AdminError("A question is waiting above; answer it first.");
    await clearDraft(backend, agent, paneId, screen);
    await backend.sendText(paneId, text, false);
    if (woke) await submitIfStuck(backend, agent, paneId, text);
  });
}

/** After a send into a just-woken Claude: if the text still sits in the box (the Enter was lost), press Enter. */
async function submitIfStuck(backend: BackendInput, agent: AgentAdapter, paneId: string, text: string): Promise<void> {
  const probe = text.trim().slice(0, 40);
  const deadline = Date.now() + DELIVER_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS * 5);
    const draft = agent.draft(await backend.readScreen(paneId));
    if (draft === null || !draft.includes(probe)) return; // left the box: sent
  }
  await backend.pressKeys(paneId, ["enter"]);
}

/**
 * Clear the prompt box: press the clear-line key (ctrl+e first, so it works from any row of a
 * multi-line draft) until the box reads empty. A press that changes nothing within CLEAR_SETTLE_MS
 * means a grey suggestion a plain read keeps showing (typing replaces it), so the send goes ahead;
 * a box still holding text after CLEAR_TRIES presses that did change it is an error.
 */
async function clearDraft(backend: BackendInput, agent: AgentAdapter, paneId: string, first: string): Promise<void> {
  let screen = first;
  for (let i = 0; i < CLEAR_TRIES; i++) {
    const draft = agent.draft(screen);
    if (draft === null || draft === "") return;
    await backend.pressKeys(paneId, ["ctrl+e", "ctrl+u"]);
    const deadline = Date.now() + CLEAR_SETTLE_MS;
    let next = screen;
    while (next === screen && Date.now() < deadline) {
      await sleep(POLL_MS);
      next = await backend.readScreen(paneId);
    }
    if (next === screen) return; // nothing changed: a ghost suggestion
    screen = next;
  }
  const left = agent.draft(screen);
  if (left !== null && left !== "") throw new AdminError("Couldn't clear Claude's input box; clear it at the desk first.");
}

/** A file name safe to hand on: its last path part, odd characters as `_`, at most 100 characters. */
export function safeName(name: string): string {
  const base = name.split(/[/\\]/u).pop() ?? "";
  const clean = base.replace(/[^\w.-]/gu, "_").replace(/^\.+/u, "").slice(-100);
  return clean === "" ? "upload" : clean;
}

/** Put an attachment beside the agent's terminal (the caller caps its size); the path to put in the message. */
export async function upload(backend: BackendInput, paneId: string, name: string, bytes: Uint8Array): Promise<string> {
  if (bytes.length === 0) throw new AdminError("The file is empty.");
  return backend.putFile(paneId, safeName(name), bytes);
}

async function until(backend: BackendInput, paneId: string, test: (screen: string) => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (test(await backend.readScreen(paneId))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

async function run(backend: BackendInput, paneId: string, steps: readonly InputStep[]): Promise<void> {
  for (const step of steps) {
    switch (step.kind) {
      case "keys":
        if (step.keys.length > 0) await backend.pressKeys(paneId, step.keys);
        break;
      case "type":
        await backend.typeText(paneId, step.text);
        break;
      case "send":
        await backend.sendText(paneId, step.text, true);
        break;
      case "until":
        if (!(await until(backend, paneId, step.test, step.timeoutMs))) throw new AdminError(step.error);
        break;
    }
  }
}

/**
 * Answer the menu on screen. The answer names the menu it was meant for; when the screen shows
 * another by now (answered at the desk, the next step came) nothing is pressed. Afterwards it waits
 * (briefly) for the screen to show something else, and returns the menu now there, so the next tap
 * names the right one at once.
 */
export function answerMenu(backend: BackendInput, agent: AgentAdapter, paneId: string, answer: MenuAnswer): Promise<ChatMenu | null> {
  if (answer.action === "other" && answer.text.length > MAX_TEXT) return Promise.reject(new AdminError("That answer is too long."));
  return serial(paneId, async () => {
    const screen = await backend.readScreen(paneId);
    const menu = agent.readMenu(screen);
    if (menu === null) throw new AdminError("The question is no longer on screen.");
    if (menu.id !== answer.id) throw new AdminError("The question on screen has changed; look again.");
    const steps = agent.answerSteps(screen, answer);
    if ("refused" in steps) throw new AdminError(steps.refused);
    await run(backend, paneId, steps);
    let now: ChatMenu | null = menu;
    await until(
      backend,
      paneId,
      (s) => {
        now = agent.readMenu(s);
        return now?.id !== answer.id;
      },
      SETTLE_MS,
    );
    return now;
  });
}

/** Checks the screen for a menu and calls `send` whenever it changes (first with what is there now). */
export function watchMenu(backend: Pick<BackendInput, "readScreen">, agent: AgentAdapter, paneId: string, send: (menu: ChatMenu | null) => void, everyMs = MENU_POLL_MS): { close(): void } {
  let closed = false;
  let last: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = async () => {
    let menu: ChatMenu | null = null;
    try {
      menu = agent.readMenu(await backend.readScreen(paneId));
    } catch {
      menu = null; // the terminal is gone or unreadable: no menu to answer
    }
    if (closed) return;
    const text = JSON.stringify(menu);
    if (text !== last) {
      last = text;
      send(menu);
    }
  };
  const loop = async () => {
    await check();
    if (!closed) timer = setTimeout(() => void loop(), everyMs);
  };
  void loop();
  return {
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
