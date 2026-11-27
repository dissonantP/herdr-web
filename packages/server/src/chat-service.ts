import type { ChatEvent } from "./chat.ts";
import type { AgentAdapter } from "./adapters/agent.ts";
import type { BackendAdapter } from "./adapters/backend.ts";
import { TranscriptTail } from "./transcript-tail.ts";

// Streams one pane's conversation: asks the backend which session the pane is in (the label changes
// when the user runs /clear or resumes), has the agent adapter find and parse that transcript, and
// sends events until closed. Knows nothing about Claude: the agent adapter does.
//
// Seam for the next task (chat input, stop, attachments, menus): it needs the same pane and agent, so
// it belongs next to this as a second service the HTTP layer routes beside `/api/chat/<pane>`.

/** How often the pane's session label is re-read, which is also how soon a new session shows up. */
const RECHECK_MS = 1500;

export interface ChatSubscription {
  close(): void;
}

export function openChat(backend: Pick<BackendAdapter, "paneFacts">, agent: AgentAdapter, paneId: string, send: (event: ChatEvent) => void, recheckMs = RECHECK_MS): ChatSubscription {
  let closed = false;
  let key: string | null = null;
  let tail: TranscriptTail | null = null;
  let lastNone = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const none = (reason: string) => {
    if (reason === lastNone) return;
    lastNone = reason;
    send({ type: "none", reason });
  };

  const check = async () => {
    try {
      const facts = await backend.paneFacts(paneId);
      if (closed) return;
      if (facts === null) return none("The terminal is gone.");
      const source = await agent.transcript(facts);
      if (closed) return;
      if (source === null) return none("Waiting for the session to start.");
      if (source.key === key) return;
      tail?.close();
      tail = null;
      const next = new TranscriptTail({ path: source.path, parser: () => agent.parser(), onMessages: (messages) => !closed && send({ type: "upsert", messages }) });
      const first = await next.start();
      if (closed) {
        next.close();
        return;
      }
      tail = next;
      key = source.key;
      lastNone = "";
      send({ type: "reset", session: source.key, messages: first.messages, truncated: first.truncated });
    } catch {
      none("The conversation can't be read right now.");
    }
  };

  const loop = async () => {
    await check();
    if (!closed) timer = setTimeout(() => void loop(), recheckMs);
  };
  void loop();

  return {
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      tail?.close();
    },
  };
}
