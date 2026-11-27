import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "../shared/chat.ts";
import type { PaneStatus, Tree } from "../shared/model.ts";
import { allSpaces } from "../shared/tree-walk.ts";
import { apply } from "./admin.tsx";
import { ChatInput } from "./ChatInput.tsx";
import { Message, STICK_PX } from "@herdr/web/ChatView.tsx";
import { newNotices, pendingFor, statusMap, withPending, type PendingSend, useReplyNotify, viewedPane, type Notice } from "./reply-notify.ts";
import { navigate, type Route } from "./router.ts";
import { useChat } from "@herdr/web/useChat.ts";
import { useSwipeAway } from "./useSwipeAway.ts";

// In-app reply notifications (task 101): a banner at the top when an agent answers or needs input; tap it for a
// quick-reply modal (the recent conversation, scrollable, then the composer or the answer picker, both the chat's own); swipe it away.
// Only while the setting is on (Settings > Notifications, per device).

/** What the quick-reply modal shows: the user's messages and the agent's text, oldest first (no thinking, tools or notes). */
export function modalMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "note") continue;
    const parts = m.parts.filter((p) => p.kind === "text");
    if (parts.length > 0) out.push({ ...m, parts });
  }
  return out;
}

function Banner({ notice, onOpen, onDismiss }: { readonly notice: Notice; readonly onOpen: () => void; readonly onDismiss: () => void }) {
  const swipe = useSwipeAway(onDismiss, onOpen);
  return (
    <div
      className="reply-banner"
      role="button"
      tabIndex={0}
      data-testid="reply-banner"
      data-pane={notice.paneId}
      data-kind={notice.kind}
      style={swipe.style}
      {...swipe.handlers}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
        else if (e.key === "Escape") onDismiss();
      }}
    >
      <span className={`status ${notice.kind === "waiting" ? "status-waiting" : "status-finished"}`} aria-hidden="true" />
      <span className="reply-banner-name">{notice.paneName}</span>
      <span className="reply-banner-text">{notice.kind === "waiting" ? "needs your input" : "replied"} · {notice.spaceName}</span>
    </div>
  );
}

function ReplyModal({ notice, tree, onClose }: { readonly notice: Notice; readonly tree: Tree; readonly onClose: () => void }) {
  const chat = useChat(notice.paneId);
  const pane = allSpaces(tree).flatMap((s) => s.tabs.flatMap((t) => t.panes)).find((p) => p.id === notice.paneId);
  const nextId = useRef(0);
  const [pending, setPending] = useState<readonly PendingSend[]>([]);
  const shown = withPending(modalMessages(chat.messages), chat.messages, pending);
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Open at the latest reply, and stay there as messages arrive unless the user has scrolled up.
  useLayoutEffect(() => {
    const el = list.current;
    if (el !== null && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.menu, pending]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="scrim reply-scrim" data-testid="reply-modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet reply-modal" role="dialog" aria-label={`${notice.paneName} replied`} data-testid="reply-modal" data-pane={notice.paneId}>
        <div className="sheet-title">
          {notice.paneName} · {notice.spaceName}
        </div>
        <div
          className="reply-last"
          data-testid="reply-last"
          ref={list}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
          }}
        >
          {shown.length > 0 ? shown.map((m) => <Message key={m.id} message={m} />) : <div className="chat-note">{chat.status === "none" ? chat.reason : "Loading…"}</div>}
        </div>
        <ChatInput
          paneId={notice.paneId}
          menu={chat.menu}
          onMenu={chat.setMenu}
          working={pane?.status === "working"}
          onSend={(text) => {
            const sent = pendingFor(chat.messages, text, String(nextId.current++));
            setPending((p) => [...p, sent]);
            return () => setPending((p) => p.filter((x) => x !== sent));
          }}
        />
        <div className="reply-actions">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="reply-open-space"
            onClick={() => {
              navigate({ space: notice.spaceId, tab: notice.tabId, pane: notice.paneId });
              onClose();
            }}
          >
            Open space
          </button>
          <button type="button" className="btn" data-testid="reply-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export function ReplyNotify({ tree, route }: { readonly tree: Tree; readonly route: Route }) {
  const enabled = useReplyNotify();
  const [notices, setNotices] = useState<readonly Notice[]>([]);
  const [open, setOpen] = useState<Notice | null>(null);
  const before = useRef<Map<string, PaneStatus> | null>(null);
  // A pane whose quick-reply modal is open counts as viewed: its replies arrive in the modal, so they are seen.
  const routed = viewedPane(tree, route);
  const viewed = open?.paneId ?? routed;
  const openUnseen = open !== null && allSpaces(tree).flatMap((s) => s.tabs.flatMap((t) => t.panes)).some((p) => p.id === open.paneId && p.unseen === true) ? open.paneId : null;

  // Like opening the session: mark the open modal's pane's finished turn seen (herdr.seen).
  useEffect(() => {
    if (openUnseen === null || document.visibilityState !== "visible") return;
    void apply({ type: "pane.seen", id: openUnseen }, "Couldn't mark it seen", { quiet: true });
  }, [openUnseen, tree]);

  useEffect(() => {
    const prev = before.current;
    before.current = statusMap(tree);
    if (!enabled) {
      setOpen(null);
      return setNotices((n) => (n.length === 0 ? n : []));
    }
    const now = before.current;
    const fresh = prev === null ? [] : newNotices(prev, tree, document.visibilityState === "visible" ? routed : null, open?.paneId ?? null);
    setNotices((old) => {
      // A banner ends when its pane is looked at, works again, or is gone.
      const kept = old.filter((n) => n.paneId !== viewed && n.paneId !== routed && now.get(n.paneId) !== undefined && now.get(n.paneId) !== "working" && !fresh.some((f) => f.paneId === n.paneId));
      return kept.length === old.length && fresh.length === 0 ? old : [...kept, ...fresh];
    });
  }, [tree, enabled, viewed, routed, open]);

  if (!enabled) return null;
  const dismiss = (paneId: string) => setNotices((n) => n.filter((x) => x.paneId !== paneId));
  return (
    <>
      {notices.length > 0 && (
        <div className="reply-banners" data-testid="reply-banners">
          {notices.map((n) => (
            <Banner
              key={n.paneId}
              notice={n}
              onOpen={() => {
                dismiss(n.paneId);
                setOpen(n);
              }}
              onDismiss={() => dismiss(n.paneId)}
            />
          ))}
        </div>
      )}
      {open !== null && <ReplyModal notice={open} tree={tree} onClose={() => setOpen(null)} />}
    </>
  );
}
