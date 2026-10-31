/*
 * An error Playwright reported for the run as a whole rather than for a test: a spec that did not load (a syntax or type
 * error, a bad import, `test.use` in the wrong scope, a duplicate title) ends the run with a report that holds no test and
 * these errors under its top-level `errors`. Read from the report's JSON, never from the process output.
 */
export interface SpecLoadError {
  message: string;
  /* Where Playwright placed it. `file` is relative to the spec directory; it is absent when the file lies outside it. */
  location?: { file: string; line?: number; column?: number };
}

/* Safety bounds on a report the child wrote: how many errors are kept and how long each message may be before it travels. */
export const MAX_LOAD_ERRORS_KEPT = 50;
export const LOAD_ERROR_MESSAGE_SAFETY_BOUND = 8_000;

/* Whether a file as the report wrote it lies inside the suite: relative, and never reaching out of it. Anything else is a host path and is not shown. */
export function isSuiteRelative(file: string): boolean {
  return file !== "" && !file.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(file) && !file.split(/[\\/]/).includes("..");
}
