/* External authority checks for DelegationResult. Prompt compliance is not enough. */
import { ACCEPTANCE_REPORT_DEFECTS } from "./acceptance-report.ts";
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
  ...ACCEPTANCE_REPORT_DEFECTS,
] as const;
export type PushbackReason = (typeof PUSHBACK_REASONS)[number];

/*
 * A sidekick's free-text "concerns" prose paraphrases an acceptance criterion in its own words
 * rather than quoting it verbatim — a plain substring check (c.includes(criterion)) silently waved
 * through a genuine contradiction whenever the wording differed at all. Match by normalized
 * key-term overlap instead: strip stopwords/punctuation, then require most of the criterion's
 * significant words to reappear (by a lenient shared-prefix "stem") somewhere in the concern.
 */
/* Vocabulary data, not decision logic: the matcher's behavior is pinned by paraphrase tests, not by
   one test per word (and words of two letters or fewer are dropped by length before this set is read). */
// Stryker disable StringLiteral: vocabulary data — see above
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "be",
  "been", "being", "must", "should", "shall", "will", "would", "with", "without", "that", "this",
  "these", "those", "it", "its", "as", "by", "at", "from", "not", "no", "does", "do", "did", "has",
  "have", "had", "before", "after", "during", "correctly", "properly",
]);
// Stryker restore StringLiteral

function keyTerms(text: string): string[] {
  const spaced = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  // Stryker disable next-line Regex: equivalent — the empty strings a single-space split leaves are dropped by the length filter
  const words = spaced.split(/\s+/);
  return words.filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/* Lenient stem check: same word, or one is a >=4-char prefix of the other (validates/validate/validation). */
function stemMatches(a: string, b: string): boolean {
  if (a === b) return true;
  const shortLen = Math.min(a.length, b.length);
  if (shortLen < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/*
 * A concern contradicts a criterion only when it CLAIMS the criterion is not satisfied; sharing the
 * criterion's words is not enough. A sidekick routinely reports uncertainty ("could not verify
 * <criterion>", no runner in scope), affirmation ("criterion satisfied: <criterion>") or a negated
 * breach ("nothing contradicts the criterion", "no violations"), and none of those contradicts it.
 *
 * A clause claims non-satisfaction when it states one of these and no negation governs it:
 *  - failed satisfaction: "cannot satisfy", "could not be met", "not met", "unmet", ...
 *  - a failure verdict on the criterion itself: "criterion failed", "acceptance fails";
 *  - a breach: "violates", "contradicts" and their inflections.
 */
const NON_SATISFACTION_CLAIMS: readonly RegExp[] = [
  /\b(?:cannot|can't|can not|could not|couldn't|unable to|does not|doesn't|did not|didn't|do not|don't|will not|won't|fails? to|failed to)\s+(?:be\s+)?(?:satisf(?:y|ied)|meet|met|fulfil+(?:ed)?|achieved?|comply with)\b/gi,
  /\bnot\s+(?:be\s+|been\s+)?(?:satisfied|met|fulfil+ed|achieved)\b/gi,
  /\b(?:unsatisfied|unmet|unfulfil+ed|unachievable)\b/gi,
  /\b(?:criterion|criteria|acceptance|requirements?)\s+(?:(?:has|have|was|were|is|are)\s+)?(?:failed|fails|failing)\b/gi,
  // Stryker disable next-line Regex: equivalent — only the match position is read, and the word stem alone fixes it
  /\bviolat\w*/gi,
  // Stryker disable next-line Regex: equivalent — only the match position is read, and the word stem alone fixes it
  /\bcontradict\w*/gi,
];

/* A claim is negated when one of the few words just before it, in the same clause, is a negation:
 * "no violations", "nothing contradicts", "does not violate", "without violating". */
const NEGATION_WORD = /^(?:no|not|nothing|never|none|neither|nor|without|cannot)$/;
/* A contracted negation: "doesn't", "can't", "isn't". */
// Stryker disable next-line Regex: equivalent — English words carry "n't" only at their end
const CONTRACTED_NEGATION = /n't$/;
const NEGATION_WINDOW = 3;

function negatedAt(clause: string, index: number): boolean {
  // Stryker disable next-line Regex: equivalent — the empty strings a single-separator split leaves are dropped below
  const words = clause.slice(0, index).toLowerCase().split(/[^a-z']+/);
  const preceding = words.filter(Boolean);
  return preceding.slice(-NEGATION_WINDOW).some((word) => NEGATION_WORD.test(word) || CONTRACTED_NEGATION.test(word));
}

function claimsNonSatisfaction(concern: string): boolean {
  // Stryker disable next-line Regex: equivalent — an empty clause between two separators holds no claim
  return concern.split(/[.;:!?\n]+/).some((clause) =>
    NON_SATISFACTION_CLAIMS.some((claim) =>
      [...clause.matchAll(claim)].some((match) => !negatedAt(clause, match.index)),
    ),
  );
}

/* True when `concern` claims non-satisfaction AND reproduces most of `criterion`'s meaningful
 * words — a paraphrase, not just an unrelated concern that happens to share a rare short word.
 * Criteria with no meaningful words (empty after stopword filtering) never match anything, to
 * avoid a vacuous always-true check. */
function concernContradictsCriterion(concern: string, criterion: string): boolean {
  if (!claimsNonSatisfaction(concern)) return false;
  const criterionTerms = keyTerms(criterion);
  // Stryker disable next-line ConditionalExpression: equivalent for the `false` case — 0/0 is NaN, which never reaches the ratio
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
    // Stryker disable next-line StringLiteral: message detail only
    findings.push({ reason: "foreign-brief", detail: "delegationId/runId mismatch" });
  }
  for (const file of result.filesChanged) {
    if (!isPathWithinWritableRoots(file.path, brief.scope.writablePaths)) {
      findings.push({ reason: "path-outside-scope", detail: file.path });
    }
  }
  /* Sidekick cannot claim expanded authority via result metadata — authority is frozen on the brief. */
  if (brief.authority.canExpandScope !== SIDEKICK_AUTHORITY.canExpandScope) {
    // Stryker disable next-line StringLiteral: message detail only
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
  /* A missing or malformed acceptance report breaks the output contract without proving any
     criterion unmet: a non-fatal finding, whatever the status. */
  if (result.acceptanceReportDefect) {
    findings.push({ reason: result.acceptanceReportDefect.reason, detail: result.acceptanceReportDefect.detail });
  }
  if (result.status === "needs-lead" && result.unresolvedQuestions.some((q) => /architect/i.test(q))) {
    // Stryker disable next-line StringLiteral: message detail only — the separator between the questions
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
  // Stryker disable next-line StringLiteral: message detail only — the separator between the reasons
  const reasonList = findings.map((f) => f.reason).join(",");
  return {
    ...result,
    status: fatal ? "blocked" : result.status === "completed" ? "completed-with-concerns" : result.status,
    recommendation: fatal ? "escalate" : result.recommendation,
    concerns: [...result.concerns, ...findings.map((f) => `${f.reason}: ${f.detail}`)],
    summary: fatal ? `pushback: ${reasonList}` : result.summary,
  };
}
