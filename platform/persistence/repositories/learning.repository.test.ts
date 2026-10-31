import { test } from "node:test";
import assert from "node:assert/strict";
import { getHistory } from "../index";
import type { RunOutcome } from "../types";

test("purging an app empties its run outcomes and leaves another app's", () => {
  const app = "hist-outcome-purge";
  const other = "hist-outcome-keep";
  const outcome = (runId: string, of: string): RunOutcome => ({
    runId, app: of, sha: "deadbeef0", mode: "diff", target: "e2e", verdict: "pass", errorClass: null,
    gateSignals: { static: true, coverageRatio: null, reviewerCorrections: [], flaky: false, retries: 0 }, at: "2026-10-31T00:00:00.000Z",
  });
  try {
    getHistory().learning.saveRunOutcome(outcome("run-purge-1", app));
    getHistory().learning.saveRunOutcome(outcome("run-keep-1", other));
    getHistory().purgeApp(app);
    assert.deepEqual(getHistory().learning.listRunOutcomes(app), []);
    assert.deepEqual(getHistory().learning.listRunOutcomes(other).map((o) => o.runId), ["run-keep-1"]);
  } finally {
    getHistory().purgeApp(app);
    getHistory().purgeApp(other);
  }
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