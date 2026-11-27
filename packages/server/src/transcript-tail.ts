import { open, stat } from "node:fs/promises";
import type { ChatMessage } from "./chat.ts";
import type { TranscriptParser } from "./adapters/chat.ts";

// Follows one transcript file: reads the end of it once (long sessions are many megabytes; only the
// recent conversation is shown), then polls for appended lines. Only whole lines are parsed, so a
// line still being written waits for its newline. Memory stays small: nothing but the bytes since
// the last poll is held.

/** How much of the end of the file the first read looks at. */
export const INITIAL_BYTES = 1024 * 1024;
/** The most messages the first read sends. */
export const INITIAL_MESSAGES = 300;
const POLL_MS = 300;
/** A single poll reads at most this much; the rest waits for the next one. */
const READ_CHUNK = 4 * 1024 * 1024;
/** A line longer than this (a huge pasted image row) is skipped, so one stream never buffers a whole big file. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface TailOptions {
  readonly path: string;
  /** A fresh parser; asked for again if the file is replaced by a shorter one, so no row is parsed twice into one state. */
  readonly parser: () => TranscriptParser;
  /** New or changed messages after the first read. */
  readonly onMessages: (messages: readonly ChatMessage[]) => void;
  readonly pollMs?: number;
}

/** Merge by id keeping the last version, in first-seen order. */
export function mergeById(messages: readonly ChatMessage[]): ChatMessage[] {
  const map = new Map<string, ChatMessage>();
  for (const m of messages) map.set(m.id, m);
  return [...map.values()];
}

export class TranscriptTail {
  private readonly opts: TailOptions;
  private offset = 0;
  private rest: Buffer = Buffer.alloc(0);
  private skipping = false;
  private parser: TranscriptParser;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private closed = false;

  constructor(opts: TailOptions) {
    this.opts = opts;
    this.parser = opts.parser();
  }

  /** Read the end of the file and start following it. Resolves with the conversation so far. */
  async start(): Promise<{ messages: ChatMessage[]; truncated: boolean }> {
    const size = (await stat(this.opts.path)).size;
    const from = Math.max(0, size - INITIAL_BYTES);
    const bytes = await this.readRange(from, size);
    this.offset = size;
    let lines = this.split(bytes);
    if (from > 0) lines = lines.slice(1); // the first line is cut in the middle
    const all = mergeById(lines.flatMap((l) => this.parser.feed(l)));
    const messages = all.slice(-INITIAL_MESSAGES);
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? POLL_MS);
    return { messages, truncated: from > 0 || all.length > messages.length };
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Whole lines of `rest` + `bytes`; an unfinished last line stays in `rest` for the next read. */
  private split(bytes: Buffer): string[] {
    let all = Buffer.concat([this.rest, bytes]);
    if (this.skipping) {
      // inside an oversized line: drop bytes until its newline
      const nl = all.indexOf(0x0a);
      if (nl < 0) {
        this.rest = Buffer.alloc(0);
        return [];
      }
      all = all.subarray(nl + 1);
      this.skipping = false;
    }
    const cut = all.lastIndexOf(0x0a);
    this.rest = cut < 0 ? all : all.subarray(cut + 1);
    if (this.rest.length > MAX_LINE_BYTES) {
      this.rest = Buffer.alloc(0);
      this.skipping = true;
    }
    return cut < 0 ? [] : all.subarray(0, cut).toString("utf8").split("\n");
  }

  private async readRange(from: number, to: number): Promise<Buffer> {
    if (to <= from) return Buffer.alloc(0);
    const handle = await open(this.opts.path, "r");
    try {
      const buffer = Buffer.alloc(to - from);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  private async poll(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const size = (await stat(this.opts.path)).size;
      if (size < this.offset) {
        this.offset = 0; // the file was replaced by a shorter one: read it from the start
        this.rest = Buffer.alloc(0);
        this.skipping = false;
        this.parser = this.opts.parser();
      }
      if (size === this.offset) return;
      const to = Math.min(size, this.offset + READ_CHUNK);
      const bytes = await this.readRange(this.offset, to);
      this.offset = to;
      const lines = this.split(bytes);
      const messages = mergeById(lines.flatMap((l) => this.parser.feed(l)));
      if (messages.length > 0 && !this.closed) this.opts.onMessages(messages);
    } catch {
      // the file vanished or is unreadable for now; the next poll (300 ms later) reads from the same offset again
    } finally {
      this.busy = false;
    }
  }
}
