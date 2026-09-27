/* LearningPort: retrieve budget-fitted rules for the generator prompt; fold outcomes off-path (never gates the run). */

import type { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { LearningPort, RetrievedRule, RelevanceBias } from "../../application/ports/index.ts";
import type { LearningRepositoryPort, RuleStatus } from "@contexts/cross-run-learning/application/ports/index.ts";
import { renderLearnedRules } from "./generation-port.adapter.ts";

const DEFAULT_RETRIEVE_LIMIT = 20;

/* Char budget for the rendered learned-rules section that reaches the generator prompt. */
export const DEFAULT_RULES_CHAR_BUDGET = 5000;

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

  async retrieve(sha: Sha, relevance?: RelevanceBias): Promise<RetrievedRule[]> {
    const fitted = await this.retrieveWithinBudget(sha, relevance);
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

  /*
   * The largest retrieval whose rendered section fits maxChars, re-asked from governance at a
   * smaller count until it fits. Trimming the tail of one oversized retrieval instead would cut the
   * exploration slots governance reserves at the END for the freshest candidates, so a budget
   * overflow by proven rules would silently stop candidate turnover. Re-asking keeps governance the
   * single ranking truth: the result is exactly what it picks at the count that fits, reservation
   * included. The slice guards the count even against a repository that returns more than asked.
   */
  private async retrieveWithinBudget(sha: Sha, relevance?: RelevanceBias): Promise<RetrievedRule[]> {
    let limit = this.limit;
    while (limit > 0) {
      const rules = (await this.repo.topRules(this.app, sha, limit, relevance)).slice(0, limit);
      const projected: RetrievedRule[] = rules.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        action: r.action,
        errorClass: r.errorClass,
        status: toRetrievedStatus(r.status),
        confidence: r.confidence,
      }));
      if (renderLearnedRules(projected).length <= this.maxChars) return projected;
      limit = projected.length - 1;
    }
    return [];
  }
}
