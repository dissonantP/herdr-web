import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ChatMenu, ChatMessage, ChatPart, DiffHunk } from "@herdr/server/chat.ts";
import { imagePaths, imageUrl } from "./chat-input.ts";
import { attachZoomGestures, clampZoom, loadZoom, saveZoom } from "./chat-zoom.ts";
import { Markdown } from "./Markdown.tsx";
import { useChat } from "./useChat.ts";

// The chat view of an agent pane: the conversation as messages. Speech and answers are markdown;
// thinking, tool calls and subagent runs are collapsed (<details>) until tapped; file edits open
// as a diff. Borrows the shape (not the code) of AltanS/collie web/src/components/agent-chat.tsx and chat-cards.tsx (MIT, commit 62e638c59770bb1ec58412732f59c102a717ede2; notice in packages/server/third_party/collie-LICENSE).
//
// `footer` is rendered under the list and stays put while the list scrolls: the composer and the
// menu card (ChatInput.tsx), handed the menu the stream reports.

/** How near the bottom counts as "reading the latest" (a new message then keeps the view pinned). */
export const STICK_PX = 80; // pixels

function Diff({ hunks }: { readonly hunks: readonly DiffHunk[] }) {
  return (
    <pre className="diff" data-testid="chat-diff">
      {hunks.map((h, i) => (
        <span key={i}>
          <span className="diff-head">{h.header}{"\n"}</span>
          {h.lines.map((line, j) => (
            <span key={j} className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : "diff-ctx"}>
              {line}
              {"\n"}
            </span>
          ))}
        </span>
      ))}
    </pre>
  );
}

function Part({ part }: { readonly part: ChatPart }) {
  switch (part.kind) {
    case "text":
      return <Markdown text={part.text} />;
    case "image":
      return <div className="chat-note">[{part.note}]</div>;
    case "thinking":
      return (
        <details className="fold" data-testid="chat-thinking">
          <summary>Thinking</summary>
          <div className="fold-body chat-thinking">{part.text}</div>
        </details>
      );
    case "tool": {
      const label = part.subagent ? "Subagent" : part.name;
      const state = part.result === undefined ? "running" : part.result.isError ? "failed" : "done";
      return (
        <details className="fold tool" data-testid={part.subagent ? "chat-subagent" : "chat-tool"} data-state={state}>
          <summary>
            <span className="tool-name">{label}</span>
            <span className="tool-summary">{part.summary}</span>
          </summary>
          <div className="fold-body">
            {part.diff !== undefined && (
              <details className="fold diff-fold">
                <summary>
                  Diff{part.file === undefined ? "" : ` · ${part.file}`}
                </summary>
                <Diff hunks={part.diff} />
              </details>
            )}
            {part.input !== "" && <pre className="tool-io">{part.input}</pre>}
            {part.result !== undefined && <pre className={`tool-io${part.result.isError ? " tool-error" : ""}`}>{part.result.text}</pre>}
          </div>
        </details>
      );
    }
  }
}

/** What the user attached to a message: the images whose paths the text holds, as thumbnails that open full size. */
function SentImages({ parts }: { readonly parts: readonly ChatPart[] }) {
  const paths = [...new Set(parts.flatMap((p) => (p.kind === "text" ? imagePaths(p.text) : [])))];
  if (paths.length === 0) return null;
  return (
    <div className="sent-images" data-testid="sent-images">
      {paths.map((path) => (
        <a key={path} href={imageUrl(path)} target="_blank" rel="noopener" className="sent-image" data-testid="sent-image">
          <img src={imageUrl(path)} alt={path.split("/").pop() ?? "image"} loading="lazy" onError={(e) => e.currentTarget.closest("a")?.setAttribute("hidden", "")} />
        </a>
      ))}
    </div>
  );
}

export function Message({ message }: { readonly message: ChatMessage }) {
  return (
    <article className={`msg msg-${message.role}`} data-testid="chat-message" data-role={message.role}>
      {message.parts.map((part, i) => (
        <Part key={i} part={part} />
      ))}
      {message.role === "user" && <SentImages parts={message.parts} />}
    </article>
  );
}

export interface ChatViewProps {
  readonly paneId: string;
  /** The agent is working (herdr-core's terminal status, via the tree): a live indicator ends the list. */
  readonly working: boolean;
  /** Rendered under the conversation (the composer and the menu card), given the menu on the agent's screen. */
  readonly footer?: (menu: ChatMenu | null, setMenu: (menu: ChatMenu | null) => void, messages: readonly ChatMessage[]) => ReactNode;
}

export function ChatView({ paneId, working, footer }: ChatViewProps) {
  const chat = useChat(paneId);
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const height = useRef(0);
  const [zoom, setZoom] = useState(loadZoom);
  const zoomRef = useRef(zoom);
  const anchor = useRef<{ ratio: number } | null>(null);

  // Keep the reading position when the text size changes: same fraction of the content stays at the top.
  useLayoutEffect(() => {
    const el = list.current;
    if (el === null || anchor.current === null) return;
    if (pinned.current) el.scrollTop = el.scrollHeight;
    else el.scrollTop = anchor.current.ratio * el.scrollHeight;
    anchor.current = null;
  }, [zoom]);

  // A two-finger pinch or Ctrl+wheel over the chat scales the chat text only: the browser's own page
  // zoom is blocked here (non-passive listeners + touch-action: pan-y) and elsewhere left alone.
  useEffect(() => {
    const el = list.current;
    if (el === null) return;
    const apply = (z: number) => {
      const next = clampZoom(z);
      if (next === zoomRef.current) return;
      anchor.current = { ratio: el.scrollHeight === 0 ? 0 : el.scrollTop / el.scrollHeight };
      zoomRef.current = next;
      setZoom(next);
      saveZoom(next);
    };
    return attachZoomGestures(el, () => zoomRef.current, apply);
  }, []);

  useLayoutEffect(() => {
    const el = list.current;
    if (el !== null && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.menu, working]);

  // The list shrinks when the input bar grows (more lines, a menu card, the on-screen keyboard):
  // stay at the bottom if that is where it was.
  useLayoutEffect(() => {
    const el = list.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
      height.current = el.clientHeight;
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  return (
    <div className="chat-view" data-testid="chat-view" data-state={chat.status}>
      <div
        ref={list}
        className="chat-list"
        data-testid="chat-list"
        data-zoom={zoom}
        style={{ "--chat-zoom": zoom } as CSSProperties}
        onScroll={(e) => {
          const el = e.currentTarget;
          // A scroll caused by the list resizing (the input bar grew) is not the reader leaving the bottom.
          if (el.clientHeight !== height.current) return;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        }}
      >
        {chat.truncated && <div className="chat-note">Older messages are not shown.</div>}
        {chat.status === "connecting" && <div className="chat-note">Loading…</div>}
        {chat.status === "none" && <div className="chat-note" data-testid="chat-none">{chat.reason}</div>}
        {chat.messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
        {working && chat.menu === null && (
          <div className="chat-working" data-testid="chat-working" role="status">
            <span className="chat-working-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            Working…
          </div>
        )}
      </div>
      {footer?.(chat.menu, chat.setMenu, chat.messages)}
    </div>
  );
}
