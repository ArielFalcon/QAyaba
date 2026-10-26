/* buildCoordination: the ledger is always served; the lead and sidekicks only for an e2e run that was given a place for their workspaces. */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { resetSharedCoordinationTelemetryForTests } from "@contexts/coordination/infrastructure/adapters/coordination-telemetry-port.adapter.ts";
import { buildCoordination, type CoordinationDeps } from "@contexts/coordination/composition/build-coordination.ts";

afterEach(() => resetSharedCoordinationTelemetryForTests());

function deps(over: Partial<CoordinationDeps> = {}): CoordinationDeps {
  return {
    isCode: false,
    runtime: { openSession: async () => { throw new Error("unused"); } },
    redaction: new PatternRedactionAdapter(),
    specFileFor: (flowId) => `e2e/flows/${flowId}.spec.ts`,
    ...over,
  };
}

const delegation = { workspaceRoot: "/mirrors/.qa-delegations", sidekickProvider: () => undefined, plannerProvider: () => undefined };

test("a run with no delegation is served the ledger and authored by its lead alone", () => {
  const api = buildCoordination(deps());

  assert.ok(api.coordinationTelemetry);
  assert.equal(api.leadSidekicks, undefined);
  assert.equal(api.sidekickProvider, undefined);
});

test("an e2e run with a place for the workspaces gets the lead and the providers it reads", () => {
  const api = buildCoordination(deps({ delegation }));

  assert.ok(api.leadSidekicks);
  assert.equal(api.sidekickProvider, delegation.sidekickProvider);
  assert.equal(api.plannerProvider, delegation.plannerProvider);
});

test("a code run never coordinates, whatever the shell offers", () => {
  const api = buildCoordination(deps({ isCode: true, delegation }));

  assert.ok(api.coordinationTelemetry);
  assert.equal(api.leadSidekicks, undefined);
});

test("the ledger is one per process, so decisions outlive a run", () => {
  assert.equal(buildCoordination(deps()).coordinationTelemetry, buildCoordination(deps()).coordinationTelemetry);
});
