import { useEffect } from "react";
import type { TreeMessage } from "../shared/model.ts";
import { openStream } from "./stream.ts";
import { reloadIfStale } from "./build.ts";
import { receive, streamLive, useSync, type SyncView } from "./sync.ts";

// The UI's only link to the backend's tree: the HTTP API's tree stream, fed into the sync store (sync.ts), which
// lays the user's own changes over it. It reopens itself after any drop (stream.ts), and each connect says which
// UI build the server has (build.ts); a gone session sends the page to the login (session.ts).

export function useTree(): SyncView {
  useEffect(() => {
    const stream = openStream("/api/events", (data) => receive(JSON.parse(data) as TreeMessage), { build: reloadIfStale }, streamLive);
    return () => stream.close();
  }, []);
  return useSync();
}
