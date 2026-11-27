import { defineConfig } from "@playwright/test";
import { storageStatePath } from "./tests/support/auth.ts";

// Every e2e run gets its own isolated herdr-core and backend (tests/support/stack.ts). Workers
// inherit these from the runner, so they are set once here.
process.env.HERDR_QA_SESSION ??= `herdr-qa-${String(process.pid)}`;
process.env.HERDR_QA_PORT ??= String(7400 + (process.pid % 500));

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/support/global-setup.ts",
  globalTeardown: "./tests/support/global-teardown.ts",
  // The tests share one core and reseed it, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"]],
  // Pages start logged in (the global setup's session); login tests clear the cookies themselves.
  use: { baseURL: `http://127.0.0.1:${process.env.HERDR_QA_PORT}`, screenshot: "only-on-failure", storageState: storageStatePath() },
  projects: [
    { name: "phone", use: { browserName: "chromium", viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true } },
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1280, height: 800 } } },
  ],
});
