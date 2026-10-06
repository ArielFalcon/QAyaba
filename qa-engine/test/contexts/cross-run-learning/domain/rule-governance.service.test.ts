import { test } from "node:test";
import assert from "node:assert/strict";
import { RuleGovernanceService } from "@contexts/cross-run-learning/domain/rule-governance.service.ts";
import type { LearningRule } from "@contexts/cross-run-learning/application/ports/index.ts";

/* `at` is required: LearningRule includes it (history.ts ORDER BY ... at DESC). */
const rule = (status: LearningRule["status"], successRate: number | null, trigger: string, at = "2026-01-01T00:00:00.000Z"): LearningRule =>
  ({ id: trigger, trigger, action: "a", errorClass: "E-X", archetype: null, status, confidence: "medium", usageCount: 0, outcomeCount: 0, oracleOutcomeCount: 0, successRate, lastVerified: null, source: "oracle", at });

const svc = new RuleGovernanceService();

test("rank: active before candidate, then by successRate desc (the former SQL ORDER BY, now pure)", () => {
  const ranked = svc.rank([
    rule("candidate", 0.9, "c-high"),
    rule("active", 0.5, "a-low"),
    rule("active", 0.8, "a-high"),
  ]);
  assert.deepEqual(ranked.map((r) => r.trigger), ["a-high", "a-low", "c-high"]);
});

test("rank: a null successRate sorts as 0 (COALESCE(success_rate, 0))", () => {
  const ranked = svc.rank([rule("active", null, "a-null"), rule("active", 0.1, "a-0.1")]);
  assert.deepEqual(ranked.map((r) => r.trigger), ["a-0.1", "a-null"]);
});

test("rank: at DESC tiebreak when status and successRate are identical (3rd SQL sort key)", () => {
  const ranked = svc.rank([
    rule("active", 0.5, "older", "2026-01-01T00:00:00.000Z"),
    rule("active", 0.5, "newer", "2026-06-01T00:00:00.000Z"),
  ]);
  assert.deepEqual(ranked.map((r) => r.trigger), ["newer", "older"]);
});

test("rank: ties broken deterministically by id ascending, regardless of input order", () => {
  /* Mirrors the deleted shell's selectForRetrieval determinism test: when status, successRate
     (+ bias) AND `at` are all tied, the final tiebreak must be a stable total order (rule id),
     not whatever order Array.sort's stability happens to preserve from the INPUT array. */
  const sameAt = "2026-01-01T00:00:00.000Z";
  const mk = (id: string) => rule("active", 0.5, id, sameAt);
  const forward = svc.rank([mk("c"), mk("a"), mk("b")]);
  const reversed = svc.rank([mk("b"), mk("a"), mk("c")]);
  assert.deepEqual(forward.map((r) => r.id), ["a", "b", "c"], "ascending by id, per the shell's a.id.localeCompare(b.id)");
  assert.deepEqual(reversed.map((r) => r.id), ["a", "b", "c"], "same result regardless of input order");
});

test("topRules: only active+candidate are retrievable, deprecated/superseded excluded", () => {
  const top = svc.topRules([rule("deprecated", 0.9, "dep"), rule("active", 0.5, "act"), rule("superseded", 0.9, "sup")], 5);
  assert.deepEqual(top.map((r) => r.trigger), ["act"]);
});

/* Relevance bias for topRules (errorClass/archetype matching, +3 each) — optional, additive,
   subordinate to successRate.
 */

const ruleWithMeta = (
  status: LearningRule["status"], successRate: number | null, trigger: string,
  errorClass: string, archetype: string | null, at = "2026-01-01T00:00:00.000Z",
): LearningRule =>
  ({ id: trigger, trigger, action: "a", errorClass, archetype, status, confidence: "medium", usageCount: 0, outcomeCount: 0, oracleOutcomeCount: 0, successRate, lastVerified: null, source: "oracle", at });

test("topRules: without a relevance bias, behaves EXACTLY as before (pure SQL-ORDER-BY parity)", () => {
  const rules = [
    ruleWithMeta("active", 0.5, "a", "E-X", null),
    ruleWithMeta("active", 0.5, "b", "E-Y", "form"),
  ];
  const top = svc.topRules(rules, 5);
  /* Tied on status+successRate -> falls through to `at` DESC; both share the same `at`, so
     insertion-stable via the sort's own tie handling (localeCompare on identical strings = 0).
   */
  assert.deepEqual(top.map((r) => r.trigger).sort(), ["a", "b"]);
});

test("topRules: an errorClass match biases a lower-successRate rule above a near-tied non-matching one", () => {
  const rules = [
    ruleWithMeta("active", 0.5, "matches-error-class", "E-EXEC-FAIL", null),
    ruleWithMeta("active", 0.6, "no-match", "E-FLAKY", null),
  ];
  const top = svc.topRules(rules, 5, { errorClass: "E-EXEC-FAIL" });
  /* successRate is scaled x10 (matches the shell's original weighting) so relevance only
     breaks NEAR-ties: matches-error-class: 0.5*10 + 3 = 8; no-match: 0.6*10 + 0 = 6 -> wins. */
  assert.deepEqual(top.map((r) => r.trigger), ["matches-error-class", "no-match"]);
});

test("topRules: an archetype match biases a lower-successRate rule above a near-tied non-matching one", () => {
  const rules = [
    ruleWithMeta("active", 0.5, "matches-archetype", "E-X", "form"),
    ruleWithMeta("active", 0.6, "no-match", "E-X", "api-call"),
  ];
  const top = svc.topRules(rules, 5, { archetypes: ["form"] });
  /* matches-archetype: 0.5*10 + 3 = 8; no-match: 0.6*10 + 0 = 6 -> matches-archetype wins. */
  assert.deepEqual(top.map((r) => r.trigger), ["matches-archetype", "no-match"]);
});

test("topRules: matching BOTH errorClass and archetype stacks the bias additively (+3 +3 = +6) within a near-tie", () => {
  const rules = [
    ruleWithMeta("active", 0.55, "double-match", "E-EXEC-FAIL", "form"),
    ruleWithMeta("active", 0.6, "single-match", "E-EXEC-FAIL", "api-call"),
  ];
  const top = svc.topRules(rules, 5, { errorClass: "E-EXEC-FAIL", archetypes: ["form"] });
  /* double-match: 0.55*10 + 3 + 3 = 11.5; single-match: 0.6*10 + 3 = 9 -> double-match wins. */
  assert.deepEqual(top.map((r) => r.trigger), ["double-match", "single-match"]);
});

test("topRules: relevance bias is a tie-breaker, NOT an override — a proven rule beats a mere relevance match", () => {
  /* Mirrors the deleted shell test (retrieval-archetype.test.ts) "earned success still outranks
     a mere archetype match": a 0.9 successRate rule with no relevance match must still beat a
     0.5 successRate rule that matches, because a single +3 bias cannot overcome an 0.4 gap once
     successRate is scaled x10 (9 vs 5+3=8). Before this fix successRate was NOT scaled, so a
     flat +3 on a [0,1] rate let the weaker, merely-relevant rule win (0.5+3=3.5 > 0.9). */
  const rules = [
    ruleWithMeta("active", 0.9, "proven", "E-X", "api-call"),
    ruleWithMeta("active", 0.5, "matches-only", "E-X", "form"),
  ];
  const top = svc.topRules(rules, 5, { archetypes: ["form"] });
  assert.deepEqual(top.map((r) => r.trigger), ["proven", "matches-only"]);
});

test("topRules: relevance bias never overrides the status (active) priority — exploit still beats explore", () => {
  const rules = [
    ruleWithMeta("candidate", 0.9, "candidate-relevant", "E-EXEC-FAIL", "form"),
    ruleWithMeta("active", 0.1, "active-irrelevant", "E-Y", null),
  ];
  const top = svc.topRules(rules, 5, { errorClass: "E-EXEC-FAIL", archetypes: ["form"] });
  assert.deepEqual(top.map((r) => r.trigger), ["active-irrelevant", "candidate-relevant"], "status is a separate, higher-priority sort key — bias only breaks ties within the same status");
});

test("topRules: breaks ties deterministically by id (same result regardless of input order)", () => {
  /* Mirrors the deleted shell's "selectForRetrieval determinism" test exactly. */
  const mk = (id: string): LearningRule => ruleWithMeta("active", 0.6, id, "E-FALSE-POSITIVE", null);
  const forward = svc.topRules([mk("c"), mk("a"), mk("b")], 2);
  const reversed = svc.topRules([mk("b"), mk("a"), mk("c")], 2);
  assert.deepEqual(forward.map((r) => r.id), reversed.map((r) => r.id));
  assert.deepEqual(forward.map((r) => r.id), ["a", "b"]);
});

/* Exploration slots. Restored from the deleted shell (selectForRetrieval): once active rules
   fill the retrieval limit, candidates would otherwise never be retrieved again, so they could
   never accumulate the outcomes that earn (or deny) promotion. The last EXPLORATION_SLOTS
   positions are reserved for the FRESHEST not-yet-picked candidates, replacing (never appending
   past) the tail of the ranked result.
 */
test("topRules: exploration floor reserves a slot for the freshest excluded candidate without growing past limit", () => {
  const rules = [
    ruleWithMeta("active", 0.9, "a1", "E-X", null, "2026-01-01T00:00:00.000Z"),
    ruleWithMeta("active", 0.9, "a2", "E-X", null, "2026-01-01T00:00:00.000Z"),
    ruleWithMeta("candidate", 0.5, "c-high", "E-X", null, "2026-01-01T00:00:00.000Z"),
    ruleWithMeta("candidate", 0.3, "c-mid", "E-X", null, "2026-02-01T00:00:00.000Z"),
    ruleWithMeta("candidate", 0.1, "c-low-but-fresh", "E-X", null, "2026-03-01T00:00:00.000Z"),
  ];
  /* Without the exploration floor, plain ranking by successRate would pick a1, a2, c-high, c-mid
     and permanently exclude c-low-but-fresh (lowest successRate) from ever being retrieved again. */
  const top = svc.topRules(rules, 4);
  assert.equal(top.length, 4, "must never grow past limit");
  assert.deepEqual(
    top.map((r) => r.trigger),
    ["a1", "a2", "c-high", "c-low-but-fresh"],
    "the freshest excluded candidate takes the reserved exploration slot, displacing the older, higher-successRate c-mid",
  );
});

test("topRules: exploration floor is capped at EXPLORATION_SLOTS even with many excluded candidates", () => {
  const rules = [
    ruleWithMeta("active", 0.9, "a1", "E-X", null),
    ruleWithMeta("active", 0.9, "a2", "E-X", null),
    ruleWithMeta("candidate", 0.9, "c1", "E-X", null, "2026-01-01T00:00:00.000Z"),
    ruleWithMeta("candidate", 0.9, "c2", "E-X", null, "2026-01-02T00:00:00.000Z"),
    ruleWithMeta("candidate", 0.9, "c3", "E-X", null, "2026-01-03T00:00:00.000Z"),
  ];
  /* 2 active + 3 candidates, limit 4: the exploration floor must REPLACE, not append. */
  const top = svc.topRules(rules, 4);
  assert.equal(top.length, 4);
});

test("topRules: no candidates present -> exploration never fires, plain truncation applies", () => {
  const rules = Array.from({ length: 6 }, (_, i) => ruleWithMeta("active", 0.9 - i * 0.01, `a${i}`, "E-X", null));
  const top = svc.topRules(rules, 3);
  assert.equal(top.length, 3);
  assert.deepEqual(top.map((r) => r.trigger), ["a0", "a1", "a2"], "highest successRate actives win, no exploration substitution when there are no candidates");
});

test("topRules: fewer eligible rules than the limit -> no truncation, exploration never fires", () => {
  const rules = [
    ruleWithMeta("active", 0.9, "a1", "E-X", null),
    ruleWithMeta("candidate", 0.2, "c1", "E-X", null),
  ];
  const top = svc.topRules(rules, 5);
  assert.deepEqual(top.map((r) => r.trigger).sort(), ["a1", "c1"]);
});

/* With limit < EXPLORATION_SLOTS, `picked.splice(limit - slots, slots, ...)` used to compute
   a NEGATIVE start (e.g. limit=1, slots=2 -> -1). Array.prototype.splice treats a negative start
   as counting from the end, so instead of replacing the tail it deleted fewer elements than it
   inserted and the result grew past `limit`. slots must be clamped to `limit` too. */
test("topRules: limit smaller than EXPLORATION_SLOTS never grows the result past limit", () => {
  const rules = [
    ruleWithMeta("active", 0.9, "a1", "E-X", null),
    ruleWithMeta("candidate", 0.5, "c-old", "E-X", null, "2026-01-01T00:00:00.000Z"),
    ruleWithMeta("candidate", 0.5, "c-new", "E-X", null, "2026-02-01T00:00:00.000Z"),
  ];
  const top = svc.topRules(rules, 1);
  assert.equal(top.length, 1, "must never grow past limit even when EXPLORATION_SLOTS > limit");
});

test("rank: a higher success rate outranks a newer rule and an earlier id", () => {
  const ranked = svc.rank([
    rule("active", 0.4, "a-lower-newer", "2026-06-01T00:00:00.000Z"),
    rule("active", 0.9, "z-higher-older", "2026-01-01T00:00:00.000Z"),
  ]);
  assert.deepEqual(ranked.map((r) => r.trigger), ["z-higher-older", "a-lower-newer"]);
});

test("topRules: a relevance match flips a near-tie whatever order the rules arrive in", () => {
  const matching = ruleWithMeta("active", 0.85, "matching", "E-EXEC-FAIL", null);
  const other = ruleWithMeta("active", 0.9, "other", "E-FLAKY", null);
  for (const input of [[matching, other], [other, matching]]) {
    const top = svc.topRules(input, 5, { errorClass: "E-EXEC-FAIL" });
    assert.deepEqual(top.map((r) => r.trigger), ["matching", "other"]);
  }
});

test("topRules: the exploration slots go to the NEWEST excluded candidates, newest first", () => {
  const rules = [
    ruleWithMeta("active", 0.9, "a1", "E-X", null),
    ruleWithMeta("active", 0.8, "a2", "E-X", null),
    ruleWithMeta("active", 0.7, "a3", "E-X", null),
    ruleWithMeta("candidate", 0.5, "c-a-oldest", "E-X", null, "2026-01-01T00:00:00.000Z"),
    ruleWithMeta("candidate", 0.5, "c-b-middle", "E-X", null, "2026-02-01T00:00:00.000Z"),
    ruleWithMeta("candidate", 0.5, "c-c-newest", "E-X", null, "2026-03-01T00:00:00.000Z"),
  ];
  const top = svc.topRules(rules, 3);
  assert.deepEqual(top.map((r) => r.trigger), ["a1", "c-c-newest", "c-b-middle"]);
});

test("rank: among rules tied on status and success rate, the newer one outranks an earlier id", () => {
  const ranked = svc.rank([
    rule("active", 0.5, "a-older", "2026-01-01T00:00:00.000Z"),
    rule("active", 0.5, "z-newer", "2026-06-01T00:00:00.000Z"),
  ]);
  assert.deepEqual(ranked.map((r) => r.trigger), ["z-newer", "a-older"]);
});
