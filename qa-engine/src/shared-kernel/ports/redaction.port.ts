/* Canonical secret-redaction seam. Everything leaving the system (diff → model, execution logs → Issue, delegation briefs → provider) passes through an adapter of this port. qa-engine must not import src/; the shell adapter in src/orchestrator/sanitizer.ts re-exports SecretLeakError from here. */

export const REDACTED = "[REDACTED]";

/** "issue" (default) is the aggressive Issue-bound policy. "model" narrows api-key-assignment to a quoted literal or a high-entropy bare token so a diff→model prompt keeps code shapes like `password: string`. */
export type RedactionMode = "issue" | "model";

export interface SecretDetection {
  redacted: boolean;
  patterns: string[];
  /** Total redactions across all patterns. */
  count: number;
}

export interface RedactionPort {
  /** Replace every detected secret with REDACTED. Pure and deterministic. */
  redact(text: string, mode?: RedactionMode): string;
  /** What `redact` found in the text: whether anything was redacted, under which pattern names, and how many times. */
  detect(text: string, mode?: RedactionMode): SecretDetection;
  /** True when the text still contains a detectable secret after redaction. Fail-loud at the logs→Issue boundary; the diff→model path uses the same guard. */
  containsSecret(text: string, mode?: RedactionMode): boolean;
}

/** Thrown by the post-redaction fail-loud egress guard. Lives in the kernel because qa-engine must not import src/. */
export class SecretLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretLeakError";
  }
}
