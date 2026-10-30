import type Database from "better-sqlite3";
import type { Migration } from "./index";

/*
 * Schema 4: the version of the engine that ran each run, so runs read as a timeline of code changes. NULL means the run recorded none
 * (a run written before, or one whose process could not tell its revision); no stored value is rewritten.
 */
export const migration0004: Migration = {
  version: 4,
  name: "0004-run-engine-version",
  up(db: Database.Database): void {
    db.exec("ALTER TABLE runs ADD COLUMN engine_version TEXT");
  },
};
