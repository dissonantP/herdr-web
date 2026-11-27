import { useEffect, useState } from "react";
import type { ChatEvent, ChatMenu, ChatMessage } from "@herdr/server/chat.ts";
import { checkSession } from "./session.ts";

// One pane's conversation from `GET /api/chat/<pane id>`. EventSource reconnects by itself (the server
// caps a stream's lifetime), and every connection starts with a `reset`, so a reconnect replaces the
// list rather than doubling it.

export type ChatState =
  | { readonly status: "connecting"; readonly messages: readonly ChatMessage[]; readonly truncated: false }
  | { readonly status: "none"; readonly reason: string; readonly messages: readonly ChatMessage[]; readonly truncated: false }
  | { readonly status: "live"; readonly messages: readonly ChatMessage[]; readonly truncated: boolean };

const CONNECTING: ChatState = { status: "connecting", messages: [], truncated: false };

/** The state after one event. Messages replace by id, unknown ids append. (A menu is kept apart: `useChat`.) */
export function applyChatEvent(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case "menu":
      return state;
    case "none":
      // A conversation already on screen stays; "none" only matters before there is one.
      return state.status === "live" ? state : { status: "none", reason: event.reason, messages: [], truncated: false };
    case "reset":
      return { status: "live", messages: event.messages, truncated: event.truncated };
    case "upsert": {
      if (state.status !== "live") return state;
      const messages = [...state.messages];
      for (const m of event.messages) {
        const at = messages.findIndex((x) => x.id === m.id);
        if (at >= 0) messages[at] = m;
        else messages.push(m);
      }
      return { ...state, messages };
    }
  }
}

/** The conversation, plus the menu waiting on the agent's screen (`null` when none); an answer hands back the next one at once with `setMenu`. */
export function useChat(paneId: string): ChatState & { readonly menu: ChatMenu | null; readonly setMenu: (menu: ChatMenu | null) => void } {
  const [state, setState] = useState<ChatState>(CONNECTING);
  const [menu, setMenu] = useState<ChatMenu | null>(null);
  useEffect(() => {
    setState(CONNECTING);
    setMenu(null);
    const source = new EventSource(`/api/chat/${encodeURIComponent(paneId)}`);
    source.onmessage = (e: MessageEvent<string>) => {
      const event = JSON.parse(e.data) as ChatEvent;
      if (event.type === "menu") setMenu(event.menu);
      else setState((s) => applyChatEvent(s, event));
    };
    source.onerror = () => void checkSession();
    return () => source.close();
  }, [paneId]);
  return { ...state, menu, setMenu };
}
