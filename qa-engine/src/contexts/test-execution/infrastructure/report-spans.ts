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

import { activeExecScope, type RunScope } from "../../../shared-infrastructure/process-sandbox/exec-scope.ts";
import { runChildOptions } from "../../../shared-infrastructure/telemetry/run-spans.ts";
import { guardTelemetry } from "../../../shared-kernel/telemetry/guarded-telemetry.ts";
import type { TelemetryPort } from "../../../shared-kernel/telemetry/telemetry.port.ts";
import { planReport, type PlannedAttempt, type PlannedCase } from "../domain/playwright-report-plan.ts";

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
  dropped: number;
}
const TALLIES = new WeakMap<RunScope, RunTally>();

function tallyOf(scope: RunScope | undefined): RunTally {
  if (!scope) return { spans: 0, dropped: 0 };
  let tally = TALLIES.get(scope);
  if (!tally) {
    tally = { spans: 0, dropped: 0 };
    TALLIES.set(scope, tally);
  }
  return tally;
}

export function synthesizeReportSpans(deps: ReportSpanDeps, report: unknown): void {
  try {
    const telemetry = guardTelemetry(deps.telemetry);
    const scope = activeExecScope();
    const nowMs = (deps.now ?? Date.now)();
    const phaseStartMs = scope?.telemetry?.phaseStart?.();
    const plan = planReport(report, { deniedHosts: scope?.report.denied ?? [], nowMs, ...(phaseStartMs !== undefined ? { phaseStartMs } : {}) });
    const options = runChildOptions();
    const tally = tallyOf(scope);
    let inReport = 0;
    /* Whether `n` more spans fit under both caps; when they do they are taken. */
    const take = (n: number): boolean => {
      if (inReport + n > MAX_SPANS_PER_REPORT || tally.spans + n > MAX_SPANS_PER_RUN) return false;
      inReport += n;
      tally.spans += n;
      return true;
    };
    for (const file of plan.files) {
      const spansOf = (c: PlannedCase): number => 1 + c.attempts.length;
      if (!take(1)) {
        tally.dropped += file.cases.reduce((sum, c) => sum + spansOf(c), 1);
        for (const c of file.cases) countCase(telemetry, c);
        continue;
      }
      const fileSpan = telemetry.startSpan("qayaba.spec.execute", {
        kind: "internal",
        ...options,
        startTime: file.startMs,
        attrs: { "qayaba.spec.file": file.file, "qayaba.span.synthesized": true, "qayaba.time.source": "report" },
      });
      for (const c of file.cases) {
        if (take(spansOf(c))) emitCase(telemetry, fileSpan, c, options);
        else tally.dropped += spansOf(c);
        countCase(telemetry, c);
      }
      fileSpan.end(file.endMs);
    }
    tally.dropped += plan.omitted;
    if (tally.dropped > 0) scope?.telemetry?.annotate?.({ "qayaba.spans.synthesized_dropped": tally.dropped });
  } catch (err) {
    console.error(`[telemetry] the Playwright report could not be turned into spans (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function countCase(telemetry: TelemetryPort, c: PlannedCase): void {
  telemetry.counter("qayaba.tests")(1, { "qayaba.test.status": c.status, ...(c.failureCategory !== undefined ? { "qayaba.test.failure_category": c.failureCategory } : {}) });
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
