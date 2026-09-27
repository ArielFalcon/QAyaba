import type { LearningRule } from "../qa/learning/learning-rule";
import type { Scorecard } from "../qa/learning/oracle-types";
import type { Curriculum } from "../qa/learning/curriculum";
import { CURRICULUM_CORRUPT } from "@contexts/cross-run-learning/infrastructure/curriculum-port.adapter";
import { listLearningRules, LEARNING_RULE_LEDGER_LIMIT, loadScorecard, loadCurriculum } from "./history";

/*
 * An app's intelligence view as the local history stores it: the intelligence API's read path.
 * LEARNING_RULE_LEDGER_LIMIT is the same retrieve cap the engine injects into generation, so the
 * operator ledger is the live set, not a truncated preview. A corrupt curriculum row reaches the
 * view as curriculumCorrupt, never as "no curriculum yet".
 */
export function loadIntelligenceView(app: string): ReturnType<typeof toIntelligenceView> {
  return toIntelligenceView(app, listLearningRules(app, LEARNING_RULE_LEDGER_LIMIT), loadScorecard(app), loadCurriculum(app));
}

/* Projects persisted learning artifacts into the read-only IntelligenceViewSchema shape. */
export function toIntelligenceView(
  app: string,
  rules: LearningRule[],
  scorecard: Scorecard | null,
  stored: Curriculum | null | typeof CURRICULUM_CORRUPT,
) {
  const curriculumCorrupt = stored === CURRICULUM_CORRUPT;
  const curriculum = curriculumCorrupt ? null : stored;
  return {
    app,
    rules: rules.map((r) => ({
      trigger: r.trigger,
      action: r.action,
      errorClass: r.errorClass,
      confidence: r.confidence,
      usageCount: r.usageCount,
      outcomeCount: r.outcomeCount,
      successRate: r.successRate,
      status: r.status,
    })),
    scorecard: scorecard && {
      updatedAt: scorecard.updatedAt,
      totalRuns: scorecard.summary.totalRuns,
      measuredRuns: scorecard.summary.measuredRuns,
      avgValueScore: scorecard.summary.avgValueScore,
      lastValueScore: scorecard.summary.lastValueScore,
      entries: scorecard.entries.slice(-10).map((e) => ({
        valueScore: e.valueScore,
        mutantCount: e.mutantCount,
        killedCount: e.killedCount,
        target: e.target,
        at: e.at,
      })),
    },
    curriculum: curriculum && {
      updatedAt: curriculum.updatedAt,
      archetypes: curriculum.archetypes.map((a) => ({
        archetype: a.archetype,
        caughtRealBug: a.caughtRealBug,
        promotionCount: a.promotionCount,
        /* Zeros included: "never evaluated" must stay distinct from a measured zero rate. */
        evaluated: a.evaluated,
        credited: a.credited,
      })),
    },
    curriculumCorrupt,
  };
}
