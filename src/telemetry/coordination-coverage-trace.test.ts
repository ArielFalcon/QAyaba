/* The coordination ledger and the change-coverage measurement as spans of the phase that is open, over the real telemetry adapter. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TracedCoordinationTelemetry } from "../../qa-engine/src/contexts/coordination/infrastructure/adapters/coordination-telemetry-trace";
import { TracedObjectiveSignalPort } from "../../qa-engine/src/contexts/objective-signal/infrastructure/adapters/objective-signal-trace";
import type { CoordinationTelemetryEvent } from "../../qa-engine/src/contexts/coordination/application/index";
import type { ObjectiveSignalPort } from "@contexts/objective-signal/application/index.ts";
import { newSandboxReport, withExecScope, type RunScope } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope";
import { Sha } from "@kernel/sha";
import { BlastRadius } from "@kernel/blast-radius";
import { lookupAttribute } from "@kernel/telemetry/attribute-registry";
import { traceHarness } from "./trace-harness";

function inPhase<T>(h: ReturnType<typeof traceHarness>, name: string, fn: () => T): T {
  const phase = h.telemetry.startSpan(name);
  const scope: RunScope = { runId: "r", workDir: "", egress: { dev: [], install: [] }, report: newSandboxReport(), telemetry: { parent: () => phase.context() } };
  try {
    return withExecScope(scope, fn);
  } finally {
    phase.end();
  }
}

test("every coordination decision is recorded in the ledger and is a span of the open phase that says why", () => {
  const h = traceHarness();
  const ledger: CoordinationTelemetryEvent[] = [];
  const event: CoordinationTelemetryEvent = { runId: "r", kind: "delegation", action: "delegate", reason: "flow cart turn 2: sidekick status=needs-lead, file taken back", delegationId: "r-flow-cart", attempt: 2, failureClass: "failed", sidekickStatus: "needs-lead", lastRunSpec: "passed", at: 1 };
  inPhase(h, "qayaba.phase.generate", () => new TracedCoordinationTelemetry({ record: (e) => void ledger.push(e) }, h.telemetry).record(event));
  assert.deepEqual(ledger, [event]);
  const span = h.only("qayaba.coordination.event");
  assert.equal(span.parentSpanContext?.spanId, h.only("qayaba.phase.generate").spanContext().spanId);
  assert.equal(span.attributes["qayaba.coordination.kind"], "delegation");
  assert.equal(span.attributes["qayaba.coordination.action"], "delegate");
  assert.equal(span.attributes["qayaba.coordination.reason"], event.reason);
  assert.equal(span.attributes["qayaba.delegation.id"], "r-flow-cart");
  assert.equal(span.attributes["qayaba.coordination.attempt"], 2);
  assert.equal(span.attributes["qayaba.coordination.failure_class"], "failed");
  assert.equal(span.attributes["qayaba.delegation.status"], "needs-lead");
  assert.equal(span.attributes["qayaba.delegation.last_run_spec"], "passed");
});

test("a coordination event carries its flow, candidates, routes, drop bases and decision as attributes, with lists bounded and every key registered", () => {
  const h = traceHarness();
  const ids = Array.from({ length: 40 }, (_, i) => `uc-${i}`);
  const event: CoordinationTelemetryEvent = {
    runId: "r", kind: "lead-decision", reason: "correction (coverage): 3 finding(s) routed", at: 1, flowId: "cart", candidateIds: ids, origin: "coverage", findings: 7,
    routes: { spec: 1, candidate: 2, lead: 1, candidateFlow: 1, unrouted: 2 }, unroutedReasons: ids, dropBases: ids, dropContradicted: true, decision: "revise", overridden: true, overrideReason: "unverified-sent-back",
  };
  inPhase(h, "qayaba.phase.generate", () => new TracedCoordinationTelemetry({ record: () => {} }, h.telemetry).record(event));
  const a = h.only("qayaba.coordination.event").attributes;
  assert.equal(a["qayaba.coordination.flow_id"], "cart");
  assert.equal((a["qayaba.coordination.candidate_ids"] as string[]).length <= 12, true);
  assert.equal(a["qayaba.coordination.origin"], "coverage");
  assert.equal(a["qayaba.coordination.findings"], 7);
  assert.deepEqual([a["qayaba.coordination.findings_by_spec"], a["qayaba.coordination.findings_by_candidate"], a["qayaba.coordination.findings_by_lead"], a["qayaba.coordination.findings_by_candidate_flow"], a["qayaba.coordination.findings_unrouted"]], [1, 2, 1, 1, 2]);
  assert.equal((a["qayaba.coordination.unrouted_reasons"] as string[]).length <= 6, true);
  assert.equal((a["qayaba.coordination.drop_bases"] as string[]).length <= 12, true);
  assert.equal(a["qayaba.coordination.drop_contradicted"], true);
  assert.equal(a["qayaba.coordination.decision"], "revise");
  assert.equal(a["qayaba.coordination.decision_overridden"], true);
  assert.equal(a["qayaba.coordination.override_reason"], "unverified-sent-back");
  for (const key of Object.keys(a).filter((k) => k.startsWith("qayaba.coordination."))) assert.ok(lookupAttribute(key), `${key} is registered`);
});

test("the change-coverage measurement is a span with its decision, what it counted and why it decided nothing", async () => {
  const h = traceHarness();
  const inner: ObjectiveSignalPort = {
    measure: async () => ({ status: "unknown", ratio: null, measurement: { changedLines: 120, coveredChanged: 0, changedFiles: 9, mappedFiles: 0, unmeasured: "no-changed-file-mapped" } }),
    blocks: () => false,
  };
  const result = await inPhase(h, "qayaba.phase.coverage", () => new TracedObjectiveSignalPort(inner, h.telemetry).measure(BlastRadius.of(Sha.of("abc1234"), []), "/e2e", "diff"));
  assert.equal(result.status, "unknown");
  const span = h.only("qayaba.coverage.measure");
  assert.equal(span.parentSpanContext?.spanId, h.only("qayaba.phase.coverage").spanContext().spanId);
  assert.equal(span.attributes["qayaba.coverage.status"], "unknown");
  assert.equal(span.attributes["qayaba.coverage.ratio"], undefined);
  assert.equal(span.attributes["qayaba.coverage.changed_lines"], 120);
  assert.equal(span.attributes["qayaba.coverage.mapped_files"], 0);
  assert.equal(span.attributes["qayaba.coverage.unmeasured"], "no-changed-file-mapped");
});

test("the change-coverage span carries the branches on the changed lines when a decision was seen there, and nothing of them when none was", async () => {
  const measured = (measurement: NonNullable<Awaited<ReturnType<ObjectiveSignalPort["measure"]>>["measurement"]>) => async () => {
    const h = traceHarness();
    const inner: ObjectiveSignalPort = { measure: async () => ({ status: "pass", ratio: 1, measurement }), blocks: () => false };
    await inPhase(h, "qayaba.phase.coverage", () => new TracedObjectiveSignalPort(inner, h.telemetry).measure(BlastRadius.of(Sha.of("abc1234"), []), "/e2e", "diff"));
    return h.only("qayaba.coverage.measure").attributes;
  };
  const withBranches = await measured({ changedLines: 3, coveredChanged: 3, changedFiles: 1, mappedFiles: 1, changedBranches: 4, takenBranches: 3 })();
  assert.equal(withBranches["qayaba.coverage.changed_branches"], 4);
  assert.equal(withBranches["qayaba.coverage.taken_branches"], 3);
  const without = await measured({ changedLines: 3, coveredChanged: 3, changedFiles: 1, mappedFiles: 1 })();
  assert.equal("qayaba.coverage.changed_branches" in without, false);
  assert.equal("qayaba.coverage.taken_branches" in without, false);
});

test("the change-coverage span says how many mutants were judged and how many a test noticed, and nothing of them when none was judged", async () => {
  const spanOf = async (result: Awaited<ReturnType<ObjectiveSignalPort["measure"]>>) => {
    const h = traceHarness();
    const inner: ObjectiveSignalPort = { measure: async () => result, blocks: () => false };
    await inPhase(h, "qayaba.phase.coverage", () => new TracedObjectiveSignalPort(inner, h.telemetry).measure(BlastRadius.of(Sha.of("abc1234"), []), "/e2e", "diff"));
    return h.only("qayaba.coverage.measure").attributes;
  };
  const judged = await spanOf({ status: "pass", ratio: 1, bundleMutation: { applied: 3, killed: 2, survived: [{ file: "src/a.ts", line: 1, operator: "negate condition" }] } });
  assert.equal(judged["qayaba.mutation.applied"], 3);
  assert.equal(judged["qayaba.mutation.killed"], 2);
  assert.equal("qayaba.mutation.applied" in (await spanOf({ status: "pass", ratio: 1 })), false);
});

test("a recount of the change-coverage is its own span with what it counted, and a port that cannot recount stays one that cannot", async () => {
  const h = traceHarness();
  const inner: ObjectiveSignalPort = {
    measure: async () => ({ status: "unknown", ratio: null }),
    blocks: () => false,
    recount: async () => ({ status: "pass", ratio: 0.9, uncovered: [], untakenArms: [], measurement: { changedLines: 10, coveredChanged: 9, changedFiles: 1, mappedFiles: 1, changedBranches: 4, takenBranches: 4 } }),
  };

  const result = await inPhase(h, "qayaba.phase.coverage", () => new TracedObjectiveSignalPort(inner, h.telemetry).recount!(BlastRadius.of(Sha.of("abc1234"), []), "/e2e", "diff", []));

  assert.equal(result?.ratio, 0.9);
  const span = h.only("qayaba.coverage.recount");
  assert.equal(span.parentSpanContext?.spanId, h.only("qayaba.phase.coverage").spanContext().spanId);
  assert.equal(span.attributes["qayaba.coverage.status"], "pass");
  assert.equal(span.attributes["qayaba.coverage.ratio"], 0.9);
  assert.equal(span.attributes["qayaba.coverage.changed_lines"], 10);
  assert.equal(span.attributes["qayaba.coverage.taken_branches"], 4);

  assert.equal(new TracedObjectiveSignalPort({ measure: inner.measure, blocks: inner.blocks }, h.telemetry).recount, undefined);
});
