import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vitest/config";

const backend = `http://127.0.0.1:${process.env.HERDR_PORT ?? "7317"}`;
const outDir = fileURLToPath(new URL("./dist/web/", import.meta.url));

// Stamps the service worker with the build id (the hashed entry script, as src/web/build.ts reads
// it), so each deploy changes sw.js and the page can tell which worker it runs (task 084).
const stampServiceWorker = (): Plugin => ({
  name: "stamp-service-worker",
  apply: "build",
  closeBundle() {
    const build = /<script[^>]*type="module"[^>]*src="([^"]*\/assets\/[^"]+)"/u.exec(readFileSync(join(outDir, "index.html"), "utf8"))?.[1];
    if (build === undefined) throw new Error("stamp-service-worker: no entry script in index.html");
    const sw = join(outDir, "sw.js");
    writeFileSync(sw, readFileSync(sw, "utf8").replace('"__SW_VERSION__"', JSON.stringify(build)));
  },
});

export default defineConfig({
  root: "src/web",
  plugins: [react(), stampServiceWorker()],
  // One React for the app and @herdr/web (a second copy breaks hooks).
  resolve: { dedupe: ["react", "react-dom"] },
  build: { outDir: "../../dist/web", emptyOutDir: true },
  // "^" keys are regexes (tested against the URL with its query): a plain "/api" prefix also caught the /api.ts module.
  server: { host: "127.0.0.1", proxy: { "^/api(/|\\?|$)": { target: backend, ws: true }, "^/login(/|\\?|$)": backend } },
  test: { root: ".", include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "release/**/*.test.ts"] },
});
