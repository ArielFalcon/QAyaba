import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteRunHistoryAdapter } from "./run-history-sqlite-adapter";
import { getHistory } from "./persistence/index";
import type { RunOutcome as KernelRunOutcome } from "@kernel/run-outcome.ts";
import type { RunOutcome as StoredRunOutcome } from "../types";

function kernelOutcome(overrides: Partial<KernelRunOutcome> = {}): KernelRunOutcome {
  return {
    runId: "run-1",
    app: "demo",
    sha: "abc1234",
    mode: "diff",
    target: "e2e",
    verdict: "pass",
    errorClass: null,
    gateSignals: {
      static: true,
      coverageRatio: 0.85,
      reviewerCorrections: [],
      flaky: false,
      retries: 0,
    },
    at: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

/* The adapter's core contract: save() reaches the injected saveOutcome fn, not the real
   module-singleton SQLite DB (dependency injection is the testing strategy, AGENTS.md).
 */
test("SqliteRunHistoryAdapter.save() delegates to the injected saveOutcome", async () => {
  let captured: StoredRunOutcome | undefined;
  const adapter = new SqliteRunHistoryAdapter({ saveOutcome: (o) => { captured = o; } });

  await adapter.save(kernelOutcome());

  assert.ok(captured, "saveOutcome must have been called");
  assert.equal(captured!.runId, "run-1");
  assert.equal(captured!.app, "demo");
  assert.equal(captured!.sha, "abc1234");
  assert.equal(captured!.mode, "diff");
  assert.equal(captured!.target, "e2e");
  assert.equal(captured!.verdict, "pass");
  assert.equal(captured!.gateSignals.coverageRatio, 0.85);
  assert.equal(captured!.at, "2026-07-02T00:00:00.000Z");
});

test("SqliteRunHistoryAdapter uses the real saveRunOutcome by default (no explicit deps)", () => {
  /* Construction alone must not touch the DB (saveRunOutcome is only called from save()). */
  const adapter = new SqliteRunHistoryAdapter();
  assert.ok(adapter, "constructs without touching the DB (lazy init, lazily opened history)");
});

/* ── the real store ─────────────────────────────────────────────────────────────────────────── */

test("an outcome saved through the adapter reads back from the history store with its signals, and the run's note, cases and logs are not stored", async () => {
  const app = "hist-adapter-roundtrip";
  getHistory().purgeApp(app);
  try {
    await new SqliteRunHistoryAdapter().save(kernelOutcome({
      runId: "run-adapter-roundtrip",
      app,
      errorClass: "E-EXEC-FAIL",
      note: "a note the run record holds",
      cases: [{ name: "c1", status: "fail" }],
      logs: "a log line",
      gateSignals: { static: true, coverageRatio: 0.7, reviewerCorrections: ["missing assertion"], reviewerApproved: true, flaky: false, retries: 2, phaseTimings: { generate: 1200 }, contractDriftCount: 0 },
    }));

    const stored = getHistory().learning.getRunOutcome("run-adapter-roundtrip")!;
    assert.equal(stored.errorClass, "E-EXEC-FAIL");
    assert.equal(stored.gateSignals.coverageRatio, 0.7);
    assert.deepEqual(stored.gateSignals.reviewerCorrections, ["missing assertion"]);
    assert.equal(stored.gateSignals.reviewerApproved, true);
    assert.equal(stored.gateSignals.retries, 2);
    assert.deepEqual(stored.gateSignals.phaseTimings, { generate: 1200 });
    assert.equal(stored.gateSignals.contractDriftCount, 0, "a genuine 0 round-trips as 0");
    assert.equal("note" in stored, false);
    assert.equal("cases" in stored, false);
    assert.equal("logs" in stored, false);
  } finally {
    getHistory().purgeApp(app);
  }
});
