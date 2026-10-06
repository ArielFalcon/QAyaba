/* qa-engine/test/contexts/cross-run-learning/domain/rule-fold.test.ts
   preventionOutcome's empty-errorClass guard, pinned at the fold level rather than only at the
   preventionOutcome unit level. The real caller (rewritten-engine-factory.ts's recordOutcome
   prevention path, forbidden-file — read-only reference here) only ever calls
   applyOutcome/recordRuleOutcome when preventionOutcome(...) returns non-null:
   const score = preventionOutcome(rule.errorClass, errorClass);
   if (score !== null) recordRuleOutcome(id, score, coverageCreditConfirmed);
   This test simulates that exact "score null -> no write" gate using ONLY this module's pure
   exports (preventionOutcome + applyOutcome), so it exercises the real governance shape without
   touching the forbidden factory file.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  preventionOutcome,
  applyOutcome,
  deriveConfidence,
  attributableRules,
  PREVENTION_HELD_SCORE,
  PROMOTE_RATE,
  DEMOTE_RATE,
  MIN_OUTCOMES,
} from "@contexts/cross-run-learning/domain/rule-fold.ts";
import type { LearningRule } from "@contexts/cross-run-learning/application/ports/index.ts";

function makeRule(overrides: Partial<LearningRule> = {}): LearningRule {
  return {
    id: "lr-1",
    trigger: "fragile selector",
    action: "use getByRole",
    errorClass: "E-FRAGILE-SELECTOR",
    archetype: null,
    confidence: "low",
    usageCount: 0,
    outcomeCount: 0,
    oracleOutcomeCount: 0,
    successRate: null,
    lastVerified: null,
    source: "distiller",
    status: "candidate",
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/* Mirrors the real caller's gate: only fold when preventionOutcome returns non-null. */
function foldPreventionOutcome(rule: LearningRule, runErrorClass: string | null): LearningRule {
  const score = preventionOutcome(rule.errorClass, runErrorClass);
  return score === null ? rule : applyOutcome(rule, score);
}

test("a rule with errorClass \"\" folded across three clean runs does NOT advance outcomeCount via the prevention path (unfalsifiable — no signal, no write)", () => {
  let rule = makeRule({ errorClass: "" as never, status: "candidate", outcomeCount: 0, successRate: null });

  for (let i = 0; i < 3; i++) {
    rule = foldPreventionOutcome(rule, null); /* clean run, three times over */
  }

  assert.equal(rule.outcomeCount, 0, "outcomeCount must stay at 0 — an unfalsifiable rule earns no prevention credit at all");
  assert.equal(rule.successRate, null, "successRate must stay unset — nothing was ever folded in");
  assert.equal(rule.status, "candidate", "status must NOT advance toward active — MIN_OUTCOMES (3) was never reached because nothing was ever recorded");
});

/* promote a real-class candidate straight to "active" (PREVENTION_HELD_SCORE sits exactly on
   (absence of a failure class), not an objective observation, so it must never by itself satisfy
   the candidate -> active gate. The accrual math (outcomeCount/successRate/confidence) is
   UNCHANGED and still pinned here; only the status assertion flips from "active" to "candidate".
 */
test("a rule with a REAL errorClass still earns held credit (PREVENTION_HELD_SCORE) on clean runs, but prevention-only credit does NOT promote to active without oracle evidence", () => {
  let rule = makeRule({ errorClass: "E-FRAGILE-SELECTOR", status: "candidate", outcomeCount: 0, successRate: null });

  for (let i = 0; i < 3; i++) {
    rule = foldPreventionOutcome(rule, null); /* clean run, three times over — the rule "held" */
  }

  assert.equal(rule.outcomeCount, 3, "a real-class rule DOES accrue prevention credit on clean runs — this is the designed, non-circular promotion signal");
  assert.equal(rule.successRate, 0.6, "held credit plateaus at PREVENTION_HELD_SCORE (0.6) — capped at medium confidence, never high");
  assert.equal(rule.oracleOutcomeCount, 0, "prevention-path folds must NEVER advance oracleOutcomeCount — foldPreventionOutcome never sets isOracleScore");
  assert.equal(rule.status, "candidate", "three clean prevention-only runs must NOT promote — zero objective evidence was ever folded in");
  assert.equal(rule.confidence, "medium", "confidence is derived from successRate/outcomeCount alone and is unaffected by the promotion gate");
});

/* pin the exact constant relationship the task calls out — with
   PREVENTION_HELD_SCORE === PROMOTE_RATE (both 0.6), three clean prevention-only runs must NOT
   promote (oracleOutcomeCount stays 0), but the SAME three runs plus one oracle-scored outcome at
   or above the promote rate MUST promote (oracleOutcomeCount reaches 1).
 */
test("PREVENTION_HELD_SCORE === PROMOTE_RATE — three prevention-only runs hold at candidate; a fourth ORACLE-scored outcome promotes", () => {
  assert.equal(PREVENTION_HELD_SCORE, 0.6, "pin the constant this test's design depends on");

  let rule = makeRule({ errorClass: "E-FRAGILE-SELECTOR", status: "candidate", outcomeCount: 0, successRate: null });
  for (let i = 0; i < 3; i++) {
    rule = foldPreventionOutcome(rule, null); /* clean run, three times over */
  }
  assert.equal(rule.status, "candidate", "three clean prevention-only runs: zero oracle evidence, must NOT promote");
  assert.equal(rule.oracleOutcomeCount, 0);

  /* A 4th outcome, this time REAL oracle evidence (valueScore path — isOracleScore=true). */
  rule = applyOutcome(rule, 0.75, null, true);
  assert.equal(rule.oracleOutcomeCount, 1, "the oracle-scored outcome must advance oracleOutcomeCount");
  assert.equal(rule.status, "active", "at least one oracle-scored outcome unblocks promotion once successRate/outcomeCount already clear their own thresholds");
});

test("an empty-errorClass rule also earns no debit when its own (nonexistent) class 'recurs' — the unfalsifiable guard is symmetric, not just a held-credit block", () => {
  /* Even if some caller passed runErrorClass === "" (never happens through the real taxonomy, but
     defensively verified here), the empty-class guard fires FIRST — no signal in either direction.
   */
  let rule = makeRule({ errorClass: "" as never, status: "candidate", outcomeCount: 0, successRate: null });
  rule = foldPreventionOutcome(rule, "" as never);
  assert.equal(rule.outcomeCount, 0, "no debit either — the guard is unconditional on the rule's own blank class");
});

/* Below: recovered from the deleted shell tests src/qa/learning/learning-rule.test.ts and
   learning-rule.invariants.test.ts (git a4827f5^), retargeted onto this live qa-engine module.
   rule-fold.ts is a byte-identical successor of the shell's learning-rule.ts core (the deleted
   rule-fold-parity.test.ts proved exactly that up to a4827f5), so these assertions exercise
   real, already-implemented behavior — not new behavior. Only cases whose subject genuinely
   still exists here are kept; "pending"-status cases are dropped because RuleStatus
   (application/ports/index.ts) no longer has a "pending" member at all.
 */

describe("preventionOutcome — direct semantics matrix (recovered)", () => {
  test("own class recurring = hard 0, clean run = capped positive (PREVENTION_HELD_SCORE), unrelated/noisy = null", () => {
    assert.equal(preventionOutcome("E-FRAGILE-SELECTOR", "E-FRAGILE-SELECTOR"), 0, "the rule did not prevent its own class");
    assert.equal(preventionOutcome("E-FRAGILE-SELECTOR", null), PREVENTION_HELD_SCORE, "a clean run is a weak positive, capped");
    assert.ok(PREVENTION_HELD_SCORE < 0.7, "the held score must stay below the 0.7 'high' threshold");
    assert.equal(preventionOutcome("E-FRAGILE-SELECTOR", "E-EXEC-FAIL"), null, "an unrelated failure carries no evidence about this rule");
    assert.equal(preventionOutcome("E-INFRA", "E-INFRA"), null, "noisy infra class teaches nothing");
    assert.equal(preventionOutcome("E-FLAKY", "E-FLAKY"), null, "noisy flaky class teaches nothing");
  });

  test("a rule whose class keeps recurring under the prevention path is demoted out of active", () => {
    let r = makeRule({ status: "active", successRate: 0.7, outcomeCount: 4, errorClass: "E-FRAGILE-SELECTOR" });
    for (let i = 0; i < 6; i++) {
      const s = preventionOutcome(r.errorClass, "E-FRAGILE-SELECTOR");
      if (s !== null) r = applyOutcome(r, s);
    }
    assert.equal(r.status, "deprecated", "a rule that never prevents its own recurring class loses trust");
  });
});

describe("deriveConfidence — direct boundary pins", () => {
  test("outcomeCount below MIN_OUTCOMES or a null successRate is always low", () => {
    assert.equal(deriveConfidence(0, null), "low");
    assert.equal(deriveConfidence(2, 0.9), "low", "2 outcomes is below MIN_OUTCOMES (3)");
  });

  test("the high/medium boundary sits exactly at 0.7", () => {
    assert.equal(deriveConfidence(5, 0.69), "medium");
    assert.equal(deriveConfidence(5, 0.7), "high");
  });

  test("the medium/low boundary sits exactly at 0.45", () => {
    assert.equal(deriveConfidence(5, 0.44), "low");
    assert.equal(deriveConfidence(5, 0.45), "medium");
  });
});

describe("applyOutcome — running mean, promotion gate, and hysteresis (recovered)", () => {
  test("sets successRate to the score on the first outcome and stays candidate (not enough evidence yet)", () => {
    const r = applyOutcome(makeRule({ outcomeCount: 0, successRate: null }), 0.8);
    assert.equal(r.successRate, 0.8);
    assert.equal(r.outcomeCount, 1);
    assert.equal(r.status, "candidate");
  });

  test("accumulates as a running mean, never an overwrite", () => {
    let r = makeRule({ outcomeCount: 0, successRate: null });
    r = applyOutcome(r, 1.0);
    r = applyOutcome(r, 0.0);
    r = applyOutcome(r, 0.5);
    assert.equal(r.outcomeCount, 3);
    assert.ok(Math.abs(r.successRate! - 0.5) < 1e-9, `expected ~0.5, got ${r.successRate}`);
  });

  test("promotes a candidate to active after enough good ORACLE-scored outcomes", () => {
    let r = makeRule({ status: "candidate" });
    r = applyOutcome(r, 0.8, null, true);
    r = applyOutcome(r, 0.8, null, true);
    assert.equal(r.status, "candidate");
    r = applyOutcome(r, 0.8, null, true);
    assert.equal(r.status, "active");
  });

  test("does NOT promote when the mean stays below PROMOTE_RATE, even with oracle evidence", () => {
    let r = makeRule({ status: "candidate" });
    r = applyOutcome(r, 0.5, null, true);
    r = applyOutcome(r, 0.5, null, true);
    r = applyOutcome(r, 0.5, null, true);
    assert.equal(r.status, "candidate");
  });

  test("does NOT promote a candidate on good outcomes alone when none are oracle-scored", () => {
    let r = makeRule({ status: "candidate" });
    r = applyOutcome(r, 0.8);
    r = applyOutcome(r, 0.8);
    r = applyOutcome(r, 0.8);
    assert.equal(r.status, "candidate", "zero oracle-scored outcomes — promotion must be held regardless of successRate");
    assert.equal(r.oracleOutcomeCount, 0);
  });

  test("demotes an active rule only after SUSTAINED low outcomes (tolerant, not trigger-happy)", () => {
    let r = makeRule({ status: "active", successRate: 0.8, outcomeCount: 3 });
    r = applyOutcome(r, 0.0);
    r = applyOutcome(r, 0.0);
    r = applyOutcome(r, 0.0);
    assert.equal(r.status, "active", "a few failures do NOT flip a trusted rule");
    for (let i = 0; i < 6; i++) r = applyOutcome(r, 0.0);
    assert.equal(r.status, "deprecated");
  });

  test("hysteresis: an active rule in the dead band [0.3,0.6) is NOT demoted", () => {
    let r = makeRule({ status: "active", successRate: 0.45, outcomeCount: 5 });
    r = applyOutcome(r, 0.45);
    r = applyOutcome(r, 0.45);
    assert.equal(r.status, "active");
  });

  test("a deprecated rule is never revived by outcomes: only a human restores it", () => {
    let r = makeRule({ status: "deprecated", successRate: 0.5, outcomeCount: 2 });
    for (let i = 0; i < 5; i++) r = applyOutcome(r, 1, true, true);
    assert.equal(r.status, "deprecated", "a veto or demotion must stick however good later outcomes look");
  });

  test("a single anomalous outcome barely moves a high-confidence rule", () => {
    const r = applyOutcome(makeRule({ status: "active", successRate: 0.9, outcomeCount: 20 }), 0.0);
    assert.ok(r.successRate! > 0.85, `expected >0.85, got ${r.successRate}`);
    assert.equal(r.status, "active");
  });

  test("no status change or confidence above 'low' before MIN_OUTCOMES", () => {
    let r = makeRule({ status: "candidate", outcomeCount: 0, successRate: null });
    r = applyOutcome(r, 1, null, true);
    r = applyOutcome(r, 1, null, true);
    assert.equal(r.confidence, "low", "insufficient evidence stays low");
    assert.equal(r.status, "candidate", "insufficient evidence does not promote");
  });

  test("promotion requires a clearly positive mean — a mean of 0.5 does NOT promote", () => {
    let r = makeRule({ status: "candidate", outcomeCount: 0, successRate: null });
    r = applyOutcome(r, 0.5, null, true);
    r = applyOutcome(r, 0.5, null, true);
    r = applyOutcome(r, 0.5, null, true);
    assert.equal(r.status, "candidate", "a 0.5 mean is not enough evidence to promote");
  });

  test("'superseded' is terminal: outcomes never revive or further move it", () => {
    const sup = makeRule({ status: "superseded" });
    let good = sup;
    for (let i = 0; i < 5; i++) good = applyOutcome(good, 1, null, true);
    assert.equal(good.status, "superseded", "good outcomes cannot revive it");
    let bad = sup;
    for (let i = 0; i < 5; i++) bad = applyOutcome(bad, 0);
    assert.equal(bad.status, "superseded", "bad outcomes cannot move it");
  });
});

describe("applyOutcome accumulates an arithmetic running mean, not a windowed/last value (recovered)", () => {
  test("successRate is the true mean of all folded scores", () => {
    const two = applyOutcome(applyOutcome(makeRule({ outcomeCount: 0, successRate: null }), 1), 0);
    assert.ok(Math.abs((two.successRate ?? -1) - 0.5) < 1e-9, "[1,0] -> 0.5");
    const three = applyOutcome(two, 0);
    assert.ok(Math.abs((three.successRate ?? -1) - 1 / 3) < 1e-9, "[1,0,0] -> 1/3, not a wrong denominator from windowing/overwriting");
  });
});

describe("ledger invariant: a rule fed ONLY prevention outcomes can never reach 'high' confidence (exhaustive)", () => {
  test("all-held sequences (n=1..30) never reach 'high'; mean never exceeds the held ceiling", () => {
    for (let n = 1; n <= 30; n++) {
      let r = makeRule({ status: "candidate", outcomeCount: 0, successRate: null });
      for (let i = 0; i < n; i++) r = applyOutcome(r, PREVENTION_HELD_SCORE, null, false);
      assert.notEqual(r.confidence, "high", `all-held n=${n} must never be 'high'`);
      assert.ok((r.successRate ?? 0) <= PREVENTION_HELD_SCORE + 1e-9, `mean must stay <= ceiling at n=${n}`);
    }
  });
});

describe("attributableRules — context-directed attribution filter (recovered, previously untested)", () => {
  function mkAttrRule(id: string, archetype: string | null): LearningRule {
    return makeRule({ id, archetype, status: "active" });
  }

  test("keeps rules whose archetype matches the diff shapes, and untagged rules (fail-open per rule)", () => {
    const rules = [mkAttrRule("form", "form"), mkAttrRule("api", "api-call"), mkAttrRule("untagged", null)];
    const kept = attributableRules(rules, { diffArchetypes: ["form"] });
    assert.deepEqual(kept.map((r) => r.id), ["form", "untagged"]);
  });

  test("keeps everything when no diff archetypes are known (fail-open)", () => {
    const rules = [mkAttrRule("a", "form"), mkAttrRule("b", "api-call")];
    assert.deepEqual(attributableRules(rules, { diffArchetypes: [] }).map((r) => r.id), ["a", "b"]);
  });

  test("drops tagged non-matching rules but keeps untagged ones", () => {
    const rules = [mkAttrRule("x", "form"), mkAttrRule("y", null)];
    const kept = attributableRules(rules, { diffArchetypes: ["data-list"] });
    assert.deepEqual(kept.map((r) => r.id), ["y"]);
  });

  test("a generic-only diff is a known shape: a form-tagged rule is dropped, an untagged one kept", () => {
    const rules = [mkAttrRule("form", "form"), mkAttrRule("untagged", null)];
    const kept = attributableRules(rules, { diffArchetypes: ["generic"] });
    assert.deepEqual(kept.map((r) => r.id), ["untagged"]);
  });

  test("handles multiple matching archetypes", () => {
    const rules = [mkAttrRule("form", "form"), mkAttrRule("api", "api-call"), mkAttrRule("nav", "navigation")];
    const kept = attributableRules(rules, { diffArchetypes: ["form", "navigation"] });
    assert.deepEqual(kept.map((r) => r.id), ["form", "nav"]);
  });
});

describe("promotion and demotion thresholds", () => {
  /* A candidate one outcome short of MIN_OUTCOMES whose running rate already sits at `rate`; folding
     one more outcome of the same score keeps the rate exactly there. */
  const candidateAt = (rate: number, oracleOutcomeCount = 1) =>
    makeRule({ status: "candidate", outcomeCount: MIN_OUTCOMES - 1, oracleOutcomeCount, successRate: rate });

  test("a candidate whose success rate lands exactly on PROMOTE_RATE is promoted", () => {
    assert.equal(applyOutcome(candidateAt(PROMOTE_RATE), PROMOTE_RATE, null, true).status, "active");
  });

  test("a candidate just below PROMOTE_RATE stays a candidate", () => {
    const below = PROMOTE_RATE - 0.01;
    assert.equal(applyOutcome(candidateAt(below), below, null, true).status, "candidate");
  });

  test("coverage measured WITHOUT credit for the changed lines blocks promotion", () => {
    assert.equal(applyOutcome(candidateAt(0.9), 0.9, false, true).status, "candidate");
  });

  test("coverage measured WITH credit for the changed lines lets the candidate promote", () => {
    assert.equal(applyOutcome(candidateAt(0.9), 0.9, true, true).status, "active");
  });

  test("an active rule whose success rate lands exactly on DEMOTE_RATE stays active; just below it is deprecated", () => {
    const activeAt = (rate: number) => makeRule({ status: "active", outcomeCount: MIN_OUTCOMES, oracleOutcomeCount: 1, successRate: rate });
    assert.equal(applyOutcome(activeAt(DEMOTE_RATE), DEMOTE_RATE).status, "active");
    const below = DEMOTE_RATE - 0.01;
    assert.equal(applyOutcome(activeAt(below), below).status, "deprecated");
  });

  test("a rule whose errorClass is only whitespace earns no prevention credit (nothing to prevent)", () => {
    assert.equal(preventionOutcome("   ", null), null);
  });
});
