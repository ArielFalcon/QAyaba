/* Six-verdict test outcome and the user-facing engine status derived from it. engineStatus answers "did the engine produce a trustworthy result?", not "did every test pass?": a real bug found (fail → Issue) is SUCCESS; only an unrunnable/un-producible run is ERROR. */

/*
 * Outcome of RUNNING the E2E tests against DEV.
 * pass        → everything green and stable
 * fail        → at least one case fails consistently (real Issue)
 * flaky       → unstable cases (pass sometimes, fail others) → quarantine
 * invalid     → generated specs did not pass the static gate (do not compile,
 * lint, or load): they were never executed
 * infra-error → the run is inconclusive due to infrastructure (DEV down, etc.):
 * NOT reported as a code bug
 * skipped     → the commit carries no tests (style/docs/chore without logic):
 * nothing is run
 */
export type RunVerdict = "pass" | "fail" | "flaky" | "invalid" | "infra-error" | "skipped";

export const RUN_ENGINE_STATUSES = { SUCCESS: "success", ERROR: "error" } as const;
export type RunEngineStatus = (typeof RUN_ENGINE_STATUSES)[keyof typeof RUN_ENGINE_STATUSES];

/* Fail-safe: a null/undefined verdict is ERROR. */
export function engineStatus(verdict: RunVerdict | null | undefined): RunEngineStatus {
  return verdict == null || verdict === "infra-error" || verdict === "invalid"
    ? RUN_ENGINE_STATUSES.ERROR
    : RUN_ENGINE_STATUSES.SUCCESS;
}
