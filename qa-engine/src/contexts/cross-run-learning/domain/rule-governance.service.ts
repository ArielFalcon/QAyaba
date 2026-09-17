/* src/contexts/cross-run-learning/domain/rule-governance.service.ts The SINGLE source of ranking truth. The SqliteLearningRepository now does a plain unordered SELECT and defers to THIS service — deleting the duplicate ORDER BY. Pure, off-path, never gates publish. */
import type { LearningRule } from "../application/ports/index.ts";

const RETRIEVABLE: ReadonlySet<LearningRule["status"]> = new Set(["active", "candidate"]);

export interface RelevanceBias {
  errorClass?: string | null;
  archetypes?: readonly string[];
}

export class RuleGovernanceService {
  rank(rules: readonly LearningRule[], bias?: (rule: LearningRule) => number): LearningRule[] {
    const score = bias ?? (() => 0);
    return [...rules].sort((a, b) => {
      const activeDelta = Number(b.status === "active") - Number(a.status === "active");
      if (activeDelta !== 0) return activeDelta;
      const rateDelta = (b.successRate ?? 0) + score(b) - ((a.successRate ?? 0) + score(a));
      if (rateDelta !== 0) return rateDelta;
      return b.at.localeCompare(a.at);
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
    return this.rank(rules.filter((r) => RETRIEVABLE.has(r.status)), bias).slice(0, limit);
  }
}
