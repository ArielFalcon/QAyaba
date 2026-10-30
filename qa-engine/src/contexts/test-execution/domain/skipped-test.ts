/*
 * What the report says about tests that did not stand as a pass. A skipped test (`test.skip`, `test.fixme`, `testInfo.skip()`, a
 * skipping condition) did not run, so it is no case and proves nothing, but it shows its spec file loaded and was reported; the type is the
 * kernel's, so every context reads the same record. A test that runs with `expectedStatus: "failed"` (`test.fail()`) is a case, and the
 * status it declared is on the case itself (`QaCase.expectedStatus`), not in a list of its own.
 */
export type { SkippedTest } from "@kernel/qa-case.ts";

/*
 * A test the report says runs with `expectedStatus: "failed"` (`test.fail()`): a failure there is the expected result, so the
 * report calls it passed although nothing was asserted green. It is a case, but not a pass of the behavior it names.
 */
export interface ExpectedFailureTest {
  name: string;
  file?: string;
}
