/* DeployGatePort: poll /version until the SHA is serving. Timeout resolves InfraError — never throws. The poll primitive is injected so this adapter needs no network in its own tests. */

import type { Sha } from "@kernel/sha.ts";
import type { Result } from "@kernel/result.ts";
import { ok, err } from "@kernel/result.ts";
import { InfraError } from "@kernel/domain-error.ts";
import type { DeployGatePort } from "@kernel/ports/deploy-gate.port.ts";

export type VersionPollFn = (versionUrl: string, sha: Sha) => Promise<{ serving: boolean }>;

export interface DeployGatePortConfig {
  versionUrl: string;
  intervalMs: number;
  timeoutMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DeployGatePortAdapter implements DeployGatePort {
  constructor(
    private readonly poll: VersionPollFn,
    private readonly cfg: DeployGatePortConfig,
  ) {}

  async waitUntilServing(sha: Sha): Promise<Result<true, InfraError>> {
    const deadline = Date.now() + this.cfg.timeoutMs;
    while (Date.now() < deadline) {
      const { serving } = await this.poll(this.cfg.versionUrl, sha);
      if (serving) return ok(true);
      if (this.cfg.intervalMs > 0) await sleep(this.cfg.intervalMs);
    }
    return err(new InfraError(`DEV did not serve sha ${sha.toString()} within ${this.cfg.timeoutMs}ms (versionUrl=${this.cfg.versionUrl})`));
  }
}

/* Always ready — no /version to poll (static sites and the code target). */
export class NullDeployGateAdapter implements DeployGatePort {
  async waitUntilServing(_sha: Sha): Promise<Result<true, InfraError>> {
    return ok(true);
  }
}
