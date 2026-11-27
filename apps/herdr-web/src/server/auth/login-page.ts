import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The login page (F30): one self-contained HTML document (styles inline, colours from the theme
// file), so it needs no asset that would otherwise sit behind the login. A plain form POST; no
// script.

const THEME_FILE = fileURLToPath(new URL("../../web/theme.css", import.meta.url));
let theme: string | null = null;

function themeCss(): string {
  theme ??= (() => {
    try {
      return readFileSync(THEME_FILE, "utf8");
    } catch {
      return "";
    }
  })();
  return theme;
}

const escape = (s: string) => s.replace(/[&<>"']/gu, (c) => `&#${String(c.charCodeAt(0))};`);

export function loginPage(opts: { error?: string; next: string; username?: string }): string {
  const error = opts.error === undefined ? "" : `<p class="error" role="alert" data-testid="login-error">${escape(opts.error)}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#111214">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<link rel="icon" type="image/png" href="/icons/icon-192.png">
<title>herdr · log in</title>
<style>
${themeCss()}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: var(--text-md) var(--font); }
main { min-height: 100%; display: flex; align-items: center; justify-content: center; padding: var(--space-5); }
form { width: 100%; max-width: 320px; display: flex; flex-direction: column; gap: var(--space-4); }
h1 { margin: 0 0 var(--space-3); font-size: var(--text-lg); font-weight: 600; letter-spacing: var(--tracking); }
label { display: flex; flex-direction: column; gap: var(--space-2); color: var(--text-dim); font-size: var(--text-sm); }
input { height: var(--tap-h); padding: 0 var(--space-4); border: var(--hairline) solid var(--border); border-radius: var(--radius);
  background: var(--surface); color: var(--text); font: var(--text-lg) var(--font); }
input:focus { outline: none; border-color: var(--accent); }
button { height: var(--tap-h); border: 0; border-radius: var(--radius); background: var(--accent); color: var(--bg);
  font: 600 var(--text-md) var(--font); cursor: pointer; }
.error { margin: 0; color: var(--danger); }
</style>
</head>
<body>
<main>
<form method="post" action="/login" data-testid="login-form">
<h1>herdr</h1>
${error}
<label>Username<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${escape(opts.username ?? "")}"></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<input type="hidden" name="next" value="${escape(opts.next)}">
<button type="submit">Log in</button>
</form>
</main>
</body>
</html>
`;
}
