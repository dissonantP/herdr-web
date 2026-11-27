import { dismissFailure, useSync } from "./sync.ts";

// What the screen knows about the server (task 142): nothing while all is well; a quiet note in the top bar while a
// change is still on its way, the stream is down, or the core failed its last read; and a toast when a change was refused.

export function SyncStatus() {
  const { health, slow } = useSync();
  const label = health === "offline" ? "Reconnecting" : health === "stale" ? "Out of date" : slow ? "Syncing" : null;
  if (label === null) return null;
  return (
    <div className="sync-status" data-testid="sync-status" data-state={health === "live" ? "syncing" : health} role="status" title={label === "Syncing" ? "Saving to herdr…" : label === "Reconnecting" ? "Lost the connection to herdr; what you see may be behind." : "herdr-core didn't answer its last read; what you see may be behind."}>
      <i className="sync-dot" aria-hidden="true" />
      <span className="sync-label">{label}</span>
    </div>
  );
}

export function SyncToast() {
  const { failure } = useSync();
  if (failure === null) return null;
  return (
    <div className="sync-toast" data-testid="sync-toast" role="alert">
      <span className="sync-toast-text">{failure}</span>
      <button type="button" className="sync-toast-close" aria-label="Dismiss" data-testid="sync-toast-close" onClick={dismissFailure}>
        ×
      </button>
    </div>
  );
}
