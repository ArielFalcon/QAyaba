/*
 * What the intent lock found when it refused a regeneration, in the shape a correction turn can read.
 * Facts only: the rule the contract applies, the clause it touches, and what that clause held before
 * and after. The generator decides what to do with them; the orchestrator never restates them as an
 * order, and the same fields are what the run records (`gateSignals.intent` counts the rejected turn).
 */

/** One deterministic violation of a spec's test-intent contract. */
export interface ContractFeedback {
  /** The rule that fired (`weakened-matcher`, `dropped-assertion`, …). */
  readonly rule: string;
  readonly file: string;
  /** The clause the delta touched; `<contract>` for a file-level rule. */
  readonly clauseId: string;
  readonly before: string;
  readonly after: string;
}
