import type Database from "better-sqlite3";
import type { Migration } from "./index";

/*
 * Schema 3: the facts of how a run ended that its record never held. `limits` and `degradations` are JSON lists (every limit that
 * fired and every fault the run went on past; an empty list means the run recorded none, NULL that it recorded nothing about them),
 * and `shadowed` says that shadow replaced the run's decision. A run written before reads all three as unknown (NULL) and no stored
 * value is rewritten: the reader (RunRepository.getRunFacts) names a stored decision of "shadow-log" as no decision with `shadowed` true.
 */
export const migration0003: Migration = {
  version: 3,
  name: "0003-run-ending-facts",
  up(db: Database.Database): void {
    db.exec("ALTER TABLE runs ADD COLUMN limits TEXT");
    db.exec("ALTER TABLE runs ADD COLUMN degradations TEXT");
    db.exec("ALTER TABLE runs ADD COLUMN shadowed INTEGER");
  },
};
