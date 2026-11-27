// Borrowed from AltanS/collie (MIT, Copyright (c) 2026 Altan Sarisin; full notice in
// third_party/collie-LICENSE), file bridge/mux/herdr-core/client.ts at commit
// 62e638c59770bb1ec58412732f59c102a717ede2. Changes for herdr are marked "herdr:".

import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import type { AttachOptions, TerminalStream } from "../adapters/backend.ts";
import type { JsonObject, JsonValue } from "./json.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The herdr-core socket, the TRANSPORT. This is the only file that knows the core's method names
// and wire shapes; `adapter.ts` next to it is the only file that knows these typed methods, and
// everything above that talks the mux port (bridge/mux/types.ts). Every fact here is in
// HC_API.md, probed on hc 0.1.14 (protocol generation 1) on 2026-10-29.
//
// Four wire facts shape this file:
//
//  • **Plain mode is JSON-RPC 2.0, one message per line, and needs no `hello`.** So a call opens
//    one connection, writes one line and reads one answer, as the Herdr and tuios clients do. The
//    snapshot's two reads run side by side on two connections, and a Unix connect costs nothing.
//  • **There is no "type this text" method.** `terminal.send` presses Enter, `terminal.keys` takes
//    key names only (it refuses `$`, `"`, a space), `terminal.put` writes a file. Raw input goes
//    through a FRAMED `terminal.attach`, and that is {@link HcClient.typeRaw}.
//  • **The last active attached viewer sets the terminal's size**, and typing makes a viewer
//    active. So the attach names the terminal's OWN `cols` and `rows`, read on the same connection
//    a moment before, and nothing herdr-app shows is resized.
//  • **The event stream has a heartbeat every 15 s.** A stream that goes quiet for longer than
//    {@link HC_STREAM_SILENCE_MS} is a dead stream, whatever the socket says.
//
// `node:net`, not `bridge/dial.ts`: a framed connection writes binary frame headers, and the
// dialer's handle writes strings only.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-call wall-clock budget, when the target names none. */
export const DEFAULT_HC_TIMEOUT_MS = 5000;

/** herdr: `terminal.send`'s budget: the core itself waits up to about 5 s for a turn to start. */
const SEND_TIMEOUT_MS = 20_000;

/** The protocol generation this client speaks, sent in `hello`. */
export const HC_GENERATION = 1;

/**
 * How long an event stream may stay silent before it counts as down. The core sends a heartbeat
 * every 15 s when it has nothing else to say (HC_API.md § events.subscribe), so two missed beats
 * and a margin.
 */
export const HC_STREAM_SILENCE_MS = 40_000;

/** The largest DATA payload one frame carries here. The core takes up to 16 MiB. */
const MAX_FRAME_PAYLOAD = 1024 * 1024;

/** Frame kinds (HC_API.md § Transport, framed mode). */
const FRAME_DATA = 0;
const FRAME_CLOSE = 2;
const FRAME_RESIZE = 3;

/** What `hello` says about the core. */
export interface WireHello {
  readonly generation: number;
  readonly version: string;
  readonly coreId: string;
  readonly coreName: string;
}

/** What `server.status` says about the core: its version and how many terminals it keeps. */
export interface WireServerStatus {
  readonly version: string;
  readonly live: number;
  readonly finished: number;
}

/** A program's own OSC 7501 report. Words are the program's; nothing is translated. */
export interface WireStatus {
  /** `idle`, `working`, `done`, `blocked` or `error`. */
  readonly state: string;
  /** The program's own name for itself (`claude-code`). Empty when it named none. */
  readonly app: string;
  /** `permission`, `question` or `auth`, on `blocked` only. Empty otherwise. */
  readonly kind: string;
}

/** What runs in a terminal right now, as the OS has it. A process name, never an agent identity. */
export interface WireForeground {
  readonly name: string;
  readonly cwd: string;
  /** The leader's process id. Optional: an older core may omit it. */
  readonly pid?: number;
  /** The leader's command line. Optional: an older core may omit it. */
  readonly argv?: readonly string[];
}

/** One terminal record, read for the fields the adapter maps and no others. */
export interface WireTerminal {
  /** `t7` here, `machine/t7` for a terminal on an added machine. */
  readonly address: string;
  /** The name it was started with, or `""`. */
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  /** `live` or `finished`. */
  readonly state: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly title: string;
  readonly status: WireStatus | null;
  /** When `status.state` last changed (ms since the epoch), or `null` when the core gave none. */
  readonly statusMs: number | null;
  /** The terminal's turn counter (what `herdr.seen` is compared with), 0 when the core gave none. */
  readonly turn?: number;
  /** The terminal's own program's process id, or `null` when the core gave none. */
  readonly pid: number | null;
  readonly foreground: WireForeground | null;
  /** herdr: the terminal that started it (`t7`), or `""` for none. */
  readonly parent: string;
}

/** What `terminal.read` hands back. Plain text: the core gives no colour. */
export interface WireRead {
  readonly text: string;
  /** `false` when part of what was asked for may be missing. */
  readonly complete: boolean;
  /** How the core read it: `screen`, `history` or `stitched` (HC_API.md § terminal.read). Absent when the core said none. */
  readonly how?: string;
  /** Why a read is incomplete, for example `working`. Absent when the core said none. */
  readonly why?: string;
}

type MutableRead = { -readonly [K in keyof WireRead]: WireRead[K] };

/**
 * herdr: one leaf of a tab's split tree (`{type:"block", id, content}`): a terminal, or a mod's
 * pane (`content.mod`, e.g. `md-review`). Rows and columns only arrange leaves, so a tab's panes are
 * its leaves in document order.
 */
export interface WireLayoutBlock {
  readonly id: string;
  /** The terminal's address, or `""` for a mod's pane. */
  readonly terminal: string;
  /** The mod's name, or `""` for a terminal. */
  readonly mod: string;
}

/** One tab of herdr-app's layout document. `name` is empty when herdr-app derives one. */
export interface WireLayoutTab {
  readonly id: string;
  readonly name: string;
  /** herdr: the split tree's leaves, in document order. */
  readonly blocks: readonly WireLayoutBlock[];
}

/** One space of herdr-app's layout document. */
export interface WireLayoutSpace {
  readonly id: string;
  readonly name: string;
  /** The folder the space was made in. */
  readonly folder: string;
  readonly tabs: readonly WireLayoutTab[];
}

/** herdr-app's `herdr-app` document, read for its spaces and tabs. */
export interface WireLayout {
  readonly spaces: readonly WireLayoutSpace[];
}

/** One line of the event stream, read for the fields the watch dispatches on. */
export interface WireEvent {
  /** An event's `type`, or `missed` for the core's "you fell behind" notification. */
  readonly type: string;
  /** The terminal's address, or `""` for a `doc` event and for `missed`. */
  readonly terminal: string;
  readonly seq: number;
}

/** What {@link HcClient.runShell} is asked for. */
export interface RunShellRequest {
  readonly cwd?: string;
  readonly labels: Readonly<Record<string, string>>;
  /** herdr: run this program instead of the machine's shell. */
  readonly argv?: readonly string[];
  /** The hc name (1-32 of a-z 0-9 - _, unique among live terminals). */
  readonly name?: string;
}

/** What {@link HcClient.subscribe} is asked for. */
export interface SubscribeOptions {
  onUp(): void;
  onEvent(event: WireEvent): void;
  onDown(reason: string): void;
}

/** The handle {@link HcClient.subscribe} hands back. `close()` is idempotent. */
export interface EventStream {
  close(): void;
}

/**
 * The core said no, with one of its stable error kinds (`data.kind`, HC_API.md § Transport).
 *
 * A transport failure is a plain `Error`; this subclass is the core's own answer, so the adapter can
 * tell "the core understood and refused" from "the core did not answer" without parsing prose.
 */
export class HcError extends Error {
  // herdr: a plain field instead of a parameter property (Node's type stripping runs this file).
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
    this.name = "HcError";
  }
}

/**
 * A call the core did not answer within the client's limit. The request had left: the core may still
 * be running it, and a write may still land (hc 0.1.14 holds a terminal's keys behind its slow
 * history reads, then delivers them). A plain `Error` subclass, so a caller that does not care reads it
 * as the transport failure it always was; the adapter's key path tells it apart.
 */
export class HcTimeout extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`herdr-core ${method}: timed out after ${String(timeoutMs)}ms`);
    this.name = "HcTimeout";
  }
}

/**
 * The client socket an `hc` in this environment would dial, when the operator named none.
 *
 * The core's own rule (herdr-core docs/security.md § State and endpoints): `HC_SOCKET`, else
 * `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`, else `/run/user/<uid>/herdr-core/<session>.sock`
 * when `/run/user/<uid>` exists, else the session's state directory,
 * `${XDG_STATE_HOME:-~/.local/state}/herdr-core/<session>/<session>.sock`, with the session from
 * `HC_SESSION` or `default`. macOS has neither `XDG_RUNTIME_DIR` nor `/run`, so its core sits in the
 * state directory. A `socket` setting in the core's config file is not followed: a bridge that
 * cannot find the socket here says where it looked, and `COLLIE_MUX_ENDPOINT_HERDR_CORE` names any
 * other path.
 */
export function defaultHcSocket(
  env: Readonly<Record<string, string | undefined>>,
  uid: number,
  dirExists: (path: string) => boolean = existsSync,
  home: string = homedir(),
): string {
  const named = (env.HC_SOCKET ?? "").trim();
  if (named.length > 0) return named;
  const session = (env.HC_SESSION ?? "").trim() || "default";
  const runtime = (env.XDG_RUNTIME_DIR ?? "").trim();
  if (runtime.length > 0) return `${runtime}/herdr-core/${session}.sock`;
  const userRun = `/run/user/${String(uid)}`;
  if (dirExists(userRun)) return `${userRun}/herdr-core/${session}.sock`;
  const stateHome = (env.XDG_STATE_HOME ?? "").trim() || `${home}/.local/state`;
  return `${stateHome}/herdr-core/${session}/${session}.sock`;
}

// ── Field readers, the parse. Every `typeof` in this file sits in one of these. ──

function asObject(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function str(record: JsonObject, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function num(record: JsonObject, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A terminal's labels: every string value of the record, anything else dropped. */
export type HcLabels = Record<string, string>;

function labelsOf(value: JsonValue | undefined) {
  const labels: HcLabels = {};
  for (const [key, raw] of Object.entries(asObject(value))) {
    if (typeof raw === "string") labels[key] = raw;
  }
  return labels;
}

function parseStatus(value: JsonValue | undefined): WireStatus | null {
  if (value === null || value === undefined) return null;
  const record = asObject(value);
  const state = str(record, "state");
  return state === "" ? null : { state, app: str(record, "app"), kind: str(record, "kind") };
}

function parseForeground(value: JsonValue | undefined): WireForeground | null {
  if (value === null || value === undefined) return null;
  const record = asObject(value);
  const pid = record.pid;
  const argv = record.argv;
  const goodPid = typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? { pid } : {};
  const goodArgv = Array.isArray(argv) && argv.every((word): word is string => typeof word === "string") ? { argv } : {};
  return { name: str(record, "name"), cwd: str(record, "cwd"), ...goodPid, ...goodArgv };
}

/** One terminal record. Exported for the fake core, which builds its answers from the same shape. */
export function parseTerminal(value: JsonValue | undefined): WireTerminal {
  const record = asObject(value);
  return {
    address: str(record, "address"),
    name: str(record, "name"),
    labels: labelsOf(record.labels),
    state: str(record, "state"),
    cwd: str(record, "cwd"),
    cols: num(record, "cols"),
    rows: num(record, "rows"),
    title: str(record, "title"),
    status: parseStatus(record.status),
    turn: num(record, "turn"),
    statusMs: typeof record.status_ms === "number" && Number.isFinite(record.status_ms) ? record.status_ms : null,
    pid: typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0 ? record.pid : null,
    foreground: parseForeground(record.foreground),
    parent: str(record, "parent"),
  };
}

/** herdr: a split tree's leaves, depth first, as herdr-app lays them out left to right, top to bottom. */
function blocksOf(value: JsonValue | undefined): WireLayoutBlock[] {
  const node = asObject(value);
  if (str(node, "type") === "block") {
    const content = asObject(node.content);
    const block = { id: str(node, "id"), terminal: str(content, "terminal"), mod: str(content, "mod") };
    return block.id !== "" && (block.terminal !== "" || block.mod !== "") ? [block] : [];
  }
  return asArray(node.children).flatMap(blocksOf);
}

/** herdr-app's document, or `null` when it was never written or is not the shape herdr-app writes. */
export function parseLayout(value: JsonValue | undefined): WireLayout | null {
  const record = asObject(value);
  if (!Array.isArray(record.spaces)) return null;
  const spaces = asArray(record.spaces).map((raw) => {
    const space = asObject(raw);
    return {
      id: str(space, "id"),
      name: str(space, "name"),
      folder: str(space, "folder"),
      tabs: asArray(space.tabs)
        .map((tab) => ({ id: str(asObject(tab), "id"), name: str(asObject(tab), "name"), blocks: blocksOf(asObject(tab).root) }))
        .filter((tab) => tab.id !== ""),
    };
  });
  return { spaces: spaces.filter((space) => space.id !== "") };
}

/** One JSON-RPC answer, decoded: its `result`, or an {@link HcError} for its `error`. */
function decodeAnswer(message: JsonObject, method: string): JsonValue {
  if (message.error !== undefined) {
    const error = asObject(message.error);
    const kind = str(asObject(error.data), "kind") || "unknown";
    throw new HcError(kind, `herdr-core ${method}: ${kind}: ${str(error, "message")}`);
  }
  if (message.result === undefined) throw new Error(`herdr-core ${method}: the answer carried no result`);
  return message.result;
}

function parseLine(line: string): JsonObject | null {
  try {
    return asObject(JSON.parse(line));
  } catch {
    return null;
  }
}

/** One frame: `[channel u32 LE][kind u8][len u32 LE][payload]`. */
function frame(channel: number, kind: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(9);
  header.writeUInt32LE(channel, 0);
  header.writeUInt8(kind, 4);
  header.writeUInt32LE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

/** One frame off the wire. */
interface Frame {
  readonly channel: number;
  readonly kind: number;
  readonly payload: Buffer;
}

/** The whole frames at the front of a buffer, and the bytes after them. */
interface FrameTake {
  readonly frames: Frame[];
  readonly rest: Buffer;
}

/** Whole frames off the front of `buf`, and what is left over. */
function takeFrames(buf: Buffer): FrameTake {
  const frames: Frame[] = [];
  let offset = 0;
  while (buf.length - offset >= 9) {
    const length = buf.readUInt32LE(offset + 5);
    if (buf.length - offset < 9 + length) break;
    frames.push({
      channel: buf.readUInt32LE(offset),
      kind: buf.readUInt8(offset + 4),
      payload: buf.subarray(offset + 9, offset + 9 + length),
    });
    offset += 9 + length;
  }
  return { frames, rest: buf.subarray(offset) };
}

let idCounter = 0;

function nextId(): number {
  idCounter += 1;
  return idCounter;
}

/**
 * The methods the adapter next door actually calls: the shape it depends on, rather than this
 * class. A `Pick` of {@link HcClient}, so it cannot drift from the real transport, and the shape
 * the fake core implements (MUX_CONTRIBUTING.md § Your deliverable).
 */
export type HcRpc = Pick<
  HcClient,
  | "hello"
  | "listTerminals"
  | "getTerminal"
  | "readTerminal"
  | "pressKeys"
  | "typeRaw"
  | "sendText"
  | "interrupt"
  | "putFile"
  | "attach"
  | "killTerminal"
  | "keepTerminal"
  | "labelTerminal"
  | "runShell"
  | "readLayout"
  | "getDoc"
  | "setDoc"
  | "subscribe"
>;

export class HcClient {
  // herdr: plain fields instead of parameter properties (Node's type stripping runs this file).
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly silenceMs: number;
  constructor(socketPath: string, timeoutMs = DEFAULT_HC_TIMEOUT_MS, silenceMs = HC_STREAM_SILENCE_MS) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.silenceMs = silenceMs;
  }

  /** One plain-mode call on its own connection. Rejects on an error answer, a timeout or a close. */
  private call(method: string, params: JsonObject = {}, timeoutMs = this.timeoutMs): Promise<JsonValue> {
    const id = nextId();
    return new Promise<JsonValue>((resolve, reject) => {
      let buf = "";
      let settled = false;
      const socket: Socket = createConnection(this.socketPath);
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new HcTimeout(method, timeoutMs))),
        timeoutMs,
      );
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buf += chunk;
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const message = parseLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (message === null) {
            finish(() => reject(new Error(`herdr-core ${method}: the answer was not JSON`)));
            return;
          }
          if (message.id === id) {
            finish(() => {
              try {
                resolve(decodeAnswer(message, method));
              } catch (err) {
                reject(err);
              }
            });
            return;
          }
          nl = buf.indexOf("\n");
        }
      });
      socket.on("error", (err) => finish(() => reject(err)));
      socket.on("close", () => finish(() => reject(new Error(`herdr-core ${method}: connection closed before the answer`))));
    });
  }

  /** The handshake at {@link HC_GENERATION}. A core outside it answers `unsupported_generation`. */
  async hello(): Promise<WireHello> {
    const result = asObject(await this.call("hello", { generation: HC_GENERATION }));
    const core = asObject(result.core);
    return {
      generation: num(result, "generation"),
      version: str(result, "version"),
      coreId: str(core, "id"),
      coreName: str(core, "name"),
    };
  }

  /** `server.status`: how many terminals the core keeps right now (M74 spec 04, `collie doctor`). */
  async serverStatus(): Promise<WireServerStatus> {
    const result = asObject(await this.call("server.status", {}));
    return { version: str(result, "version"), live: num(result, "live"), finished: num(result, "finished") };
  }

  /** Every LIVE terminal: this machine's, then each added machine's (`machine/t7`). */
  async listTerminals(): Promise<WireTerminal[]> {
    const result = asObject(await this.call("terminal.list", {}));
    return asArray(result.terminals).map(parseTerminal);
  }

  /** One terminal, live or finished. An unknown address rejects with `not_found`. */
  async getTerminal(address: string): Promise<WireTerminal> {
    return parseTerminal(await this.call("terminal.get", { terminal: address }));
  }

  /** The screen, plus up to `lines` lines of history above it, as plain text. */
  async readTerminal(address: string, lines: number): Promise<WireRead> {
    const result = asObject(await this.call("terminal.read", { terminal: address, lines: Math.max(0, Math.floor(lines)) }));
    const read: MutableRead = { text: str(result, "text"), complete: result.complete !== false };
    const how = str(result, "how");
    const why = str(result, "why");
    if (how !== "") read.how = how;
    if (why !== "") read.why = why;
    return read;
  }

  /** Named keys, in order, encoded by the core for the program's keyboard mode. */
  async pressKeys(address: string, keys: readonly string[]): Promise<void> {
    await this.call("terminal.keys", { terminal: address, keys: [...keys] });
  }

  /**
   * herdr: paste `text` and press Enter (`terminal.send`). `force` types even while the program is
   * blocked on a dialog (it may answer it); without it the core refuses a blocked program. The core
   * answers once it sees the program start a turn, or after about 5 s when none starts (a command
   * like `/model`), so this call gets longer than the usual budget.
   */
  async sendText(address: string, text: string, force: boolean): Promise<void> {
    await this.call("terminal.send", { terminal: address, text, force }, SEND_TIMEOUT_MS);
  }

  /** herdr: press the program's stop key (`terminal.interrupt`); the core's word for what happened. */
  async interrupt(address: string): Promise<string> {
    return str(asObject(await this.call("terminal.interrupt", { terminal: address, timeout: 3 })), "outcome");
  }

  /** herdr: write a file beside the terminal, on its machine (`terminal.put`, at most 8 MB); where it landed. */
  async putFile(address: string, name: string, bytes: Uint8Array): Promise<string> {
    return str(asObject(await this.call("terminal.put", { terminal: address, name, data: Buffer.from(bytes).toString("base64") })), "path");
  }

  /** herdr: set labels on a terminal (`terminal.label`); an empty value removes the label, as `hc label k=` does. */
  async labelTerminal(address: string, labels: Readonly<Record<string, string>>): Promise<void> {
    await this.call("terminal.label", { terminal: address, labels: { ...labels } });
  }

  /** herdr: replace the terminal's program with a shell when it is lost (`terminal.keep`, as `hc keep` does). */
  async keepTerminal(address: string): Promise<void> {
    await this.call("terminal.keep", { terminal: address, keep: true });
  }

  /** End the program: hangup, then terminate, then kill. */
  async killTerminal(address: string): Promise<void> {
    await this.call("terminal.kill", { terminal: address });
  }

  /**
   * A new terminal running this machine's shell. `no_parent` and `no_notify`, so a bridge that
   * itself runs inside an hc terminal never gets notes typed into that terminal.
   */
  async runShell(request: RunShellRequest): Promise<WireTerminal> {
    const params: JsonObject = { labels: { ...request.labels }, no_parent: true, no_notify: true };
    if (request.cwd !== undefined) params.cwd = request.cwd;
    if (request.argv !== undefined) params.argv = [...request.argv];
    if (request.name !== undefined) params.name = request.name;
    return parseTerminal(await this.call("terminal.run", params));
  }

  /** herdr-app's layout document, or `null` when herdr-app never wrote one. */
  async readLayout(): Promise<WireLayout | null> {
    const result = asObject(await this.call("doc.get", { name: "herdr-app" }));
    return parseLayout(result.value);
  }

  /** herdr: a document's raw value and version (`version` 0 and `value` null when never written). */
  async getDoc(name: string): Promise<{ readonly value: JsonValue; readonly version: number }> {
    const result = asObject(await this.call("doc.get", { name }));
    return { value: result.value ?? null, version: num(result, "version") };
  }

  /**
   * herdr: write a document only if it is still at `version` (the core answers the `conflict`
   * kind otherwise, as an {@link HcError}).
   */
  async setDoc(name: string, value: JsonValue, version: number): Promise<void> {
    await this.call("doc.set", { name, value, version });
  }

  /**
   * Type `text` into the terminal as raw input, pressing nothing after it.
   *
   * One framed connection: `hello {framed}`, `terminal.get` for the size, `terminal.attach` at that
   * same size, the text as DATA on the attach channel, then CLOSE and the core's CLOSE back. The
   * paint the core streams on the channel meanwhile is read and dropped. HC_API.md § Typing.
   */
  typeRaw(address: string, text: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket: Socket = createConnection(this.socketPath);
      let settled = false;
      let framed = false;
      let lineBuf = "";
      let frameBuf: Buffer = Buffer.alloc(0);
      let channel = -1;
      const getId = nextId();
      const attachId = nextId();
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new HcTimeout("terminal.attach", this.timeoutMs))),
        this.timeoutMs,
      );
      const sendRpc = (id: number, method: string, params: JsonObject) => {
        socket.write(frame(0, FRAME_DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }))));
      };
      const onRpc = (message: JsonObject) => {
        if (message.id === getId) {
          let terminal: WireTerminal;
          try {
            terminal = parseTerminal(decodeAnswer(message, "terminal.get"));
          } catch (err) {
            finish(() => reject(err));
            return;
          }
          sendRpc(attachId, "terminal.attach", { terminal: address, cols: terminal.cols, rows: terminal.rows });
          return;
        }
        if (message.id !== attachId) return;
        try {
          channel = num(asObject(decodeAnswer(message, "terminal.attach")), "channel");
        } catch (err) {
          finish(() => reject(err));
          return;
        }
        const bytes = Buffer.from(text, "utf8");
        for (let offset = 0; offset < bytes.length; offset += MAX_FRAME_PAYLOAD) {
          socket.write(frame(channel, FRAME_DATA, bytes.subarray(offset, offset + MAX_FRAME_PAYLOAD)));
        }
        socket.write(frame(channel, FRAME_CLOSE, Buffer.alloc(0)));
      };
      const onFrames = (chunk: Buffer) => {
        frameBuf = Buffer.concat([frameBuf, chunk]);
        const taken = takeFrames(frameBuf);
        frameBuf = taken.rest;
        for (const { channel: on, kind, payload } of taken.frames) {
          if (on === 0 && kind === FRAME_DATA) {
            const message = parseLine(payload.toString("utf8"));
            if (message !== null) onRpc(message);
          } else if (on === channel && kind === FRAME_CLOSE) {
            // The core's CLOSE answers ours: everything before it was taken.
            finish(() => resolve());
            return;
          }
          if (settled) return;
        }
      };
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId(), method: "hello", params: { generation: HC_GENERATION, framed: true } })}\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        if (framed) {
          onFrames(chunk);
          return;
        }
        // Until the hello answer, the connection is plain: one line, and frames may follow it in
        // the same chunk.
        lineBuf += chunk.toString("latin1");
        const nl = lineBuf.indexOf("\n");
        if (nl < 0) return;
        const hello = parseLine(Buffer.from(lineBuf.slice(0, nl), "latin1").toString("utf8"));
        const rest = Buffer.from(lineBuf.slice(nl + 1), "latin1");
        try {
          decodeAnswer(hello ?? {}, "hello");
        } catch (err) {
          finish(() => reject(err));
          return;
        }
        framed = true;
        sendRpc(getId, "terminal.get", { terminal: address });
        if (rest.length > 0) onFrames(rest);
      });
      socket.on("error", (err) => finish(() => reject(err)));
      socket.on("close", () => finish(() => reject(new Error("herdr-core terminal.attach: connection closed before the core closed the stream"))));
    });
  }

  /**
   * herdr: a long-lived framed `terminal.attach`: the terminal's paint (raw VT bytes) arrives as DATA
   * on the attach channel, input bytes go back the same way. The attach names the terminal's OWN
   * size, so merely attaching resizes nothing; `resize` is what makes this viewer's size count.
   */
  attach(address: string, opts: AttachOptions): TerminalStream {
    const socket: Socket = createConnection(this.socketPath);
    let framed = false;
    let lineBuf = "";
    let frameBuf: Buffer = Buffer.alloc(0);
    let channel = -1;
    let closed = false;
    const getId = nextId();
    const attachId = nextId();
    // Input and resizes made before the channel opens wait for it.
    const queued: { kind: number; payload: Buffer }[] = [];
    const send = (kind: number, payload: Buffer) => {
      if (closed) return;
      if (channel < 0) queued.push({ kind, payload });
      else socket.write(frame(channel, kind, payload));
    };
    const finish = (reason: string, ended = false) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      socket.destroy();
      opts.onClose(reason, ended);
    };
    const timer = setTimeout(() => finish("no answer to terminal.attach"), this.timeoutMs);
    const sendRpc = (id: number, method: string, params: JsonObject) => {
      socket.write(frame(0, FRAME_DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }))));
    };
    const onRpc = (message: JsonObject) => {
      try {
        if (message.id === getId) {
          const terminal = parseTerminal(decodeAnswer(message, "terminal.get"));
          sendRpc(attachId, "terminal.attach", { terminal: address, cols: terminal.cols, rows: terminal.rows });
        } else if (message.id === attachId) {
          channel = num(asObject(decodeAnswer(message, "terminal.attach")), "channel");
          clearTimeout(timer);
          for (const item of queued.splice(0)) send(item.kind, item.payload);
        }
      } catch (err) {
        finish(err instanceof Error ? err.message : String(err));
      }
    };
    const onFrames = (chunk: Buffer) => {
      frameBuf = Buffer.concat([frameBuf, chunk]);
      const taken = takeFrames(frameBuf);
      frameBuf = taken.rest;
      for (const { channel: on, kind, payload } of taken.frames) {
        if (on === 0 && kind === FRAME_DATA) {
          const message = parseLine(payload.toString("utf8"));
          if (message !== null) onRpc(message);
        } else if (on === channel && kind === FRAME_DATA) {
          opts.onData(payload);
        } else if (on === channel && kind === FRAME_CLOSE) {
          finish("the terminal closed the stream", true);
        }
        if (closed) return;
      }
    };
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId(), method: "hello", params: { generation: HC_GENERATION, framed: true } })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      if (framed) {
        onFrames(chunk);
        return;
      }
      lineBuf += chunk.toString("latin1");
      const nl = lineBuf.indexOf("\n");
      if (nl < 0) return;
      const hello = parseLine(Buffer.from(lineBuf.slice(0, nl), "latin1").toString("utf8"));
      const rest = Buffer.from(lineBuf.slice(nl + 1), "latin1");
      try {
        decodeAnswer(hello ?? {}, "hello");
      } catch (err) {
        finish(err instanceof Error ? err.message : String(err));
        return;
      }
      framed = true;
      sendRpc(getId, "terminal.get", { terminal: address });
      if (rest.length > 0) onFrames(rest);
    });
    socket.on("error", (err) => finish(err.message || "socket error"));
    socket.on("close", () => finish("connection closed"));
    return {
      write(bytes) {
        for (let offset = 0; offset < bytes.length; offset += MAX_FRAME_PAYLOAD) {
          send(FRAME_DATA, Buffer.from(bytes.subarray(offset, offset + MAX_FRAME_PAYLOAD)));
        }
      },
      resize(cols, rows) {
        const payload = Buffer.alloc(4);
        payload.writeUInt16LE(cols, 0);
        payload.writeUInt16LE(rows, 2);
        send(FRAME_RESIZE, payload);
      },
      close() {
        if (closed) return;
        send(FRAME_CLOSE, Buffer.alloc(0));
        finish("closed");
      },
    };
  }

  /**
   * Open a LONG-LIVED `events.subscribe` stream over every terminal and document.
   *
   * The answer (a snapshot) brings the stream up. After it each line is a notification: `event`,
   * `heartbeat` or `missed`. A heartbeat only keeps the stream alive; `missed` reaches the caller
   * as an event of that type, because it means "read everything again". Events at or below the seq
   * of the last `missed` are dropped, as the core's docs ask. `onDown` fires exactly once, for any
   * reason, including {@link HC_STREAM_SILENCE_MS} without a line; `close()` is idempotent.
   */
  subscribe(opts: SubscribeOptions): EventStream {
    const id = nextId();
    const socket: Socket = createConnection(this.socketPath);
    let buf = "";
    let down = false;
    let up = false;
    let floor = -1;
    let silence: ReturnType<typeof setTimeout> | null = null;

    const fireDown = (reason: string) => {
      if (down) return;
      down = true;
      if (silence !== null) clearTimeout(silence);
      socket.destroy();
      opts.onDown(reason);
    };
    const arm = (ms: number, reason: string) => {
      if (silence !== null) clearTimeout(silence);
      silence = setTimeout(() => fireDown(reason), ms);
    };
    // A core that takes the connection and never answers counts as down, not healthy.
    arm(this.timeoutMs, "no answer to events.subscribe");

    const handle = (message: JsonObject) => {
      if (!up) {
        if (message.id !== id) return;
        if (message.error !== undefined) {
          const error = asObject(message.error);
          fireDown(`${str(asObject(error.data), "kind")}: ${str(error, "message")}`);
          return;
        }
        up = true;
        arm(this.silenceMs, "no heartbeat from herdr-core");
        opts.onUp();
        return;
      }
      arm(this.silenceMs, "no heartbeat from herdr-core");
      const params = asObject(message.params);
      if (message.method === "missed") {
        floor = num(params, "seq");
        opts.onEvent({ type: "missed", terminal: "", seq: floor });
        return;
      }
      if (message.method !== "event") return;
      const seq = num(params, "seq");
      if (seq <= floor) return;
      opts.onEvent({ type: str(params, "type"), terminal: str(params, "terminal"), seq });
    };

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "events.subscribe", params: {} })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        // `down` turns true inside fireDown, called from handle() below.
        if (down) return;
        const message = parseLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (message === null) {
          fireDown("protocol error: an event line was not JSON");
          return;
        }
        handle(message);
        nl = buf.indexOf("\n");
      }
    });
    socket.on("error", (err) => fireDown(err.message || "socket error"));
    socket.on("close", () => fireDown("connection closed"));
    return { close: () => fireDown("closed") };
  }
}

/** What `collie doctor` learns by dialling the core: `hello` then `server.status`. */
export interface HcCoreReading {
  readonly version: string;
  readonly generation: number;
  readonly live: number;
}

/** The two calls the `hc-socket` doctor row makes, each under `timeoutMs`. Rejects on any failure. */
export async function readHcCore(socketPath: string, timeoutMs: number): Promise<HcCoreReading> {
  const client = new HcClient(socketPath, timeoutMs);
  const hello = await client.hello();
  const status = await client.serverStatus();
  return { version: hello.version || status.version, generation: hello.generation, live: status.live };
}
