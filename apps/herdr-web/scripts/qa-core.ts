import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QA_PASSWORD, QA_USER } from "../tests/support/auth.ts";
import { seed } from "../tests/support/fixture.ts";
import { QaCore, qaEnv } from "../tests/support/qa-core.ts";
import { startStack, stopStack } from "../tests/support/stack.ts";

// For QA driving the app by hand: an isolated herdr-core seeded with the test world, and the
// backend on it, never the live core or files.
//
//   npm run build && npm run qa-core -- up [port]   start it (default port 7390); prints the URL
//   npm run qa-core -- seed                          reset the world
//   npm run qa-core -- down                          stop everything and delete its temp folder
//
// While up, `hc` reaches the QA core with the env printed by `up` (HC_SESSION, XDG_STATE_HOME).

const STATE = join(tmpdir(), "herdr-qa-current.json");

interface Saved {
  readonly dir: string;
  readonly session: string;
  readonly pid: number | undefined;
}

const load = (): Saved => JSON.parse(readFileSync(STATE, "utf8")) as Saved;

const [command, arg] = process.argv.slice(2);
if (command === "up") {
  const stack = await startStack(Number(arg ?? "7390"), "herdr-qa-manual", true);
  writeFileSync(STATE, JSON.stringify({ dir: stack.dir, session: "herdr-qa-manual", pid: stack.server.pid }));
  console.log(`herdr (QA) at ${stack.url}  (log in as ${QA_USER} / ${QA_PASSWORD})`);
  console.log(`hc env: HC_SESSION=${stack.core.env.HC_SESSION} XDG_STATE_HOME=${stack.core.env.XDG_STATE_HOME}`);
  console.log(`groups file: ${stack.core.env.HERDR_GROUPS_FILE}; backend log: ${stack.dir}/server.log`);
  process.exit(0);
} else if (command === "seed") {
  const saved = load();
  await seed(new QaCore(qaEnv(saved.dir, saved.session)));
} else if (command === "down") {
  const saved = load();
  await stopStack(saved.dir, saved.session, saved.pid);
} else {
  console.error("usage: qa-core up [port] | seed | down");
  process.exit(2);
}
