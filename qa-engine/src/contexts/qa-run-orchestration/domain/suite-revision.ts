/*
 * SuiteRevision: the one admitted result of an executed suite. `files` is the sha256 of each spec's bytes as it ran (the
 * fingerprint), `verdict`/`cases` the executed outcome, `namespace` the execution's test-data namespace. Only an executed
 * pass/fail/flaky outcome admits a revision — a validation failure or an execution infra-error has no revision, and the run
 * ends through its existing terminal instead.
 */

import type { QaCase } from "@kernel/qa-case.ts";

/** The verdicts an executed suite can have. Anything else never ran and has no revision. */
export type SuiteRevisionVerdict = "pass" | "fail" | "flaky";

export interface SuiteRevision {
  readonly files: ReadonlyMap<string, string>;
  readonly verdict: SuiteRevisionVerdict;
  readonly cases: readonly QaCase[];
  readonly namespace: string;
}

/** Whether a verdict is one an executed suite can report (pass, fail, flaky). */
export function isExecutedVerdict(verdict: string): verdict is SuiteRevisionVerdict {
  return verdict === "pass" || verdict === "fail" || verdict === "flaky";
}

/** The sole constructor: returns a revision only for an executed verdict, so a non-executed terminal can never masquerade as one. */
export function suiteRevision(input: {
  files: ReadonlyMap<string, string>;
  verdict: string;
  cases: readonly QaCase[];
  namespace: string;
}): SuiteRevision | undefined {
  if (!isExecutedVerdict(input.verdict)) return undefined;
  return { files: input.files, verdict: input.verdict, cases: input.cases, namespace: input.namespace };
}
