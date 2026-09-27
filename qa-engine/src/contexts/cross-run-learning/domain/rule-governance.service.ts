/* src/contexts/cross-run-learning/domain/rule-governance.service.ts The SINGLE source of ranking truth. The SqliteLearningRepository now does a plain unordered SELECT and defers to THIS service — deleting the duplicate ORDER BY. Pure, off-path, never gates publish. */
import type { LearningRule } from "../application/ports/index.ts";

const RETRIEVABLE: ReadonlySet<LearningRule["status"]> = new Set(["active", "candidate"]);

export interface RelevanceBias {
  errorClass?: string | null;
  archetypes?: readonly string[];
}

/*
 * successRate is the earned-from-outcomes signal and must dominate the
 * relevance bias (+3 per errorClass/archetype match). Scaling successRate by this weight before
 * adding the bias means a single relevance match (+3) only flips a NEAR-tie (e.g. 0.9 vs 0.85);
 * it can never let a merely-relevant, unproven rule beat a strongly-proven one (0.9 vs 0.5).
 * Without this scaling a flat +3 on a raw [0,1] rate overrides earned proof outright.
 */
const RETRIEVAL_SUCCESS_RATE_WEIGHT = 10;

/*
 * How many of the last retrieval slots are
 * reserved for unproven candidates once active rules alone would fill the limit. Without this, a
 * candidate that never cracks the top `limit` by score is NEVER retrieved again — it can't
 * accumulate the outcomes that earn (or deny) promotion, and the injected rule set ossifies.
 */
export const EXPLORATION_SLOTS = 2;

export class RuleGovernanceService {
  rank(rules: readonly LearningRule[], bias?: (rule: LearningRule) => number): LearningRule[] {
    const score = bias ?? (() => 0);
    return [...rules].sort((a, b) => {
      const activeDelta = Number(b.status === "active") - Number(a.status === "active");
      if (activeDelta !== 0) return activeDelta;
      const rateDelta =
        (b.successRate ?? 0) * RETRIEVAL_SUCCESS_RATE_WEIGHT + score(b) - ((a.successRate ?? 0) * RETRIEVAL_SUCCESS_RATE_WEIGHT + score(a));
      if (rateDelta !== 0) return rateDelta;
      const atDelta = b.at.localeCompare(a.at);
      if (atDelta !== 0) return atDelta;
      /*
       * Final, total-order tiebreak by id: without this, two rules tied on every other
       * criterion fall through to Array.sort's stability, which preserves INPUT order — making
       * retrieval order depend on incidental row-read order rather than the rule contents.
       */
      return a.id.localeCompare(b.id);
    });
  }

  topRules(rules: readonly LearningRule[], limit: number, relevance?: RelevanceBias): LearningRule[] {
    const bias = relevance
      ? (r: LearningRule): number => {
          let s = 0;
          if (relevance.errorClass && r.errorClass === relevance.errorClass) s += 3;
          if (relevance.archetypes?.length && r.archetype && relevance.archetypes.includes(r.archetype)) s += 3;
          return s;
        }
      : undefined;
    const eligible = rules.filter((r) => RETRIEVABLE.has(r.status));
    const picked = this.rank(eligible, bias).slice(0, limit);

    /*
     * Exploration floor: once `limit` slots are already filled by ranked rules, reserve the last
     * EXPLORATION_SLOTS positions for the NEWEST candidates not already selected, so candidate
     * turnover never stalls. Only replace when `picked` is actually FULL — splicing past the end
     * would append and grow the result beyond `limit`.
     *
     * Slots must also be clamped to `limit` itself. Without it, limit < EXPLORATION_SLOTS (e.g.
     * limit=1) made `limit - slots` negative; Array.prototype.splice treats a negative start as
     * counting from the END, so it deleted fewer elements than it inserted and `picked` grew past
     * `limit`.
     */
    if (eligible.length > limit && picked.length >= limit) {
      const pickedIds = new Set(picked.map((r) => r.id));
      const freshCandidates = eligible
        .filter((r) => r.status === "candidate" && !pickedIds.has(r.id))
        .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
      const slots = Math.min(EXPLORATION_SLOTS, freshCandidates.length, limit);
      if (slots > 0) picked.splice(limit - slots, slots, ...freshCandidates.slice(0, slots));
    }
    return picked;
  }
}
