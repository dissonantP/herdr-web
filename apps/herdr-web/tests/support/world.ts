import { qaEnv, QaCore } from "./qa-core.ts";

/** The QA core the global setup started, for tests that change it the way Desktop would. */
export function qaCore(): QaCore {
  const dir = process.env.HERDR_QA_DIR;
  const session = process.env.HERDR_QA_SESSION;
  if (dir === undefined || session === undefined) throw new Error("no QA stack: run through playwright");
  return new QaCore(qaEnv(dir, session));
}
