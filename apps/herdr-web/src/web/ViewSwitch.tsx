import { setGraphPrefs, VIEWS_ENABLED, type ViewMode } from "./graph-view.ts";
import { useInboxEnabled } from "./settings.ts";

const LABELS: Record<ViewMode, string> = { list: "List", graph: "Graph", inbox: "Inbox", pinned: "Pinned" };

/** The view switch: List, Inbox and Pinned (those two only when that setting is on; Graph too once views are enabled). Hidden with fewer than two options. Every option is always shown, the current one highlighted. */
export function ViewSwitch({ mode, wrap = false }: { readonly mode: ViewMode; readonly wrap?: boolean }) {
  const inbox = useInboxEnabled() === true;
  // Graph is parked (task 057); the switch then shows only when the Inbox setting is on: List | Inbox.
  const modes: ViewMode[] = [...(VIEWS_ENABLED ? (["list", "graph"] as const) : (["list"] as const)), ...(inbox ? (["inbox", "pinned"] as const) : [])];
  if (modes.length < 2) return null;
  const seg = (
    <div className="seg" role="tablist" aria-label="Hierarchy view">
      {modes.map((m) => (
        <button key={m} type="button" role="tab" aria-selected={mode === m} className="seg-pick" data-testid={`view-${m}`} onClick={() => setGraphPrefs({ mode: m })}>
          {LABELS[m]}
        </button>
      ))}
    </div>
  );
  return wrap ? <div className="tree-views">{seg}</div> : seg;
}
