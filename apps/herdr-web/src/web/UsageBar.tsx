import { useEffect, useRef, useState } from "react";
import type { UsageLimit, UsageReply } from "../shared/usage.ts";
import { toLogin } from "@herdr/web/session.ts";

// The usage bar (task 098): a one-line strip at the bottom of every view with the Claude plan's 5-hour and weekly
// % used (the numbers /usage shows); tap it for a popup with every limit and its reset time. The server caches
// the read (usage.ts), so polling here is cheap; it pauses while the page is hidden.

const POLL_MS = 5 * 60_000; // the server's cache lasts as long
const LOADING_POLL_MS = 3_000;

/** "session" -> "5h", "week (all models)" -> "wk"; others keep their label. */
export function shortLabel(label: string): string {
  if (label === "session") return "5h";
  if (label === "week (all models)") return "wk";
  return label;
}

/** The limits the one-liner shows: the 5-hour and the all-models weekly. */
export function headline(limits: readonly UsageLimit[]): UsageLimit[] {
  const known = limits.filter((l) => l.label === "session" || l.label === "week (all models)");
  return known.length > 0 ? known : limits.slice(0, 2); // Claude renamed its labels: show the first two as they are
}

/** The one-liner's text. */
export function summary(limits: readonly UsageLimit[]): string {
  return headline(limits).map((l) => `${shortLabel(l.label)} ${String(l.pct)}%`).join(" · ");
}

/** A class for a high reading: amber from 80%, red from 95%. */
export function level(pct: number): string {
  return pct >= 95 ? " usage-crit" : pct >= 80 ? " usage-warn" : "";
}

/** "Nov 24, 1am (America/Los_Angeles)" -> "Nov 24, 1am"; the zone is shown once, in the popup's footer. */
export function resetTime(resets: string): { time: string; zone: string | null } {
  const m = /^(.*?)\s*\(([^)]+)\)$/u.exec(resets);
  return m === null ? { time: resets, zone: null } : { time: m[1]!, zone: m[2]! };
}

function useUsage(): [UsageReply | null, () => void] {
  const [reply, setReply] = useState<UsageReply | null>(null);
  const reload = useRef<() => void>(() => undefined);
  useEffect(() => {
    let timer: number | undefined;
    let stopped = false;
    const load = async () => {
      let next = POLL_MS;
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch("/api/usage", { cache: "no-store" });
          if (res.status === 401) return toLogin();
          const body = (await res.json()) as UsageReply;
          if (!stopped) setReply(body);
          if (body.loading) next = LOADING_POLL_MS;
        } catch {
          // offline: try again at the normal pace
        }
      }
      if (!stopped) timer = window.setTimeout(() => void load(), next);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        window.clearTimeout(timer);
        void load();
      }
    };
    reload.current = onVisible;
    document.addEventListener("visibilitychange", onVisible);
    void load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return [reply, () => reload.current()];
}

function ago(ms: number): string {
  const min = Math.floor((Date.now() - ms) / 60_000);
  return min < 1 ? "just now" : `${String(min)} min ago`;
}

export function UsageBar() {
  const [reply, refresh] = useUsage();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (root.current !== null && !root.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const snap = reply?.snapshot ?? null;
  const zone = snap?.limits.map((l) => (l.resets === null ? null : resetTime(l.resets).zone)).find((z) => z !== null) ?? null;
  const failed = snap === null && reply !== null && !reply.loading;
  return (
    <div className="usage" ref={root}>
      {open && (
        <div className="usage-pop" data-testid="usage-popup" role="dialog" aria-label="Claude usage">
          {snap === null ? (
            <div className="usage-note">{reply?.error ?? "Reading usage…"}</div>
          ) : (
            <>
              {snap.limits.map((l) => (
                <div className="usage-row" key={l.label}>
                  <div className="usage-name">
                    <span>{l.label}</span>
                    <span className={`usage-pct${level(l.pct)}`}>{String(l.pct)}%</span>
                  </div>
                  <div className="usage-meter">
                    <div className={`usage-fill${level(l.pct)}`} style={{ width: `${String(Math.min(100, l.pct))}%` }} />
                  </div>
                  {l.resets !== null && <div className="usage-note">resets {resetTime(l.resets).time}</div>}
                </div>
              ))}
              <div className="usage-note">
                {zone === null ? "" : `times in ${zone} · `}updated {ago(snap.fetchedAt)}
                {reply?.error != null ? ` (last refresh failed: ${reply.error})` : ""}
              </div>
            </>
          )}
        </div>
      )}
      <button type="button" className="usage-line" data-testid="usage-line" aria-expanded={open} aria-label="Claude usage" onClick={() => {
          if (!open) refresh(); // the server answers from its cache unless that is stale
          setOpen((o) => !o);
        }}>
        {snap !== null ? (
          headline(snap.limits).map((l, i) => (
            <span key={l.label}>
              {i > 0 && " · "}
              {shortLabel(l.label)} <span className={level(l.pct).trim()}>{String(l.pct)}%</span>
            </span>
          ))
        ) : (
          <span className={failed ? "usage-warn" : ""}>{failed ? "usage unavailable" : "usage…"}</span>
        )}
      </button>
    </div>
  );
}
