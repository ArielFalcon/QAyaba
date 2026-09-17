/* LearningPort: retrieve budget-fitted rules for the generator prompt; fold outcomes off-path (never gates the run). */

import type { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { LearningPort, RetrievedRule } from "../../application/ports/index.ts";
import type { LearningRepositoryPort, RuleStatus } from "@contexts/cross-run-learning/application/ports/index.ts";
import { renderLearnedRules } from "./generation-port.adapter.ts";

const DEFAULT_RETRIEVE_LIMIT = 20;

/* Char budget for the rendered learned-rules section that reaches the generator prompt. */
export const DEFAULT_RULES_CHAR_BUDGET = 5000;

/* Drop lowest-ranked (tail) rules until renderLearnedRules(...) fits maxChars. Whole-rule cuts only; measured against this render so usage matches what the generator will see. */
function fitRulesToBudget(rules: readonly RetrievedRule[], maxChars: number): RetrievedRule[] {
  let included = [...rules];
  while (included.length > 0 && renderLearnedRules(included).length > maxChars) {
    included = included.slice(0, -1); /* drop the lowest-ranked (last) rule and re-render */
  }
  return included;
}

/* RetrievedRule.status is narrowed to "active" | "candidate" (the only two statuses RuleGovernanceService.topRules ever returns — deprecated/superseded are filtered out before this point). A defensive fallback to "candidate" for any other value keeps this a total function without widening the port's own narrow union. */
function toRetrievedStatus(status: RuleStatus): "active" | "candidate" {
  return status === "active" ? "active" : "candidate";
}

export class LearningPortAdapter implements LearningPort {
  constructor(
    private readonly repo: LearningRepositoryPort,
    private readonly app: string,
    private readonly limit = DEFAULT_RETRIEVE_LIMIT,
    /* Injectable so a test can assert the swallow without polluting stderr; defaults to console.error. */
    private readonly onFoldError: (err: unknown) => void = (err) => console.error("[LearningPortAdapter] fold failed (off-path, swallowed):", err),
    private readonly onIncrementUsageError: (err: unknown) => void = (err) => console.warn("[LearningPortAdapter] incrementUsage failed (off-path, swallowed):", err),
    private readonly maxChars = DEFAULT_RULES_CHAR_BUDGET,
  ) {}

  async fold(outcome: RunOutcome): Promise<void> {
    try {
      await this.repo.applyOutcome(outcome);
    } catch (err) {
      /* Off-path by contract: never gates publish. Logged, not re-thrown. */
      this.onFoldError(err);
    }
  }

  async retrieve(sha: Sha): Promise<RetrievedRule[]> {
    const rules = await this.repo.topRules(this.app, sha, this.limit);
    const projected: RetrievedRule[] = rules.map((r) => ({
      id: r.id,
      trigger: r.trigger,
      action: r.action,
      errorClass: r.errorClass,
      status: toRetrievedStatus(r.status),
      confidence: r.confidence,
    }));
    /* Budget-fit BEFORE recording usage so usageCount reflects exactly what the generator will see. */
    const fitted = fitRulesToBudget(projected, this.maxChars);
    /* Increment usage on the budget-fitted set only. Isolated try/catch: a telemetry-write failure must never discard the already-successful retrieval (same off-path contract as fold()). */
    if (fitted.length > 0) {
      try {
        await this.repo.incrementUsage?.(fitted.map((r) => r.id));
      } catch (err) {
        this.onIncrementUsageError(err);
      }
    }
    return fitted;
  }
}
