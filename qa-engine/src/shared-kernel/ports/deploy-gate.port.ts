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
  verifyServed(sha: Sha, run: { source: TriggerSource }): Promise<Result<ServedVersionFact, InfraError>>;
  /** Waits until the declared source reports DEV healthy. A source that cannot be read is no evidence that DEV is unhealthy. Fails with an InfraError when the wait runs out. */
  waitUntilHealthy(): Promise<Result<true, InfraError>>;
}
