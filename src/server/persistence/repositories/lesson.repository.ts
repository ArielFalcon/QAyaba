import type { LeftOutReason, LessonKindId, LessonObservation, ObservedFact } from "@contexts/cross-run-learning/application/index";
import type { ServedVersionState } from "@kernel/served-version";
import type { HistoryDatabase } from "../database";
import { parseJsonColumn } from "../json-column";

/* What runs read of DEV: lesson_observations (append-only). A row is written once with its run; nothing updates or deletes one except purging the app. */
export class LessonRepository {
  private readonly insert;

  constructor(private readonly db: HistoryDatabase) {
    this.insert = db.raw.prepare(`
      INSERT INTO lesson_observations (id, app, run_id, sha, repo, kind, scope, served_state, admitted, left_out_reason, fact, at)
      VALUES (@id, @app, @runId, @sha, @repo, @kind, @scope, @servedState, @admitted, @leftOutReason, @fact, @at)
    `);
  }

  /* Removes an app's observations with the rest of what its runs left. */
  deleteApp(app: string): void {
    this.db.write(() => this.db.statement("DELETE FROM lesson_observations WHERE app = ?").run(app));
  }

  /* Appends the rows of one run in one transaction: all of them or none. */
  record(rows: readonly LessonObservation[]): void {
    this.db.write(() => {
      for (const o of rows) {
        this.insert.run({ id: o.id, app: o.app, runId: o.runId, sha: o.sha, repo: o.repo, kind: o.kind, scope: o.scope, servedState: o.servedState, admitted: o.admitted ? 1 : 0, leftOutReason: o.leftOutReason, fact: JSON.stringify(o.fact), at: o.at });
      }
    });
  }

  /* The admitted rows of an app, of the given kinds, for the given scopes written strictly before `before`, in a fixed order (time, then id). The app, kind and scope are the index's columns. */
  listAdmitted(query: { app: string; kinds: readonly LessonKindId[]; scopes: readonly string[]; before: string }): LessonObservation[] {
    if (query.kinds.length === 0 || query.scopes.length === 0) return [];
    const kindMarks = query.kinds.map(() => "?").join(", ");
    const scopeMarks = query.scopes.map(() => "?").join(", ");
    const sql = `SELECT * FROM lesson_observations WHERE app = ? AND kind IN (${kindMarks}) AND scope IN (${scopeMarks}) AND admitted = 1 AND at < ? ORDER BY at ASC, id ASC`;
    return (this.db.read((raw) => raw.prepare(sql).all(query.app, ...query.kinds, ...query.scopes, query.before)) as Array<Record<string, unknown>>).map(rowToObservation);
  }

  /* How many rows an app holds, by whether they are inputs to a lesson. */
  countByApp(app: string): { admitted: number; leftOut: number } {
    const rows = this.db.read((raw) => raw.prepare("SELECT admitted, COUNT(*) AS n FROM lesson_observations WHERE app = ? GROUP BY admitted").all(app)) as Array<{ admitted: number; n: number }>;
    return { admitted: rows.find((r) => r.admitted === 1)?.n ?? 0, leftOut: rows.find((r) => r.admitted === 0)?.n ?? 0 };
  }
}

function rowToObservation(row: Record<string, unknown>): LessonObservation {
  const id = row.id as string;
  return {
    id,
    app: row.app as string,
    runId: row.run_id as string,
    sha: row.sha as string,
    repo: row.repo as string,
    kind: row.kind as LessonKindId,
    scope: row.scope as string,
    servedState: row.served_state as ServedVersionState,
    admitted: row.admitted === 1,
    leftOutReason: (row.left_out_reason as LeftOutReason | null) ?? null,
    fact: parseJsonColumn(row.fact as string, {} as ObservedFact, { table: "lesson_observations", column: "fact", id }),
    at: row.at as string,
  };
}
