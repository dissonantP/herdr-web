import type { InputResult, MenuAnswer, SlashCommand } from "@herdr/server/chat.ts";
import { toLogin } from "./session.ts";

// The chat's input requests (F17, F18): a message, the stop key, an attachment, a menu answer, and
// the slash commands for autocomplete. Each answers an InputResult; a refusal carries its reason.

const base = (paneId: string) => `/api/chat/${encodeURIComponent(paneId)}`;

async function post(url: string, body: BodyInit | null, type: string): Promise<InputResult> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": type }, body });
    if (res.status === 401) {
      toLogin();
      return { ok: false, error: "Logged out." };
    }
    const answer = (await res.json().catch(() => null)) as InputResult | null;
    return answer ?? { ok: false, error: `The server answered ${String(res.status)}.` };
  } catch {
    return { ok: false, error: "Can't reach herdr." };
  }
}

const json = (value: unknown) => JSON.stringify(value);

/** `id` names this message, so a retry of it after a dropped connection is not delivered twice. */
export const sendMessage = (paneId: string, text: string, id?: string) => post(`${base(paneId)}/send`, json({ text, id }), "application/json");
export const stopAgent = (paneId: string) => post(`${base(paneId)}/stop`, null, "application/json");
export const answerMenu = (paneId: string, answer: MenuAnswer) => post(`${base(paneId)}/answer`, json(answer), "application/json");
export const uploadFile = (paneId: string, file: File) => post(`${base(paneId)}/upload?name=${encodeURIComponent(file.name)}`, file, "application/octet-stream");

export async function loadCommands(paneId: string): Promise<readonly SlashCommand[]> {
  try {
    const res = await fetch(`${base(paneId)}/commands`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as SlashCommand[]) : [];
  } catch {
    return [];
  }
}

/** The commands to offer while the text is a bare `/word` being typed: prefix matches first, then those with a later part (`/git:sync`) starting with it. */
export function slashMatches(text: string, commands: readonly SlashCommand[], max = 8): readonly SlashCommand[] {
  if (!/^\/[\w:.-]*$/u.test(text)) return [];
  const typed = text.toLowerCase();
  const prefix = commands.filter((c) => c.name.toLowerCase().startsWith(typed));
  const word = typed.slice(1);
  const inside = word === "" ? [] : commands.filter((c) => !c.name.toLowerCase().startsWith(typed) && c.name.toLowerCase().slice(1).split(/[:_-]/u).slice(1).some((part) => part.startsWith(word)));
  const found = [...prefix, ...inside];
  return found.length === 1 && found[0]?.name.toLowerCase() === typed ? [] : found.slice(0, max);
}

/** Where an uploaded file's path goes in the message: after what is there, separated by a space. */
export function withPath(text: string, path: string): string {
  return text === "" || /\s$/u.test(text) ? `${text}${path} ` : `${text} ${path} `;
}

const IMAGE_EXTS = "png|jpe?g|gif|webp";

/** Whether an attachment is an image the browser can preview. */
export const isImageName = (name: string): boolean => new RegExp(`\\.(?:${IMAGE_EXTS})$`, "iu").test(name);

/** The text without that uploaded path (every time it appears, with the space after it). */
export function withoutPath(text: string, path: string): string {
  return text.split(`${path} `).join("").split(path).join("");
}

/** The absolute image paths in a sent message (what an upload put there), each once, in order. The server decides which it will serve. */
export function imagePaths(text: string): readonly string[] {
  const found = text.match(new RegExp(`(?:^|(?<=\\s))\\/\\S+\\.(?:${IMAGE_EXTS})(?=\\s|$)`, "giu")) ?? [];
  return [...new Set(found)];
}

/** Where the server hands an uploaded image back. */
export const imageUrl = (path: string): string => `/api/upload-image?path=${encodeURIComponent(path)}`;

/** Images on a paste event's clipboard, when it carries no text (a copy from a spreadsheet has both: the text wins). Each gets a unique name, since a pasted image is always called `image.png`. */
export function pastedImages(data: DataTransfer | null): File[] {
  if (data === null || data.getData("text/plain") !== "") return [];
  return Array.from(data.files)
    .filter((f) => f.type.startsWith("image/"))
    .map((f, i) => {
      const ext = /^image\/([a-z0-9]+)/iu.exec(f.type)?.[1]?.toLowerCase().replace("jpeg", "jpg") ?? "png";
      return new File([f], `pasted-${String(Date.now())}-${String(i)}.${ext}`, { type: f.type });
    });
}
