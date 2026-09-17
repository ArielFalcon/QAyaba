/* Narrow Playwright launch/host signatures only — matched from Playwright's own error strings, kept narrow so a genuine failure is never relabeled as infra.
`Target (page|context|browser) ... closed` is deliberately excluded: the app under test crashing the tab produces the same string, so reclassifying it fail→infra-error would hide a genuine bug. */
export const PLAYWRIGHT_INFRA_RE =
  /browserType\.(?:launch|connect)|Executable doesn't exist|Failed to launch|missing dependencies to run browsers|Host system is missing dependencies/i;
