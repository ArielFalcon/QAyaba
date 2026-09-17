/* Deploy-gate seam. Both orchestration (wait for DEV before any phase) and test-execution (health before Playwright) consume this. Absent for static sites and the code target — the adapter returns ok(true) immediately. */

import type { Result } from "@kernel/result.ts";
import type { InfraError } from "@kernel/domain-error.ts";
import type { Sha } from "@kernel/sha.ts";

export interface DeployGatePort {
  waitUntilServing(sha: Sha): Promise<Result<true, InfraError>>;
}
