/* A run's plan: kept per run in the history, sanitized, the last record winning, pruned with the spec snapshots, and never in the way of the run. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizedPlanSnapshots, type PlanSnapshot } from "@kernel/ports/plan-snapshot.port";
import { SqlitePlanSnapshotAdapter } from "./plan-snapshot-sqlite.adapter";
import { createRecord, getRunPlan } from "./history";
import { getHistoryDatabase } from "./persistence/index";
import { pruneRunPlans } from "./persistence/retention";

const SECRET = "s3cr3t-account-pass-value";

function snapshot(runId: string, over: Partial<PlanSnapshot> = {}): PlanSnapshot {
  return {
    runId,
    kind: "fanout",
    changeRoutes: ["/cart"],
    unvisited: [],
    candidates: [{ id: "uc-1", tier: "direct", reachability: "page", state: "dropped", reason: `no test ${SECRET}` }],
    flows: [{ id: "cart", objective: `the cart ${SECRET}`, acceptance: [`total ${SECRET}`], routes: ["/cart"], specFile: "flows/cart.spec.ts", visits: ["/cart"], candidates: [{ id: "uc-1", claimed: "covered" }], outcome: { kind: "failed", reason: `crashed ${SECRET}` } }],
    recordedAt: Date.now(),
    ...over,
  };
}

test("a run keeps its last plan, with every text the lead wrote sanitized", () => {
  const port = sanitizedPlanSnapshots(new SqlitePlanSnapshotAdapter(), (text) => text.replaceAll(SECRET, "[redacted]"));
  port.record(snapshot("plan-run-1", { flows: [] }));
  port.record(snapshot("plan-run-1"));
  const kept = JSON.parse(getRunPlan("plan-run-1")!) as PlanSnapshot;
  assert.equal(kept.flows.length, 1);
  assert.equal(kept.flows[0]!.objective, "the cart [redacted]");
  assert.deepEqual(kept.flows[0]!.acceptance, ["total [redacted]"]);
  assert.equal(kept.flows[0]!.outcome?.reason, "crashed [redacted]");
  assert.equal(kept.candidates[0]!.reason, "no test [redacted]");
  assert.equal(JSON.stringify(kept).includes(SECRET), false);
  assert.equal(getRunPlan("plan-run-never"), undefined);
});

test("a plan that cannot be stored does not fail the run", () => {
  const adapter = new SqlitePlanSnapshotAdapter(() => { throw new Error("disk full"); });
  assert.doesNotThrow(() => adapter.record(snapshot("plan-run-2")));
});

test("plans of a campaign run inside the campaign window survive the ordinary one, and go past it", () => {
  const day = 24 * 60 * 60 * 1000;
  const campaign = createRecord({ target: "e2e", app: "plan-retention", sha: "abcdef1234", mode: "diff", campaign: { id: "plan-camp", variant: {}, replicate: 1 } });
  const ordinary = createRecord({ target: "e2e", app: "plan-retention", sha: "abcdef1234", mode: "diff" });
  const adapter = new SqlitePlanSnapshotAdapter();
  const early = Date.now() + 100 * day;
  adapter.record(snapshot(campaign.id, { recordedAt: early - 40 * day }));
  adapter.record(snapshot(ordinary.id, { recordedAt: early - 40 * day }));
  pruneRunPlans(getHistoryDatabase(), 30, early, 100, 180);
  assert.notEqual(getRunPlan(campaign.id), undefined);
  assert.equal(getRunPlan(ordinary.id), undefined);
  const late = Date.now() + 200 * day;
  pruneRunPlans(getHistoryDatabase(), 30, late, 100, 180);
  assert.equal(getRunPlan(campaign.id), undefined);
});
