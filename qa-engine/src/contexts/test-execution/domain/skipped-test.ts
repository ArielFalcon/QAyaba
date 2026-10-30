/*
 * A test the report says was skipped (`test.skip`, `test.fixme`, `testInfo.skip()`, a skipping condition): it did not run, so it
 * is no case and proves nothing, but it shows its spec file loaded and was reported. A file the report names no case and no
 * skipped test of did not load. `file` is as the report wrote it, the spec's top suite title; `annotation` is the type of the
 * annotation that skipped it (`skip`, `fixme`), absent when the report carries none.
 */
export interface SkippedTest {
  name: string;
  file?: string;
  annotation?: string;
}

/*
 * A test the report says runs with `expectedStatus: "failed"` (`test.fail()`): a failure there is the expected result, so the
 * report calls it passed although nothing was asserted green. It is a case, but not a pass of the behavior it names.
 */
export interface ExpectedFailureTest {
  name: string;
  file?: string;
}
