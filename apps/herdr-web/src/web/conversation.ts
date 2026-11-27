import type { ChatMessage } from "../shared/chat.ts";

// Conversation mode (task 123): the pure parts. Speech in and out use the browser's own APIs.

/** What the browser calls speech recognition; Chrome still prefixes it. */
export function recognitionClass(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** The slice of the SpeechRecognition API used here (the DOM lib has no types for it). */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { readonly results: ArrayLike<ArrayLike<{ readonly transcript: string }> & { readonly isFinal: boolean }> }) => void) | null;
  onerror: ((e: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

/** Markdown as something worth reading aloud: code blocks and symbols dropped, links keep their text. */
export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/gu, " (code omitted) ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gmu, "")
    .replace(/\*+|~~|\|/gu, "")
    .replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/gu, "")
    .replace(/https?:\/\/\S+/gu, "link")
    .replace(/\s+/gu, " ")
    .trim();
}

/** The speech of the assistant messages after the first `from` ones, in order; tools and thinking are not read. */
export function replyAfter(messages: readonly ChatMessage[], from: number): string {
  return messages
    .slice(from)
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.parts.flatMap((p) => (p.kind === "text" ? [speakable(p.text)] : [])))
    .filter((t) => t !== "")
    .join(" ");
}

/** A recognition or mic error as a sentence for the UI; `aborted` (our own stop) is not an error. */
export function recognitionErrorText(code: string): string {
  switch (code) {
    case "aborted":
      return "";
    case "no-speech":
      return "Didn't hear anything. Tap the mic to try again.";
    case "not-allowed":
    case "service-not-allowed":
    case "NotAllowedError":
      return "Microphone blocked. Allow it for this site in the browser's settings, then tap the mic.";
    case "audio-capture":
    case "NotFoundError":
      return "No microphone found.";
    case "insecure":
      return "This page can't use the microphone (it needs HTTPS).";
    case "network":
      return "Speech recognition needs a network connection.";
    case "language-not-supported":
      return "Speech recognition doesn't support this language.";
    default:
      return `Speech recognition: ${code}`;
  }
}

/** Asks for the mic up front so the permission prompt always shows; resolves to an error code, or "" once granted. */
export async function requestMic(): Promise<string> {
  if (!navigator.mediaDevices?.getUserMedia) return "insecure";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop();
    return "";
  } catch (e) {
    return e instanceof DOMException ? e.name : "audio-capture";
  }
}

const RATE_KEY = "herdr.conversationRate";
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** Talking speed for the read-out: a per-device setting (localStorage), 1 by default. */
export function loadRate(): number {
  try {
    const n = Number(window.localStorage.getItem(RATE_KEY));
    return RATES.find((r) => r === n) ?? 1;
  } catch {
    return 1;
  }
}

export function saveRate(rate: number): void {
  try {
    window.localStorage.setItem(RATE_KEY, String(rate));
  } catch {
    // Storage blocked: the speed holds for this visit only.
  }
}
