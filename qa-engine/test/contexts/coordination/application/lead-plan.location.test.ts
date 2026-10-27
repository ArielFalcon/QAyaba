import { test } from "node:test";
import assert from "node:assert/strict";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { admitLeadPlan, LEAD_PLAN_KIND, type AdmittedFlow, type AdmittedPlan } from "@contexts/coordination/application/lead-plan.ts";

const BARCELONA = { latitude: 41.3874, longitude: 2.1686 };
const MADRID = { latitude: 40.4168, longitude: -3.7038 };

const deps = {
  redaction: new PatternRedactionAdapter(),
  specRelDir: "e2e",
  specFileFor: (id: string) => `flows/${id}.spec.ts`,
  places: { barcelona: BARCELONA, madrid: MADRID },
};

const limits = { maxParallel: 3, flowBudgetMs: 600_000, remainingMs: 3_600_000, reserveMs: 600_000, minFlowMs: 60_000, runSpecPerCallMs: 120_000, runSpecDevWrites: 20, browserPerCallMs: 30_000 };

const flow = (id: string, location: unknown) => ({ id, objective: `check ${id}`, acceptance: [`${id} works`], routes: [`/${id}`], location });

function flows(plan: AdmittedPlan): AdmittedFlow[] {
  assert.equal(plan.kind, LEAD_PLAN_KIND.FANOUT);
  return plan.kind === LEAD_PLAN_KIND.FANOUT ? plan.flows : [];
}

test("a flow names a declared place or carries a point; the admitted flow keeps the coordinates", () => {
  const admitted = flows(admitLeadPlan({ kind: "fanout", flows: [flow("nearby", "Barcelona"), flow("empty", { latitude: 0, longitude: 0 })] }, limits, deps));
  assert.deepEqual(admitted[0]!.location, BARCELONA);
  assert.deepEqual(admitted[1]!.location, { latitude: 0, longitude: 0 });
});

test("an unknown place or an invalid point is dropped, and the flow inherits the lead's location", () => {
  const admitted = flows(admitLeadPlan({ kind: "fanout", flows: [flow("unknown", "atlantis"), flow("bad", { latitude: 100, longitude: 0 })] }, limits, deps));
  assert.equal(admitted[0]!.location, undefined);
  assert.equal(admitted[1]!.location, undefined);
});

test("the location never changes what a flow may write", () => {
  const admitted = flows(admitLeadPlan({ kind: "fanout", flows: [flow("nearby", "barcelona"), flow("empty", "barcelona")] }, limits, { ...deps, specRelDir: "e2e" }));
  assert.deepEqual(admitted[0]!.writablePaths, ["e2e/flows/nearby.spec.ts"]);
  assert.equal(admitted[0]!.specFile, "flows/nearby.spec.ts");
});

test("without declared places a named location is dropped, and a point still works", () => {
  const admitted = flows(
    admitLeadPlan(
      { kind: "fanout", flows: [flow("named", "barcelona"), flow("point", { latitude: 1, longitude: 2 })] },
      limits,
      { redaction: deps.redaction, specRelDir: "e2e", specFileFor: deps.specFileFor },
    ),
  );
  assert.equal(admitted[0]!.location, undefined);
  assert.deepEqual(admitted[1]!.location, { latitude: 1, longitude: 2 });
});
