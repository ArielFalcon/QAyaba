import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRecords } from "./history";

/* Without HISTORY_DB_PATH the store lives at <QAYABA_ROOT>/data/qayaba.db. The store resolves its
   location on first use, so this file (its own process) sets both variables before any history call. */
const root = mkdtempSync(join(tmpdir(), "qayaba-history-default-root-"));
delete process.env.HISTORY_DB_PATH;
process.env.QAYABA_ROOT = root;
after(() => rmSync(root, { recursive: true, force: true }));

test("without HISTORY_DB_PATH the history store opens under the root's data dir", () => {
  listRecords("history-default-location-app", 1);

  assert.equal(existsSync(join(root, "data", "qayaba.db")), true);
});
