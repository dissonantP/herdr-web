// Which service worker runs (task 084): the worker answers {type:"version"} with the build id the
// build stamped into it (vite.config.ts), the same id as the page's own build (build.ts) when both
// are current.

export interface WorkerInfo {
  /** The active worker's build id; `null` without one, "unknown" when it doesn't answer (pre-084). */
  readonly version: string | null;
  /** The page is controlled by a worker. */
  readonly controlling: boolean;
  /** A newer worker is installing or waiting. */
  readonly updating: boolean;
}

const ASK_MS = 2000;

export async function workerInfo(): Promise<WorkerInfo> {
  const sw = "serviceWorker" in navigator ? navigator.serviceWorker : undefined;
  const reg = await sw?.getRegistration().catch(() => undefined);
  const active = reg?.active ?? null;
  const base = { controlling: sw?.controller != null, updating: reg?.installing != null || reg?.waiting != null };
  if (active === null) return { version: null, ...base };
  const version = await new Promise<string>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e: MessageEvent<unknown>) => resolve(typeof e.data === "string" ? e.data : "unknown");
    setTimeout(() => resolve("unknown"), ASK_MS);
    active.postMessage({ type: "version" }, [channel.port2]);
  });
  return { version, ...base };
}
