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

/**
 * The git dir git would use for a working copy is not the orchestrator's own: untrusted code may have replaced the
 * repository. A security refusal, not an infrastructure fault and not a code defect: it is never turned into an empty
 * result and never opens a maintainer incident, and the message carries repository-controlled text only in escaped form.
 */
export class UntrustedGitTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedGitTreeError";
  }
}

/* The name fallback covers cross-realm cases where `instanceof` fails. */
export function isUntrustedGitTreeError(err: unknown): boolean {
  return err instanceof UntrustedGitTreeError || (err instanceof Error && err.name === "UntrustedGitTreeError");
}

/** For every fail-open catch around a git call: an untrusted git dir is never a soft failure, so it is thrown on. Call it first in the catch block. */
export function rethrowIfUntrusted(err: unknown): void {
  if (isUntrustedGitTreeError(err)) throw err;
}

/* Name fallbacks cover cross-realm cases where `instanceof` fails; the message check covers operator cancel. */
export function isInfraError(err: unknown): boolean {
  if (err instanceof InfraError) return true;
  if (err instanceof Error && (err.name === "InfraError" || err.name === "AgentUnavailableError" || err.name === "StalledAgentError" || err.name === "AgentTimeoutError")) return true;
  if (err instanceof Error && /\brun cancelled by operator\b/i.test(err.message)) return true;
  return false;
}
