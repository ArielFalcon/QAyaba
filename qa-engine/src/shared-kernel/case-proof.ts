/*
 * What a report's tests prove, by the mode each declared and never by its title. One place decides it for every proof writer (the first
 * pass, the closed loop's `run_spec`, a regeneration's acceptance, the suite store's admission) and for the rule against a test that
 * stops being a pass. A file is proven when its bytes ran with at least one real passing case: a case that executed, was declared to
 * pass and passed. A file whose tests were all skipped, are all marked `test.fail()` or did not run has no proof. Pure.
 */
import type { QaCase, SkippedTest } from "./qa-case.ts";
import { normalizeSpecPath } from "./spec-path.ts";

/* What an execution reported of its tests: the cases that ran and the tests it says were skipped. */
export interface ReportedTests {
  cases: readonly QaCase[];
  skippedTests?: readonly SkippedTest[];
}

/* A case that executed, was declared to pass and passed. A case recorded without a declared status is read as the runner reports it: an execution that states none (the repo's own test runner) has no `test.fail()` to state. */
export const isRealPass = (c: QaCase): boolean => c.status === "pass" && c.expectedStatus !== "failed" && c.expectedStatus !== "not-run";

export const sameFile = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && normalizeSpecPath(a) === normalizeSpecPath(b);

/*
 * Whether `file`'s bytes ran with at least one real passing case of their own. An execution that names a file for none of its cases (a
 * runner that cannot attribute, as the repo's own test runner) cannot say which file a case belongs to, so its real passes stand for the
 * whole run; one that names a file for any case is read strictly, and a case with none proves no file.
 */
export const hasProof = (file: string, cases: readonly QaCase[]): boolean =>
  cases.some((c) => c.file !== undefined) ? cases.some((c) => sameFile(c.file, file) && isRealPass(c)) : hasRealPass(cases);

/* Whether any case of the execution is a real pass: what a single spec's run must show before it says "passed". */
export const hasRealPass = (cases: readonly QaCase[]): boolean => cases.some(isRealPass);

/* The tests of one spec file by the mode each declared. `ran` counts the cases that executed and were declared to pass (whatever came of them), `passing` those of them that passed. */
export interface ModeTally {
  ran: number;
  passing: number;
  expectedFailures: number;
  skipped: number;
}

export function tallyOf(file: string, reported: ReportedTests): ModeTally {
  const tally: ModeTally = { ran: 0, passing: 0, expectedFailures: 0, skipped: 0 };
  for (const c of reported.cases) {
    if (!sameFile(c.file, file) || c.expectedStatus === "not-run") continue;
    if (c.expectedStatus === "failed") tally.expectedFailures += 1;
    else {
      tally.ran += 1;
      if (c.status === "pass") tally.passing += 1;
    }
  }
  tally.skipped = (reported.skippedTests ?? []).filter((t) => sameFile(t.file, file)).length;
  return tally;
}
