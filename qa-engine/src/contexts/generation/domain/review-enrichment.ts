import type { RetrievedRule } from "@kernel/learned-rule.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { ReviewChangeView } from "./review-change-view.ts";

/**
 * `priorCorrections` lets the next review judge convergence on previously
 * raised blocking issues instead of inventing new nits.
 */
import type { RouteAvailabilityFact } from "@kernel/route-availability.ts";

export interface ReviewEnrichment {
  priorCorrections?: readonly string[];
  /* The arms of the changed code no delivered test ran, when the measurement describes the bytes under review: the facts a missing case cites. */
  untakenArms?: readonly { file: string; line: number; kind: string; arm: string }[];
  /* Why the routes the run's capture could not show at their own address were not: the facts an `availability` citation names. */
  routeAvailability?: readonly RouteAvailabilityFact[];
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
  /* On a run with a plan: the change by flow under review, which the reviewer receives instead of the whole diff. */
  changeView?: ReviewChangeView;
  /** Per-run id for the reviewer SSE session (separate from the generator's). */
  runId?: string;
}
