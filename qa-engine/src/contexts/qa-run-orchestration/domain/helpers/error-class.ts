/* Zero-LLM error taxonomy derived on every persisted RunOutcome. Hardcoding errorClass:null breaks the learning/governance flywheel (rule retrieval keys on this field). E-INFRA is recorded but excluded from learning — infrastructure failures teach nothing. E-REVIEWER-REJECTED is not produced here; it is the corrections-distillation fallback in distill-rule.ts. */

export const ERROR_CLASSES = [
  "E-STATIC",
  "E-EXEC-FAIL",
  "E-FLAKY",
  "E-COVERAGE-GAP",
  "E-FALSE-POSITIVE",
  "E-WRONG-OBJECTIVE",
  "E-FRAGILE-SELECTOR",
  "E-NO-CLEANUP",
  "E-REVIEWER-REJECTED",
  "E-VALUE-SURVIVED",
  "E-INFRA",
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

/* Reviewer anti-pattern keywords. */
const AP_FALSE_POSITIVE = /\b(?:asserts? nothing|asserts? 200|no real assertion|test clicks? without asserting|false positive|green noise|trivial assert|passes? when feature is broken)\b/i;
const AP_WRONG_OBJECTIVE = /\b(?:not tied to the (?:commit|change|diff)|misses? the (?:change|intent|objective)|tests? the wrong thing|irrelevant to the diff|does not test the change)\b/i;
const AP_FRAGILE_SELECTOR = /\b(?:fragile selector|ambiguous (?:selector|regex|locator)|text selector|nth-child|hardcoded index|brittle locator|magic string)\b/i;
const AP_NO_CLEANUP = /\b(?:no cleanup|does not clean up|orphaned (?:data|test data)|pollutes? DEV|missing cleanup|test data left behind)\b/i;

const TAG_TO_CLASS: Record<string, ErrorClass> = {
  "false-positive": "E-FALSE-POSITIVE",
  "wrong-objective": "E-WRONG-OBJECTIVE",
  "fragile-selector": "E-FRAGILE-SELECTOR",
  "no-cleanup": "E-NO-CLEANUP",
};

function classifyReviewerCorrection(correction: string): ErrorClass | null {
  const tag = /^\s*\[([a-z][a-z-]*)\]/i.exec(correction)?.[1]?.toLowerCase();
  if (tag) {
    const mapped = TAG_TO_CLASS[tag];
    if (mapped) return mapped;
    if (tag === "other") return null; /* explicitly classified as none of the buckets — do not re-guess */
    /* unrecognized tag (typo) falls through to the keyword heuristics below */
  }
  if (AP_FALSE_POSITIVE.test(correction)) return "E-FALSE-POSITIVE";
  if (AP_WRONG_OBJECTIVE.test(correction)) return "E-WRONG-OBJECTIVE";
  if (AP_FRAGILE_SELECTOR.test(correction)) return "E-FRAGILE-SELECTOR";
  if (AP_NO_CLEANUP.test(correction)) return "E-NO-CLEANUP";
  return null;
}

/* Dominant ErrorClass from reviewer corrections. First match wins (reviewer lists the most critical first). Null when no anti-pattern is recognized. */
export function errorClassFromCorrections(corrections: string[]): ErrorClass | null {
  for (const c of corrections) {
    const cls = classifyReviewerCorrection(c);
    if (cls) return cls;
  }
  return null;
}

/* ErrorClass from verdict alone: E-STATIC, E-EXEC-FAIL, E-FLAKY, E-INFRA, E-COVERAGE-GAP. */
export function errorClassFromVerdict(
  verdict: string,
  coverageRatio: number | null,
  minRatio: number,
): ErrorClass | null {
  switch (verdict) {
    case "invalid":
      return "E-STATIC";
    case "fail":
      return "E-EXEC-FAIL";
    case "flaky":
      return "E-FLAKY";
    case "infra-error":
      return "E-INFRA";
    case "pass":
      /* Green runs can still have a coverage gap. */
      if (coverageRatio !== null && coverageRatio < minRatio) return "E-COVERAGE-GAP";
      return null; /* healthy green → no error class */
    case "skipped":
      return null; /* skipped runs teach nothing */
    default:
      return null;
  }
}

export interface ResolveErrorClassInput {
  verdict: string;
  coverageRatio: number | null;
  minCoverageRatio: number;
  reviewerCorrections: string[];
  valueScore?: number | null;
}

/* Verdict-derived structural classes short-circuit first, then reviewer corrections, then E-COVERAGE-GAP, then E-VALUE-SURVIVED (green + good coverage but mutants survive). */
export function resolveErrorClass(input: ResolveErrorClassInput): ErrorClass | null {
  const fromVerdict = errorClassFromVerdict(input.verdict, input.coverageRatio, input.minCoverageRatio);

  if (fromVerdict === "E-INFRA") return "E-INFRA";
  if (fromVerdict === "E-STATIC") return "E-STATIC";
  if (fromVerdict === "E-EXEC-FAIL") return "E-EXEC-FAIL";
  if (fromVerdict === "E-FLAKY") return "E-FLAKY";

  const fromReviewer = errorClassFromCorrections(input.reviewerCorrections);
  if (fromReviewer) return fromReviewer;

  if (fromVerdict === "E-COVERAGE-GAP") return "E-COVERAGE-GAP";

  /* E-VALUE-SURVIVED: green + good coverage but mutants survive (the deepest false positive) */
  if (input.verdict === "pass" && input.valueScore !== null && input.valueScore !== undefined && input.valueScore < 0.5) {
    return "E-VALUE-SURVIVED";
  }

  return null;
}
