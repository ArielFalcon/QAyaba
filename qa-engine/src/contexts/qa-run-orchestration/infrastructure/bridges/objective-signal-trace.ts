/*
 * The change-coverage measurement as a span: `qayaba.coverage.measure`, a child of the phase that is open, with the decision, what it counted
 * and why a measurement that decides nothing did not; a recount over dumps already on disk is `qayaba.coverage.recount`, with what it counted.
 * A decorator: what the port returns, and what it throws, is returned and thrown as it was, and a port that cannot recount stays one that cannot.
 */

import { startRunChildSpan } from "../../../../shared-infrastructure/telemetry/run-spans.ts";
import type { TelemetryPort } from "../../../../shared-kernel/telemetry/telemetry.port.ts";
import type { CoverageMeasurement, ObjectiveSignalPort } from "../../application/ports/index.ts";

/* What a measurement counted, as span attributes. */
function countsOf(m: CoverageMeasurement | undefined): Record<string, string | number> {
  if (!m) return {};
  return {
    "qayaba.coverage.changed_lines": m.changedLines,
    "qayaba.coverage.covered_lines": m.coveredChanged,
    "qayaba.coverage.changed_files": m.changedFiles,
    "qayaba.coverage.mapped_files": m.mappedFiles,
    ...(m.changedBranches !== undefined ? { "qayaba.coverage.changed_branches": m.changedBranches, "qayaba.coverage.taken_branches": m.takenBranches ?? 0 } : {}),
    ...(m.unmeasured ? { "qayaba.coverage.unmeasured": m.unmeasured } : {}),
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
        ...(result.bundleMutation ? { "qayaba.mutation.applied": result.bundleMutation.applied, "qayaba.mutation.killed": result.bundleMutation.killed } : {}),
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
