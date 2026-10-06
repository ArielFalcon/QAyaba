/*
 * The deployment cannot take the requested agent runtime configuration (a provider it does not offer).
 * Distinct from an invalid request: the operator asked for something well-formed that this install
 * will never do, so the control API answers 422 with the reason.
 */
export class AgentConfigRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigRefusedError";
  }
}
