/*
 * The Prometheus mirror of the run scores (docs/telemetry-local.md): an adapter for the evaluation context's ScoreSinkPort.
 * Scores stay stored in `run_scores` first; this sink only makes them visible in Grafana. It is fail-open: a lookup or a
 * measurement fault is logged and never reaches the grade.
 *
 * Cardinality: only catalog names, closed-set classes, the configured app and the verdict may become labels. The run id,
 * shas, comments and observation ids never do. `qayaba.eval.score` is a gauge (the latest value per label set stands, so a
 * regrade replaces a series); `qayaba.eval.class` counts grading events, so a regrade counts its class once more.
 */

import { appLogger } from "../integrations/redacting-logger";
import type { ScoreSinkPort } from "@contexts/evaluation/application/index.ts";
import { COVERAGE_CLASSES } from "@contexts/evaluation/application/index";
import type { Score } from "@contexts/evaluation/application/index";
import { ERROR_CLASSES } from "@kernel/error-class";
import { RUN_PHASES } from "@kernel/run-step";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port";

/* The categorical scores whose values are a closed set. Any other categorical score is not emitted. */
const CLOSED_CLASSES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["furthest_phase", new Set(RUN_PHASES)],
  ["change_coverage", new Set(COVERAGE_CLASSES)],
  /* An infra-error's class, plus the two values the grader emits without one. */
  ["infra_error", new Set([...ERROR_CLASSES, "unclassified", "cancelled"])],
]);

export interface ScoreMetricsSinkDeps {
  telemetry: Pick<TelemetryPort, "gauge" | "counter">;
  /* The run's configured app name, from the run store. */
  appOf: (runId: string) => string | undefined;
  /* The run's verdict, from its outcome or record. */
  verdictOf: (runId: string) => string | undefined;
  log?: (message: string) => void;
}

export class ScoreMetricsSink implements ScoreSinkPort {
  private readonly log: (message: string) => void;

  constructor(private readonly deps: ScoreMetricsSinkDeps) {
    this.log = deps.log ?? ((m: string) => appLogger.error(m));
  }

  emit(runId: string, scores: readonly Score[]): void {
    try {
      const app = this.deps.appOf(runId);
      const verdict = this.deps.verdictOf(runId);
      const score = this.deps.telemetry.gauge("qayaba.eval.score");
      const classified = this.deps.telemetry.counter("qayaba.eval.class");
      for (const s of scores) {
        if (s.dataType === "CATEGORICAL") {
          /* Its value is a free string (the limit, role and intent that fired): qayaba.budget.exhausted already carries the limit. */
          if (s.name === "budget_exhaustion") continue;
          const closed = CLOSED_CLASSES.get(s.name);
          if (!closed || typeof s.value !== "string") continue;
          classified(1, { "qayaba.eval.name": s.name, "qayaba.eval.value": closed.has(s.value) ? s.value : "other" });
          continue;
        }
        const value = typeof s.value === "boolean" ? (s.value ? 1 : 0) : s.value;
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        score(value, {
          "qayaba.eval.name": s.name,
          "qayaba.eval.source": s.source,
          "qayaba.eval.data_type": s.dataType,
          ...(app !== undefined ? { "qayaba.app": app } : {}),
          ...(verdict !== undefined ? { "qayaba.verdict": verdict } : {}),
        });
      }
    } catch (err) {
      this.log(`[evaluation] the score metrics sink failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/* Fans one emission out to every sink, isolating a failing one so the others still see it. */
export function composeScoreSinks(sinks: readonly ScoreSinkPort[], log: (message: string) => void = (m) => appLogger.error(m)): ScoreSinkPort {
  return {
    async emit(runId, scores, at): Promise<void> {
      for (const sink of sinks) {
        try {
          await sink.emit(runId, scores, at);
        } catch (err) {
          log(`[evaluation] a score sink failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  };
}
