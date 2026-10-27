/*
 * The change-coverage measurement as a span: `qayaba.coverage.measure`, a child of the phase that is open, with the decision, what it counted
 * and why a measurement that decides nothing did not; a recount over dumps already on disk is `qayaba.coverage.recount`, with what it counted.
 * A decorator: what the port returns, and what it throws, is returned and thrown as it was, and a port that cannot recount stays one that cannot.
 */

import { startRunChildSpan } from "../../../../shared-infrastructure/telemetry/run-spans.ts";
import type { TelemetryPort } from "../../../../shared-kernel/telemetry/telemetry.port.ts";
import type { CandidateCoverage } from "../../domain/per-candidate-coverage.ts";
import type { BundleMutationOutcome, CoverageMeasurement } from "../../domain/objective-signal.ts";
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

/* How many mutants were judged and noticed, and how many survivors a spec reached (so they can reach its flow) and how many none did. */
function survivorAttrs(m: BundleMutationOutcome) {
  const routed = m.survived.filter((s) => (s.specFiles?.length ?? 0) > 0).length;
  return {
    "qayaba.mutation.applied": m.applied,
    "qayaba.mutation.killed": m.killed,
    "qayaba.mutation.survivors_routed": routed,
    "qayaba.mutation.survivors_without_spec": m.survived.length - routed,
  };
}

/* What a measurement counted, as span attributes. */
function countsOf(m: CoverageMeasurement | undefined): Record<string, string | number | string[]> {
  if (!m) return {};
  return {
    "qayaba.coverage.changed_lines": m.changedLines,
    "qayaba.coverage.covered_lines": m.coveredChanged,
    "qayaba.coverage.changed_files": m.changedFiles,
    "qayaba.coverage.mapped_files": m.mappedFiles,
    ...(m.changedBranches !== undefined ? { "qayaba.coverage.changed_branches": m.changedBranches, "qayaba.coverage.taken_branches": m.takenBranches ?? 0 } : {}),
    ...(m.unmeasured ? { "qayaba.coverage.unmeasured": m.unmeasured } : {}),
    ...(m.perCandidate ? candidateAttrs(m.perCandidate) : {}),
  };
}

export class TracedObjectiveSignalPort implements ObjectiveSignalPort {
  readonly recount?: ObjectiveSignalPort["recount"];

  constructor(
    private readonly inner: ObjectiveSignalPort,
    private readonly telemetry: TelemetryPort,
  ) {
    const recount = inner.recount;
    if (recount) {
      this.recount = async (...args) => {
        const span = startRunChildSpan(this.telemetry, "qayaba.coverage.recount");
        try {
          const result = await recount.apply(inner, args);
          span.setAttrs(result ? { "qayaba.coverage.status": result.status, ...(result.ratio !== null ? { "qayaba.coverage.ratio": result.ratio } : {}), ...countsOf(result.measurement) } : {});
          span.end();
          return result;
        } catch (err) {
          span.recordError(err);
          span.end();
          throw err;
        }
      };
    }
  }

  async measure(...args: Parameters<ObjectiveSignalPort["measure"]>): ReturnType<ObjectiveSignalPort["measure"]> {
    const span = startRunChildSpan(this.telemetry, "qayaba.coverage.measure");
    try {
      const result = await this.inner.measure(...args);
      span.setAttrs({
        "qayaba.coverage.status": result.status,
        ...(result.bundleMutation ? survivorAttrs(result.bundleMutation) : {}),
        ...(result.ratio !== null ? { "qayaba.coverage.ratio": result.ratio } : {}),
        ...countsOf(result.measurement),
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
