import { RunVerdictSchema } from "./contract/events";
import { engineStatus, RUN_ENGINE_STATUSES } from "./types";

/*
 * CLI exit-code: 0 when the engine produced a trustworthy result — including a real bug found
 * (verdict `fail` → Issue). Only infra-error/invalid (or no verdict) is non-zero. An unknown
 * wire value never silently counts as success.
 */
export function runSucceeded(verdict: string | null | undefined): boolean {
  const parsed = RunVerdictSchema.safeParse(verdict);
  return engineStatus(parsed.success ? parsed.data : null) === RUN_ENGINE_STATUSES.SUCCESS;
}
