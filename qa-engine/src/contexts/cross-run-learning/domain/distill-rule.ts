import type { LearningRule } from "@contexts/cross-run-learning/application/ports/index.ts";
import { detectStructuralPatterns } from "@kernel/structural-pattern.ts";

export const RULE_FIELD_MAX = 400;

export const TRIGGER_PREFIX = "Applies when ";
const TRIGGER_PREFIX_RE = /^applies\s+when\b\s*/i;

function decapitalizeLeadingWord(body: string): string {
  const space = body.indexOf(" ");
  const first = space === -1 ? body : body.slice(0, space);
  if (/^[A-Z][a-z]+$/.test(first)) {
    return body.charAt(0).toLowerCase() + body.slice(1);
  }
  return body;
}

export function normalizeTrigger(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  const body = collapsed.replace(TRIGGER_PREFIX_RE, "").trim();
  if (body === "") return "";
  return TRIGGER_PREFIX + decapitalizeLeadingWord(body);
}

export function isWellFormedTrigger(trigger: string): boolean {
  return TRIGGER_PREFIX_RE.test(trigger) && trigger.replace(TRIGGER_PREFIX_RE, "").trim().length > 0;
}

export function capRuleFields<T extends { trigger: string; action: string }>(candidate: T): T {
  return {
    ...candidate,
    trigger: normalizeTrigger(candidate.trigger.slice(0, RULE_FIELD_MAX - TRIGGER_PREFIX.length)),
    action: candidate.action.slice(0, RULE_FIELD_MAX),
  };
}

function normalizeRuleText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/[.;,\s]+$/, "").trim();
}

export function ruleKey(rule: { trigger: string; action: string }): string {
  return `${normalizeRuleText(rule.trigger)}::${normalizeRuleText(rule.action)}`;
}

export type DistillDecision =
  | { decision: "save"; key: string }
  | { decision: "skip-duplicate"; key: string; match: LearningRule };

export function decideDistill(
  candidate: { trigger: string; action: string },
  existingRules: readonly LearningRule[],
): DistillDecision {
  const key = ruleKey(candidate);
  const match = existingRules.find((r) => ruleKey(r) === key);
  if (match) return { decision: "skip-duplicate", key, match };
  return { decision: "save", key };
}

/*
 * The archetype a distilled rule is stored under: the first structural kind of the run's diff, from
 * the SAME kernel detector that biases retrieval and attributes folds (detectStructuralPatterns), so
 * a stored archetype is always a kind that diff's shape can match.
 */
export function detectArchetype(diff: string | undefined, changedFiles: readonly string[]): string | null {
  if (!diff) return null;
  return detectStructuralPatterns(diff, [...changedFiles])[0]?.kind ?? null;
}

const AP_FALSE_POSITIVE = /\b(?:asserts? nothing|asserts? 200|no real assertion|test clicks? without asserting|false positive|green noise|trivial assert|passes? when feature is broken)\b/i;
const AP_WRONG_OBJECTIVE = /\b(?:not tied to the (?:commit|change|diff)|misses? the (?:change|intent|objective)|tests? the wrong thing|irrelevant to the diff|does not test the change)\b/i;
const AP_FRAGILE_SELECTOR = /\b(?:fragile selector|ambiguous (?:selector|regex|locator)|text selector|nth-child|hardcoded index|brittle locator|magic string)\b/i;
const AP_NO_CLEANUP = /\b(?:no cleanup|does not clean up|orphaned (?:data|test data)|pollutes? DEV|missing cleanup|test data left behind)\b/i;

const TAG_TO_CLASS: Record<string, string> = {
  "false-positive": "E-FALSE-POSITIVE",
  "wrong-objective": "E-WRONG-OBJECTIVE",
  "fragile-selector": "E-FRAGILE-SELECTOR",
  "no-cleanup": "E-NO-CLEANUP",
};

function classifyReviewerCorrection(correction: string): string | null {
  const tag = /^\s*\[([a-z][a-z-]*)\]/i.exec(correction)?.[1]?.toLowerCase();
  if (tag) {
    const mapped = TAG_TO_CLASS[tag];
    if (mapped) return mapped;
    if (tag === "other") return null;
  }
  if (AP_FALSE_POSITIVE.test(correction)) return "E-FALSE-POSITIVE";
  if (AP_WRONG_OBJECTIVE.test(correction)) return "E-WRONG-OBJECTIVE";
  if (AP_FRAGILE_SELECTOR.test(correction)) return "E-FRAGILE-SELECTOR";
  if (AP_NO_CLEANUP.test(correction)) return "E-NO-CLEANUP";
  return null;
}

export function correctionToErrorClass(correction: string): string {
  return classifyReviewerCorrection(correction) ?? "E-REVIEWER-REJECTED";
}
