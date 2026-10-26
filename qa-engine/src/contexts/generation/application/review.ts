import type { RetrievedRule } from "@contexts/cross-run-learning/application/index.ts";
import type { QaCase } from "@kernel/qa-case.ts";

/**
 * `priorCorrections` lets the next review judge convergence on previously
 * raised blocking issues instead of inventing new nits.
 */
export interface ReviewEnrichment {
  priorCorrections?: readonly string[];
  /* The spec lines that changed since the prior rejection, already bounded and rendered. */
  specChanges?: string;
  /* Paths of the suite's existing specs: context only, never a target and never a reason to reject. */
  existingSpecFiles?: readonly string[];
  /**
   * Same retrieved rules the generator saw. The adapter renders only active
   * rules; candidates are for the generator to explore, never for the judge to
   * gate on.
   */
  learnedRules?: readonly RetrievedRule[];
  /**
   * Live DEV a11y snapshot of routes under review. Absent: the reviewer defers
   * on unverifiable UI facts.
   */
  domSnapshot?: string;
  /**
   * The run's own execution of the specs under review (verdict and cases). The adapter renders it as
   * the reviewer's execution evidence, so an app defect (a 5xx, a redirect, a runtime error) is
   * distinguishable from a test defect without asking the generator. Absent: the prompt carries none.
   */
  executionEvidence?: { verdict: string; cases: readonly QaCase[] };
  /** Per-run id for the reviewer SSE session (separate from the generator's). */
  runId?: string;
}
