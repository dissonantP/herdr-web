import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { storageStatePath, writeStorageState } from "./auth.ts";
import { startStack } from "./stack.ts";

/** One line per run of the fake usage command (f53-usage.spec.ts counts them). */
export const usageCountFile = (port: number): string => join(tmpdir(), `herdr-usage-count-${String(port)}`);

export default async function globalSetup(): Promise<void> {
  const port = Number(process.env.HERDR_QA_PORT);
  const stack = await startStack(port, process.env.HERDR_QA_SESSION, false, {
    HERDR_CLAUDE_COMMAND: JSON.stringify([join(dirname(fileURLToPath(import.meta.url)), "fake-bin", "claude")]),
    HERDR_USAGE_COMMAND: JSON.stringify([join(dirname(fileURLToPath(import.meta.url)), "fake-bin", "usage")]),
    HERDR_USAGE_COUNT_FILE: usageCountFile(port),
    // Auto-sleep looks for idle sessions every 2 s, so its test needn't wait a minute between rounds.
    HERDR_AUTOSLEEP_EVERY_MS: "2000",
  });
  // Workers and the teardown read these.
  process.env.HERDR_QA_DIR = stack.dir;
  process.env.HERDR_QA_SERVER_PID = String(stack.server.pid);
  process.env.HERDR_QA_TOKEN = stack.token;
  // Every page starts logged in on this session (playwright.config.ts).
  writeStorageState(storageStatePath(), stack.token);
}
