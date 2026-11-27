// The UI build the page is running, against the one the server has now. After a deploy an open page
// would keep running old code; the tree stream sends the server's build id on every connect, and a
// mismatch reloads the page (at most once in 10 s, so a bad id can't loop).

/** The entry script's path, which Vite hashes per build; `null` in dev (nothing hashed). */
export function runningBuild(doc: Document = document): string | null {
  const src = doc.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute("src");
  return src ?? null;
}

const KEY = "herdr.reloaded";

export function reloadIfStale(serverBuild: string): void {
  const mine = runningBuild();
  if (mine === null || serverBuild === "" || serverBuild === mine) return;
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? "0");
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // no storage: reload anyway
  }
  window.location.reload();
}
