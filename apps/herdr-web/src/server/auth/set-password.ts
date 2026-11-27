import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { credentialsPath } from "./credentials.ts";
import { hashPassword } from "./password.ts";

// Writes the login's credentials file (F30) for `install.sh apply login`, which prompts for the
// username and password and pipes them in on stdin, one per line (never as arguments, so they do
// not show in the process list). Only the argon2id hash is stored, in a 0600 file in a 0700 folder.
// A new password ends every existing session (sessions are bound to the hash).
//
//   printf '%s\n%s\n' "$user" "$password" | node src/server/auth/set-password.ts [file]

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const path = process.argv[2] ?? credentialsPath(process.env);
const [username = "", password = ""] = (await stdin()).split("\n");
if (!/^[\w.@-]{1,64}$/u.test(username)) {
  console.error("username: 1-64 letters, digits, or . _ @ -");
  process.exit(2);
}
if (password.length < 8 || password.length > 1024) {
  console.error("password: 8 to 1024 characters");
  process.exit(2);
}
const hash = await hashPassword(password);
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const tmp = `${path}.${String(process.pid)}.tmp`;
writeFileSync(tmp, `${JSON.stringify({ username, hash })}\n`, { mode: 0o600 });
chmodSync(tmp, 0o600);
renameSync(tmp, path);
console.log(`wrote ${path}`);
