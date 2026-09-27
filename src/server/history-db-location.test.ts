import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRecords } from "./history";

/* The history store opens lazily on first use and resolves its location then, so this file (its own
   process) points HISTORY_DB_PATH into a directory that does not exist yet, and QAYABA_ROOT at an
   empty directory, before the first history call. */
const root = mkdtempSync(join(tmpdir(), "qayaba-history-root-"));
const dbParent = mkdtempSync(join(tmpdir(), "qayaba-history-db-"));
const dbPath = join(dbParent, "volume", "history.db");
process.env.QAYABA_ROOT = root;
process.env.HISTORY_DB_PATH = dbPath;
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dbParent, { recursive: true, force: true });
});

test("the history store opens at HISTORY_DB_PATH, creating its directory, and leaves the root's data dir alone", () => {
  listRecords("history-location-app", 1);

  assert.equal(existsSync(dbPath), true);
  assert.equal(existsSync(join(root, "data")), false);
});
