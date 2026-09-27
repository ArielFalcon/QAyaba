/*
 * Typed classification of a delegation's contract outcome. Exists so telemetry consumers (e.g.
 * toCoordinationSignals in src/server/coordination-events.ts) can identify a contract failure from
 * a STRUCTURED field instead of regexing the `reason` prose string — which only ever reads
 * "sidekick status=<DelegationStatus>" and can never distinguish a pushback-blocked delegation from
 * a completed one that claimed files never verified on disk.
 *
 * Returns undefined when the delegation is NOT a contract failure: a clean completion, or an
 * intentional needs-lead handoff (the sidekick recognizing its own limits is not a broken contract).
 */
import type { DelegationStatus } from "./delegation-result.ts";

export const DELEGATION_FAILURE_CLASSES = ["failed", "blocked", "claimed-files-missing"] as const;
export type DelegationFailureClass = (typeof DELEGATION_FAILURE_CLASSES)[number];

export function classifyDelegationFailure(
  status: DelegationStatus,
  claimedFileCount: number,
  verifiedFileCount: number,
): DelegationFailureClass | undefined {
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  if (
    (status === "completed" || status === "completed-with-concerns") &&
    claimedFileCount > 0 &&
    verifiedFileCount === 0
  ) {
    return "claimed-files-missing";
  }
  return undefined;
}
