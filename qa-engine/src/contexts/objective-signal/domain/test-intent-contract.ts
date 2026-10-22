/* The test-intent contract: what a delivered test is FOR, derived by the orchestrator so no agent can
   redefine it. A primary pass fixes a set of authored clauses (targets, scope, expected values) against
   the change's own tokens; every later regeneration is diffed against that baseline and only generically
   weaker changes are rejected. Pure: no I/O, no selector- or app-specific rule. */

import type { ChangeTokenSet } from "./change-tokens.ts";
import { normalizeToken } from "./change-tokens.ts";

/** Matcher strength, weakest first. A regeneration may not move a clause down this order. */
export type MatcherStrength = "truthy" | "presence" | "contains" | "exact";

const STRENGTH_ORDER: readonly MatcherStrength[] = ["truthy", "presence", "contains", "exact"];

/** One statically readable piece of a test: a locator chain or an assertion. */
export interface IntentClause {
  /** Stable within its test across regenerations (the extractor keeps it stable per clause position). */
  readonly id: string;
  readonly kind: "locator" | "assertion";
  /** Literals the clause names: locator chain texts/values, and the expected value. */
  readonly literals: readonly string[];
  /** The expected literal, when the assertion's expected value is readable. */
  readonly expected?: string;
  /** Assertion strength; absent for locators. */
  readonly strength?: MatcherStrength;
  /** The assertion is negated (`not.`), whose flip is a weakening. */
  readonly negated?: boolean;
  /** Scope steps in order (container, filter, role) — what narrows the target. */
  readonly scope: readonly string[];
  /** Positional steps in order (`first`, `last`, `nth`) — a target picked by position, not by scope. */
  readonly positional: readonly string[];
  /** Any non-literal argument: nothing about the clause is statically knowable. Never rejects. */
  readonly opaque: boolean;
}

/** One test's clauses, in the file it lives in. */
export interface SpecIntent {
  readonly file: string;
  readonly testName: string;
  readonly clauses: readonly IntentClause[];
}

/**
 * How a primary pass relates to the change's token set.
 * - `anchored`: a readable clause names a change token.
 * - `unanchored`: the token set is non-empty and no readable clause names one.
 * - `no-tokens`: the change produced no token at all (style, pure logic) — never unanchored.
 * - `not-evaluable`: every clause is opaque, so anchoring cannot be judged (opacity is telemetry only).
 */
export type Anchoring = "anchored" | "unanchored" | "no-tokens" | "not-evaluable";

/** The generic delta rules. Ids are stable so prompt feedback and telemetry can name them. */
export type IntentViolationRule =
  | "dropped-assertion"
  | "deleted-test"
  | "weakened-matcher"
  | "negation-flip"
  | "scope-to-position"
  | "lost-anchor"
  | "changed-expected-value";

/** One rejected delta, in the shape the next repair turn receives as facts. */
export interface IntentViolation {
  readonly rule: IntentViolationRule;
  readonly file: string;
  /** The clause the delta touched; `<contract>` for a file-level rule. */
  readonly clauseId: string;
  readonly before: string;
  readonly after: string;
}

const CONTRACT_SCOPE = "<contract>";

function names(clause: IntentClause, tokens: ChangeTokenSet): boolean {
  return clause.literals.some((literal) => tokens.all.has(normalizeToken(literal)));
}

/** Whether a primary pass is anchored to the change. Opaque clauses cannot anchor anything. */
export function anchoring(clauses: readonly IntentClause[], tokens: ChangeTokenSet): Anchoring {
  if (tokens.all.size === 0) return "no-tokens";
  const readable = clauses.filter((clause) => !clause.opaque);
  if (readable.length === 0) return "not-evaluable";
  return readable.some((clause) => names(clause, tokens)) ? "anchored" : "unanchored";
}

function strengthIndex(strength: MatcherStrength | undefined): number {
  return strength ? STRENGTH_ORDER.indexOf(strength) : STRENGTH_ORDER.indexOf("presence");
}

/** A clause's own literals, so a diff between two versions can be described without the extractor. */
function describe(clause: IntentClause): string {
  const parts = [`scope=${clause.scope.join(">") || "-"}`, `targets=${clause.literals.join(",") || "-"}`];
  if (clause.expected !== undefined) parts.push(`expected=${clause.expected}`);
  if (clause.strength) parts.push(`strength=${clause.strength}`);
  if (clause.negated) parts.push("negated");
  if (clause.positional.length) parts.push(`positional=${clause.positional.join(",")}`);
  return parts.join(" ");
}

/**
 * Every generic delta between a baseline contract and a regeneration's bytes. A clause that is opaque on
 * either side is never judged. Waivers come from the change, never from an agent's claim:
 * - adding scope (an extra container, filter or role step) is not a violation;
 * - a changed expected value is waived only when the new value is a token from an added diff line.
 */
export function diffContracts(
  before: readonly SpecIntent[],
  after: readonly SpecIntent[],
  tokens: ChangeTokenSet,
): IntentViolation[] {
  const violations: IntentViolation[] = [];
  const afterByKey = new Map<string, SpecIntent>();
  for (const spec of after) afterByKey.set(`${spec.file}\u0000${spec.testName}`, spec);

  for (const baseline of before) {
    if (baseline.clauses.length === 0) continue;
    const current = afterByKey.get(`${baseline.file}\u0000${baseline.testName}`);

    if (!current) {
      violations.push({
        rule: "deleted-test",
        file: baseline.file,
        clauseId: CONTRACT_SCOPE,
        before: `${baseline.testName} (${baseline.clauses.length} clause(s))`,
        after: "absent",
      });
      continue;
    }

    const currentById = new Map<string, IntentClause>();
    for (const clause of current.clauses) currentById.set(clause.id, clause);

    for (const previous of baseline.clauses) {
      if (previous.opaque) continue;
      const next = currentById.get(previous.id);
      if (!next || next.opaque) {
        if (!next && previous.kind === "assertion") {
          violations.push({
            rule: "dropped-assertion",
            file: baseline.file,
            clauseId: previous.id,
            before: describe(previous),
            after: nextFor(current, previous.id),
          });
        }
        continue;
      }

      if (next.positional.length > 0 && previous.positional.length === 0) {
        violations.push({
          rule: "scope-to-position",
          file: baseline.file,
          clauseId: previous.id,
          before: describe(previous),
          after: describe(next),
        });
        continue;
      }

      if (Boolean(next.negated) !== Boolean(previous.negated)) {
        violations.push({
          rule: "negation-flip",
          file: baseline.file,
          clauseId: previous.id,
          before: describe(previous),
          after: describe(next),
        });
        continue;
      }

      if (next.kind === "assertion" && strengthIndex(next.strength) < strengthIndex(previous.strength)) {
        violations.push({
          rule: "weakened-matcher",
          file: baseline.file,
          clauseId: previous.id,
          before: describe(previous),
          after: describe(next),
        });
        continue;
      }

      /* An expected value is in scope when the clause names a change token; changing it then changes
         asserted behavior. The new value being an added-line token is the only waiver. */
      const inScope = names(previous, tokens);
      if (
        inScope &&
        previous.expected !== undefined &&
        next.expected !== undefined &&
        normalizeToken(previous.expected) !== normalizeToken(next.expected) &&
        !tokens.literals.has(normalizeToken(next.expected))
      ) {
        violations.push({
          rule: "changed-expected-value",
          file: baseline.file,
          clauseId: previous.id,
          before: describe(previous),
          after: describe(next),
        });
      }
    }

    /* A file that anchored the change and no longer names it lost the only link the contract had. */
    if (anchoring(baseline.clauses, tokens) === "anchored" && anchoring(current.clauses, tokens) === "unanchored") {
      violations.push({
        rule: "lost-anchor",
        file: baseline.file,
        clauseId: CONTRACT_SCOPE,
        before: "anchored",
        after: "unanchored",
      });
    }
  }

  return violations;
}

function nextFor(spec: SpecIntent, clauseId: string): string {
  const clause = spec.clauses.find((candidate) => candidate.id === clauseId);
  return clause ? describe(clause) : "absent";
}
