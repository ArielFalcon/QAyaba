/*
 * A test the report says was skipped (`test.skip`, `test.fixme`, a skipping condition): it did not run, so it is no case and
 * proves nothing, but it shows its spec file loaded and was reported. A file the report names no case and no skipped test of
 * did not load. `file` is as the report wrote it, the spec's top suite title.
 */
export interface SkippedTest {
  name: string;
  file?: string;
}
