/* Six-verdict test outcome and the user-facing engine status derived from it. engineStatus answers "did the engine produce a trustworthy result?", not "did every test pass?": a real bug found (fail → Issue) is SUCCESS; only an unrunnable/un-producible run is ERROR. */

export type RunVerdict = "pass" | "fail" | "flaky" | "invalid" | "infra-error" | "skipped";

export const RUN_ENGINE_STATUSES = { SUCCESS: "success", ERROR: "error" } as const;
export type RunEngineStatus = (typeof RUN_ENGINE_STATUSES)[keyof typeof RUN_ENGINE_STATUSES];

/* Fail-safe: a null/undefined verdict is ERROR. */
export function engineStatus(verdict: RunVerdict | null | undefined): RunEngineStatus {
  return verdict == null || verdict === "infra-error" || verdict === "invalid"
    ? RUN_ENGINE_STATUSES.ERROR
    : RUN_ENGINE_STATUSES.SUCCESS;
}
