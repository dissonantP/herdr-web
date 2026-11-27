import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ChatMenu, ChatMessage, InputResult, MenuChoice, SlashCommand } from "../shared/chat.ts";
import { PlusIcon, SendIcon, StopIcon } from "./ComposerIcons.tsx";
import { Conversation } from "./Conversation.tsx";
import { track, useSync } from "./sync.ts";
import { answerMenu, isImageName, loadCommands, pastedImages, sendMessage, slashMatches, stopAgent, uploadFile, withoutPath, withPath } from "@herdr/web/chat-input.ts";

// Under the conversation: the menu waiting on the agent's screen as tappable options (F18), then
// the composer (F17): text, attach, stop, and slash-command autocomplete when the text starts with
// `/`. Every request answers with a reason when it is refused, shown under the box.

const KIND_LABEL: Record<ChatMenu["kind"], string> = {
  permission: "Permission",
  question: "Question",
  plan: "Plan",
  review: "Review answers",
  trust: "Trust this folder?",
};

/** Phones have no Enter-to-send: Enter is a new line, the button sends. */
const coarse = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

/** One menu; keyed by its question, so the next step or another prompt starts clean but a tick does not. */
function MenuCard({ paneId, menu, onMenu }: { readonly paneId: string; readonly menu: ChatMenu; readonly onMenu: (menu: ChatMenu | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [other, setOther] = useState("");

  const send = async (answer: MenuChoice) => {
    setBusy(true);
    setError("");
    const result = await answerMenu(paneId, { ...answer, id: menu.id });
    setBusy(false);
    if (!result.ok) setError(result.error);
    else {
      if (answer.action === "other") setOther("");
      // The screen after the answer: the next tap names the right menu without waiting for the stream.
      if (result.menu !== undefined) onMenu(result.menu);
    }
  };
  const typedAtDesk = menu.other?.mode === "field" && menu.other.value !== "";
  const otherPlaceholder = menu.other?.mode === "message" ? "No, and tell Claude what to do instead…" : menu.kind === "plan" ? "Tell Claude what to change…" : "Other…";

  return (
    <section className="menu-card" data-testid="menu-card" data-id={menu.id} data-kind={menu.kind} data-multi={menu.multi ? "1" : "0"} aria-busy={busy}>
      <div className="menu-kind">{KIND_LABEL[menu.kind]}</div>
      {menu.steps.length > 0 && (
        <ol className="menu-steps" data-testid="menu-steps">
          {menu.steps.map((s, i) => (
            <li key={i} className={s.answered ? "menu-step done" : "menu-step"}>
              {s.answered ? "☒" : "☐"} {s.label}
            </li>
          ))}
        </ol>
      )}
      {menu.detail !== "" && <pre className="menu-detail" data-testid="menu-detail">{menu.detail}</pre>}
      {menu.title !== "" && <div className="menu-title" data-testid="menu-title">{menu.title}</div>}
      <div className="menu-options">
        {menu.options.map((o) => (
          <button
            key={o.n}
            type="button"
            className={`menu-option${o.checked === true ? " checked" : ""}`}
            data-testid="menu-option"
            data-n={o.n}
            aria-pressed={o.checked === null ? undefined : o.checked}
            disabled={busy}
            onClick={() => void send(menu.multi ? { action: "toggle", n: o.n } : { action: "pick", n: o.n })}
          >
            <span className="menu-option-label">
              {o.checked !== null && <span className="menu-check">{o.checked ? "☑" : "☐"} </span>}
              {o.label}
            </span>
            {o.detail !== "" && <span className="menu-option-detail">{o.detail}</span>}
          </button>
        ))}
      </div>
      {menu.other !== null &&
        (typedAtDesk ? (
          <div className="menu-note" data-testid="menu-other-typed">
            Typed at the desk: {menu.other.value}
          </div>
        ) : (
          <form
            className="menu-other"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (other.trim() !== "") void send({ action: "other", text: other });
            }}
          >
            <input data-testid="menu-other" value={other} placeholder={otherPlaceholder} aria-label="Other answer" disabled={busy} onChange={(e) => setOther(e.target.value)} />
            <button type="submit" className="btn" data-testid="menu-other-send" disabled={busy || other.trim() === ""}>
              Send
            </button>
          </form>
        ))}
      {menu.submit !== null && (
        <div className="menu-actions">
          <button type="button" className="btn btn-primary" data-testid="menu-submit" disabled={busy} onClick={() => void send({ action: "submit" })}>
            {menu.submit}
          </button>
        </div>
      )}
      {error !== "" && (
        <div className="input-error" role="alert" data-testid="menu-error">
          {error}
        </div>
      )}
    </section>
  );
}

function Composer({ paneId, working, waking, onSend, slotRef, heard, onSent }: { readonly paneId: string; readonly working: boolean; readonly waking: boolean; readonly onSend?: ChatInputProps["onSend"]; readonly slotRef: (el: HTMLElement | null) => void; readonly heard: { readonly text: string; readonly n: number }; readonly onSent: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState("");
  // The message on its way (shown as pending until the server has it), and the id a retry of the same text reuses.
  const [pending, setPending] = useState<{ readonly text: string; readonly wake: boolean } | null>(null);
  const attempt = useRef<{ readonly text: string; readonly id: string } | null>(null);
  // A quick send never flashes the pending note: it shows once the server is slow to answer (sync.ts).
  const { slow } = useSync();
  const [commands, setCommands] = useState<readonly SlashCommand[] | null>(null);
  const [picked, setPicked] = useState(0);
  // Images attached so far: a thumbnail from the file itself, shown while its path is still in the text.
  const [previews, setPreviews] = useState<readonly { readonly path: string; readonly name: string; readonly url: string }[]>([]);
  const box = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  // Desktop only (a fine pointer): the composer takes focus when its pane opens, so switching tab or space
  // lets you type at once. Never on touch, where it would pop the keyboard on every switch.
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) box.current?.focus();
  }, [paneId]);

  // The command list is fetched the first time a `/` is typed, once per pane.
  const wantsCommands = text.startsWith("/");
  useEffect(() => {
    if (!wantsCommands || commands !== null) return;
    let live = true;
    void loadCommands(paneId).then((list) => live && setCommands(list));
    return () => {
      live = false;
    };
  }, [wantsCommands, commands, paneId]);
  const matches = slashMatches(text, commands ?? []);

  // The box grows with its text (CSS `field-sizing`); browsers without it get the same by hand.
  // Either way the CSS max height caps it, and the box scrolls past that.
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null || (typeof CSS !== "undefined" && CSS.supports("field-sizing", "content"))) return;
    el.style.height = "auto";
    // scrollHeight leaves out the border, which border-box sizing counts. (Untested: Chromium has field-sizing.)
    el.style.height = `${String(el.scrollHeight + el.offsetHeight - el.clientHeight)}px`;
  }, [text]);

  const report = (result: InputResult) => {
    if (!result.ok) setError(result.error);
    return result.ok;
  };
  const submit = async () => {
    if (text.trim() === "" || busy) return;
    setBusy(true);
    setError("");
    const sentText = text;
    const retract = onSend?.(text);
    if (attempt.current?.text !== text) attempt.current = { text, id: crypto.randomUUID() };
    // Shown as on its way at once and out of the box (task 142); a refusal puts it back in front of anything typed since.
    setPending({ text, wake: waking });
    setText("");
    const ok = report(await track(sendMessage(paneId, text, attempt.current.id)));
    setPending(null);
    setBusy(false);
    if (ok) {
      attempt.current = null;
      onSent();
    } else {
      setText((t) => (t.trim() === "" ? sentText : `${sentText} ${t}`));
      retract?.();
    }
  };
  // Conversation mode: what was said goes into the box for the user to check and send.
  const lastHeard = useRef(heard.n);
  useEffect(() => {
    if (heard.n === lastHeard.current) return;
    lastHeard.current = heard.n;
    setText((t) => (t.trim() === "" ? heard.text : `${t.trimEnd()} ${heard.text}`));
  }, [heard]);
  // Thumbnails of what is still attached: a path the text no longer holds (sent, edited out) drops its preview.
  const shown = previews.filter((p) => text.includes(p.path));
  useEffect(() => {
    if (shown.length === previews.length) return;
    const gone = previews.filter((p) => !text.includes(p.path));
    gone.forEach((p) => URL.revokeObjectURL(p.url));
    setPreviews((list) => list.filter((p) => !gone.includes(p)));
  }, [text, previews, shown.length]);
  const latest = useRef(previews);
  latest.current = previews;
  useEffect(() => () => latest.current.forEach((p) => URL.revokeObjectURL(p.url)), []);
  const complete = (c: SlashCommand) => {
    setText(`${c.name} `);
    setPicked(0);
    box.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setPicked((p) => (p + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
      return;
    }
    if (matches.length > 0 && e.key === "Tab") {
      e.preventDefault();
      const c = matches[picked] ?? matches[0];
      if (c !== undefined) complete(c);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !coarse()) {
      e.preventDefault();
      void submit();
    }
  };
  const attach = async (list: ArrayLike<File> | null) => {
    if (list === null || list.length === 0) return;
    setError("");
    setUploading((n) => n + list.length);
    for (const file of Array.from(list)) {
      const result = await uploadFile(paneId, file);
      setUploading((n) => n - 1);
      if (report(result) && result.ok && result.path !== undefined) {
        const path = result.path;
        setText((t) => withPath(t, path));
        // The same path again (a re-attached name) replaces its thumbnail.
        if (isImageName(file.name)) setPreviews((list) => [...list.filter((p) => p.path !== path), { path, name: file.name, url: URL.createObjectURL(file) }]);
      }
    }
    if (files.current !== null) files.current.value = "";
    box.current?.focus();
  };

  return (
    <div className="composer-wrap">
      {matches.length > 0 && (
        <ul className="slash-list" role="listbox" data-testid="slash-list">
          {matches.map((c, i) => (
            <li key={c.name} role="option" aria-selected={i === picked}>
              <button type="button" className="slash-item" data-testid="slash-item" onMouseDown={(e) => e.preventDefault()} onClick={() => complete(c)}>
                <span className="slash-name">{c.name}</span>
                {c.arg !== "" && <span className="slash-arg">{c.arg}</span>}
                <span className="slash-desc">{c.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {shown.length > 0 && (
        <ul className="attach-previews" data-testid="attach-previews">
          {shown.map((p) => (
            <li key={p.path} className="attach-preview" data-testid="attach-preview">
              <img src={p.url} alt={p.name} />
              <button type="button" className="attach-remove" aria-label={`Remove ${p.name}`} data-testid="attach-remove" onClick={() => setText((t) => withoutPath(t, p.path))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="composer"
        data-testid="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <button type="button" className="composer-btn" aria-label="Attach files" data-testid="attach" onClick={() => files.current?.click()}>
          <PlusIcon />
        </button>
        <input ref={files} type="file" multiple hidden data-testid="attach-input" onChange={(e) => void attach(e.target.files)} />
        <textarea
          ref={box}
          className="composer-text"
          data-testid="composer-text"
          rows={1}
          value={text}
          placeholder={uploading > 0 ? "Uploading…" : "Message"}
          aria-label="Message"
          onChange={(e) => {
            setText(e.target.value);
            setPicked(0);
          }}
          onKeyDown={onKey}
          onPaste={(e) => {
            const images = pastedImages(e.clipboardData);
            if (images.length === 0) return;
            e.preventDefault();
            void attach(images);
          }}
        />
        {working && (
          <button type="button" className="composer-btn composer-stop" aria-label="Stop" data-testid="stop" onClick={() => void stopAgent(paneId).then(report)}>
            <StopIcon />
          </button>
        )}
        <span ref={slotRef} className="composer-slot" />
        <button type="submit" className="composer-btn composer-send" aria-label="Send" data-testid="send" disabled={busy || uploading > 0 || text.trim() === ""}>
          <SendIcon />
        </button>
      </form>
      {pending !== null && (pending.wake || slow) && (
        <div className="pending-message" data-testid="pending-message">
          <span className="pending-text">{pending.text}</span>
          <span className="pending-state">{pending.wake ? "Sending when ready…" : "Sending…"}</span>
        </div>
      )}
      {error !== "" && (
        <div className="input-error" role="alert" data-testid="composer-error">
          {error}
        </div>
      )}
    </div>
  );
}

export interface ChatInputProps {
  readonly paneId: string;
  readonly menu: ChatMenu | null;
  /** The menu an answer left on screen, ahead of the stream. */
  readonly onMenu: (menu: ChatMenu | null) => void;
  /** The agent is working: the stop button shows. */
  readonly working: boolean;
  /** The session is asleep or waking: a message in flight shows as pending. */
  readonly waking?: boolean;
  /** Called with the text when a send starts (the quick-reply modal shows it before the transcript does); the result takes it back if the send fails. */
  readonly onSend?: (text: string) => () => void;
  /** The conversation so far: with it, conversation mode (voice in and out) is offered. */
  readonly messages?: readonly ChatMessage[];
}

const menuKey = (m: ChatMenu) => `${m.kind}|${m.title}|${m.steps.map((s) => s.label).join(",")}`;

export function ChatInput({ paneId, menu, onMenu, working, waking = false, onSend, messages }: ChatInputProps) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [heard, setHeard] = useState({ text: "", n: 0 });
  const [sent, setSent] = useState(0);
  return (
    <div className="chat-input" data-testid="chat-input">
      {menu !== null && <MenuCard key={menuKey(menu)} paneId={paneId} menu={menu} onMenu={onMenu} />}
      {messages !== undefined && <Conversation paneId={paneId} messages={messages} working={working} slot={slot} onHeard={(text) => setHeard((h) => ({ text, n: h.n + 1 }))} sent={sent} />}
      <Composer paneId={paneId} working={working} waking={waking} onSend={onSend} slotRef={setSlot} heard={heard} onSent={() => setSent((n) => n + 1)} />
    </div>
  );
}
