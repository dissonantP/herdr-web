import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Conversation } from "../model.ts";

// Past Claude conversations for "resume" (F15): the transcripts in `<config dir>/projects/<folder>/<session>.jsonl`.
// Only the head of each file is read (its folder, its name or first message), the newest files first,
// so a long history stays cheap.

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;
const HEAD_BYTES = 256 * 1024;
const TITLE_CHARS = 120;

type Line = Record<string, unknown>;

/** The text of a user message (a string, or the text parts of a content array). */
function userText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => ((p as { type?: unknown; text?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join(" ");
}

/** What the head of a transcript says: its folder, its name, its first real message. */
export function readHead(text: string): { cwd: string; title: string } {
  let cwd = "";
  let named = "";
  let first = "";
  for (const raw of text.split("\n")) {
    if (raw === "" || raw[0] !== "{") continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue; // the head can cut the last line short
    }
    if (cwd === "" && typeof line.cwd === "string") cwd = line.cwd;
    if (line.type === "custom-title" && typeof line.customTitle === "string") named = line.customTitle;
    if (first === "" && line.type === "user" && line.isMeta !== true && line.isSidechain !== true) {
      const t = userText(line.message).replace(/\s+/gu, " ").trim();
      // Commands and hook output are wrapped in <tags>; they are not what the person asked.
      if (t !== "" && !t.startsWith("<")) first = t;
    }
  }
  const title = (named !== "" ? named : first).slice(0, TITLE_CHARS);
  return { cwd, title };
}

async function head(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await file.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

/** The most recent conversations (at most `limit`), newest first; those with no folder or no words are left out. */
export async function listConversations(configDir: string, limit = 60): Promise<Conversation[]> {
  if (configDir === "") return [];
  const projects = join(configDir, "projects");
  const found: { session: string; path: string; updated: number }[] = [];
  for (const dir of await readdir(projects).catch(() => [] as string[])) {
    for (const name of await readdir(join(projects, dir)).catch(() => [] as string[])) {
      const m = SESSION_FILE.exec(name);
      if (m?.[1] === undefined) continue;
      const path = join(projects, dir, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile() === true) found.push({ session: m[1], path, updated: info.mtimeMs });
    }
  }
  found.sort((a, b) => b.updated - a.updated);
  const out: Conversation[] = [];
  for (const f of found) {
    if (out.length >= limit) break;
    const { cwd, title } = readHead(await head(f.path).catch(() => ""));
    if (cwd !== "" && title !== "") out.push({ session: f.session, cwd, title, updated: f.updated });
  }
  return out;
}
