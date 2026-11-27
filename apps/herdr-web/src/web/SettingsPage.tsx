import { useEffect, useState } from "react";
import { disablePush, enablePush, pushInfo, pushSupported, refreshPushInfo, sendTestPush, setPaused, thisDeviceSubscribed } from "./push.ts";
import { logout } from "@herdr/web/session.ts";
import { SettingsButton } from "./admin.tsx";
import { goHome } from "./router.ts";
import { ShortcutsSettings } from "./ShortcutsSettings.tsx";
import { runningBuild } from "./build.ts";
import { workerInfo, type WorkerInfo } from "./sw-version.ts";
import { setReplyNotify, useReplyNotify } from "./reply-notify.ts";
import { changeSettings, useSettings, type SettingsChange, type SettingsView } from "./settings.ts";

// The settings page (F51), stored on the server: auto-sleep (on/off, idle threshold), the "needs you"
// inbox view, and the global push pause. Each control saves at once. Keyboard shortcuts are kept per browser (ShortcutsSettings.tsx). Only global settings live here; never-sleep is per space, in the space's own menu.

export function SettingsPage({ showBack }: { readonly showBack: boolean }) {
  const settings = useSettings();
  const [error, setError] = useState<string | null>(null);
  const [idle, setIdle] = useState<string | null>(null);
  const [every, setEvery] = useState<string | null>(null);
  const [paused, setPausedState] = useState<boolean | null>(null);
  const [here, setHere] = useState<boolean | null>(null);
  const [pushNote, setPushNote] = useState<string | null>(null);
  const [worker, setWorker] = useState<WorkerInfo | null>(null);
  useEffect(() => {
    void workerInfo().then(setWorker);
  }, []);
  void refreshPushInfo().then((i) => setPausedState((p) => p ?? i?.paused ?? null));
  useEffect(() => {
    void thisDeviceSubscribed().then((h) => setHere((cur) => cur ?? h));
  }, []);

  const toggleHere = async (on: boolean) => {
    setHere(on);
    if (!on) return void disablePush();
    const why = await enablePush().catch((e: unknown) => (e instanceof Error ? e.message : "Couldn't turn notifications on."));
    setPushNote(why);
    if (why !== null) setHere(false);
  };
  const testPush = async () => {
    const r = await sendTestPush();
    setPushNote(typeof r === "number" ? (r === 0 ? "Nothing was sent (paused, or no device is subscribed)." : `Sent to ${String(r)} device${r === 1 ? "" : "s"}.`) : r);
  };

  // Shown at once and taken back if refused (settings.ts); the error says why.
  const save = async (change: SettingsChange) => {
    const result = await changeSettings(change);
    setError(typeof result === "string" ? result : null);
    setIdle(null);
    setEvery(null);
  };
  const replyBanners = useReplyNotify();
  const pushPaused = paused ?? settings?.pushPaused ?? false;

  const body = (s: SettingsView) => (
    <>
      <div className="settings-group">
        <h2>Auto-sleep</h2>
        <div className="setting">
          <label htmlFor="autosleep-on">Put idle Claude sessions to sleep</label>
          <input id="autosleep-on" type="checkbox" data-testid="autosleep-enabled" checked={s.autosleep.enabled} onChange={(e) => void save({ autosleep: { enabled: e.target.checked } })} />
        </div>
        <div className="setting">
          <label htmlFor="autosleep-idle">Idle for longer than</label>
          <input
            id="autosleep-idle"
            type="text"
            data-testid="autosleep-idle"
            value={idle ?? s.autosleep.idle}
            onChange={(e) => setIdle(e.target.value)}
            onBlur={() => idle !== null && idle.trim() !== s.autosleep.idle && void save({ autosleep: { idle: idle.trim() } })}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </div>
        <div className="setting">
          <label htmlFor="autosleep-every">Check every</label>
          <input
            id="autosleep-every"
            type="text"
            data-testid="autosleep-every"
            value={every ?? s.autosleep.every}
            onChange={(e) => setEvery(e.target.value)}
            onBlur={() => every !== null && every.trim() !== s.autosleep.every && void save({ autosleep: { every: every.trim() } })}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </div>
        <div className="setting-hint">Durations like 90m, 3h or 1d. Checked every {s.autosleep.every}; a sleeping session wakes with Resume. Spaces that never sleep are set from each space's menu.</div>
      </div>
      <div className="settings-group">
        <h2>Views</h2>
        <div className="setting">
          <label htmlFor="inbox-on">“Needs you” inbox view</label>
          <input id="inbox-on" type="checkbox" data-testid="inbox-enabled" checked={s.inbox} onChange={(e) => void save({ inbox: e.target.checked })} />
        </div>
      </div>
      <ShortcutsSettings />
      <div className="settings-group">
        <h2>Notifications</h2>
        {pushSupported() && (
          <div className="setting">
            <label htmlFor="push-device">Notifications on this device</label>
            <input id="push-device" type="checkbox" data-testid="push-device" checked={here ?? false} disabled={here === null || pushInfo()?.enabled === false} onChange={(e) => void toggleHere(e.target.checked)} />
          </div>
        )}
        <div className="setting">
          <label htmlFor="reply-banners">Reply banners in the app</label>
          <input id="reply-banners" type="checkbox" data-testid="reply-banners-enabled" checked={replyBanners} onChange={(e) => setReplyNotify(e.target.checked)} />
        </div>
        <div className="setting-hint">When an agent answers or needs input, a banner shows at the top; tap it to reply without leaving the page. This device only.</div>
        <div className="setting">
          <label htmlFor="push-pause">Pause all notifications</label>
          <input
            id="push-pause"
            type="checkbox"
            data-testid="push-paused"
            checked={pushPaused}
            disabled={pushInfo()?.enabled === false}
            onChange={(e) => {
              setPausedState(e.target.checked);
              void setPaused(e.target.checked);
            }}
          />
        </div>
        {pushInfo()?.enabled === true && here === true && (
          <div className="setting">
            <span>Send a test notification</span>
            <button type="button" data-testid="push-test" onClick={() => void testPush()}>
              Send
            </button>
          </div>
        )}
        {pushNote !== null && (
          <div className="setting-hint" data-testid="push-note">
            {pushNote}
          </div>
        )}
      </div>
      <div className="settings-group">
        <h2>Version</h2>
        <div className="setting-hint" data-testid="sw-version">
          {versionText(worker)}
        </div>
      </div>
      <div className="settings-group">
        <h2>Account</h2>
        <button type="button" className="danger setting-logout" data-testid="logout" onClick={() => void logout()}>
          Log out
        </button>
      </div>
    </>
  );

  return (
    <section className="settings" data-testid="settings-page">
      <header className="bar">
        {showBack && (
          <button type="button" className="back" aria-label="Back to spaces" onClick={goHome}>
            ‹
          </button>
        )}
        <h1 className="bar-title">Settings</h1>
        {showBack && <SettingsButton />}
      </header>
      {error !== null && (
        <div className="setting-error" role="alert">
          {error}
        </div>
      )}
      {settings === null ? <div className="notice">Loading…</div> : body(settings)}
    </section>
  );
}

// The build ids are the hashed entry script paths (build.ts); only the hash part is shown.
const shortBuild = (id: string | null): string => (id === null ? "dev" : id.replace(/^.*\/assets\/index-/u, "").replace(/\.js$/u, ""));

function versionText(w: WorkerInfo | null): string {
  const page = `Page ${shortBuild(runningBuild())}`;
  if (w === null) return page;
  if (w.version === null) return `${page}, no service worker`;
  const notes = [w.controlling ? null : "not controlling this page", w.updating ? "update waiting" : null].filter((n) => n !== null);
  return `${page}, service worker ${w.version === "unknown" ? "older than this build" : shortBuild(w.version)}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
}
