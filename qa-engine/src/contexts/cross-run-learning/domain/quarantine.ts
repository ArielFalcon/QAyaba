/*
 * Which learned rules an operator sets aside. Pure: the rules and a date in, the rules to quarantine out.
 * Quarantine is for rules whose origin is suspect (learned from a signal later found false), so it is chosen
 * by when a rule was learned, not by how it has fared since: a suspect rule's own outcomes are suspect too.
 */
import type { LearningRule } from "./learning-repository.ts";

/** The statuses a rule still reaches a prompt in. A retired rule (deprecated, superseded) is already out of retrieval, so quarantining it would change nothing. */
const IN_FORCE: ReadonlySet<LearningRule["status"]> = new Set(["active", "candidate"]);

/** A date the way the store holds one (UTC, ISO 8601, millisecond precision), so that comparing two as text is comparing them in time. Throws on anything that is not a date. */
export function parseQuarantineSince(raw: string): string {
  const text = raw.trim();
  const ms = text === "" ? NaN : new Date(text).getTime();
  if (!Number.isFinite(ms)) throw new Error(`--since must be an ISO date (e.g. 2026-09-01 or 2026-09-01T12:00:00Z), got ${JSON.stringify(raw)}`);
  return new Date(ms).toISOString();
}

export interface QuarantineSelection {
  /** In force, learned at or after the date, not yet quarantined: what a run of the command marks. */
  toQuarantine: LearningRule[];
  /** Learned at or after the date and in force but already quarantined: what makes a second run a no-op. */
  alreadyQuarantined: LearningRule[];
}

export function selectForQuarantine(rules: readonly LearningRule[], sinceIso: string): QuarantineSelection {
  const learnedSince = rules.filter((r) => IN_FORCE.has(r.status) && r.at >= sinceIso);
  return {
    toQuarantine: learnedSince.filter((r) => !r.quarantinedAt),
    alreadyQuarantined: learnedSince.filter((r) => Boolean(r.quarantinedAt)),
  };
}
