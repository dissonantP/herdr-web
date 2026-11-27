import { checkSession } from "@herdr/web/session.ts";

// A server-sent stream that never stays dead. EventSource reconnects by itself after a dropped
// connection, but gives up for good when the answer isn't a 200 event stream, which is what the proxy
// returns while the backend restarts (502/503). A page left open through a deploy then kept its old
// tree. Here a closed source is reopened after a short delay until the page unmounts.

const RETRY_MS = 1000;

export interface Stream {
  readonly close: () => void;
}

/** `onLive`: told when the stream drops (`false`) and when it is open again (`true`). */
export function openStream(url: string, onMessage: (data: string) => void, onNamed?: Record<string, (data: string) => void>, onLive?: (live: boolean) => void): Stream {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const open = () => {
    const es = new EventSource(url);
    source = es;
    es.onopen = () => onLive?.(true);
    es.onmessage = (e: MessageEvent<string>) => onMessage(e.data);
    for (const [name, handler] of Object.entries(onNamed ?? {})) es.addEventListener(name, (e) => handler((e as MessageEvent<string>).data));
    es.onerror = () => {
      void checkSession();
      if (!closed) onLive?.(false);
      if (es.readyState !== EventSource.CLOSED || closed) return; // CONNECTING: the browser retries by itself
      timer = setTimeout(open, RETRY_MS);
    };
  };
  open();
  return {
    close: () => {
      closed = true;
      clearTimeout(timer);
      source?.close();
    },
  };
}
