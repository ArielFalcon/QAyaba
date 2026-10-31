/* How often and for how long a run waits for DEV to serve its commit. The primary app's gate polls quickly and gives up early; a service's deploy is slower, so its gate waits longer between polls and much longer overall. */

export const DEFAULT_DEPLOY_GATE_INTERVAL_MS = 2000;
export const DEFAULT_DEPLOY_GATE_TIMEOUT_MS = 60000;
export const DEFAULT_SERVICE_DEPLOY_GATE_INTERVAL_MS = 10_000;
export const DEFAULT_SERVICE_DEPLOY_GATE_TIMEOUT_MS = 600_000;

/* The part of an app's `dev` block, or of a declared service, that sets the gate. */
export interface DeployGateDeclaration {
  pollIntervalMs?: number | undefined;
  deployTimeoutMs?: number | undefined;
}

export interface DeployGateTiming {
  intervalMs: number;
  timeoutMs: number;
}

export function deployGateTiming(declared: DeployGateDeclaration, owner: "app" | "service"): DeployGateTiming {
  return owner === "service"
    ? { intervalMs: declared.pollIntervalMs ?? DEFAULT_SERVICE_DEPLOY_GATE_INTERVAL_MS, timeoutMs: declared.deployTimeoutMs ?? DEFAULT_SERVICE_DEPLOY_GATE_TIMEOUT_MS }
    : { intervalMs: declared.pollIntervalMs ?? DEFAULT_DEPLOY_GATE_INTERVAL_MS, timeoutMs: declared.deployTimeoutMs ?? DEFAULT_DEPLOY_GATE_TIMEOUT_MS };
}
