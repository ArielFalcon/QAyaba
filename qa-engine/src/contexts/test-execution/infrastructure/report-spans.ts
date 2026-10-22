/*
 * The execution of a suite as spans, made after the fact from the Playwright JSON report: `qayaba.spec.execute` per spec file,
 * `qayaba.test` per case and `qayaba.attempt` per try, with the report's own start times and durations. They are children of the phase
 * that is open (the execute phase, or the fix loop's), marked synthesized with the report as their time source.
 *
 * The report is written by the test process, so how much of it becomes spans is bounded: times are held between the start of the phase and now
 * (planReport), and no more than MAX_SPANS_PER_REPORT spans come from one report nor MAX_SPANS_PER_RUN from one run. What the caps leave out
 * is counted on the phase span. Cases are still counted in `qayaba.tests` whether or not their spans were made.
 *
 * Observability never changes a verdict: the report is read by the runner as it was, this only reads it again, and a fault here is logged and
 * ends the synthesis.
 */

import { activeExecScope, runScopeKey, type RunScope } from "../../../shared-infrastructure/process-sandbox/exec-scope.ts";
import { runChildOptions } from "../../../shared-infrastructure/telemetry/run-spans.ts";
import { guardTelemetry } from "../../../shared-kernel/telemetry/guarded-telemetry.ts";
import type { TelemetryPort } from "../../../shared-kernel/telemetry/telemetry.port.ts";
import type { QaCase, FailureAttemptEvidence } from "../../../shared-kernel/qa-case.ts";
import type { Attrs } from "../../../shared-kernel/telemetry/attribute-registry.ts";
import { planReport, type PlannedAttempt, type PlannedCase } from "../domain/playwright-report-plan.ts";
import { summarizePlaywrightFailure } from "../domain/playwright-error-summary.ts";

export const MAX_SPANS_PER_REPORT = 500;
export const MAX_SPANS_PER_RUN = 2000;

export interface ReportSpanDeps {
  telemetry: TelemetryPort;
  /* Wall-clock ms: the ceiling of every time taken from a report, and the stand-in for a case the report gave no time for. */
  now?: () => number;
}

/* What a run has synthesized so far, and what it has left out. Outside a run there is nowhere to keep it, and each report gets a fresh count. */
interface RunTally {
  spans: number;
  /* What the caps left out, per phase span (a phase can read several reports). */
  droppedByPhase: Map<string, number>;
}
const TALLIES = new WeakMap<RunScope, RunTally>();

function tallyOf(scope: RunScope | undefined): RunTally {
  if (!scope) return { spans: 0, droppedByPhase: new Map() };
  let tally = TALLIES.get(scope);
  if (!tally) {
    tally = { spans: 0, droppedByPhase: new Map() };
    TALLIES.set(scope, tally);
  }
  return tally;
}

export function synthesizeReportSpans(deps: ReportSpanDeps, report: unknown, cases: readonly QaCase[] = []): void {
  try {
    const telemetry = guardTelemetry(deps.telemetry);
    const scope = activeExecScope();
    const nowMs = (deps.now ?? Date.now)();
    const phaseStartMs = scope?.telemetry?.phaseStart?.();
    const plan = planReport(report, { deniedHosts: scope?.report.denied ?? [], nowMs, ...(phaseStartMs !== undefined ? { phaseStartMs } : {}) });
    const options = runChildOptions();
    const tally = tallyOf(scope ? runScopeKey(scope) : undefined);
    /* The runtime evidence the runner harvested per case, keyed by the case's report name (fullName). */
    const evidence = new Map(cases.map((c) => [c.name, c]));
    let inReport = 0;
    /* Whether `n` more spans fit under both caps; when they do they are taken. */
    const take = (n: number): boolean => {
      if (inReport + n > MAX_SPANS_PER_REPORT || tally.spans + n > MAX_SPANS_PER_RUN) return false;
      inReport += n;
      tally.spans += n;
      return true;
    };
    const phaseKey = scope?.telemetry?.parent()?.spanId ?? "";
    let dropped = plan.omitted;
    for (const file of plan.files) {
      const spansOf = (c: PlannedCase): number => 1 + c.attempts.length;
      /* The file's span is made only when one of its cases is: an execute span with nothing under it says nothing. */
      let fileTaken = false;
      const fitting: PlannedCase[] = [];
      for (const c of file.cases) {
        if (take(spansOf(c) + (fileTaken ? 0 : 1))) {
          fileTaken = true;
          fitting.push(c);
        } else {
          dropped += spansOf(c);
        }
        countCase(telemetry, c);
      }
      if (!fileTaken) continue;
      const fileSpan = telemetry.startSpan("qayaba.spec.execute", {
        kind: "internal",
        ...options,
        startTime: file.startMs,
        attrs: { "qayaba.spec.file": file.file, "qayaba.span.synthesized": true, "qayaba.time.source": "report" },
      });
      for (const c of fitting) emitCase(telemetry, fileSpan, c, options, evidence);
      fileSpan.end(file.endMs);
    }
    if (dropped > 0) {
      const total = (tally.droppedByPhase.get(phaseKey) ?? 0) + dropped;
      tally.droppedByPhase.set(phaseKey, total);
      scope?.telemetry?.annotate?.({ "qayaba.spans.synthesized_dropped": total });
    }
  } catch (err) {
    console.error(`[telemetry] the Playwright report could not be turned into spans (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function countCase(telemetry: TelemetryPort, c: PlannedCase): void {
  telemetry.counter("qayaba.tests")(1, { "qayaba.test.status": c.status, ...(c.failureCategory !== undefined ? { "qayaba.test.failure_category": c.failureCategory } : {}) });
}

function emitCase(telemetry: TelemetryPort, fileSpan: ReturnType<TelemetryPort["startSpan"]>, c: PlannedCase, options: ReturnType<typeof runChildOptions>, evidence: ReadonlyMap<string, QaCase>): void {
  const e = evidence.get(c.fullName);
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
      ...(e?.httpStatus !== undefined ? { "qayaba.test.http_status": e.httpStatus } : {}),
      ...(e?.networkErrors !== undefined && e.networkErrors.length > 0 ? { "qayaba.test.network_error_count": e.networkErrors.length } : {}),
      ...(e?.networkClass !== undefined ? { "qayaba.test.network_class": e.networkClass } : {}),
    },
  });
  for (const a of c.attempts) emitAttempt(telemetry, span, a, options, e?.failureAttempts?.find((f) => f.retry === a.index));
  const failedStatus = c.status === "failed" || c.status === "timedOut" || c.status === "interrupted" ? c.status : undefined;
  if (failedStatus !== undefined) {
    const failedAttempt = c.attempts.find((a) => a.status === "failed" || a.status === "timedOut" || a.status === "interrupted");
    /* A report that carried no message still marked the case as failed: the status is the fact, never an invented reason. */
    const message = failedAttempt?.errorMessage !== undefined ? summarizePlaywrightFailure(failedAttempt.errorMessage) : failedStatus;
    const err = new Error(message);
    err.name = c.failureCategory ?? "PlaywrightFailure";
    span.recordError(
      err,
      {
        ...(c.failureCategory !== undefined ? { "qayaba.test.failure_category": c.failureCategory } : {}),
        ...(c.strategy !== undefined ? { "qayaba.selector.strategy": c.strategy } : {}),
      },
      failedAttempt?.endMs ?? c.endMs,
    );
  }
  span.end(c.endMs);
}

function emitAttempt(telemetry: TelemetryPort, testSpan: ReturnType<TelemetryPort["startSpan"]>, a: PlannedAttempt, options: ReturnType<typeof runChildOptions>, capture: FailureAttemptEvidence | undefined): void {
  const span = telemetry.startSpan("qayaba.attempt", {
    kind: "internal",
    ...(options.secrets ? { secrets: options.secrets } : {}),
    parent: testSpan,
    startTime: a.startMs,
    attrs: {
      "qayaba.test.attempt": a.index,
      "qayaba.test.status": a.status,
      "qayaba.span.synthesized": true,
      "qayaba.time.source": "report",
      ...(a.failureCategory !== undefined ? { "qayaba.test.failure_category": a.failureCategory } : {}),
      ...(a.strategy !== undefined ? { "qayaba.selector.strategy": a.strategy } : {}),
      ...(a.errorMessage !== undefined ? { "qayaba.error.message": summarizePlaywrightFailure(a.errorMessage) } : {}),
      ...(capture !== undefined ? captureAttrs(capture) : {}),
    },
  });
  if (a.strictMatchCount !== undefined) {
    span.addEvent("strict_mode_violation", { "qayaba.selector.match_count": a.strictMatchCount, ...(a.strategy !== undefined ? { "qayaba.selector.strategy": a.strategy } : {}) }, a.endMs);
  }
  span.end(a.endMs);
}

/* What the attempt's page showed when it failed: the facts that tell a test defect from a page that was not there yet. */
function captureAttrs(c: FailureAttemptEvidence): Attrs {
  return {
    ...(c.finalUrl !== undefined ? { "qayaba.failure.final_url": c.finalUrl } : {}),
    ...(c.httpStatus !== undefined ? { "qayaba.failure.http_status": c.httpStatus } : {}),
    ...(c.resultCount !== undefined ? { "qayaba.failure.result_count": c.resultCount } : {}),
    ...(c.settle !== undefined ? { "qayaba.failure.data_in_flight": c.settle.inFlight, "qayaba.failure.tree_stable": c.settle.treeStable } : {}),
    ...(c.settle?.quietMs !== undefined ? { "qayaba.failure.quiet_ms": c.settle.quietMs } : {}),
    "qayaba.failure.runtime_error_count": c.runtimeErrorCount,
    ...(c.runtimeError !== undefined ? { "qayaba.failure.runtime_error": c.runtimeError } : {}),
    "qayaba.failure.network_error_count": c.networkErrorCount,
    ...(c.domLines !== undefined ? { "qayaba.failure.dom_lines": c.domLines } : {}),
    ...(c.domSha256 !== undefined ? { "qayaba.failure.dom_sha256": c.domSha256 } : {}),
  };
}
