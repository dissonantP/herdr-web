import { rmSync } from "node:fs";
import { storageStatePath } from "./auth.ts";
import { stopStack } from "./stack.ts";

export default async function globalTeardown(): Promise<void> {
  rmSync(storageStatePath(), { force: true });
  const dir = process.env.HERDR_QA_DIR;
  const session = process.env.HERDR_QA_SESSION;
  if (dir === undefined || session === undefined) return;
  const pid = process.env.HERDR_QA_SERVER_PID;
  await stopStack(dir, session, pid === undefined ? undefined : Number(pid));
}
