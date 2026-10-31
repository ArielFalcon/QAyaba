import type Database from "better-sqlite3";
import type { Migration } from "./index";

/* Schema 2: a turn that ended without an answer keeps what it had streamed (`agent_turns.partial_text`); rows written before it read as unknown (NULL). */
export const migration0002: Migration = {
  version: 2,
  name: "0002-agent-turn-partial-text",
  up(db: Database.Database): void {
    db.exec("ALTER TABLE agent_turns ADD COLUMN partial_text TEXT");
  },
};
