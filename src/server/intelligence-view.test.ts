import { test } from "node:test";
import assert from "node:assert/strict";
import { toIntelligenceView } from "./intelligence-view";
import { foldCurriculum, initCurriculum } from "../qa/learning/curriculum";

test("toIntelligenceView projects rules, scorecard and curriculum", () => {
  const rules = [
    {
      id: "r1", trigger: "fragile selector", action: "scope to a test id",
      errorClass: "E-SELECTOR-FRAGILE", confidence: "high",
      usageCount: 22, outcomeCount: 3, successRate: 0.86,
      lastVerified: null, source: "reviewer", status: "active", at: "2026-01-01",
    },
  ] as never;
  const scorecard = {
    app: "qayaba", updatedAt: "2026-01-02",
    entries: [
      { runId: "x", app: "qayaba", sha: "s", target: "code", valueScore: 0.82, mutantCount: 50, killedCount: 41, at: "2026-01-02" },
    ],
    summary: { totalRuns: 1, measuredRuns: 1, avgValueScore: 0.82, lastValueScore: 0.82 },
  } as never;
  const curriculum = {
    app: "qayaba", updatedAt: "2026-01-02",
    archetypes: [
      { archetype: "happy-path", caughtRealBug: true, firstCaughtAt: "2026-01-01", promotionCount: 2, lastPromoted: "2026-01-02" },
    ],
  } as never;

  const view = toIntelligenceView("qayaba", rules, scorecard, curriculum);
  assert.equal(view.app, "qayaba");
  assert.equal(view.rules.length, 1);
  assert.equal(view.rules[0]!.confidence, "high");
  assert.equal(view.rules[0]!.successRate, 0.86);
  assert.equal(view.scorecard?.lastValueScore, 0.82);
  assert.equal(view.scorecard?.entries[0]!.killedCount, 41);
  assert.equal(view.curriculum?.archetypes[0]!.caughtRealBug, true);
});

/* Built through the domain fold rather than a hand-written literal so the expectation cannot drift
   from what a real run actually writes into the curriculum.
 */
test("toIntelligenceView projects the curriculum's evidence counters", () => {
  const curriculum = foldCurriculum(initCurriculum("app"), ["invalid-input"], "covered", "2026-09-04T10:00:00.000Z");
  const view = toIntelligenceView("app", [], null, curriculum);

  const offered = view.curriculum!.archetypes.find((a) => a.archetype === "invalid-input")!;
  assert.deepEqual({ evaluated: offered.evaluated, credited: offered.credited }, { evaluated: 1, credited: 1 });

  /* An archetype the fold never offered carries the REAL zeros. The projection never invents a
     sentinel — turning evaluated === 0 into "no evidence yet" is the renderers' job.
   */
  const untouched = view.curriculum!.archetypes.find((a) => a.archetype === "happy-path")!;
  assert.deepEqual({ evaluated: untouched.evaluated, credited: untouched.credited }, { evaluated: 0, credited: 0 });
});

test("toIntelligenceView tolerates a missing scorecard and curriculum", () => {
  const view = toIntelligenceView("portfolio", [], null, null);
  assert.equal(view.scorecard, null);
  assert.equal(view.curriculum, null);
  assert.deepEqual(view.rules, []);
});
