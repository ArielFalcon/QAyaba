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

/* A test a correction named, by the file and the title the correction gave it. The title only addresses the test the correction means; no rule below compares titles to decide anything else. */
export interface NamedTest {
  file: string;
  name: string;
}

export interface ModeRefusal {
  file: string;
  why: string;
}

const times = (n: number, what: string): string => `${n} more ${what}`;

/*
 * Why a changed file's tests no longer stand as a pass, read from the declared modes and the counts of the file alone: the tests that
 * were in its prior bytes (`prior`, the run before the regeneration) against the tests it reports now (`now`). A skipped test and a test
 * marked `test.fail()` that were already there are not refused (the regeneration did not make them); one more of either is, whatever its
 * title and however it came about (a renamed test is not an escape, nor is a new one added beside the fix). A file that had a failing
 * test and reports fewer tests declared to pass than before has dropped one rather than fixed it. A test a correction named that is
 * skipped or marked to fail now is refused whether or not it ran before. A file the report names nothing of is the silent rule's.
 */
export function modeRefusals(files: readonly string[], prior: ReportedTests, now: ReportedTests, named: readonly NamedTest[] = []): ModeRefusal[] {
  const refusals: ModeRefusal[] = [];
  for (const file of files) {
    const before = tallyOf(file, prior);
    const after = tallyOf(file, now);
    if (after.expectedFailures > before.expectedFailures) refusals.push({ file, why: times(after.expectedFailures - before.expectedFailures, "test(s) expected to fail (test.fail())") });
    if (after.skipped > before.skipped) refusals.push({ file, why: times(after.skipped - before.skipped, "skipped test(s)") });
    const reported = after.ran + after.expectedFailures + after.skipped > 0;
    if (reported && before.passing < before.ran && after.ran < before.ran) refusals.push({ file, why: "a test that was failing is gone from the file rather than fixed" });
    for (const test of named.filter((t) => sameFile(t.file, file))) {
      const skipped = (now.skippedTests ?? []).some((t) => sameFile(t.file, file) && t.name === test.name);
      const expectedToFail = now.cases.some((c) => sameFile(c.file, file) && c.name === test.name && c.expectedStatus === "failed");
      if (skipped || expectedToFail) refusals.push({ file, why: `the test a correction named is ${skipped ? "skipped" : "expected to fail (test.fail())"}` });
    }
  }
  return refusals;
}
