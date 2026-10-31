import { test } from "node:test";
import assert from "node:assert/strict";
import { historyPhaseHistory, phaseRecordOf } from "./phase-history";

test("a stored row keeps the phases the engine knows and drops a phase name or a figure it cannot read", () => {
  assert.deepEqual(
    phaseRecordOf({ furthestPhase: "learn", phaseTimings: { generate: 1_000, review: 250, nonsense: 5, execute: -3, decide: Number.NaN } }),
    { furthestPhase: "learn", phaseTimings: { generate: 1_000, review: 250 } },
  );
  assert.equal(phaseRecordOf({ furthestPhase: "nonsense", phaseTimings: {} }).furthestPhase, null);
  assert.equal(phaseRecordOf({ furthestPhase: null, phaseTimings: {} }).furthestPhase, null);
});

test("the history port asks for the app, kind of run and limit it is given and returns the checked rows", async () => {
  const asked: unknown[] = [];
  const port = historyPhaseHistory((app, budget, limit) => (asked.push({ app, budget, limit }), [{ furthestPhase: "publish", phaseTimings: { decide: 4 } }]));
  assert.deepEqual(await port.recentPhaseRecords({ app: "shop", budget: "diff", limit: 20 }), [{ furthestPhase: "publish", phaseTimings: { decide: 4 } }]);
  assert.deepEqual(asked, [{ app: "shop", budget: "diff", limit: 20 }]);
});

test("the purposes a run's deadline cut are kept when the engine knows them and dropped when it does not", () => {
  assert.deepEqual(phaseRecordOf({ furthestPhase: "learn", phaseTimings: {}, cutPurposes: ["review", "nonsense"] }).cutPurposes, ["review"]);
  assert.equal("cutPurposes" in phaseRecordOf({ furthestPhase: "learn", phaseTimings: {}, cutPurposes: [] }), false);
});
