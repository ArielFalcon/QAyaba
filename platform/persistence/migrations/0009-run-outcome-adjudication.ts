import type Database from "better-sqlite3";
import type { Migration } from "./index";

/*
 * Schema 9: what the fix loop's adjudicator concluded about the failing run (its class, confidence, action and the reason as the record
 * keeps it), as JSON, so a stored run says whether a failure was classified as the app's defect and on what confidence. NULL means the
 * run recorded none (it never reached adjudication, or it was written before): it reads back as no adjudication and no stored value is
 * rewritten. The operator copies the history file before the first boot of a build that holds this migration, since an earlier build
 * refuses schema 9.
 */
export const migration0009: Migration = {
  version: 9,
  name: "0009-run-outcome-adjudication",
  up(db: Database.Database): void {
    db.exec("ALTER TABLE run_outcomes ADD COLUMN adjudication TEXT");
  },
};
