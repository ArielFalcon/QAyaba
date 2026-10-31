import type Database from "better-sqlite3";
import type { Migration } from "./index";

/*
 * Schema 5: the status each case's test declared before it ran (passed, failed for `test.fail()`, skipped for a refused skip), so a stored
 * case says what its pass was a pass of. NULL means the case recorded none (a case written before): it reads back as unknown, never as
 * passing, and no stored row is rewritten.
 */
export const migration0005: Migration = {
  version: 5,
  name: "0005-case-expected-status",
  up(db: Database.Database): void {
    db.exec("ALTER TABLE cases ADD COLUMN expected_status TEXT");
  },
};
