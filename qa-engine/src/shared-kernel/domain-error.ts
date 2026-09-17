/* Sealed error taxonomy. Classified by type, never by substring-matching the message. InfraError means the run was inconclusive because of the environment (DEV down, deploy gate, git/network), not a code/test fault and not an orchestrator defect. */

export class InfraError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "InfraError";
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/* Agent layer could not produce a result for a non-code reason (provider rejected/rate-limited/length-limited/aborted/5xx). Never a code/test verdict. */
export class AgentUnavailableError extends InfraError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentUnavailableError";
  }
}

/* No agent activity for longer than the liveness-watchdog window — engine resilience, not the DEV environment. Distinct from AgentUnavailableError so alert routing can be specific. */
export class StalledAgentError extends InfraError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StalledAgentError";
  }
}

/* Hard deadline on an agent call. Distinct from StalledAgentError (inactivity watchdog) so the operator message can say the agent exceeded its budget. */
export class AgentTimeoutError extends InfraError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentTimeoutError";
  }
}

/* Name fallbacks cover cross-realm cases where `instanceof` fails; the message check covers operator cancel. */
export function isInfraError(err: unknown): boolean {
  if (err instanceof InfraError) return true;
  if (err instanceof Error && (err.name === "InfraError" || err.name === "AgentUnavailableError" || err.name === "StalledAgentError" || err.name === "AgentTimeoutError" || err.name === "DeployTimeoutError")) return true;
  if (err instanceof Error && /\brun cancelled by operator\b/i.test(err.message)) return true;
  return false;
}
