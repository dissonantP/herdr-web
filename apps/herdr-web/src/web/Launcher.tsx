import { useEffect, useMemo, useRef, useState } from "react";
import type { Tree } from "../shared/model.ts";
import { entries, liveRecents, search, setLauncherOpen, toggleLauncher, useLauncherOpen, type Entry } from "./launcher.ts";
import { navigate } from "./router.ts";
import { hint, pressed, useBindings } from "./shortcuts.ts";
import { StatusDot } from "./StatusDot.tsx";

// The quick launcher (task 059): its shortcuts (Ctrl/Cmd+K and Ctrl/Cmd+P by default, set in Settings; they work
// from a focused terminal or chat box too) or the header button opens a search box over spaces; arrows and Enter open a result, Escape closes.

const SHOWN = 50;

/** The header button, for phones (and anyone without the hotkey). */
export function LauncherButton() {
  const keys = hint(useBindings().launcher);
  return (
    <button type="button" className="launcher-open" aria-label="Quick launcher" title={keys === "" ? "Quick launcher" : `Quick launcher (${keys})`} data-testid="launcher-open" onClick={toggleLauncher}>
      ⌕
    </button>
  );
}

export function Launcher({ tree }: { readonly tree: Tree }) {
  const open = useLauncherOpen();
  useEffect(() => {
    // Capture phase on the window, so it beats a terminal's own key handling.
    const onKey = (e: KeyboardEvent) => {
      if (pressed("launcher", e)) {
        e.preventDefault();
        e.stopPropagation();
        toggleLauncher();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
  return open ? <Palette tree={tree} /> : null;
}

function Palette({ tree }: { readonly tree: Tree }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const all = useMemo(() => entries(tree), [tree]);
  const recents = useMemo(() => liveRecents(tree), [tree]);
  const results = useMemo(() => search(all, query, recents).slice(0, SHOWN), [all, query, recents]);
  const at = Math.min(index, Math.max(results.length - 1, 0));

  // Escape closes it even if focus has moved off the box (a terminal that opened behind it grabs focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setLauncherOpen(false);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [at, results]);

  const choose = (e: Entry | undefined) => {
    if (e === undefined) return;
    setLauncherOpen(false);
    navigate(e.route);
  };

  return (
    <div className="launcher-scrim" data-testid="launcher-scrim" onMouseDown={(e) => e.target === e.currentTarget && setLauncherOpen(false)}>
      <div className="launcher" role="dialog" aria-label="Quick launcher" data-testid="launcher">
        <input
          autoFocus
          className="launcher-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="launcher-list"
          aria-activedescendant={results[at] === undefined ? undefined : `launcher-${results[at].key}`}
          placeholder="Jump to a space"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          data-testid="launcher-input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex(Math.min(at + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex(Math.max(at - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(results[at]);
            }
          }}
        />
        <div className="launcher-list" id="launcher-list" role="listbox" ref={list}>
          {results.length === 0 && <div className="notice" data-testid="launcher-empty">Nothing matches “{query.trim()}”.</div>}
          {results.map((e, i) => (
            <div
              key={e.key}
              id={`launcher-${e.key}`}
              role="option"
              aria-selected={i === at}
              className={`launcher-row${i === at ? " selected" : ""}`}
              data-testid="launcher-result"
              data-kind={e.kind}
              data-name={e.name}
              onMouseMove={() => setIndex(i)}
              onClick={() => choose(e)}
            >
              <StatusDot state={e.asleep ? "asleep" : (e.status ?? "none")} />
              <span className="launcher-name">{e.name}</span>
              {e.path !== "" && <span className="launcher-path">{e.path}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
