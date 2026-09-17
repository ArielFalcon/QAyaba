/* Canonical secret-redaction seam. Everything leaving the system (diff → model, execution logs → Issue) passes through an adapter of this port. qa-engine must not import src/; src/orchestrator/sanitizer.ts is the shell-side twin and re-exports SecretLeakError from here. */

export const REDACTED = "[REDACTED]";

export interface RedactionPort {
  /** Replace every detected secret with REDACTED. Pure and deterministic. */
  redact(text: string): string;
  /** True when the text still contains a detectable secret after redaction. Fail-loud at the logs→Issue boundary; the diff→model path uses the same guard on the shell sanitizer. */
  containsSecret(text: string): boolean;
}

/** Thrown by the post-redaction fail-loud egress guard. Lives in the kernel because qa-engine must not import src/. */
export class SecretLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretLeakError";
  }
}
