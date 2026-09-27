/*
 * Regeneration-loop telemetry: the configured ceiling (a backstop derived from maxRetries/
 * numObjectives, or an iterationBudget override), surfaced to evidence (evidenceFromBudget) for
 * observability. Nothing in the engine enforces this ceiling — the run's actual time-based cap is
 * WallClockBudget.exhausted(), checked directly by run-qa.use-case.ts before each regen round (see
 * wall-clock-budget.ts). iterationBudget config override wins over the derived backstop.
 */

import { deriveCycleBackstop } from "./helpers/derive-cycle-backstop.ts";

export interface CycleBudgetInput {
  maxRetries: number;
  iterationBudget?: number;
  numObjectives?: number;
}

export class CycleBudget {
  private constructor(readonly ceiling: number) {}

  static derive(input: CycleBudgetInput): CycleBudget {
    const ceiling = input.iterationBudget ?? deriveCycleBackstop(input.maxRetries, input.numObjectives);
    return new CycleBudget(ceiling);
  }
}
