/* Operator guidance: the one place the free text a run request, a continuation or a webhook carries is bounded. It is redacted first (the orchestrator's environment secrets, the run's secrets and the patterns) and cut after (qa-engine shared-kernel/redact-then-bound.ts), so a pasted credential that straddles the bound leaves nothing of itself in the task a prompt carries. */

import { redactThenBound } from "../../qa-engine/src/shared-kernel/redact-then-bound";
import { RedactionPortAdapter } from "../telemetry/sanitizer";

/* The longest guidance a run request carries. */
export const MAX_GUIDANCE_LENGTH = 2000;

/* The guidance a request body carries, bounded; a value that is not text is ignored, as if it were absent. */
export function boundGuidance(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const port = new RedactionPortAdapter();
  return redactThenBound(value, MAX_GUIDANCE_LENGTH, (text) => port.redact(text));
}
