import type Database from "better-sqlite3";
import type { Migration } from "./index";

/*
 * Schema 8: drops the storage no code reads since lessons became derived (docs/architecture/rfc/0013-learning-slice.md, U5): the
 * `learning_rules`, `curriculum` and `scorecard` tables and the `rules_retrieved` and `reflection` columns of `run_outcomes`. Nothing
 * writes or reads them; a lesson is derived from `lesson_observations`. Every other row and column is left as it was. The operator copies
 * the history file before the first boot of a build that holds this migration, since an earlier build refuses schema 8.
 */
export const migration0008: Migration = {
  version: 8,
  name: "0008-drop-dead-learning-tables",
  up(db: Database.Database): void {
    db.exec(`
      DROP TABLE IF EXISTS learning_rules;
      DROP TABLE IF EXISTS curriculum;
      DROP TABLE IF EXISTS scorecard;
      ALTER TABLE run_outcomes DROP COLUMN rules_retrieved;
      ALTER TABLE run_outcomes DROP COLUMN reflection;
    `);
  },
};
