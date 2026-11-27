import { ensureVapid } from "./vapid.ts";

// `node gen-vapid.ts <path>`: create the VAPID key file unless it exists (install.sh apply vapid).
const path = process.argv[2];
if (path === undefined) {
  console.error("usage: gen-vapid.ts <path>");
  process.exit(2);
}
console.log(ensureVapid(path) ? `created ${path}` : `${path} already exists; left alone`);
