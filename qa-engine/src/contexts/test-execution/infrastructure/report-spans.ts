/*
 * The execution of a suite as spans, made after the fact from the Playwright JSON report: `qayaba.spec.execute` per spec file,
 * `qayaba.test` per case and `qayaba.attempt` per try, with the report's own start times and durations. They are children of the phase
 * that is open (the execute phase, or the fix loop's), marked synthesized with the report as their time source.
 *
 * Observability never changes a verdict: the report is read by the runner as it was, this only reads it again, and a fault here is logged and
 * ends the synthesis.
 */

import { activeExecScope } from "../../../shared-infrastructure/process-sandbox/exec-scope.ts";
import { runChildOptions } from "../../../shared-infrastructure/telemetry/run-spans.ts";
import { guardTelemetry } from "../../../shared-kernel/telemetry/guarded-telemetry.ts";
import type { TelemetryPort } from "../../../shared-kernel/telemetry/telemetry.port.ts";
import { planReport, type PlannedAttempt, type PlannedCase } from "../domain/playwright-report-plan.ts";

export interface ReportSpanDeps {
  telemetry: TelemetryPort;
  /* Wall-clock ms for a case the report gave no time for. */
  now?: () => number;
}

export function synthesizeReportSpans(deps: ReportSpanDeps, report: unknown): void {
  try {
    const telemetry = guardTelemetry(deps.telemetry);
    const scope = activeExecScope();
    const plan = planReport(report, { deniedHosts: scope?.report.denied ?? [], nowMs: (deps.now ?? Date.now)() });
    const options = runChildOptions();
    for (const file of plan.files) {
      const fileSpan = telemetry.startSpan("qayaba.spec.execute", {
        kind: "internal",
        ...options,
        startTime: file.startMs,
        attrs: { "qayaba.spec.file": file.file, "qayaba.span.synthesized": true, "qayaba.time.source": "report" },
      });
      for (const c of file.cases) emitCase(telemetry, fileSpan, c, options);
      fileSpan.end(file.endMs);
    }
  } catch (err) {
    console.error(`[telemetry] the Playwright report could not be turned into spans (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function emitCase(telemetry: TelemetryPort, fileSpan: ReturnType<TelemetryPort["startSpan"]>, c: PlannedCase, options: ReturnType<typeof runChildOptions>): void {
  const span = telemetry.startSpan("qayaba.test", {
    kind: "internal",
    ...(options.secrets ? { secrets: options.secrets } : {}),
    parent: fileSpan,
    startTime: c.startMs,
    attrs: {
      "qayaba.test.name": c.name,
      "qayaba.test.status": c.status,
      "qayaba.test.retries": c.retries,
      "qayaba.span.synthesized": true,
      "qayaba.time.source": "report",
      ...(c.failureCategory !== undefined ? { "qayaba.test.failure_category": c.failureCategory } : {}),
      ...(c.strategy !== undefined ? { "qayaba.selector.strategy": c.strategy } : {}),
    },
  });
  for (const a of c.attempts) emitAttempt(telemetry, span, a, options);
  span.end(c.endMs);
  telemetry.counter("qayaba.tests")(1, { "qayaba.test.status": c.status, ...(c.failureCategory !== undefined ? { "qayaba.test.failure_category": c.failureCategory } : {}) });
}

function emitAttempt(telemetry: TelemetryPort, testSpan: ReturnType<TelemetryPort["startSpan"]>, a: PlannedAttempt, options: ReturnType<typeof runChildOptions>): void {
  const span = telemetry.startSpan("qayaba.attempt", {
    kind: "internal",
    ...(options.secrets ? { secrets: options.secrets } : {}),
    parent: testSpan,
    startTime: a.startMs,
    attrs: {
      "qayaba.attempt": a.index,
      "qayaba.test.status": a.status,
      "qayaba.span.synthesized": true,
      "qayaba.time.source": "report",
      ...(a.failureCategory !== undefined ? { "qayaba.test.failure_category": a.failureCategory } : {}),
      ...(a.strategy !== undefined ? { "qayaba.selector.strategy": a.strategy } : {}),
      ...(a.errorMessage !== undefined ? { "qayaba.error.message": a.errorMessage } : {}),
    },
  });
  if (a.strictMatchCount !== undefined) {
    span.addEvent("strict_mode_violation", { "qayaba.selector.match_count": a.strictMatchCount, ...(a.strategy !== undefined ? { "qayaba.selector.strategy": a.strategy } : {}) }, a.endMs);
  }
  span.end(a.endMs);
}
