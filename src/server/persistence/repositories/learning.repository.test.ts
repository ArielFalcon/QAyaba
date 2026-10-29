import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getHistory } from "../index";
import type { RunOutcome } from "../../../types";

test("purging an app removes the scorecard row earlier runs left", () => {
  const app = "hist-scorecard-purge";
  getHistory(); /* opens the history database, and so creates its tables, before a second connection reads it */
  /* Nothing reads or writes a scorecard any more: the row is left by a second connection to the same on-disk db, as an earlier version of the engine left it. */
  const dbPath = process.env.HISTORY_DB_PATH ?? join(process.env.QAYABA_ROOT ?? process.cwd(), "data", "qayaba.db");
  const countRows = (): number => {
    const raw = new Database(dbPath);
    try {
      return (raw.prepare("SELECT COUNT(*) AS n FROM scorecard WHERE app = ?").get(app) as { n: number }).n;
    } finally {
      raw.close();
    }
  };
  const raw = new Database(dbPath);
  try {
    raw.prepare("INSERT INTO scorecard (app, data, updated_at) VALUES (?, ?, ?)").run(app, "{}", "2026-06-13T00:00:00.000Z");
  } finally {
    raw.close();
  }
  assert.equal(countRows(), 1);

  getHistory().purgeApp(app);
  assert.equal(countRows(), 0);
});

test("getRunOutcome returns the single run's outcome and round-trips the reviewer verdict", () => {
  const app = "value-report-app";
  getHistory().purgeApp(app); /* self-isolate: the history DB is a module-global singleton */
  try {
    const outcome: RunOutcome = {
      runId: "run-value-1", app, sha: "deadbeef0", mode: "diff", target: "e2e",
      verdict: "pass", errorClass: null,
      gateSignals: { static: true, coverageRatio: 0.82, reviewerCorrections: [], reviewerRationale: "covers the new validation branch", reviewerApproved: true, flaky: false, retries: 0 },
      at: "2026-06-13T00:00:00.000Z",
    };
    getHistory().learning.saveRunOutcome(outcome);

    const got = getHistory().learning.getRunOutcome("run-value-1");
    assert.ok(got, "expected an outcome for the known runId");
    assert.equal(got!.gateSignals.coverageRatio, 0.82);
    assert.equal(got!.gateSignals.reviewerApproved, true);
    assert.equal(got!.gateSignals.reviewerRationale, "covers the new validation branch");
    assert.equal(getHistory().learning.getRunOutcome("does-not-exist"), undefined);
  } finally {
    getHistory().purgeApp(app);
  }
});

test("a crash reclassifies the outcome the engine persisted, keeping the evidence it carried, and writes one where none was", () => {
  const app = "hist-crashed-class";
  try {
    const withEvidence = getHistory().runs.createRecord({ target: "e2e", app, sha: "abcdef1234", mode: "diff" });
    getHistory().learning.saveRunOutcome({
      runId: withEvidence.id, app, sha: "abcdef1234", mode: "diff", target: "e2e", verdict: "infra-error", errorClass: "E-INFRA",
      gateSignals: { static: false, coverageRatio: null, reviewerCorrections: [], flaky: false, retries: 0, contractDriftCount: 7 },
      at: "2026-10-19T00:00:00.000Z",
    });

    getHistory().learning.saveCrashedRunOutcome(getHistory().runs.getRecord(withEvidence.id)!, "internal-error");
    const reclassified = getHistory().learning.getRunOutcome(withEvidence.id)!;
    assert.equal(reclassified.errorClass, "internal-error");
    assert.equal(reclassified.verdict, "infra-error");
    assert.equal(reclassified.gateSignals.contractDriftCount, 7, "the evidence the engine kept is not replaced with a bare row");

    const bare = getHistory().runs.createRecord({ target: "e2e", app, sha: "abcdef1234", mode: "diff" });
    getHistory().learning.saveCrashedRunOutcome(getHistory().runs.getRecord(bare.id)!, "internal-error");
    assert.equal(getHistory().learning.getRunOutcome(bare.id)?.verdict, "infra-error");
    assert.equal(getHistory().learning.getRunOutcome(bare.id)?.errorClass, "internal-error");
  } finally {
    getHistory().purgeApp(app);
  }
});