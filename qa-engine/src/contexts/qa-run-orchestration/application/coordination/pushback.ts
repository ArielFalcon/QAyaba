/* External authority checks for DelegationResult. Prompt compliance is not enough. */
import { SIDEKICK_AUTHORITY } from "./authority.ts";
import type { DelegationBrief } from "./delegation-brief.ts";
import { belongsToBrief, type DelegationResult } from "./delegation-result.ts";
import { isPathWithinWritableRoots } from "./path-scope.ts";

export const PUSHBACK_REASONS = [
  "missing-artifact",
  "acceptance-contradiction",
  "insufficient-scope",
  "architecture-decision-required",
  "dependency-unavailable",
  "path-outside-scope",
  "foreign-brief",
  "authority-violation",
] as const;
export type PushbackReason = (typeof PUSHBACK_REASONS)[number];

/*
 * A sidekick's free-text "concerns" prose paraphrases an acceptance criterion in its own words
 * rather than quoting it verbatim — a plain substring check (c.includes(criterion)) silently waved
 * through a genuine contradiction whenever the wording differed at all. Match by normalized
 * key-term overlap instead: strip stopwords/punctuation, then require most of the criterion's
 * significant words to reappear (by a lenient shared-prefix "stem") somewhere in the concern.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "be",
  "been", "being", "must", "should", "shall", "will", "would", "with", "without", "that", "this",
  "these", "those", "it", "its", "as", "by", "at", "from", "not", "no", "does", "do", "did", "has",
  "have", "had", "before", "after", "during", "correctly", "properly",
]);

function keyTerms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/* Lenient stem check: same word, or one is a >=4-char prefix of the other (validates/validate/validation). */
function stemMatches(a: string, b: string): boolean {
  if (a === b) return true;
  const shortLen = Math.min(a.length, b.length);
  if (shortLen < 4) return false;
  return a.slice(0, 4) === b.slice(0, 4) && (a.startsWith(b) || b.startsWith(a));
}

/*
 * Wording that asserts a criterion is NOT met. Sharing the criterion's words is not enough: a
 * sidekick routinely reports "could not verify <criterion>" (no runner in scope) or "criterion
 * satisfied: <criterion>", and neither contradicts it. Only an explicit non-satisfaction claim does.
 */
const NON_SATISFACTION =
  /\b(?:cannot|can't|can not|could not|couldn't|unable to|does not|doesn't|did not|didn't|do not|will not|won't|fails? to|failed to)\s+(?:satisfy|meet|fulfil+|achieve|comply with)\b|\bnot\s+(?:satisfied|met|fulfil+ed|achieved)\b|\b(?:unsatisfied|unmet|unfulfil+ed|unachievable)\b|\bviolat(?:e|es|ed|ing|ion)\b|\bcontradict(?:s|ed|ing|ion)?\b/i;

/* True when `concern` claims non-satisfaction AND reproduces most of `criterion`'s meaningful
 * words — a paraphrase, not just an unrelated concern that happens to share a rare short word.
 * Criteria with no meaningful words (empty after stopword filtering) never match anything, to
 * avoid a vacuous always-true check. */
function concernContradictsCriterion(concern: string, criterion: string): boolean {
  if (!NON_SATISFACTION.test(concern)) return false;
  const criterionTerms = keyTerms(criterion);
  if (criterionTerms.length === 0) return false;
  const concernTerms = keyTerms(concern);
  const matched = criterionTerms.filter((ct) => concernTerms.some((cc) => stemMatches(ct, cc)));
  return matched.length / criterionTerms.length >= 0.6;
}

export interface PushbackFinding {
  readonly reason: PushbackReason;
  readonly detail: string;
}

export function validateDelegationAuthority(
  brief: DelegationBrief,
  result: DelegationResult,
): PushbackFinding[] {
  const findings: PushbackFinding[] = [];
  if (!belongsToBrief(result, brief.delegationId, brief.runId)) {
    findings.push({ reason: "foreign-brief", detail: "delegationId/runId mismatch" });
  }
  for (const file of result.filesChanged) {
    if (!isPathWithinWritableRoots(file.path, brief.scope.writablePaths)) {
      findings.push({ reason: "path-outside-scope", detail: file.path });
    }
  }
  /* Sidekick cannot claim expanded authority via result metadata — authority is frozen on the brief. */
  if (brief.authority.canExpandScope !== SIDEKICK_AUTHORITY.canExpandScope) {
    findings.push({ reason: "authority-violation", detail: "brief authority was mutated" });
  }
  if (result.status === "completed" || result.status === "completed-with-concerns") {
    for (const step of brief.validationPlan) {
      const hit = result.validation.find((v) => v.id === step.id);
      if (!hit) findings.push({ reason: "missing-artifact", detail: `validation ${step.id}` });
      else if (!hit.ok) findings.push({ reason: "acceptance-contradiction", detail: `validation ${step.id} failed` });
    }
    for (const criterion of brief.acceptanceCriteria) {
      const contradicted = result.concerns.some((c) => concernContradictsCriterion(c, criterion));
      if (contradicted) {
        findings.push({ reason: "acceptance-contradiction", detail: criterion });
      }
    }
  }
  if (result.status === "needs-lead" && result.unresolvedQuestions.some((q) => /architect/i.test(q))) {
    findings.push({ reason: "architecture-decision-required", detail: result.unresolvedQuestions.join("; ") });
  }
  if (result.status === "blocked" && /dependenc/i.test(result.summary)) {
    findings.push({ reason: "dependency-unavailable", detail: result.summary });
  }
  if (result.status === "blocked" && /scope/i.test(result.summary)) {
    findings.push({ reason: "insufficient-scope", detail: result.summary });
  }
  return findings;
}

export function applyPushback(brief: DelegationBrief, result: DelegationResult): DelegationResult {
  const findings = validateDelegationAuthority(brief, result);
  if (findings.length === 0) return result;
  const fatal = findings.some((f) =>
    f.reason === "foreign-brief" ||
    f.reason === "path-outside-scope" ||
    f.reason === "authority-violation" ||
    f.reason === "acceptance-contradiction",
  );
  return {
    ...result,
    status: fatal ? "blocked" : result.status === "completed" ? "completed-with-concerns" : result.status,
    recommendation: fatal ? "escalate" : result.recommendation,
    concerns: [...result.concerns, ...findings.map((f) => `${f.reason}: ${f.detail}`)],
    summary: fatal ? `pushback: ${findings.map((f) => f.reason).join(",")}` : result.summary,
  };
}
