/*
 * Sealed error taxonomy. Classify by type, never by substring-matching the message.
 * InfraError = environment made the run inconclusive (DEV down, git/network, host pressure) —
 * not a code/test fault and not an orchestrator bug.
 */

export class InfraError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "InfraError";
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/*
 * Agent layer could not produce a result for a non-code reason (auth, credits, rate-limit,
 * abort). Inconclusive — never a code/test verdict. Own type so an out-of-credits run is not
 * blamed on the watched repo's tests.
 */
export class AgentUnavailableError extends InfraError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentUnavailableError";
  }
}

/* Agent stalled past the liveness window — still infra-error, never blamed on the watched repo. */
export class StalledAgentError extends InfraError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StalledAgentError";
  }
}

/* Name fallbacks cover instanceof failing across module/bundle realms. */
export function isInfraError(err: unknown): boolean {
  if (err instanceof InfraError) return true;
  if (err instanceof Error && (err.name === "InfraError" || err.name === "AgentUnavailableError" || err.name === "StalledAgentError" || err.name === "DeployTimeoutError")) return true;
  if (err instanceof Error && /\brun cancelled by operator\b/i.test(err.message)) return true;
  return false;
}
