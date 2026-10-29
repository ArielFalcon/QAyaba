/* buildCoordination: the ledger is always served; the lead and sidekicks only for a run that was given a place for their workspaces. */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { resetSharedCoordinationTelemetryForTests } from "@contexts/coordination/infrastructure/adapters/coordination-telemetry-port.adapter.ts";
import { buildCoordination, type CoordinationDeps } from "@contexts/coordination/composition/build-coordination.ts";

describe("buildCoordination", () => {
  afterEach(() => resetSharedCoordinationTelemetryForTests());

  function deps(over: Partial<CoordinationDeps> = {}): CoordinationDeps {
    return {
      runtime: { openSession: async () => { throw new Error("unused"); } },
      redaction: new PatternRedactionAdapter(),
      specFileFor: (flowId) => `e2e/flows/${flowId}.spec.ts`,
      ...over,
    };
  }

  const delegation = { workspaceRoot: "/mirrors/.qa-delegations" };

  test("a run with no delegation is served the ledger and authored by its lead alone", () => {
    const api = buildCoordination(deps());

    assert.ok(api.coordinationTelemetry);
    assert.equal(api.leadSidekicks, undefined);
  });

  test("a run with a place for the workspaces gets the lead", () => {
    const api = buildCoordination(deps({ delegation }));

    assert.ok(api.leadSidekicks);
  });

  test("the ledger is one per process, so decisions outlive a run", () => {
    assert.equal(buildCoordination(deps()).coordinationTelemetry, buildCoordination(deps()).coordinationTelemetry);
  });
});
