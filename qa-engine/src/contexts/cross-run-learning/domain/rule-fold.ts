
import type { LearningRule, RuleStatus } from "@contexts/cross-run-learning/application/ports/index.ts";

export const MIN_OUTCOMES = 3;
export const PROMOTE_RATE = 0.6;
export const DEMOTE_RATE = 0.3;

export function deriveConfidence(outcomeCount: number, successRate: number | null): "low" | "medium" | "high" {
  if (outcomeCount < MIN_OUTCOMES || successRate === null) return "low";
  if (successRate >= 0.7) return "high";
  if (successRate >= 0.45) return "medium";
  return "low";
}

/* coverageCreditConfirmed is the coverage-anchor governance signal. true → coverage was measured AND confirmed credit (covered lines in the changed diff) — promotion eligible false → coverage was measured but NO credit (covered 0 changed lines) — promotion blocked for this transition null → coverage not measured / cross-repo / unknown — no gate (promotion proceeds normally) This is the non-circular anchor: a rule can only earn `active` when the test that exercised it also covered the diff's changed lines, not just made the reviewer happy. Coverage stays non-blocking where unmeasurable (null), so the flywheel turns for every app. Promotion is objective-signal-only per the project invariant — prevention credit is DERIVED (absence of a failure class), not an objective observation, so three clean prevention-only runs must NEVER by themselves promote a candidate to `active`. */
function nextStatus(
  status: RuleStatus,
  outcomeCount: number,
  successRate: number,
  coverageCreditConfirmed: boolean | null = null,
  oracleOutcomeCount = 0,
): RuleStatus {
  if ((status as string) === "pending") return "candidate";
  if (outcomeCount < MIN_OUTCOMES) return status;
  switch (status) {
    case "candidate": {
      if (successRate < PROMOTE_RATE) return "candidate";
      if (coverageCreditConfirmed === false) return "candidate";
      if (oracleOutcomeCount < 1) return "candidate";
      return "active";
    }
    case "active":
      return successRate < DEMOTE_RATE ? "deprecated" : "active";
    case "deprecated":
      return successRate >= PROMOTE_RATE ? "active" : "deprecated";
    default:
      return status;
  }
}

export const PREVENTION_HELD_SCORE = 0.6;

export function preventionOutcome(ruleErrorClass: string, runErrorClass: string | null): number | null {
  if (ruleErrorClass.trim() === "") return null;
  if (runErrorClass === "E-INFRA" || runErrorClass === "E-FLAKY") return null;
  if (runErrorClass === ruleErrorClass) return 0;
  if (runErrorClass === null) return PREVENTION_HELD_SCORE;
  return null;
}

export function applyOutcome(
  rule: LearningRule,
  score: number,
  coverageCreditConfirmed: boolean | null = null,
  isOracleScore = false,
): LearningRule {
  const n = (rule.outcomeCount ?? 0) + 1;
  const oracleOutcomeCount = (rule.oracleOutcomeCount ?? 0) + (isOracleScore ? 1 : 0);
  const prev = rule.successRate;
  const successRate = prev === null || prev === undefined ? score : prev + (score - prev) / n;
  return {
    ...rule,
    outcomeCount: n,
    oracleOutcomeCount,
    successRate,
    confidence: deriveConfidence(n, successRate),
    status: nextStatus(rule.status, n, successRate, coverageCreditConfirmed, oracleOutcomeCount),
  };
}

/** Context-directed attribution: fold an oracle outcome only onto rules that COULD have influenced it, so a global suite-quality score is not smeared across genuinely-irrelevant rules. Fail-open on two levels: (1) with no known diff archetypes, keep every rule; (2) PER RULE, an untagged rule (no archetype) carries no signal to discriminate on, so it is kept — only a rule whose archetype is PRESENT and does NOT match the diff is dropped as noise. Pure and deterministic. */
export function attributableRules(rules: LearningRule[], ctx: { diffArchetypes: string[] }): LearningRule[] {
  if (ctx.diffArchetypes.length === 0) return rules;
  const shapes = new Set(ctx.diffArchetypes);
  return rules.filter((r) => r.archetype == null || shapes.has(r.archetype));
}
