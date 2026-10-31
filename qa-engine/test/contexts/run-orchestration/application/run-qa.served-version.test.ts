/* The run records what DEV served relative to the commit under test: one state of a closed set on every run, on the persisted record and on the gate phase's span, and the gate waits only for a deploy that has not landed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ok, err } from "@kernel/result.ts";
import { InfraError } from "@kernel/domain-error.ts";
import { DeployNotServedError, SERVED_VERSION_STATES, type ServedVersionFact, type ServedVersionState } from "@kernel/served-version.ts";
import type { DeployGatePort } from "@kernel/ports/deploy-gate.port.ts";
import type { TriggerSource } from "@kernel/run-mode.ts";
import { Sha } from "@kernel/sha.ts";
import { ChangeSet } from "@contexts/change-analysis/application/index.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { SpanHandle, StartSpanOptions } from "@kernel/telemetry/telemetry.port.ts";
import { dispose, newRig, observe, type Observed, type Rig } from "./run-flow/run-end-rig.ts";

class SpanLog extends NoopTelemetry {
  readonly spans: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  override startSpan(name: string, opts?: StartSpanOptions): SpanHandle {
    const record = { name, attrs: { ...(opts?.attrs ?? {}) } };
    this.spans.push(record);
    return {
      setAttrs: (attrs) => { Object.assign(record.attrs, attrs); },
      addEvent: () => {},
      recordError: () => {},
      end: () => {},
      context: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16) }),
    };
  }
}

interface Asked { sha: string; source: TriggerSource }

async function runWith(source: TriggerSource, gate: ((asked: Asked[]) => DeployGatePort) | "absent"): Promise<{ observed: Observed; asked: Asked[]; telemetry: SpanLog }> {
  const rig: Rig = newRig();
  try {
    const asked: Asked[] = [];
    const telemetry = new SpanLog();
    rig.input = { source };
    rig.extra = { telemetry, ...(gate === "absent" ? { deployGate: undefined } : { deployGate: gate(asked) }) };
    return { observed: await observe(rig, "served-version"), asked, telemetry };
  } finally {
    dispose(rig);
  }
}

const gateAnswering = (fact: ServedVersionFact) => (asked: Asked[]): DeployGatePort => ({
  verifyServed: async (sha, run) => { asked.push({ sha: sha.toString(), source: run.source }); return ok(fact); },
  waitUntilHealthy: async () => ok(true),
});

const recorded = (observed: Observed) => observed.saved.at(-1)!.gateSignals.servedVersion;

test("the closed set of served-version states is the six the record names", () => {
  assert.deepEqual([...SERVED_VERSION_STATES], ["undeclared", "unreadable", "equal", "behind", "ahead", "unrelated"]);
});

test("a run whose app declares no source ends with undeclared on its record, and the run goes on", async () => {
  const { observed, telemetry } = await runWith("webhook", "absent");
  assert.equal(observed.result?.decision.verdict, "pass");
  assert.deepEqual(recorded(observed), { state: "undeclared" });
  const gate = telemetry.spans.find((s) => s.name === "qayaba.phase.gate");
  assert.equal(gate?.attrs["qayaba.served_version.state"], "undeclared");
});

test("a declared source that cannot be read is recorded unreadable with its reason, and the run goes on", async () => {
  const { observed, telemetry } = await runWith("webhook", gateAnswering({ state: "unreadable", reason: "malformed-body" }));
  assert.equal(observed.result?.decision.verdict, "pass");
  assert.deepEqual(recorded(observed), { state: "unreadable", reason: "malformed-body" });
  const gate = telemetry.spans.find((s) => s.name === "qayaba.phase.gate");
  assert.equal(gate?.attrs["qayaba.served_version.state"], "unreadable");
  assert.equal(gate?.attrs["qayaba.served_version.reason"], "malformed-body");
});

for (const state of ["equal", "behind", "ahead", "unrelated"] as const satisfies readonly ServedVersionState[]) {
  test(`a run that read ${state} records it with the commit DEV served, and the run goes on`, async () => {
    const { observed, telemetry } = await runWith("webhook", gateAnswering({ state, served: "1111111" }));
    assert.equal(observed.result?.decision.verdict, "pass");
    assert.deepEqual(recorded(observed), { state, served: "1111111" });
    assert.equal(telemetry.spans.find((s) => s.name === "qayaba.phase.gate")?.attrs["qayaba.served_version.state"], state);
  });
}

test("the gate is told whether the run is deploy-triggered, and the commit under test", async () => {
  const webhook = await runWith("webhook", gateAnswering({ state: "equal" }));
  assert.deepEqual(webhook.asked, [{ sha: "abc1234", source: "webhook" }]);
  const manual = await runWith("manual", gateAnswering({ state: "equal" }));
  assert.deepEqual(manual.asked, [{ sha: "abc1234", source: "manual" }]);
});

test("a deploy that never lands ends the run at the gate as before, and the behind fact is on the gate phase's span", async () => {
  const { observed, telemetry } = await runWith("webhook", () => ({
    verifyServed: async () => err(new DeployNotServedError("DEV did not serve sha abc1234 within 60000ms (versionUrl=https://dev/version)", { state: "behind", served: "1111111", waitedMs: 60000 })),
    waitUntilHealthy: async () => ok(true),
  }));
  assert.equal(observed.result?.decision.verdict, "infra-error");
  assert.match(observed.result?.note ?? "", /DEV did not serve sha abc1234 within 60000ms/);
  assert.equal(observed.saved.length, 0, "this end saves no outcome, as before");
  const gate = telemetry.spans.find((s) => s.name === "qayaba.phase.gate");
  assert.equal(gate?.attrs["qayaba.served_version.state"], "behind");
  assert.equal(gate?.attrs["qayaba.served_version.waited_ms"], 60000);
});

test("a source that is read and reports DEV unhealthy still ends the run at the gate as before, after the fact is recorded", async () => {
  const { observed, telemetry } = await runWith("manual", () => ({
    verifyServed: async () => ok({ state: "equal", served: "abc1234" }),
    waitUntilHealthy: async () => err(new InfraError("DEV did not report healthy within 60000ms (versionUrl=https://dev/version)")),
  }));
  assert.equal(observed.result?.decision.verdict, "infra-error");
  assert.match(observed.result?.note ?? "", /did not report healthy/);
  assert.equal(telemetry.spans.find((s) => s.name === "qayaba.phase.gate")?.attrs["qayaba.served_version.state"], "equal");
});

test("a run over several repos records the anchor's state and each other repo's, an undeclared repo included", async () => {
  const rig = newRig();
  try {
    const FRONT = Sha.of("f111111");
    const BACK = Sha.of("b222222");
    rig.input = { source: "webhook", sha: FRONT, changeSet: ChangeSet.of("demo", [{ repo: "org/back", role: "service", headSha: BACK }, { repo: "org/front", role: "primary", headSha: FRONT }]) };
    const answering = (fact: ServedVersionFact): DeployGatePort => ({ verifyServed: async () => ok(fact), waitUntilHealthy: async () => ok(true) });
    rig.extra = {
      deployGate: answering({ state: "equal", served: "f111111" }),
      companionDeployGates: new Map([["org/back", answering({ state: "behind", served: "a000000" })]]),
    };
    const observed = await observe(rig, "served-version-two-repos");
    assert.deepEqual(recorded(observed), { state: "equal", served: "f111111", companions: [{ repo: "org/back", state: "behind", served: "a000000" }] });
  } finally {
    dispose(rig);
  }
});
