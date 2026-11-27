import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ActionResult } from "../shared/model.ts";

// The one overlay at a time: an action menu (the ⋯ button, long-press or right-click on a row) or a
// dialog (a small form, a confirm). Opened from anywhere with `openMenu` / `openDialog`; `<Overlay/>`
// draws it. A menu is a context menu next to where the user tapped or clicked (flipped and clamped to
// stay on screen); a dialog is a sheet at the bottom of a phone, centered on a wide screen.

export interface MenuItem {
  readonly label: string;
  readonly danger?: boolean;
  /** Small title of the section this item sits under; sections show in order of first use. Red items always go last, together. */
  readonly section?: string;
  readonly run: () => void;
}

/** Splits a menu into titled sections, with every danger item moved to a final section of its own. */
function sectionMenu(items: readonly MenuItem[]): { readonly title: string | null; readonly items: readonly MenuItem[] }[] {
  const out: { title: string | null; items: MenuItem[] }[] = [];
  for (const item of items.filter((i) => i.danger !== true)) {
    const title = item.section ?? null;
    const sec = out.find((s) => s.title === title);
    if (sec === undefined) out.push({ title, items: [item] });
    else sec.items.push(item);
  }
  // A lone titled section needs no title: the menu's own title already says what it is.
  if (out.length === 1 && out[0]) out[0].title = null;
  const danger = items.filter((i) => i.danger === true);
  if (danger.length > 0) out.push({ title: out.length > 0 ? "Danger" : null, items: danger });
  return out;
}

export interface Field {
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  /** A select's choices; a text box when absent. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

export interface DialogButton {
  readonly label: string;
  readonly danger?: boolean;
  /** Runs the change; an `ok: false` answer keeps the dialog open with the error shown. */
  readonly run: (values: Readonly<Record<string, string>>) => Promise<ActionResult>;
}

type State =
  | { readonly kind: "menu"; readonly title: string; readonly items: readonly MenuItem[]; readonly anchor: Point }
  | { readonly kind: "dialog"; readonly title: string; readonly body?: ReactNode; readonly fields?: readonly Field[]; readonly buttons: readonly DialogButton[] }
  | null;

export interface Point {
  readonly x: number;
  readonly y: number;
}

// Where the user last tapped, clicked or long-pressed, so a menu opens there whoever opens it. A
// keyboard-made click has no position: use the clicked element instead.
let pointer: Point = { x: 0, y: 0 };
if (typeof window !== "undefined") {
  const note = (e: MouseEvent | PointerEvent) => {
    if (e.type === "click" && e.detail === 0 && e.target instanceof Element) {
      const r = e.target.getBoundingClientRect();
      pointer = { x: r.left, y: r.bottom };
    } else if (e.clientX !== 0 || e.clientY !== 0) pointer = { x: e.clientX, y: e.clientY };
  };
  for (const type of ["pointerdown", "contextmenu", "click"] as const) window.addEventListener(type, note, true);
}

/** Where a w x h box goes so it starts at `anchor`, flipped to the other side near an edge, and never off screen. */
export function placeBox(anchor: Point, size: { readonly w: number; readonly h: number }, view: { readonly w: number; readonly h: number }, margin = 8): Point {
  const clamp = (v: number, max: number) => Math.max(margin, Math.min(v, max));
  const x = anchor.x + size.w + margin > view.w ? anchor.x - size.w : anchor.x;
  const y = anchor.y + size.h + margin > view.h ? anchor.y - size.h : anchor.y;
  return { x: clamp(x, view.w - size.w - margin), y: clamp(y, view.h - size.h - margin) };
}

let state: State = null;
/** Bumped on every open, so a new dialog starts with fresh fields. */
let seq = 0;
const listeners = new Set<() => void>();

function set(next: State): void {
  state = next;
  seq += 1;
  for (const listener of listeners) listener();
}

export const openMenu = (title: string, items: readonly MenuItem[]): void => set({ kind: "menu", title, items, anchor: pointer });
export const openDialog = (dialog: Omit<Extract<State, { kind: "dialog" }>, "kind">): void => set({ kind: "dialog", ...dialog });
export const closeOverlay = (): void => set(null);

function useOverlayState(): State {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => state,
  );
}

function Menu({ title, items, anchor }: { readonly title: string; readonly items: readonly MenuItem[]; readonly anchor: Point }) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<Point | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    setAt(placeBox(anchor, { w: r.width, h: r.height }, { w: window.innerWidth, h: window.innerHeight }));
  }, [anchor]);
  return (
    <div ref={box} className="ctx" role="menu" aria-label={title} data-testid="action-menu" style={{ left: at?.x ?? 0, top: at?.y ?? 0, visibility: at === null ? "hidden" : "visible" }}>
      <div className="sheet-title">{title}</div>
      {sectionMenu(items).map((sec, n) => (
        <div key={sec.title ?? `_${String(n)}`} role="group" aria-label={sec.title ?? undefined} className="ctx-section" data-testid="menu-section">
          {sec.title !== null && <div className="ctx-section-title" data-testid="menu-section-title">{sec.title}</div>}
          {sec.items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`sheet-item${item.danger === true ? " danger" : ""}`}
              onClick={() => {
                closeOverlay();
                item.run();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function Dialog({ title, body, fields = [], buttons }: Omit<Extract<State, { kind: "dialog" }>, "kind">) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, f.value])));
  const [error, setError] = useState<string | null>(null);
  // The button whose change is waiting on the server (a create needs its new ids); the others predict theirs and close at once.
  const [busy, setBusy] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const idBase = useId();
  useEffect(() => first.current?.select(), []);
  const run = async (button: DialogButton) => {
    setBusy(button.label);
    setError(null);
    try {
      const result = await button.run(values);
      if (result.ok) closeOverlay();
      else setError(result.error);
    } finally {
      setBusy(null);
    }
  };
  const primary = buttons[0];
  return (
    <form
      className="sheet"
      role="dialog"
      aria-label={title}
      data-testid="dialog"
      onSubmit={(e) => {
        e.preventDefault();
        if (primary !== undefined && busy === null) void run(primary);
      }}
    >
      <div className="sheet-title">{title}</div>
      {body !== undefined && <div className="sheet-body">{body}</div>}
      {fields.map((f, i) => (
        <div key={f.name} className="field">
          <label className="field-label" htmlFor={`${idBase}-${f.name}`}>
            {f.label}
          </label>
          {f.options === undefined ? (
            <input
              id={`${idBase}-${f.name}`}
              ref={i === 0 ? first : undefined}
              name={f.name}
              value={values[f.name] ?? ""}
              placeholder={f.placeholder}
              autoComplete="off"
              autoCapitalize="off"
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            />
          ) : (
            <select id={`${idBase}-${f.name}`} name={f.name} value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </div>
      ))}
      {error !== null && (
        <div className="sheet-error" role="alert">
          {error}
        </div>
      )}
      <div className="sheet-buttons">
        <button type="button" className="btn" onClick={closeOverlay}>
          Cancel
        </button>
        {buttons.map((b, i) => (
          <button key={b.label} type={i === 0 ? "submit" : "button"} disabled={busy !== null} aria-busy={busy === b.label} className={`btn${b.danger === true ? " btn-danger" : " btn-primary"}`} onClick={i === 0 ? undefined : () => void run(b)}>
            {b.label}
          </button>
        ))}
      </div>
    </form>
  );
}

export function Overlay() {
  const current = useOverlayState();
  useEffect(() => {
    if (current === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeOverlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);
  if (current === null) return null;
  return (
    <div className={current.kind === "menu" ? "scrim scrim-clear" : "scrim"} onClick={(e) => e.target === e.currentTarget && closeOverlay()} onContextMenu={(e) => e.target === e.currentTarget && e.preventDefault()}>
      {current.kind === "menu" ? <Menu key={seq} title={current.title} items={current.items} anchor={current.anchor} /> : <Dialog key={seq} {...current} />}
    </div>
  );
}
