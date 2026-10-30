/*
 * What the report says about tests that did not run. A skipped test (`test.skip`, `test.fixme`, `testInfo.skip()`, a skipping
 * condition) is no case and proves nothing, but it shows its spec file loaded and was reported; the type is the kernel's, so every
 * context reads the same record. A test marked `test.fail()` is a case, and the status it declared is on the case itself
 * (`QaCase.expectedStatus`), not in a list of its own.
 */
export type { SkippedTest } from "@kernel/qa-case.ts";
