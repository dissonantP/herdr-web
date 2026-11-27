import { CLAUDE_EFFORTS, CLAUDE_MODELS, CLAUDE_PERMISSIONS, type AdminAction, type ClaudeStart, validColour } from "../shared/model.ts";
import type { AgentAdapter } from "@herdr/server/adapters/agent.ts";
import type { BackendAdapter, BackendAdmin, Created, TabProgram } from "@herdr/server/adapters/backend.ts";

// `POST /api/actions`: one change to the hierarchy. The body is checked here, field by field, and
// handed to the backend adapter; nothing else on the server knows how a change is made.

const ID = /^[A-Za-z0-9_.:/-]{1,128}$/u;
const MAX_NAME = 120;
const MAX_FOLDER = 1024;
// Control characters (and DEL) never belong in a name or a folder.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;

type Fields = Record<string, unknown>;

class Invalid extends Error {}

function id(body: Fields, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !ID.test(value)) throw new Invalid(`bad ${key}`);
  return value;
}

function idOrNull(body: Fields, key: string): string | null {
  return body[key] === null ? null : id(body, key);
}

/** A colour token, or `null` for none; `dim` only where the caller allows it (spaces). */
function colour(body: Fields, allowDim: boolean): string | null {
  const value = body.color;
  if (value === null) return null;
  if (typeof value !== "string" || !validColour(value) || (value === "dim" && !allowDim)) throw new Invalid("bad color");
  return value;
}

function name(body: Fields, required: boolean): string {
  const value = body.name;
  if (typeof value !== "string") throw new Invalid("bad name");
  const trimmed = value.trim();
  if (trimmed.length > MAX_NAME || CONTROL.test(trimmed)) throw new Invalid("bad name");
  if (required && trimmed === "") throw new Invalid("a name is needed");
  return trimmed;
}

function folder(body: Fields): string {
  const value = body.folder;
  if (typeof value !== "string" || value.length > MAX_FOLDER || CONTROL.test(value)) throw new Invalid("bad folder");
  return value.trim();
}

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Invalid(`bad ${what}`);
  return value as T;
}

/** The `claude` part of a tab.create: how a Claude session starts. Absent: a terminal tab. */
function claudeStart(body: Fields): ClaudeStart | undefined {
  const value = body.claude;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Invalid("bad claude");
  const c = value as Fields;
  const where = folder(c);
  if (where === "") throw new Invalid("a folder is needed");
  const resume = c.resume === undefined || c.resume === null ? null : c.resume;
  if (resume !== null && (typeof resume !== "string" || !SESSION.test(resume))) throw new Invalid("bad resume");
  return { folder: where, model: oneOf(c.model, CLAUDE_MODELS, "model"), effort: oneOf(c.effort, CLAUDE_EFFORTS, "effort"), permission: oneOf(c.permission, CLAUDE_PERMISSIONS, "permission"), resume };
}

const claudeField = (body: Fields): { claude?: ClaudeStart } => {
  const claude = claudeStart(body);
  return claude === undefined ? {} : { claude };
};

/** The action in a request body, or the reason it is not one. */
export function parseAction(value: unknown): AdminAction | { readonly invalid: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { invalid: "not an action" };
  const body = value as Fields;
  try {
    switch (body.type) {
      case "group.create":
        return { type: body.type, name: name(body, true), parentId: idOrNull(body, "parentId") };
      case "group.rename":
        return { type: body.type, id: id(body, "id"), name: name(body, true) };
      case "group.delete":
        if (body.children !== "lift" && body.children !== "delete") throw new Invalid("bad children");
        return { type: body.type, id: id(body, "id"), children: body.children };
      case "space.create":
        return { type: body.type, name: name(body, false), folder: folder(body), groupId: idOrNull(body, "groupId"), parentId: body.parentId === undefined ? null : idOrNull(body, "parentId"), ...claudeField(body) };
      case "space.rename":
      case "tab.rename":
        return { type: body.type, id: id(body, "id"), name: name(body, false) };
      case "group.color":
        return { type: body.type, id: id(body, "id"), color: colour(body, false) };
      case "space.color":
        return { type: body.type, id: id(body, "id"), color: colour(body, true) };
      case "space.move":
        return { type: body.type, id: id(body, "id"), groupId: idOrNull(body, "groupId") };
      case "space.reparent":
        return { type: body.type, id: id(body, "id"), parentId: idOrNull(body, "parentId") };
      case "space.delete":
        // Old clients send no `children`; a space with nested spaces then keeps them (lift).
        if (body.children !== undefined && body.children !== "lift" && body.children !== "delete") throw new Invalid("bad children");
        return { type: body.type, id: id(body, "id"), children: body.children === "delete" ? "delete" : "lift" };
      case "space.quiet":
        if (typeof body.quiet !== "boolean") throw new Invalid("bad quiet");
        return { type: body.type, id: id(body, "id"), quiet: body.quiet };
      case "tab.create": {
        const claude = claudeStart(body);
        return { type: body.type, spaceId: id(body, "spaceId"), name: name(body, false), ...(claude === undefined ? {} : { claude }) };
      }
      case "tab.delete":
      case "pane.close":
      case "pane.sleep":
      case "pane.wake":
      case "pane.seen":
      case "pane.dismiss":
        return { type: body.type, id: id(body, "id") };
      default:
        return { invalid: "unknown action" };
    }
  } catch (err) {
    if (err instanceof Invalid) return { invalid: err.message };
    throw err;
  }
}

/** A Claude session as a tab's program, named after its space (`-n`, which a resume leaves alone: it keeps its own title). */
function claudeProgram(agent: Pick<AgentAdapter, "startCommand">, claude: ClaudeStart): TabProgram {
  return { folder: claude.folder, argv: (title) => (claude.resume === null ? [...agent.startCommand(claude), "-n", title] : agent.startCommand(claude)) };
}

export async function runAction(backend: BackendAdmin & Pick<BackendAdapter, "sleepPane" | "wakePane" | "markSeen" | "dismissPane">, agent: Pick<AgentAdapter, "startCommand">, action: AdminAction): Promise<Created> {
  switch (action.type) {
    case "group.create":
      return backend.createGroup(action.name, action.parentId);
    case "group.rename":
      await backend.renameGroup(action.id, action.name);
      return {};
    case "group.delete":
      await backend.deleteGroup(action.id, action.children);
      return {};
    case "space.create":
      return backend.createSpace(action.name, action.folder, action.groupId, action.parentId, action.claude === undefined ? undefined : claudeProgram(agent, { ...action.claude, folder: action.folder }));
    case "space.rename":
      await backend.renameSpace(action.id, action.name);
      return {};
    case "space.delete":
      await backend.deleteSpace(action.id, action.children);
      return {};
    case "group.color":
      await backend.setGroupColor(action.id, action.color);
      return {};
    case "space.color":
      await backend.setSpaceColor(action.id, action.color);
      return {};
    case "space.move":
      await backend.moveSpace(action.id, action.groupId);
      return {};
    case "space.reparent":
      await backend.reparentSpace(action.id, action.parentId);
      return {};
    case "space.quiet":
      await backend.setQuiet(action.id, action.quiet);
      return {};
    case "tab.create":
      return backend.createTab(action.spaceId, action.name, action.claude === undefined ? undefined : claudeProgram(agent, action.claude));
    case "tab.rename":
      await backend.renameTab(action.id, action.name);
      return {};
    case "tab.delete":
      await backend.deleteTab(action.id);
      return {};
    case "pane.close":
      await backend.closePane(action.id);
      return {};
    case "pane.sleep":
      await backend.sleepPane(action.id);
      return {};
    case "pane.wake":
      await backend.wakePane(action.id);
      return {};
    case "pane.seen":
      await backend.markSeen(action.id);
      return {};
    case "pane.dismiss":
      await backend.dismissPane(action.id);
      return {};
  }
}
