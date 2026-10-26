/*
 * The change-coverage measurement as a span: `qayaba.coverage.measure`, a child of the phase that is open, with the decision, what it counted
 * and why a measurement that decides nothing did not. A decorator: what the port returns, and what it throws, is returned and thrown as it was.
 */

import { startRunChildSpan } from "../../../../shared-infrastructure/telemetry/run-spans.ts";
import type { TelemetryPort } from "../../../../shared-kernel/telemetry/telemetry.port.ts";
import type { CandidateCoverage } from "../../domain/per-candidate-coverage.ts";
import type { ObjectiveSignalPort } from "../../application/ports/objective-signal.port.ts";

/* How many candidates were measured and, per reason, how many were not: `reason: count`, once each. */
function candidateAttrs(perCandidate: readonly CandidateCoverage[]) {
  const reasons = new Map<string, number>();
  for (const c of perCandidate) if (c.unmeasured) reasons.set(c.unmeasured, (reasons.get(c.unmeasured) ?? 0) + 1);
  return {
    "qayaba.coverage.candidates": perCandidate.length,
    "qayaba.coverage.candidates_measured": perCandidate.filter((c) => c.ratio !== null).length,
    "qayaba.coverage.candidates_unmeasured": [...reasons].map(([reason, count]) => `${reason}: ${count}`),
  };
}

export class TracedObjectiveSignalPort implements ObjectiveSignalPort {
  constructor(
    private readonly inner: ObjectiveSignalPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  async measure(...args: Parameters<ObjectiveSignalPort["measure"]>): ReturnType<ObjectiveSignalPort["measure"]> {
    const span = startRunChildSpan(this.telemetry, "qayaba.coverage.measure");
    try {
      const result = await this.inner.measure(...args);
      const m = result.measurement;
      span.setAttrs({
        "qayaba.coverage.status": result.status,
        ...(result.ratio !== null ? { "qayaba.coverage.ratio": result.ratio } : {}),
        ...(m
          ? {
              "qayaba.coverage.changed_lines": m.changedLines,
              "qayaba.coverage.covered_lines": m.coveredChanged,
              "qayaba.coverage.changed_files": m.changedFiles,
              "qayaba.coverage.mapped_files": m.mappedFiles,
              ...(m.unmeasured ? { "qayaba.coverage.unmeasured": m.unmeasured } : {}),
              ...(m.perCandidate ? candidateAttrs(m.perCandidate) : {}),
            }
          : {}),
      });
      span.end();
      return result;
    } catch (err) {
      span.recordError(err);
      span.end();
      throw err;
    }
  }

  blocks(status: "pass" | "fail" | "unknown"): boolean {
    return this.inner.blocks(status);
  }
}
