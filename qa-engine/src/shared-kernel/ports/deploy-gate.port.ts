/* Deploy-gate seam. Orchestration reads it at the entry of a run (what DEV serves, and DEV's health) and again before Playwright (health). Absent for static sites: the adapter records `undeclared` and reports healthy at once. */

import type { Result } from "@kernel/result.ts";
import type { InfraError } from "@kernel/domain-error.ts";
import type { Sha } from "@kernel/sha.ts";
import type { TriggerSource } from "@kernel/run-mode.ts";
import type { ServedVersionFact } from "@kernel/served-version.ts";

export interface DeployGatePort {
  /**
   * What DEV serves relative to `sha`, as one state of the closed set. A run started by a deploy waits while the state is `behind`
   * (the deploy has not landed) and fails with a `DeployNotServedError` when the wait runs out; every other state, and every state
   * of any other run, is recorded without waiting.
   */
  verifyServed(sha: Sha, run: { source: TriggerSource; startedAt?: number }): Promise<Result<ServedVersionFact, InfraError>>;
  /**
   * Waits until the declared source reports DEV healthy; a source that cannot be read is not healthy, so DEV going down is still
   * detected. `startedAt` is the clock of the entry's wait (the version wait and this one share one deadline); absent, the wait starts
   * now. With `servedSha`, DEV must also still serve that commit: another one ends the wait at once with a `DeployNotServedError`
   * carrying what was read. Fails with an InfraError when the wait runs out.
   */
  waitUntilHealthy(opts?: { startedAt?: number; servedSha?: Sha }): Promise<Result<true, InfraError>>;
}
