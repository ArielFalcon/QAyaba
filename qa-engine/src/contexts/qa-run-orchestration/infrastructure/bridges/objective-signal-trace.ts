/*
 * The change-coverage measurement as a span: `qayaba.coverage.measure`, a child of the phase that is open, with the decision, what it counted
 * and why a measurement that decides nothing did not. A decorator: what the port returns, and what it throws, is returned and thrown as it was.
 */

import { startRunChildSpan } from "../../../../shared-infrastructure/telemetry/run-spans.ts";
import type { TelemetryPort } from "../../../../shared-kernel/telemetry/telemetry.port.ts";
import type { ObjectiveSignalPort } from "../../application/ports/index.ts";

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
