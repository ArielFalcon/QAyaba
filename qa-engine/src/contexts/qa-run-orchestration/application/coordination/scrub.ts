/* Shared secret-scrub wrapper for coordination's free-form text egress (delegation briefs,
   sidekick prompts, evidence summaries) — the same sanitizeText twin the lead/worker prompt
   builders use, so secrets never reach the provider or a telemetry sink. */
import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";

export function scrub(text: string): string {
  return sanitizeText(text).text;
}

export function scrubStrings(values: readonly string[]): string[] {
  return values.map(scrub);
}
