/*
 * What a report's tests prove, by the mode each declared and never by its title. One place decides it for every proof writer (the first
 * pass, the closed loop's `run_spec`, a regeneration's acceptance, the suite store's admission) and for the rule against a test that
 * stops being a pass. A file is proven when its bytes ran with at least one real passing case: a case that executed, was declared to
 * pass and passed. A file whose tests were all skipped, are all marked `test.fail()` or did not run has no proof. Pure.
 */
import type { QaCase, SkippedTest } from "./qa-case.ts";
import type { RunVerdict } from "./run-verdict.ts";
import { sameSpecPath } from "./spec-path.ts";

/* A test by the file it sits in and its title path (the describe titles and the test's own, joined by " › "). */
export interface NamedTest {
  file: string;
  name: string;
}

/* What an execution reported of its tests: the cases that ran and the tests it says were skipped, and the tests that intercept requests (read from the spec's text by the caller, since a report says nothing of them). */
export interface ReportedTests {
  cases: readonly QaCase[];
  skippedTests?: readonly SkippedTest[];
  interceptedTests?: readonly NamedTest[];
}

export const TITLE_SEPARATOR = " › ";

/* The title path a case's name holds after the file's own title: the report names a case `<file title> › <describe titles> › <test title>`. */
export function titlePathOf(c: Pick<QaCase, "name">): string | undefined {
  const at = c.name.indexOf(TITLE_SEPARATOR);
  return at === -1 ? undefined : c.name.slice(at + TITLE_SEPARATOR.length);
}

/* A case that executed, was declared to pass and passed. A case recorded without a declared status is a stored case from before the declaration was kept: it states no `test.fail()` or skip, and is read as a test that was declared to pass. */
export const isRealPass = (c: QaCase): boolean => c.status === "pass" && c.refused !== true && c.expectedStatus !== "failed" && c.expectedStatus !== "skipped";

/*
 * Whether `file`'s bytes ran with at least one real passing case of their own. A case names the file it belongs to (every report does,
 * suite-relative), and a case that names none proves no file: no pass stands for a file by being the only one the run reported.
 */
export const hasProof = (file: string, cases: readonly QaCase[]): boolean => cases.some((c) => sameSpecPath(c.file, file) && isRealPass(c));

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
    if (!sameSpecPath(c.file, file) || c.refused === true) continue;
    if (c.expectedStatus === "failed") tally.expectedFailures += 1;
    else {
      tally.ran += 1;
      if (c.status === "pass") tally.passing += 1;
    }
  }
  tally.skipped = (reported.skippedTests ?? []).filter((t) => sameSpecPath(t.file, file)).length;
  return tally;
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
    for (const test of named.filter((t) => sameSpecPath(t.file, file))) {
      const skipped = (now.skippedTests ?? []).some((t) => sameSpecPath(t.file, file) && t.name === test.name);
      const expectedToFail = now.cases.some((c) => sameSpecPath(c.file, file) && c.name === test.name && c.expectedStatus === "failed");
      if (skipped || expectedToFail) refusals.push({ file, why: `the test a correction named is ${skipped ? "skipped" : "expected to fail (test.fail())"}` });
    }
    const intercepting = (now.interceptedTests ?? []).filter((t) => sameSpecPath(t.file, file));
    if (intercepting.length > 0) refusals.push({ file, why: `${intercepting.length} test(s) intercepting requests` });
  }
  return refusals;
}

export interface RefusedTests {
  /* The report's cases without the tests marked to fail it refused. */
  cases: QaCase[];
  /* The report's skipped tests without the ones it refused. */
  skippedTests: SkippedTest[];
  /* One failing case per refused test, named as the test is, marked `refused`: what the author is told and what the fix loop repairs. */
  refused: QaCase[];
}

const skipMessage = (t: SkippedTest): string =>
  `"${t.name}" is skipped${t.annotation ? ` (test.${t.annotation})` : ""}: a skipped test is not a pass and proves nothing, whatever the app's own lint says. Make it run and pass, or remove it.`;
const expectedFailureMessage = (name: string): string =>
  `"${name}" is marked test.fail(): a test expected to fail is not a pass of the behavior it names, whatever the app's own lint says. Fix the behavior it checks, or remove the test.`;
const interceptionMessage = (name: string): string =>
  `"${name}" intercepts requests: a test that answers or alters the responses the page reads checks a fake contract, not DEV, and hides the defects of the backend. Remove the interception and assert what the page does with DEV's real responses; a state DEV cannot reach is reported unmet, never stubbed.`;

/*
 * The engine's rule where there is no earlier run to compare with (the first pass over the files a run delivered, and a single spec
 * run through `run_spec`): every skipped test, every test marked `test.fail()` and every test that intercepts requests in `files` is
 * refused, so none of them is a pass, whatever the app's own lint says. They leave the report and come back as failing cases the author
 * can read and the fix loop can repair; the tests that remain are the baseline a later round is compared with, and a round that keeps a
 * refused test has added one. An intercepting test is refused whether or not it ran. `files` absent: every test of the report is judged
 * (a run of one spec file).
 */
export function refuseOutright(reported: ReportedTests, files?: readonly string[]): RefusedTests {
  const judged = (file: string | undefined): boolean => files === undefined || files.some((f) => sameSpecPath(f, file));
  const intercepting = (reported.interceptedTests ?? []).filter((t) => judged(t.file));
  const refused: QaCase[] = [];
  const cases: QaCase[] = [];
  const interceptionOf = (c: QaCase): NamedTest | undefined => intercepting.find((t) => sameSpecPath(t.file, c.file) && t.name === (titlePathOf(c) ?? c.name));
  const refusedByInterception = new Set<NamedTest>();
  for (const c of reported.cases) {
    const interception = interceptionOf(c);
    if (interception !== undefined) {
      refusedByInterception.add(interception);
      refused.push({ name: c.name, status: "fail", refused: true, detail: interceptionMessage(c.name), ...(c.file !== undefined ? { file: c.file } : {}) });
    } else if (c.expectedStatus === "failed" && judged(c.file)) refused.push({ name: c.name, status: "fail", expectedStatus: "failed", refused: true, detail: expectedFailureMessage(c.name), ...(c.file !== undefined ? { file: c.file } : {}) });
    else cases.push(c);
  }
  for (const t of intercepting) {
    if (!refusedByInterception.has(t)) refused.push({ name: `${t.file} › ${t.name}`, status: "fail", refused: true, detail: interceptionMessage(t.name), file: t.file });
  }
  const skippedTests: SkippedTest[] = [];
  for (const t of reported.skippedTests ?? []) {
    if (judged(t.file)) refused.push({ name: t.name, status: "fail", expectedStatus: "skipped", refused: true, detail: skipMessage(t), ...(t.file !== undefined ? { file: t.file } : {}) });
    else skippedTests.push(t);
  }
  return { cases, skippedTests, refused };
}

/*
 * The verdict of an execution once its refused tests are counted: a pass or a flaky run that holds a refused test fails, and so does a
 * run that executed nothing because every test it found was a refused skip (a suite of skipped tests reports no case, which the runner
 * calls infrastructure). An infrastructure fault that executed a test stays one: when the browser cannot launch, the tests that ran fail
 * on the runner and Playwright counts a declared `test.fail()` as the failure it expected, which says nothing about the suite.
 */
export function verdictAfterRefusal(verdict: RunVerdict, judged: RefusedTests): RunVerdict {
  if (judged.refused.length === 0) return verdict;
  if (verdict === "pass" || verdict === "flaky") return "fail";
  const executedNothing = judged.cases.length === 0 && judged.refused.every((c) => c.expectedStatus === "skipped");
  return verdict === "infra-error" && executedNothing ? "fail" : verdict;
}
