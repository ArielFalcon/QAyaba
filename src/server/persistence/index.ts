import { join } from "node:path";
import { qayabaDataDir } from "../../paths";
import { openHistoryDatabase, type HistoryDatabase } from "./database";
import { ContextRepository } from "./repositories/context.repository";
import { EvaluationRepository } from "./repositories/evaluation.repository";
import { JudgeRepository } from "./repositories/judge.repository";
import { LearningRepository } from "./repositories/learning.repository";
import { TelemetryRepository } from "./repositories/telemetry.repository";

let shared: HistoryDatabase | undefined;
let history: History | undefined;

/* The repositories over one history database, one per aggregate. */
export interface History {
  readonly contexts: ContextRepository;
  readonly judges: JudgeRepository;
  readonly evaluations: EvaluationRepository;
  readonly learning: LearningRepository;
  readonly telemetry: TelemetryRepository;
}

/* The repositories over `db`, their statements prepared once. */
export function createHistory(db: HistoryDatabase): History {
  return { contexts: new ContextRepository(db), judges: new JudgeRepository(db), evaluations: new EvaluationRepository(db), learning: new LearningRepository(db), telemetry: new TelemetryRepository(db) };
}

/*
 * The process's history database, opened and migrated on first use at HISTORY_DB_PATH (default `<data>/qayaba.db`). Opening never
 * prunes: retention is `pruneHistory`, run by the caller.
 */
export function getHistoryDatabase(): HistoryDatabase {
  shared ??= openHistoryDatabase(process.env.HISTORY_DB_PATH ?? join(qayabaDataDir(), "qayaba.db"));
  return shared;
}

/* The process's repositories, built on first use over `getHistoryDatabase()`. */
export function getHistory(): History {
  history ??= createHistory(getHistoryDatabase());
  return history;
}
