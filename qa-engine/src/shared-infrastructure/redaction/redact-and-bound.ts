/* The engine's pattern redaction (the run's secrets by value, then the patterns) bound to the redact-then-bound rule: the form every infrastructure producer of untrusted text uses. A caller whose redaction is not the pattern policy (the shell adds the orchestrator's environment secrets) passes its own to `redactThenBound`. */

import { PRODUCER_MEMORY_BOUND_CHARS, redactThenBound, type BoundOptions } from "../../shared-kernel/redact-then-bound.ts";
import { sanitizeText, type RedactionMode } from "./pattern-redaction.adapter.ts";

export function redactAndBound(raw: string, maxChars: number, options: BoundOptions & { mode?: RedactionMode } = {}): string {
  return redactThenBound(raw, maxChars, (text) => sanitizeText(text, options.mode).text, options);
}

/* Text a process that cannot redact handed over (a page, the seed's fixtures), already held to its memory bound: redacted, then bounded, and told when the producer may have cut it, so its far edge is never kept. */
export function boundProducerText(raw: string, maxChars: number, options: BoundOptions & { mode?: RedactionMode } = {}): string {
  return redactAndBound(raw, maxChars, { ...options, rawIsWindow: raw.length >= PRODUCER_MEMORY_BOUND_CHARS });
}
