import { join } from "node:path";
import { qayabaDataDir } from "../../paths";
import { openHistoryDatabase, type HistoryDatabase } from "./database";

let shared: HistoryDatabase | undefined;

/*
 * The process's history database, opened and migrated on first use at HISTORY_DB_PATH (default `<data>/qayaba.db`). Opening never
 * prunes: retention is `pruneHistory`, run by the caller.
 */
export function getHistoryDatabase(): HistoryDatabase {
  shared ??= openHistoryDatabase(process.env.HISTORY_DB_PATH ?? join(qayabaDataDir(), "qayaba.db"));
  return shared;
}
