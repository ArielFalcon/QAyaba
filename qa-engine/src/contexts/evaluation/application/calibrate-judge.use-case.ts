/*
 * Calibrates a judge: pairs its newest scores with the human labels of the same runs, computes agreement, TPR and TNR on the test split
 * (domain/judge-calibration.ts) and persists the report. The status it earns is read by consumers of the catalog; nothing gates on it.
 */

import { calibrate, DEFAULT_CALIBRATION, type CalibrationReport } from "../domain/judge-calibration.ts";
import { judgeDefinition, type JudgeName } from "../domain/judges.ts";
import type { CalibrationPairsPort } from "./ports/calibration-pairs.port.ts";
import type { CalibrationStorePort } from "./ports/calibration-store.port.ts";

export interface CalibrateJudgeDeps {
  pairs: CalibrationPairsPort;
  store: CalibrationStorePort;
  now: () => string;
}

export type CalibrateJudgeResult = { ok: true; report: CalibrationReport } | { ok: false; reason: string };

export class CalibrateJudgeUseCase {
  constructor(private readonly deps: CalibrateJudgeDeps) {}

  execute(request: { judge: JudgeName; minN?: number }): CalibrateJudgeResult {
    if (request.minN !== undefined && (!Number.isInteger(request.minN) || request.minN < 1)) throw new Error(`--min-n must be a positive whole number, got ${request.minN}`);
    const found = this.deps.pairs.pairsFor(request.judge);
    if (!found) return { ok: false, reason: `${request.judge} has no scores yet: run the judge first (QA_JUDGES_ENABLED=true) and import human labels (npm run langfuse:labels)` };
    const report = calibrate(judgeDefinition(request.judge), found.pairs, {
      promptVersion: found.promptVersion,
      model: found.model,
      computedAt: this.deps.now(),
      thresholds: { ...DEFAULT_CALIBRATION, ...(request.minN !== undefined ? { minN: request.minN } : {}) },
    });
    this.deps.store.save(report);
    return { ok: true, report };
  }
}
