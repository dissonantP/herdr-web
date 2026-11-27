import { spawn } from "node:child_process";

// `npm run dev`: the backend (restarting on change) on HERDR_PORT, and Vite's dev server, which
// proxies /api to it. Uses whatever herdr-core and groups file the environment names (your live
// ones by default: the app only reads them in M1).

const env = { ...process.env, HERDR_WEB_ROOT: "none", HERDR_ALLOWED_SOURCE: process.env.HERDR_ALLOWED_SOURCE ?? "127.0.0.1" };
const children = [
  spawn(process.execPath, ["--watch-path=src/server", "--watch-path=src/shared", "src/server/main.ts"], { stdio: "inherit", env }),
  spawn("npx", ["vite"], { stdio: "inherit", env }),
];
const stop = () => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", stop);
