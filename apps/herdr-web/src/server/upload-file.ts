import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, sep } from "node:path";
import { MAX_UPLOAD_BYTES } from "./input-service.ts";

// Serves back an image the chat uploaded, so a thumbnail can show it (task 091). `terminal.put`
// writes to `<core state>/files/<terminal>/<name>`; only a real file exactly there, with an image
// extension, is ever served. Never SVG (it can carry script).

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Where herdr-core keeps what `terminal.put` writes, from the same environment the client reads. */
export function uploadsRoot(env: Readonly<Record<string, string | undefined>>, home: string = homedir()): string {
  const session = (env.HC_SESSION ?? "").trim() || "default";
  const stateHome = (env.XDG_STATE_HOME ?? "").trim() || join(home, ".local/state");
  return join(stateHome, "herdr-core", session, "files");
}

/** The real path of `path` when it is an image directly inside one terminal's folder under `root`, else null. */
export async function servableImage(root: string, path: string): Promise<{ readonly file: string; readonly type: string; readonly size: number } | null> {
  if (!path.startsWith("/") || path.includes("\0")) return null;
  try {
    const file = await realpath(path);
    // The type is the real file's, so a link named .png to another upload is not served as an image.
    const type = IMAGE_TYPES[extname(file).toLowerCase()];
    if (type === undefined) return null;
    const base = await realpath(root);
    // Exactly `<root>/<terminal>/<file>`: no deeper, no sideways, and a link out of it resolves out of it.
    if (dirname(dirname(file)) !== base || !file.startsWith(base + sep)) return null;
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_UPLOAD_BYTES) return null;
    return { file, type, size: info.size };
  } catch {
    return null;
  }
}

export async function serveUploadedImage(root: string, path: string | null, res: ServerResponse): Promise<void> {
  const found = path === null ? null : await servableImage(root, path);
  // Open without following a link, then size what was opened: a file swapped or removed since the check is refused or ends the response, never crashes.
  const handle = found === null ? null : await open(found.file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  const size = handle === null ? null : await handle.stat().then((i) => (i.isFile() && i.size <= MAX_UPLOAD_BYTES ? i.size : null)).catch(() => null);
  if (found === null || handle === null || size === null) {
    await handle?.close().catch(() => undefined);
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": found.type,
    "content-length": size,
    "cache-control": "private, max-age=3600",
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
  });
  const stream = handle.createReadStream({ autoClose: true });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}
