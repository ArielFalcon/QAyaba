/* Recovered from the deleted shell test src/qa/learning/learning-rule.test.ts's `ruleKey` and
   `deduplicateRules` describe blocks (git a4827f5^), retargeted onto qa-engine's live
   distill-rule.ts (ruleKey/decideDistill) — the shell's dead deduplicateRules/ruleKey were already
   twins of these before a4827f5 deleted them (see that commit's own message). decideDistill is a
   per-candidate API (existingRules in, one decision out), unlike the shell's batch-shaped
   deduplicateRules({toInsert,toSkip}) — the only live caller (ReflectorPortAdapter.reflect) never
   distills more than one candidate per call, so there is no batch entry point to retarget the old
   "deduplicates within the same batch" case onto directly. The last test below recasts it as
   what a caller processing several candidates in one pass WOULD have to do with this API: fold
   each newly-accepted candidate back into the existing set before deciding the next one.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ruleKey, decideDistill, detectArchetype } from "@contexts/cross-run-learning/domain/distill-rule.ts";
import { detectStructuralPatterns } from "@kernel/structural-pattern.ts";
import type { LearningRule } from "@contexts/cross-run-learning/application/ports/index.ts";

function existingRule(overrides: Partial<LearningRule> = {}): LearningRule {
  return {
    id: "rule-1",
    trigger: "form without validation",
    action: "test invalid input",
    errorClass: "E-FALSE-POSITIVE",
    archetype: null,
    confidence: "low",
    usageCount: 0,
    outcomeCount: 0,
    oracleOutcomeCount: 0,
    successRate: null,
    lastVerified: null,
    source: "run-1",
    status: "candidate",
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ruleKey", () => {
  test("produces stable key from trigger + action", () => {
    assert.equal(ruleKey({ trigger: "a", action: "b" }), "a::b");
  });

  test("normalizes casing, whitespace and trailing punctuation so near-duplicates collide", () => {
    assert.equal(
      ruleKey({ trigger: "Fragile  selector", action: "Scope the locator." }),
      ruleKey({ trigger: "fragile selector", action: "scope the locator" }),
    );
  });
});

describe("decideDistill (per-candidate dedup against the existing rule set)", () => {
  test("saves a new candidate when no existing rule shares its key", () => {
    const decision = decideDistill({ trigger: "a", action: "b" }, []);
    assert.equal(decision.decision, "save");
  });

  test("skips a candidate that duplicates an existing rule's key", () => {
    const existing = [existingRule({ trigger: "a", action: "b" })];
    const decision = decideDistill({ trigger: "a", action: "b" }, existing);
    assert.equal(decision.decision, "skip-duplicate");
    if (decision.decision === "skip-duplicate") {
      assert.equal(decision.match.id, "rule-1");
    }
  });

  test("a caller processing several candidates in one pass must fold each accepted one back into 'existing' to catch batch-internal duplicates", () => {
    const candidates = [
      { trigger: "a", action: "b" },
      { trigger: "a", action: "b" }, /* same key as the first */
    ];
    const accepted: LearningRule[] = [];
    const decisions = candidates.map((c) => {
      const decision = decideDistill(c, accepted);
      if (decision.decision === "save") {
        accepted.push(existingRule({ id: `new-${accepted.length}`, ...c }));
      }
      return decision.decision;
    });
    assert.deepEqual(decisions, ["save", "skip-duplicate"], "the second candidate must be recognized as a duplicate of the first WITHIN the same pass");
  });
});

/*
 * The archetype stored on a distilled rule must be one of the structural kinds retrieval biases on
 * for the same diff — otherwise a rule written for a diff can never be matched by that diff's shape.
 * The expected archetype is the first detected kind, in the detector's precedence order.
 */
describe("detectArchetype", () => {
  const cases: Array<{ name: string; diff: string | undefined; files: string[]; archetype: string | null }> = [
    { name: "an .html form", diff: "+<form (ngSubmit)=\"save()\">", files: ["src/app/a.component.html"], archetype: "form" },
    { name: "a .tsx FormGroup", diff: "+const g = new FormGroup({})", files: ["src/A.tsx"], archetype: "form" },
    { name: "a fetch call", diff: "+await fetch('/api/orders')", files: ["src/orders.ts"], archetype: "api-call" },
    { name: "a redis cache", diff: "+redis.set(key, value)", files: ["src/cache.ts"], archetype: "stateful-cache" },
    { name: "a login change", diff: "+function login(user) {}", files: ["src/auth.ts"], archetype: "auth-flow" },
    { name: "a results table", diff: "+<table class=\"results\">", files: ["src/list.ts"], archetype: "data-list" },
    { name: "a form that also fetches", diff: "+<form>\n+fetch('/api/save')", files: ["src/a.html"], archetype: "form" },
    { name: "a <form> tag outside markup files", diff: "+<form>\n+fetch('/api')", files: ["src/a.ts"], archetype: "api-call" },
    { name: "a change with no known shape", diff: "+const x = 1;", files: ["src/x.ts"], archetype: "generic" },
    { name: "no diff", diff: undefined, files: ["src/x.ts"], archetype: null },
    { name: "an empty diff", diff: "", files: [], archetype: null },
  ];
  for (const c of cases) {
    test(`${c.name} is stored as ${c.archetype ?? "no archetype"}`, () => {
      assert.equal(detectArchetype(c.diff, c.files), c.archetype);
    });
    if (c.archetype !== null && c.diff) {
      const diff = c.diff;
      test(`${c.name}: the stored archetype is a kind retrieval biases on for the same diff`, () => {
        const retrievalKinds = detectStructuralPatterns(diff, c.files).map((p) => p.kind);
        assert.ok(retrievalKinds.includes(c.archetype as (typeof retrievalKinds)[number]), `${c.archetype} not in [${retrievalKinds.join(", ")}]`);
      });
    }
  }
});
