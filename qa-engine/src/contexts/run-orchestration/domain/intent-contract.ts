/*
 * The test-intent contract's extraction seam. Defined here as a structural mirror of the
 * objective-signal domain shapes (kernel-resident policy: this file imports no other context), so the
 * run judges the contract without depending on how a spec is parsed. Absent: the intent lock has nothing
 * to judge and never rejects.
 */

export type IntentClauseView = {
  readonly id: string;
  readonly kind: "locator" | "assertion";
  readonly literals: readonly string[];
  readonly expected?: string;
  readonly strength?: "truthy" | "presence" | "contains" | "exact";
  readonly negated?: boolean;
  readonly scope: readonly string[];
  readonly positional: readonly string[];
  readonly opaque: boolean;
};

export type SpecIntentView = {
  readonly file: string;
  readonly testName: string;
  readonly clauses: readonly IntentClauseView[];
};

export interface IntentContractExtractionView {
  readonly specs: readonly SpecIntentView[];
  readonly clauseCount: number;
  readonly opaqueCount: number;
  readonly opacityRatio: number;
}
