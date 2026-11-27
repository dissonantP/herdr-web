// The login session as the UI sees it (F31-F32). The cookie is HttpOnly, so the page only learns
// about it from answers: a 401 anywhere means "go to the login page". Streams can't show their
// status (EventSource, WebSocket), so when one drops the page asks GET /api/session.

/** Set while logging out, so the streams that logout closes don't send the page off first. */
let leaving = false;

/** Leave for the login page, coming back here afterwards. */
export function toLogin(): void {
  if (leaving) return;
  const here = window.location.pathname + window.location.search;
  window.location.assign(`/login?next=${encodeURIComponent(here)}`);
}

let checking: Promise<void> | null = null;

/** After a dropped stream: go to the login page if the session is gone (a network error is not that). */
export function checkSession(): Promise<void> {
  checking ??= fetch("/api/session", { cache: "no-store" })
    .then((res) => {
      if (res.status === 401) toLogin();
    })
    .catch(() => undefined)
    .finally(() => {
      checking = null;
    });
  return checking;
}

/** Log out: end the session on the server, drop every cache the service worker kept, then the login page. */
export async function logout(): Promise<void> {
  leaving = true;
  await fetch("/api/logout", { method: "POST" }).catch(() => undefined);
  if ("caches" in window) {
    const keys = await caches.keys().catch(() => [] as string[]);
    await Promise.all(keys.map((key) => caches.delete(key)));
  }
  window.location.assign("/login");
}
