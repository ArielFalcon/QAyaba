import type Database from "better-sqlite3";
import type { Migration } from "./index";

/*
 * Schema 7: what runs read of DEV, one row per page read and lesson kind (docs/architecture/rfc/0013-learning-slice.md). Append-only: a run
 * adds its rows and nothing ever updates or removes one except purging the whole app. A lesson is derived from the admitted rows when it is
 * read and is never stored. `scope` is the captured route address, or the template of the map when the page came from one; `fact` holds the
 * read (result count, empty state confirmed, readiness); `left_out_reason` is null for an admitted row. Nothing existing is rewritten or dropped.
 */
export const migration0007: Migration = {
  version: 7,
  name: "0007-lesson-observations",
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE lesson_observations (
        id TEXT PRIMARY KEY,
        app TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sha TEXT NOT NULL,
        repo TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        served_state TEXT NOT NULL,
        admitted INTEGER NOT NULL CHECK (admitted IN (0, 1)),
        left_out_reason TEXT,
        fact TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX idx_lesson_observations_scope ON lesson_observations(app, kind, scope);
    `);
  },
};
