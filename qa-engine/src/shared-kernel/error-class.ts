/* Zero-LLM error taxonomy derived on every persisted RunOutcome. Hardcoding errorClass:null breaks the learning/governance flywheel (rule retrieval keys on this field). E-INFRA is recorded but excluded from learning — infrastructure failures teach nothing. E-STEP-BUDGET (the agent ran out of steps with no spec reported) is an engine-side infrastructure class that DOES feed learning; E-NO-DECISION (a verdict with no specs and no no-op) is recorded but never learned from. E-PRECONDITION (the app's login was positively evidenced to fail before generation) is recorded but never learned from: it says nothing about the tests or the engine. E-TIME-BUDGET (the generator's turn was cut off by the wall-clock budget its change allowed, or any agent turn by the run's own deadline, with no verdict reached) is the time counterpart of E-STEP-BUDGET but is never learned from: how long a turn takes is confounded by DEV latency, so it says nothing about the tests or the engine. E-REVIEWER-UNAVAILABLE (the reviewer's session failed or returned nothing, so the tests that passed were never judged) is recorded, never learned from, and is not a rejection: it opens no Issue and no PR. E-REVIEWER-REJECTED is not produced here; it is the corrections-distillation fallback in distill-rule.ts. E-REVIEW-DISPUTED (a verified blocking finding survived every round while the generator's rebuttal stayed unverified) is recorded, never learned from, and is neither a PR nor an Issue: the engine could not decide. */
import { GENERATION_END, type GenerationEndKind } from "@kernel/generation-end.ts";

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
  "E-STEP-BUDGET",
  "E-NO-DECISION",
  "E-NO-AUTHOR",
  /* mutation-scope:begin error-classes-precondition */
  "E-PRECONDITION",
  /* mutation-scope:end error-classes-precondition */
  "E-TIME-BUDGET",
  "E-REVIEWER-UNAVAILABLE",
  "E-REVIEW-DISPUTED",
  "E-SANDBOX",
  /* The shell's own classes: a run it ended itself, not one the engine classified. The learning gates decide they teach nothing. */
  "internal-error",
  "security-refusal",
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

/* Named handles for the classes other modules decide on, so none of them re-types the literal. */
/* mutation-scope:begin error-class-table */
export const ERROR_CLASS = {
/* mutation-scope:end error-class-table */
  INFRA: "E-INFRA",
  FLAKY: "E-FLAKY",
  STEP_BUDGET: "E-STEP-BUDGET",
  NO_DECISION: "E-NO-DECISION",
  NO_AUTHOR: "E-NO-AUTHOR",
  PRECONDITION: "E-PRECONDITION",
  TIME_BUDGET: "E-TIME-BUDGET",
  REVIEWER_UNAVAILABLE: "E-REVIEWER-UNAVAILABLE",
  REVIEW_DISPUTED: "E-REVIEW-DISPUTED",
  SANDBOX: "E-SANDBOX",
} as const satisfies Record<string, ErrorClass>;

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

/* The GRAVE class tags: anti-patterns that must block publish whatever severity the reviewer assigned (a false-positive test, one that misses the change, or one that leaves orphaned DEV data). Derived from TAG_TO_CLASS, the single source of the tag vocabulary, minus the recoverable `fragile-selector`, so a grave tag added to the vocabulary is grave here too and cannot reopen the downgrade-to-advisory hole the verdict gate closes. */
const RECOVERABLE_TAGS = new Set<string>(["fragile-selector"]);
export const GRAVE_TAGS: ReadonlySet<string> = new Set(Object.keys(TAG_TO_CLASS).filter((tag) => !RECOVERABLE_TAGS.has(tag)));

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
  /** How the generation ended, when it ended the run. An exhausted or undecided end names its own class. */
  generationEnd?: GenerationEndKind;
  /** The run ended on a positively evidenced setup failure (the app's login), before generation had anything to test. */
  preconditionFailed?: boolean;
  /** The run ended because its reviewer could not be reached or returned nothing: the tests were never judged, which is not a rejection. */
  reviewerUnavailable?: boolean;
  /** The run ended on a finding the reviewer verified and the generator disputed without evidence the orchestrator could check: a judgment it could not settle. */
  reviewDisputed?: boolean;
  /** The run ended because agent-influenced code could not be run safely (no sandbox uid, or the egress filter is down under enforce): nothing about the app or the tests. */
  /* mutation-scope:begin resolve-input-sandbox-flag */
  sandboxUnavailable?: boolean;
  /* mutation-scope:end resolve-input-sandbox-flag */
}

/* A generation end that ended the run names its class before anything the verdict implies, and a failed precondition follows it; then verdict-derived structural classes short-circuit, then reviewer corrections, then E-COVERAGE-GAP, then E-VALUE-SURVIVED (green + good coverage but mutants survive). */
export function resolveErrorClass(input: ResolveErrorClassInput): ErrorClass | null {
  if (input.generationEnd === GENERATION_END.EXHAUSTED) return ERROR_CLASS.STEP_BUDGET;
  if (input.generationEnd === GENERATION_END.TIME_BUDGET) return ERROR_CLASS.TIME_BUDGET;
  if (input.generationEnd === GENERATION_END.UNDECIDED_EMPTY) return ERROR_CLASS.NO_DECISION;
  if (input.generationEnd === GENERATION_END.NO_AUTHOR) return ERROR_CLASS.NO_AUTHOR;
  if (input.preconditionFailed) return ERROR_CLASS.PRECONDITION;
  if (input.reviewerUnavailable) return ERROR_CLASS.REVIEWER_UNAVAILABLE;
  if (input.reviewDisputed) return ERROR_CLASS.REVIEW_DISPUTED;
  if (input.sandboxUnavailable) return ERROR_CLASS.SANDBOX;

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
