import { useEffect } from "react";
import type { Tree } from "../shared/model.ts";
import { useGraphPrefs } from "./graph-view.ts";
import { navigate, useRoute, type Route } from "./router.ts";
import { useInboxEnabled } from "./settings.ts";
import { inboxItems } from "./tree-utils.ts";

const ICONS = {
  inbox: "M3 13l3-8h12l3 8v6H3z M3 13h5l1 3h6l1-3h5",
  pinned: "M9 3h6l-1 6 3 3v2H7v-2l3-3z M12 14v7",
  list: "M10 6h10 M10 12h10 M10 18h10 M4 6h.01 M4 12h.01 M4 18h.01",
} as const;

/** Where the home view was opened from, so a second tap goes back there. Cleared once something is opened from it. */
let returnTo: Route | null = null;

/** Phone top bar: one tap from any screen opens the home view you last picked (List, Inbox or Pinned, via the view switch); the badge counts sessions waiting on you. Hidden when the Inbox setting is off. */
export function InboxButton({ tree }: { readonly tree: Tree }) {
  const on = useInboxEnabled() === true;
  const stored = useGraphPrefs().mode;
  const mode = (stored === "inbox" || stored === "pinned") && on ? stored : "list"; // same fallback as App: these are only honoured while the setting is on
  const route = useRoute();
  const home = route.space === null && route.settings !== true;
  useEffect(() => {
    if (!home) returnTo = null; // something was opened from the home view (or we are back): a later tap opens it afresh
  }, [home]);
  if (!on) return null;
  const waiting = inboxItems(tree).filter((i) => i.pane.status === "waiting").length;
  const name = mode === "inbox" ? "Inbox" : mode === "pinned" ? "Pinned" : "List";
  const label = waiting === 0 ? name : `${name}, ${String(waiting)} waiting`;
  return (
    <button
      type="button"
      className={`inbox-open${waiting > 0 ? " has-waiting" : ""}`}
      aria-label={label}
      title={label}
      data-testid="inbox-open"
      data-waiting={waiting}
      aria-pressed={home}
      onClick={() => {
        if (home && returnTo !== null) {
          const back = returnTo;
          returnTo = null;
          navigate(back);
          return;
        }
        returnTo = home ? null : route;
        navigate({ space: null, tab: null, pane: null });
      }}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
        <path d={ICONS[mode]} />
      </svg>
      {waiting > 0 && (
        <span className="inbox-badge" data-testid="inbox-badge">
          {waiting > 9 ? "9+" : waiting}
        </span>
      )}
    </button>
  );
}
