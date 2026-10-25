/* The coordination ledger and the change-coverage measurement as spans of the phase that is open, over the real telemetry adapter. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TracedCoordinationTelemetry } from "../../qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/coordination-telemetry-trace";
import { TracedObjectiveSignalPort } from "../../qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/objective-signal-trace";
import type { CoordinationTelemetryEvent } from "../../qa-engine/src/contexts/qa-run-orchestration/application/coordination/coordination-telemetry";
import type { ObjectiveSignalPort } from "../../qa-engine/src/contexts/qa-run-orchestration/application/ports/index";
import { newSandboxReport, withExecScope, type RunScope } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope";
import { Sha } from "@kernel/sha";
import { BlastRadius } from "@kernel/blast-radius";
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
