import type Database from "better-sqlite3";
import type { Migration } from "./index";

/*
 * Schema 6: the kind of run each run was bounded as (the row of the run time budget it was armed with: diff, manual or context; rows
 * stored under the former per-size labels diff-tiny, diff-focused and diff-broad are read as diff). A later run reads the phases of runs
 * of its own kind to know what the phases after the one asking will need. NULL means the run recorded none (a run written before, or one
 * that ended before its deadline was armed); no stored value is rewritten, and the reader takes such a run for its mode's kind.
 */
export const migration0006: Migration = {
  version: 6,
  name: "0006-run-time-budget",
  up(db: Database.Database): void {
    db.exec("ALTER TABLE runs ADD COLUMN time_budget TEXT");
  },
};
