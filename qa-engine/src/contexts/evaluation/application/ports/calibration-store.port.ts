import type { CalibrationReport } from "../../domain/judge-calibration.ts";
import type { JudgeName } from "../../domain/judges.ts";

export interface CalibrationStorePort {
  save(report: CalibrationReport): void;
  /* The newest report of the judge for exactly this prompt version, or undefined. */
  latest(judge: JudgeName, promptVersion: string): CalibrationReport | undefined;
}
