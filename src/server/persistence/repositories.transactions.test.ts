import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHistoryDatabase } from "./database";
import { createHistory } from "./index";

/* Every mutating method of a repository writes inside a transaction: the statements SQLite runs, recorded with the transaction flag. */
function instrumented(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "history-tx-"));
  const writes: Array<{ sql: string; inTransaction: boolean }> = [];
  const db = openHistoryDatabase(join(dir, "history.db"), {
    onStatement: (sql, inTransaction) => {
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) writes.push({ sql, inTransaction });
    },
  });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { history: createHistory(db), writes };
}

test("the context repository writes only inside transactions", (t) => {
  const { history, writes } = instrumented(t);
  history.contexts.markContextStale("app");
  history.contexts.clearContextStale("app");
  history.contexts.recordContextHealRequest("app");
  history.contexts.saveContextMap("app", "abcdef1", { builtAtSha: "abcdef1", routes: [], api: [], feBe: [] });

  assert.equal(writes.length, 4);
  assert.deepEqual(writes.filter((w) => !w.inTransaction), []);
});

test("the judge repository writes only inside transactions", (t) => {
  const { history, writes } = instrumented(t);
  history.judges.insertJudgeAttempt({ runId: "r", judge: "j", promptVersion: "v1", model: null, outcome: "scored", tokens: 1, detail: null, at: "2026-10-01T00:00:00.000Z" });
  history.judges.insertJudgeCalibration({
    judge: "j", promptVersion: "v1", model: "m", trainN: 1, devN: 1, testN: 1, tpr: null, tnr: null, agreement: null, status: "ok", report: "{}", computedAt: "2026-10-01T00:00:00.000Z",
  });

  assert.equal(writes.length, 2);
  assert.deepEqual(writes.filter((w) => !w.inTransaction), []);
});
