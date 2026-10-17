/*
 * The deterministic graders: pure functions from a run's evidence to scores. A grader says nothing when it has no data (a score
 * absent is "not measurable", never a fabricated 0), and never grades a run that has not finished. Definitions follow
 * docs/observability-design.md §11.2; every BOOLEAN is pass-oriented (`true` = the check passed, the problem is absent).
 */

import { RUN_PHASES } from "@contexts/qa-run-orchestration/domain/run-phase-cursor";
import { STEP_INTENTS, scoreOf } from "./grader-catalog.ts";
import type { RunEvaluationEvidence as Evidence } from "./run-evaluation-evidence.ts";
import type { RawScore, Score } from "./score.ts";

export interface Grader {
  /* The catalog base names this grader emits: what a regrade request names to run only some graders. */
  readonly names: readonly string[];
  grade(evidence: Evidence): RawScore[];
}

const ratio = (part: number, whole: number): number => part / whole;

/* The run was let through: it passed, or it chose to publish a PR. */
function accepted(e: Evidence): boolean {
  return e.verdict === "pass" || e.decision === "pr";
}

/* A run with no verdict has nothing to grade. */
const finishedOnly = (grade: (e: Evidence) => RawScore[]) => (e: Evidence): RawScore[] => (e.finished && e.verdict !== null ? grade(e) : []);

const emptyOutputGuard: Grader = {
  names: ["empty_output_guard"],
  grade: finishedOnly((e) => {
    /* A context run delivers no specs by design. */
    if (e.mode === "context") return [];
    if (!accepted(e)) return [{ name: "empty_output_guard", value: true }];
    const problems: string[] = [];
    if (e.specs.valid === 0) problems.push("accepted with no valid spec delivered by this run");
    if (e.reviewRequired !== false && e.reviewerTurns === 0) problems.push("accepted without a reviewer turn");
    return [{ name: "empty_output_guard", value: problems.length === 0, ...(problems.length > 0 ? { comment: problems.join("; ") } : {}) }];
  }),
};

const furthestPhase: Grader = {
  names: ["furthest_phase"],
  grade: (e) => (e.finished && e.furthestPhase !== null && (RUN_PHASES as readonly string[]).includes(e.furthestPhase) ? [{ name: "furthest_phase", value: e.furthestPhase }] : []),
};

const specValidityRate: Grader = {
  names: ["spec_validity_rate"],
  grade: (e) => (e.finished && e.specs.generated > 0 ? [{ name: "spec_validity_rate", value: ratio(e.specs.valid, e.specs.generated), comment: `${e.specs.valid} of ${e.specs.generated}` }] : []),
};

const specPassRate: Grader = {
  names: ["spec_pass_rate"],
  grade: (e) => (e.finished && e.specs.valid > 0 ? [{ name: "spec_pass_rate", value: ratio(e.specs.passed, e.specs.valid), comment: `${e.specs.passed} of ${e.specs.valid}` }] : []),
};

const budgetExhaustion: Grader = {
  names: ["budget_exhaustion"],
  grade: finishedOnly((e) => [{ name: "budget_exhaustion", value: e.limit ? `${e.limit.fired}@${e.furthestPhase ?? "unknown"}/${e.limit.role ?? "unknown"}` : "none" }]),
};

const approvalConsistent: Grader = {
  names: ["approval_consistent"],
  grade: finishedOnly((e) => {
    if (e.mode === "context") return [];
    const said: string[] = [];
    if (e.signals) {
      if (!e.signals.static) said.push("static checks failed");
      if ((e.signals.catalogGateFailClosed ?? 0) > 0) said.push("catalog gate failed closed");
      if (e.signals.coverageMode === "enforce" && coverageClass(e) === "fail") said.push("change-coverage below the enforced threshold");
    }
    const inconsistent = accepted(e) && said.length > 0;
    return [{ name: "approval_consistent", value: !inconsistent, ...(inconsistent ? { comment: `accepted while: ${said.join("; ")}` } : {}) }];
  }),
};

/* unknown is its own class and never passes: an unmeasured run says nothing about coverage. */
function coverageClass(e: Evidence): "pass" | "fail" | "unknown" {
  const ratioValue = e.signals?.coverageRatio;
  if (ratioValue === null || ratioValue === undefined) return "unknown";
  return ratioValue >= (e.signals?.coverageMinRatio ?? Number.POSITIVE_INFINITY) ? "pass" : "fail";
}

const changeCoverage: Grader = {
  names: ["change_coverage"],
  grade: (e) => (e.finished && e.signals ? [{ name: "change_coverage", value: coverageClass(e) }] : []),
};

const mutationValue: Grader = {
  names: ["mutation_value"],
  grade: (e) => {
    const s = e.signals;
    if (!e.finished || !s || s.mutantCount === undefined || s.killedCount === undefined || s.mutantCount <= 0) return [];
    return [{ name: "mutation_value", value: ratio(s.killedCount, s.mutantCount), comment: `${s.killedCount} of ${s.mutantCount} mutants killed` }];
  },
};

const infraError: Grader = {
  names: ["infra_error"],
  grade: finishedOnly((e) => [{ name: "infra_error", value: e.verdict === "infra-error" ? (e.errorClass ?? "unclassified") : "none" }]),
};

const stepIntent: Grader = {
  names: ["step_intent_mix", "auth_overhead"],
  grade: (e) => {
    if (!e.finished || !e.stepIntents) return [];
    const counts: Record<string, number> = Object.fromEntries(STEP_INTENTS.map((i) => [i, 0]));
    for (const [intent, n] of Object.entries(e.stepIntents)) {
      const key = (STEP_INTENTS as readonly string[]).includes(intent) ? intent : "other";
      counts[key] = (counts[key] ?? 0) + n;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) return [];
    return [
      ...STEP_INTENTS.map((i) => ({ name: `step_intent_mix.${i}`, value: ratio(counts[i] ?? 0, total) })),
      { name: "auth_overhead", value: ratio(counts.auth ?? 0, total), comment: `${counts.auth ?? 0} of ${total} steps` },
    ];
  },
};

export const GRADERS: readonly Grader[] = [
  emptyOutputGuard,
  furthestPhase,
  specValidityRate,
  specPassRate,
  budgetExhaustion,
  approvalConsistent,
  changeCoverage,
  mutationValue,
  infraError,
  stepIntent,
];

/* Runs the graders that emit one of `only` (all of them when absent) and returns the catalog-typed scores. A throwing grader is not caught here. */
export function gradeEvidence(evidence: Evidence, only?: readonly string[]): Score[] {
  const wanted = only ? new Set(only) : undefined;
  return GRADERS.filter((g) => !wanted || g.names.some((n) => wanted.has(n))).flatMap((g) => g.grade(evidence).map(scoreOf));
}
