import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// The service worker's push handling (F19-F21), run against a stand-in for the worker's global
// scope: what a push shows, where a tap goes, and that no tap can leave the app's origin.

type Handler = (event: Record<string, unknown>) => void;

function load() {
  const handlers: Record<string, Handler> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const reports: Record<string, unknown>[] = [];
  const onScreen: { title: string; tag: string; body: string; data: unknown; close(): void }[] = [];
  const windows: { url: string; navigated?: string; navigate?(u: string): Promise<void>; messages: unknown[]; focused: boolean; postMessage(m: unknown): void; focus(): Promise<void> }[] = [];
  const self = {
    location: { origin: "https://herdr.example" },
    addEventListener: (type: string, fn: Handler) => {
      const before = handlers[type];
      handlers[type] = before === undefined ? fn : (e) => (before(e), fn(e));
    },
    skipWaiting: () => Promise.resolve(),
    registration: {
      // Like the browser: a notification with the same tag replaces the one on screen.
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        const i = onScreen.findIndex((n) => n.tag === options.tag);
        if (i >= 0) onScreen.splice(i, 1);
        const n = { title, tag: options.tag as string, body: options.body as string, data: options.data, close: () => void onScreen.splice(onScreen.indexOf(n), 1) };
        onScreen.push(n);
        return Promise.resolve();
      },
      getNotifications: () => Promise.resolve([...onScreen]),
    },
    clients: {
      matchAll: () => Promise.resolve(windows),
      openWindow: (url: string) => (opened.push(url), Promise.resolve(null)),
      claim: () => Promise.resolve(),
    },
  };
  runInNewContext(readFileSync(new URL("./public/sw.js", import.meta.url), "utf8"), { self, caches: {}, URL, fetch: (path: string, init: { body: string }) => (path === "/api/diag" && reports.push(JSON.parse(init.body) as Record<string, unknown>), Promise.reject(new Error("no network"))), /* a short ack wait for the tests (the worker waits 1500 ms) */ setTimeout: (fn: () => void) => globalThis.setTimeout(fn, 5) });
  const wait = async (fire: (event: Record<string, unknown>) => void, extra: Record<string, unknown> = {}) => {
    let pending: Promise<unknown> = Promise.resolve();
    fire({ ...extra, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  };
  let ack = false;
  const addWindow = (url: string, answers = true) => {
    ack = answers;
    const w = { url, messages: [] as unknown[], focused: false, navigated: undefined as string | undefined, navigate(u: string) { this.navigated = u; return Promise.resolve(); }, postMessage(m: unknown) { this.messages.push(m); if (ack) handlers.message?.({ data: { type: "opened" } }); }, focus() { this.focused = true; return Promise.resolve(); } };
    windows.push(w);
    return w;
  };
  const push = (data: unknown) => wait((e) => handlers.push?.(e), { data: { json: () => data } });
  const tap = (url: unknown) => wait((e) => handlers.notificationclick?.(e), { notification: { data: url === undefined ? undefined : { url }, close: () => undefined } });
  const ask = (data: unknown) => {
    let answer: unknown;
    handlers.message?.({ data, ports: [{ postMessage: (m: unknown) => (answer = m) }], waitUntil: () => undefined });
    return answer;
  };
  const tapShown = () => wait((e) => handlers.notificationclick?.(e), { notification: { ...onScreen[0], close: () => undefined } });
  return { shown, opened, push, tap, addWindow, reports, ask, onScreen, tapShown };
}

describe("service worker push", () => {
  it("shows the payload as a notification that replaces its predecessor by tag", async () => {
    const sw = load();
    await sw.push({ title: "alpha", body: "worker needs your input", url: "/s/a/b/t1", tag: "needs-input:t1" });
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]?.title).toBe("alpha");
    expect(sw.shown[0]?.options).toMatchObject({ body: "worker needs your input", tag: "needs-input:t1", renotify: true, data: { url: "/s/a/b/t1" } });
  });

  it("still shows something for a payload it can't read (the browser requires a visible notification)", async () => {
    const sw = load();
    await sw.push({});
    expect(sw.shown[0]?.title).toBe("herdr");
  });

  it("a tap with no window open opens one at the session", async () => {
    const sw = load();
    await sw.tap("/s/a/b/t1");
    expect(sw.opened).toEqual(["/s/a/b/t1"]);
  });

  it("a tap with the app open focuses it and tells it to navigate, without a reload", async () => {
    const sw = load();
    const w = sw.addWindow("https://herdr.example/");
    await sw.tap("/s/a");
    expect(w.messages).toEqual([{ type: "open", url: "/s/a" }]);
    expect(w.focused).toBe(true);
    expect(sw.opened).toEqual([]);
  });

  it("a tap with no data (Android's collapsed bundle) opens the Inbox, not a session", async () => {
    const sw = load();
    await sw.tap(undefined);
    expect(sw.opened).toEqual(["/inbox"]);
  });

  it("a window that never answers (frozen page) is navigated instead", async () => {
    const sw = load();
    const w = sw.addWindow("https://herdr.example/", false);
    await sw.tap("/s/a/b/t1");
    expect(w.navigated).toBe("/s/a/b/t1");
  });

  it("a window that answers is not reloaded", async () => {
    const sw = load();
    const w = sw.addWindow("https://herdr.example/");
    await sw.tap("/s/a/b/t1");
    expect(w.navigated).toBeUndefined();
  });

  it("a tap never leaves the app's origin", async () => {
    for (const bad of ["https://evil.example/x", "//evil.example/x", "javascript:alert(1)", 5]) {
      const sw = load();
      await sw.tap(bad);
      expect(sw.opened, String(bad)).toEqual(["/"]);
    }
  });

  it("reports each tap to the diagnostic trail, even when the network is down", async () => {
    const sw = load();
    await sw.tap(undefined);
    const w = sw.addWindow("https://herdr.example/", false);
    await sw.tap("/s/a");
    expect(sw.reports[0]).toMatchObject({ kind: "tap", sw: "__SW_VERSION__", tapped: null, target: "/inbox", matched: 0, action: "openWindow" });
    expect(sw.reports[1]).toMatchObject({ kind: "tap", tapped: "/s/a", target: "/s/a", matched: 1, picked: w.url, acked: false, action: "navigate" });
  });

  it("tells a page which version it is", () => {
    expect(load().ask({ type: "version" })).toBe("__SW_VERSION__");
  });

  it("a second pending notification turns them into one summary that opens the Inbox (so Android never bundles them)", async () => {
    const sw = load();
    await sw.push({ title: "alpha", body: "w1 needs your input", url: "/s/a/b/t1", tag: "needs-input:t1" });
    await sw.push({ title: "beta", body: "w2 finished", url: "/s/c/d/t2", tag: "finished:t2" });
    expect(sw.onScreen).toHaveLength(1);
    expect(sw.onScreen[0]).toMatchObject({ title: "2 herdr notifications", tag: "herdr-summary", body: "beta: w2 finished\nalpha: w1 needs your input", data: { url: "/inbox" } });
    await sw.push({ title: "gamma", body: "w3 ended", url: "/s/e/f/t3", tag: "died:t3" });
    expect(sw.onScreen).toHaveLength(1);
    expect(sw.onScreen[0]?.title).toBe("3 herdr notifications");
    await sw.tapShown();
    expect(sw.opened).toEqual(["/inbox"]);
  });

  it("a push for a session already pending replaces its line instead of adding one", async () => {
    const sw = load();
    await sw.push({ title: "alpha", body: "w1 needs your input", url: "/s/a", tag: "needs-input:t1" });
    await sw.push({ title: "alpha", body: "w1 needs your input again", url: "/s/a", tag: "needs-input:t1" });
    expect(sw.onScreen).toEqual([expect.objectContaining({ tag: "needs-input:t1", body: "w1 needs your input again" })]);
    await sw.push({ title: "beta", body: "w2 finished", url: "/s/b", tag: "finished:t2" });
    await sw.push({ title: "beta", body: "w2 finished again", url: "/s/b", tag: "finished:t2" });
    expect(sw.onScreen).toHaveLength(1);
    expect(sw.onScreen[0]).toMatchObject({ title: "2 herdr notifications", body: "beta: w2 finished again\nalpha: w1 needs your input again" });
  });

  it("once the summary is dismissed, the next push is a single notification again", async () => {
    const sw = load();
    await sw.push({ title: "alpha", body: "a", url: "/s/a", tag: "t1" });
    await sw.push({ title: "beta", body: "b", url: "/s/b", tag: "t2" });
    sw.onScreen[0]?.close();
    await sw.push({ title: "gamma", body: "c", url: "/s/c", tag: "t3" });
    expect(sw.onScreen).toEqual([expect.objectContaining({ title: "gamma", tag: "t3", data: { url: "/s/c" } })]);
  });
});
