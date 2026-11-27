// The service worker: makes the app installable. It never serves a page or API data on its own
// (F32): navigations and /api go to the network untouched, so the server's login check always
// decides (a page without a session redirects to /login, /api answers 401 and the page goes to the
// login, @herdr/web/session.ts). The only thing cached is the hashed build assets (/assets/: code and
// styles, no data), and logging out deletes every cache. Older versions cached the app shell; the
// new cache name makes `activate` delete that.
//
// Push (F19-F21): the server sends `{title, body, url, tag}` already encrypted for this browser; the
// worker only shows it, so a notification needs neither a login session nor the network. Authelia
// session expiry therefore cannot stop one arriving. Tapping it opens `url`: an open window is
// focused and told to navigate (no reload, so no round trip through Authelia); with none open, a
// new window opens, and if the session has expired the login comes first and then returns there.
// Traefik lets exactly this file skip Authelia, so the browser's update check works even when the
// Authelia session has expired (a redirect would fail the update and keep the old worker).
const CACHE = "herdr-assets-v2";
// The build stamps its id here (vite.config.ts), so the page and the trail can tell which worker runs.
const SW_VERSION = "__SW_VERSION__";

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Logout (session.ts) clears the caches itself; this is the same for a page that asks the worker.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "version" && event.ports && event.ports[0]) event.ports[0].postMessage(SW_VERSION);
  if (event.data === "logout") event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Network-only: everything but same-origin GETs of hashed assets, navigations and /api included.
  if (request.method !== "GET" || request.mode === "navigate" || url.origin !== self.location.origin || !url.pathname.startsWith("/assets/")) return;

  // Hashed build assets are cache-first (their names change with their content). Only a real
  // asset answer is stored: never a redirect to the login, never HTML.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          const type = response.headers.get("content-type") ?? "";
          if (response.ok && !response.redirected && !type.includes("text/html")) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});

// Android collapses several notifications from one app into a bundle, and tapping the collapsed
// bundle only launches the app at its start URL, with no notificationclick (seen on a real phone, task
// 084). So at most one herdr notification is ever shown: while another is pending, a new push
// replaces them all with one summary whose tap opens the Inbox. The summary keeps the items it
// stands for, so the next push can count them; a push with the same tag as a pending item replaces it.
const SUMMARY_TAG = "herdr-summary";
const NOTIFY = { renotify: true, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png" };

// Pushes are handled one at a time, so two arriving together can't both see nothing pending and
// both show a single notification.
let lastPush = Promise.resolve();

const itemsOf = (n) =>
  n.tag === SUMMARY_TAG ? (n.data && Array.isArray(n.data.items) ? n.data.items : []) : [{ tag: n.tag, title: n.title, body: n.body, url: n.data && n.data.url }];

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // not JSON: show a plain notification
  }
  const text = (value, fallback) => (typeof value === "string" && value !== "" ? value : fallback);
  const item = { tag: text(data.tag, "herdr"), title: text(data.title, "herdr"), body: text(data.body, ""), url: text(data.url, "/") };
  const show = async () => {
    const pending = await self.registration.getNotifications().catch(() => []);
    const others = pending.flatMap(itemsOf).filter((i) => i.tag !== item.tag);
    if (others.length === 0) {
      return self.registration.showNotification(item.title, { ...NOTIFY, body: item.body, tag: item.tag, data: { url: item.url } });
    }
    const items = [...others, item];
    for (const n of pending) if (n.tag !== SUMMARY_TAG) n.close();
    const lines = items.map((i) => (i.body === "" ? i.title : `${i.title}: ${i.body}`)).reverse();
    return self.registration.showNotification(`${String(items.length)} herdr notifications`, { ...NOTIFY, body: lines.join("\n"), tag: SUMMARY_TAG, data: { url: INBOX, items } });
  };
  lastPush = lastPush.then(show, show);
  event.waitUntil(lastPush);
});

// Only same-origin paths: a notification can't send the app anywhere else.
const safeUrl = (url) => (typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? url : "/");

// An open page answers {type:"open"} with {type:"opened"}. A frozen or stale page never does, so the
// tap then navigates that window instead (a reload, but it gets there).
let acked = null;
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "opened" && acked) acked();
});
const ACK_MS = 1500;

// Android's collapsed bundle delivers a notification without our data: that tap opens the Inbox
// (the app falls back to the spaces list when the Inbox view is off). A single notification, also
// one inside an expanded bundle, carries its own session URL.
const INBOX = "/inbox";
const targetUrl = (tapped) => {
  const own = tapped.data && tapped.data.url;
  return own === undefined || own === null || own === "" ? INBOX : safeUrl(own);
};

// Each tap is reported to the server's diagnostic trail (task 084, src/server/diag.ts): what was
// tapped, the windows found, and what the worker did with them.
const report = (trace) =>
  fetch("/api/diag", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(trace) }).catch(() => undefined);
const errorText = (e) => String((e && e.message) || e).slice(0, 200);

self.addEventListener("notificationclick", (event) => {
  const tapped = event.notification;
  event.waitUntil(
    (async () => {
      const url = targetUrl(tapped);
      const trace = { kind: "tap", sw: SW_VERSION, tapped: tapped.data && typeof tapped.data.url === "string" ? tapped.data.url : null, target: url };
      tapped.close();
      try {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        trace.matched = windows.length;
        trace.windows = windows.map((w) => ({ id: w.id, url: w.url, focused: w.focused, visibility: w.visibilityState }));
        const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
        if (open === undefined) {
          trace.action = "openWindow";
          const opened = await self.clients.openWindow(url);
          trace.result = opened ? opened.url : null;
          return;
        }
        trace.picked = open.url;
        await open.focus();
        const answered = new Promise((resolve) => {
          acked = () => resolve(true);
          setTimeout(() => resolve(false), ACK_MS);
        });
        open.postMessage({ type: "open", url });
        const ok = await answered;
        acked = null;
        trace.acked = ok;
        trace.action = "message";
        if (!ok && typeof open.navigate === "function") {
          trace.action = "navigate";
          const moved = await open.navigate(url).catch((e) => {
            trace.error = errorText(e);
            return undefined;
          });
          trace.result = moved ? moved.url : null;
        }
      } catch (e) {
        trace.error = errorText(e);
      } finally {
        // Which windows the worker controls, asked after the tap's own work so it adds no delay to it.
        const controlled = await self.clients
          .matchAll({ type: "window" })
          .then((ws) => new Set(ws.map((w) => w.id)))
          .catch(() => new Set());
        for (const w of trace.windows || []) {
          w.controlled = controlled.has(w.id);
          delete w.id;
        }
        await report(trace);
      }
    })(),
  );
});

// The browser replaced the subscription (keys rotated or expired): register the new one while the
// login still stands. If it doesn't (401), the page offers to turn notifications on again.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const options = event.oldSubscription && event.oldSubscription.options;
      const key = options && options.applicationServerKey;
      if (!key) return;
      const sub = event.newSubscription || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
    })().catch(() => undefined),
  );
});
