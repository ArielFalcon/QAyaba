import type { JudgeName } from "../../domain/judges.ts";
import type { JudgePairs } from "../../domain/judge-evidence.ts";

export interface CalibrationPairsPort {
  /* The human labels paired with the judge's scores of the same runs: the newest prompt version and model the judge has scores for. Undefined: it has none. */
  pairsFor(judge: JudgeName): JudgePairs | undefined;
}
